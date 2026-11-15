const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const express = require('express');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.BROWSER_PASSWORD || 'Cacademarde2.0';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const VIEWPORT = { width: 1024, height: 640 };
const FRAME_INTERVAL_MS = 83;
const loginAttempts = new Map();
const cookieName = 'browser_session';
const isProduction = process.env.NODE_ENV === 'production';

const app = express();
const server = http.createServer(app);
const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2kb' }));

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  for (const part of cookies.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

function hasSession(req) {
  const [expires, signature, ...rest] = getCookie(req, cookieName).split('.');
  if (!expires || !signature || rest.length || !/^\d+$/.test(expires)) return false;
  if (Number(expires) < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(sign(expires), signature);
}

function setSessionCookie(res) {
  const expires = String(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS);
  const value = `${expires}.${sign(expires)}`;
  res.cookie(cookieName, value, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  });
}

function requireSession(req, res, next) {
  if (hasSession(req)) return next();
  return res.status(401).json({ error: 'Authentication required' });
}

function getClientAddress(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function remainingLoginBlock(address) {
  const record = loginAttempts.get(address);
  if (!record) return 0;
  if (Date.now() - record.startedAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(address);
    return 0;
  }
  return record.count >= MAX_LOGIN_ATTEMPTS
    ? Math.ceil((LOGIN_WINDOW_MS - (Date.now() - record.startedAt)) / 1000)
    : 0;
}

function recordFailedLogin(address) {
  const now = Date.now();
  const record = loginAttempts.get(address);
  if (!record || now - record.startedAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(address, { startedAt: now, count: 1 });
  } else {
    record.count += 1;
  }
}

app.get('/health', (_req, res) => {
  res.status(200).json({ status: browser ? 'ready' : 'starting' });
});

app.post('/api/login', (req, res) => {
  const address = getClientAddress(req);
  const retryAfter = remainingLoginBlock(address);
  if (retryAfter) {
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  if (typeof req.body?.password !== 'string' || !safeEqual(req.body.password, PASSWORD)) {
    recordFailedLogin(address);
    return res.status(401).json({ error: 'Incorrect password' });
  }
  loginAttempts.delete(address);
  setSessionCookie(res);
  return res.status(200).json({ authenticated: true });
});

app.post('/api/logout', requireSession, (_req, res) => {
  res.clearCookie(cookieName, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
  });
  return res.status(200).json({ authenticated: false });
});

app.get(['/app', '/app/'], requireSession, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});
app.get('/app.html', requireSession, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});
app.get('/', (req, res) => {
  res.redirect(hasSession(req) ? '/app/' : '/login');
});
app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { index: false, dotfiles: 'deny' }));

let browser;
let page;
let activeSocket;
let actionQueue = Promise.resolve();
const activeAudioStreams = new Map();

function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  const executablePath = candidates.find((candidate) => {
    try {
      return require('node:fs').accessSync(candidate) === undefined;
    } catch {
      return false;
    }
  });
  if (!executablePath) {
    throw new Error('Chromium not found. Install the "chromium" apt package or set CHROMIUM_PATH.');
  }
  return executablePath;
}

const blockedIPv4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
];

function isPublicAddress(address) {
  const version = net.isIP(address);
  if (version === 4) return !blockedIPv4.some((range) => range.test(address));
  if (version === 6) {
    const normalized = address.toLowerCase();
    return normalized !== '::' && normalized !== '::1'
      && !normalized.startsWith('fc')
      && !normalized.startsWith('fd')
      && !normalized.startsWith('fe80:')
      && !normalized.startsWith('::ffff:127.')
      && !normalized.startsWith('::ffff:10.')
      && !normalized.startsWith('::ffff:192.168.');
  }
  return false;
}

async function validateDestination(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Enter a valid website address.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP and HTTPS websites can be opened.');
  }
  if (url.username || url.password) throw new Error('Website addresses cannot contain credentials.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Private and local network addresses cannot be opened.');
  }
  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Private and local network addresses cannot be opened.');
  }
  return url.href;
}

