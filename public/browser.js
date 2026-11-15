(() => {
  const screen = document.querySelector('#screen');
  const wrap = document.querySelector('.screen-wrap');
  const address = document.querySelector('#address');
  const statusText = document.querySelector('#status-text');
  const statusDot = document.querySelector('#status-dot');
  const placeholder = document.querySelector('#screen-placeholder');
  const toast = document.querySelector('#toast');
  const audioToggle = document.querySelector('#audio-toggle');
  const audioOutput = document.querySelector('#audio-output');
  const audioStreams = new Map();
  const audioMimeType = 'audio/webm;codecs=opus';
  let audioEnabled = false;
  let socket;
  let currentObjectUrl;
  let toastTimer;
  let lastTouchY;
  let pendingScroll;
  let scrollTimer;
  let pendingMove;
  let moveScheduled = false;

  function showError(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 4500);
  }

  function send(message) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function updateCoordinates(event) {
    const bounds = screen.getBoundingClientRect();
    const scale = Math.min(bounds.width / 1024, bounds.height / 640);
    const width = 1024 * scale;
    const height = 640 * scale;
    const left = bounds.left + (bounds.width - width) / 2;
    const top = bounds.top + (bounds.height - height) / 2;
    return {
      x: Math.max(0, Math.min(1023, (event.clientX - left) / scale)),
      y: Math.max(0, Math.min(639, (event.clientY - top) / scale)),
    };
  }

  function removeAudio(id, state) {
    if (state.audio) {
      state.audio.pause();
      state.audio.removeAttribute('src');
      state.audio.load();
      state.audio.remove();
    }
    URL.revokeObjectURL(state.objectUrl);
    audioStreams.delete(id);
  }

  function pumpAudio(state) {
    const sourceBuffer = state.sourceBuffer;
    if (!sourceBuffer || sourceBuffer.updating) return;
    if (state.audio.currentTime > 30 && sourceBuffer.buffered.length
      && sourceBuffer.buffered.start(0) < state.audio.currentTime - 15) {
      sourceBuffer.remove(0, state.audio.currentTime - 15);
      return;
    }
    const chunk = state.chunks.shift();
    if (chunk) {
      try {
        sourceBuffer.appendBuffer(chunk);
      } catch {
        showError('Audio playback could not keep up. Try reloading the page.');
      }
    } else if (state.stopped && state.mediaSource.readyState === 'open') {
      try {
        state.mediaSource.endOfStream();
      } catch {
        showError('The remote audio stream ended unexpectedly.');
      }
    }
  }

  function startAudio(id) {
    if (audioStreams.has(id)) return;
    if (!window.MediaSource || !MediaSource.isTypeSupported(audioMimeType)) {
      showError('This browser does not support streamed audio playback.');
      return;
    }
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.autoplay = true;
    audio.muted = !audioEnabled;
    audio.setAttribute('aria-label', 'Remote page audio');
    const mediaSource = new MediaSource();
    const state = {
      audio,
      mediaSource,
      sourceBuffer: null,
      chunks: [],
      stopped: false,
      objectUrl: URL.createObjectURL(mediaSource),
    };
    audioStreams.set(id, state);
    audioOutput.append(audio);
    audio.src = state.objectUrl;
    audio.addEventListener('ended', () => removeAudio(id, state), { once: true });
    mediaSource.addEventListener('sourceopen', () => {
      if (audioStreams.get(id) !== state) return;
      try {
        state.sourceBuffer = mediaSource.addSourceBuffer(audioMimeType);
        state.sourceBuffer.mode = 'sequence';
        state.sourceBuffer.addEventListener('updateend', () => pumpAudio(state));
        pumpAudio(state);
        audio.play().catch(() => {
          if (audioEnabled) showError('Audio playback was blocked. Use the audio button and try again.');
        });
      } catch {
        showError('Audio playback could not be started.');
        removeAudio(id, state);
      }
    }, { once: true });
  }

  function resetAudio() {
    for (const [id, state] of audioStreams) removeAudio(id, state);
    audioOutput.replaceChildren();
  }

  audioToggle.addEventListener('click', () => {
    audioEnabled = !audioEnabled;
    audioToggle.textContent = audioEnabled ? 'Mute audio' : 'Enable audio';
    for (const state of audioStreams.values()) {
      state.audio.muted = !audioEnabled;
      if (audioEnabled) {
        state.audio.play().catch(() => showError('Audio playback was blocked by the browser.'));
      }
    }
  });

  function queueScroll(event, deltaX, deltaY) {
    const point = updateCoordinates(event);
    pendingScroll = {
      ...point,
      deltaX: Math.max(-1200, Math.min(1200, (pendingScroll?.deltaX || 0) + deltaX)),
      deltaY: Math.max(-1200, Math.min(1200, (pendingScroll?.deltaY || 0) + deltaY)),
    };
    if (!scrollTimer) {
      scrollTimer = setTimeout(() => {
        send({ type: 'scroll', ...pendingScroll });
        pendingScroll = undefined;
        scrollTimer = undefined;
      }, 20);
    }
  }

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/ws`);
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => {
      statusText.textContent = 'Connected to Railway Chromium';
      statusDot.classList.add('online');
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        const bytes = new Uint8Array(event.data);
        if (bytes.length < 1) return;
        if (bytes[0] === 0) {
          const nextUrl = URL.createObjectURL(new Blob([bytes.subarray(1)], { type: 'image/jpeg' }));
          screen.src = nextUrl;
          if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
          currentObjectUrl = nextUrl;
          placeholder.hidden = true;
        } else if (bytes[0] === 1 && bytes.length > 5) {
          const id = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1);
          const state = audioStreams.get(id);
          if (state) {
            state.chunks.push(bytes.slice(5).buffer);
            pumpAudio(state);
          }
        }
        return;
      }
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data.type === 'page') {
        if (data.url && data.url !== 'about:blank') address.value = data.url;
        statusText.textContent = data.title || data.url || 'Ready';
      } else if (data.type === 'audio-start') {
        startAudio(data.id);
      } else if (data.type === 'audio-stop') {
        const state = audioStreams.get(data.id);
        if (state) {
          state.stopped = true;
          pumpAudio(state);
        }
      } else if (data.type === 'audio-reset') {
        resetAudio();
      } else if (data.type === 'error') {
        showError(data.message);
      }
    });
    socket.addEventListener('close', (event) => {
      statusDot.classList.remove('online');
      statusText.textContent = event.code === 1013
        ? 'Browser is already in use in another window'
        : 'Disconnected — reconnecting…';
      if (event.code !== 1013 && event.code !== 1000) setTimeout(connect, 2000);
    });
    socket.addEventListener('error', () => socket.close());
  }

  document.querySelector('#address-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = address.value.trim();
    if (!value) return;
    const destination = value.includes(' ') && !value.includes('://')
      ? `https://www.google.com/search?q=${encodeURIComponent(value)}`
      : value;
    send({ type: 'navigate', url: destination });
    screen.focus();
  });
  document.querySelector('#back').addEventListener('click', () => send({ type: 'back' }));
  document.querySelector('#forward').addEventListener('click', () => send({ type: 'forward' }));
  document.querySelector('#reload').addEventListener('click', () => send({ type: 'reload' }));
  document.querySelector('#logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.assign('/login');
  });

  screen.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    screen.focus();
    send({ type: 'click', ...updateCoordinates(event), clickCount: event.detail === 2 ? 2 : 1 });
  });
  screen.addEventListener('mousemove', (event) => {
    pendingMove = updateCoordinates(event);
    if (!moveScheduled) {
      moveScheduled = true;
      requestAnimationFrame(() => {
        moveScheduled = false;
        if (pendingMove) send({ type: 'move', ...pendingMove });
        pendingMove = undefined;
      });
    }
  });
  screen.addEventListener('wheel', (event) => {
    event.preventDefault();
    queueScroll(event, event.deltaX, event.deltaY);
  }, { passive: false });
  screen.addEventListener('contextmenu', (event) => event.preventDefault());
  screen.addEventListener('keydown', (event) => {
    if (event.target !== screen) return;
    event.preventDefault();
    send({ type: 'keyDown', key: event.key });
  });
  screen.addEventListener('keyup', (event) => {
    if (event.target !== screen) return;
    event.preventDefault();
    send({ type: 'keyUp', key: event.key });
  });
  screen.addEventListener('blur', () => {
    for (const key of ['Shift', 'Control', 'Alt', 'Meta']) send({ type: 'keyUp', key });
  });
  wrap.addEventListener('touchstart', (event) => {
    const touch = event.touches[0];
    if (touch) {
      lastTouchY = touch.clientY;
      const point = updateCoordinates(touch);
      send({ type: 'click', ...point });
    }
  }, { passive: true });
  wrap.addEventListener('touchmove', (event) => {
    event.preventDefault();
    const touch = event.touches[0];
    if (touch) {
      const deltaY = lastTouchY === undefined ? 0 : lastTouchY - touch.clientY;
      lastTouchY = touch.clientY;
      queueScroll(touch, 0, deltaY);
    }
  }, { passive: false });

  connect();
})();