function send(socket, value) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function sendAudioChunk(socket, id, chunk) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const header = Buffer.allocUnsafe(5);
  header[0] = 1;
  header.writeUInt32BE(id, 1);
  socket.send(Buffer.concat([header, chunk]), { binary: true });
}

function resetAudioStreams(socket) {
  activeAudioStreams.clear();
  send(socket, { type: 'audio-reset' });
}

async function openAddress(socket, address) {
  if (typeof address !== 'string' || address.length > 2048) {
    throw new Error('Website address is too long or invalid.');
  }
  const rawUrl = /^[a-z][a-z\d+.-]*:/i.test(address)
    ? address
    : `https://${address}`;
  const url = await validateDestination(rawUrl);
  resetAudioStreams(socket);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  send(socket, { type: 'page', url: page.url(), title: await page.title() });
}

async function handleMessage(socket, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return send(socket, { type: 'error', message: 'Invalid browser action.' });
  }
  if (!message || typeof message.type !== 'string') return;

  try {
    switch (message.type) {
      case 'navigate':
        await openAddress(socket, message.url);
        break;
      case 'back':
        resetAudioStreams(socket);
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 });
        break;
      case 'forward':
        resetAudioStreams(socket);
        await page.goForward({ waitUntil: 'domcontentloaded', timeout: 20_000 });
        break;
      case 'reload':
        resetAudioStreams(socket);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
        break;
      case 'click':
        await page.mouse.click(message.x, message.y, { button: 'left', clickCount: message.clickCount === 2 ? 2 : 1 });
        break;
      case 'move':
        await page.mouse.move(message.x, message.y);
        break;
      case 'scroll':
        await page.mouse.move(message.x, message.y);
        await page.mouse.wheel({ deltaX: message.deltaX || 0, deltaY: message.deltaY || 0 });
        break;
      case 'keyDown':
        if (typeof message.key === 'string' && message.key.length <= 32) await page.keyboard.down(message.key);
        break;
      case 'keyUp':
        if (typeof message.key === 'string' && message.key.length <= 32) await page.keyboard.up(message.key);
        break;
      case 'type':
        if (typeof message.text === 'string' && message.text.length <= 2000) await page.keyboard.type(message.text);
        break;
      default:
        return;
    }
    if (['back', 'forward', 'reload'].includes(message.type)) {
      send(socket, { type: 'page', url: page.url(), title: await page.title() });
    }
  } catch (error) {
    send(socket, { type: 'error', message: error.message || 'The browser action failed.' });
  }
}

server.on('upgrade', (req, socket, head) => {
  let requestUrl;
  let originUrl;
  try {
    requestUrl = new URL(req.url, `http://${req.headers.host}`);
    originUrl = req.headers.origin ? new URL(req.headers.origin) : undefined;
  } catch {
    socket.destroy();
    return;
  }
  if (requestUrl.pathname !== '/ws' || !hasSession(req) || !originUrl
    || originUrl.host !== req.headers.host) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(req, socket, head, (webSocket) => {
    sockets.emit('connection', webSocket, req);
  });
});

sockets.on('connection', async (socket) => {
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    socket.close(1013, 'The browser is already in use.');
    return;
  }
  activeSocket = socket;
  for (const [id, firstChunk] of activeAudioStreams) {
    send(socket, { type: 'audio-start', id });
    if (firstChunk) sendAudioChunk(socket, id, firstChunk);
  }
  send(socket, { type: 'page', url: page.url(), title: await page.title().catch(() => '') });
  socket.on('message', (message) => {
    actionQueue = actionQueue
      .then(() => handleMessage(socket, message))
      .catch((error) => send(socket, { type: 'error', message: error.message || 'The browser action failed.' }));
  });
  socket.on('close', () => {
    if (activeSocket === socket) activeSocket = undefined;
  });
});

async function streamScreenshots() {
  if (activeSocket?.readyState === WebSocket.OPEN && activeSocket.bufferedAmount < 512 * 1024) {
    try {
      const image = await page.screenshot({
        type: 'jpeg',
        quality: 60,
        optimizeForSpeed: true,
      });
      activeSocket.send(Buffer.concat([Buffer.from([0]), image]), { binary: true });
    } catch (error) {
      if (activeSocket?.readyState === WebSocket.OPEN) {
        send(activeSocket, { type: 'error', message: `Page capture failed: ${error.message}` });
      }
    }
  }
  setTimeout(() => void streamScreenshots(), FRAME_INTERVAL_MS).unref();
}

async function start() {
  const executablePath = findChromium();
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-extensions',
      '--disable-sync',
      '--disable-default-apps',
      '--renderer-process-limit=1',
      '--autoplay-policy=no-user-gesture-required',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    ],
  });
  page = await browser.newPage();
  await page.setViewport({ ...VIEWPORT, deviceScaleFactor: 1 });
  await page.exposeFunction('__remoteAudioStart', (id) => {
    activeAudioStreams.set(id, undefined);
    send(activeSocket, { type: 'audio-start', id });
  });
  await page.exposeFunction('__remoteAudioStop', (id) => {
    activeAudioStreams.delete(id);
    send(activeSocket, { type: 'audio-stop', id });
  });
  await page.exposeFunction('__remoteAudioChunk', (id, dataUrl) => {
    if (!activeAudioStreams.has(id) || typeof dataUrl !== 'string') return;
    const comma = dataUrl.indexOf(',');
    if (comma < 0 || !Number.isInteger(id) || id < 1 || id > 0xffffffff) return;
    const encoded = dataUrl.slice(comma + 1);
    const chunk = Buffer.from(encoded, 'base64');
    if (!chunk.length || chunk.length > 256 * 1024) return;
    if (activeAudioStreams.get(id) === undefined) activeAudioStreams.set(id, chunk);
    sendAudioChunk(activeSocket, id, chunk);
  });
  await page.evaluateOnNewDocument(() => {
    const mimeType = 'audio/webm;codecs=opus';
    const streams = new WeakMap();
    let nextStreamId = crypto.getRandomValues(new Uint32Array(1))[0];

    function startRecording(stream) {
      if (stream.recording || !stream.mediaStream.getAudioTracks().length) return;
      if (!MediaRecorder.isTypeSupported(mimeType)) return;
      const id = ++nextStreamId;
      const recorder = new MediaRecorder(
        new MediaStream(stream.mediaStream.getAudioTracks()),
        { mimeType },
      );
      stream.recording = true;
      stream.recorder = recorder;
      window.__remoteAudioStart(id);
      let pendingChunks = Promise.resolve();
      recorder.addEventListener('dataavailable', (event) => {
        if (!event.data.size) return;
        pendingChunks = pendingChunks.then(() => new Promise((resolve) => {
          const reader = new FileReader();
          reader.addEventListener('load', () => {
            Promise.resolve(window.__remoteAudioChunk(id, reader.result)).then(resolve, resolve);
          }, { once: true });
          reader.addEventListener('error', resolve, { once: true });
          reader.readAsDataURL(event.data);
        }));
      });
      recorder.addEventListener('stop', () => {
        pendingChunks.then(() => window.__remoteAudioStop(id));
      }, { once: true });
      recorder.start(250);
    }

    document.addEventListener('play', (event) => {
      const element = event.target;
      if (!(element instanceof HTMLMediaElement) || streams.has(element)) return;
      if (typeof element.captureStream !== 'function') return;
      try {
        const mediaStream = element.captureStream();
        const stream = { mediaStream, recording: false };
        streams.set(element, stream);
        startRecording(stream);
        mediaStream.addEventListener('addtrack', () => startRecording(stream));
        element.addEventListener('ended', () => {
          if (stream.recorder && stream.recorder.state !== 'inactive') stream.recorder.stop();
        }, { once: true });
      } catch {
        // Some protected or DRM-backed media cannot expose a capture stream.
      }
    }, true);
  });
  await page.goto('about:blank');
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Remote browser listening on port ${PORT}`);
  });
  void streamScreenshots();
}

async function shutdown() {
  server.close();
  if (browser) await browser.close();
}

if (require.main === module) {
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());

  start().catch((error) => {
    console.error('Failed to start remote browser:', error);
    process.exitCode = 1;
  });
}

module.exports = { app, server, validateDestination, isPublicAddress };
