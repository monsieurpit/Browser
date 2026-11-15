# Railway Remote Browser

A password-protected, single-session browser. Chromium runs on Railway; the
website is rendered there and its screen is streamed to the browser UI. Mouse,
keyboard, and scroll input are sent back to Chromium. The browser supports
normal interactive CAPTCHA challenges, but does not bypass or automatically
solve them.

## Deploy to Railway

1. Deploy this repository using Railpack. The checked-in `railpack.json`
   installs Chromium into the runtime image.
2. Set `BROWSER_PASSWORD` to a unique password. If unset, the initial password
   is `Cacademarde2.0`.
3. Set `NODE_ENV=production` so the authentication cookie is marked Secure.
   Railway's HTTPS endpoint is required in production.
4. Set the Railway service resource limits to **1 GB memory** and **2 vCPU**.

Railway supplies `PORT`; the app listens on that port and exposes `/health` for
the configured deployment health check. `CHROMIUM_PATH` can override the
Chromium executable path if the package installs it somewhere other than
`/usr/bin/chromium`.

The app runs one Chromium page and permits one connected browser window at a
time. Browser cookies and site storage live in that Railway Chromium process;
they are not copied to the visitor's device and are lost when the service
restarts. The screen is streamed as optimized JPEG images at up to about 12
frames per second. This is suitable for browsing and video, but is not
equivalent to a local 30/60 FPS browser and actual frame rate depends on page
complexity and Railway CPU load.

Audio from standard HTML audio/video elements is streamed separately. Click
**Enable audio** in the browser toolbar to hear it; the in-page audio controls
allow volume adjustment. Protected/DRM media and audio produced outside media
elements may not be capturable. This single-page, single-session setup limits
Chromium to one renderer and is tuned for the configured 1 GB memory and 2
vCPU Railway service; actual resource use still depends on the website being
opened.

## Local development

Install Node.js 22.12+ and Chromium, then run:

```sh
npm install
BROWSER_PASSWORD='Cacademarde2.0' CHROMIUM_PATH=/path/to/chromium npm start
```

Open `http://localhost:3000`. For production, override the default password and
use Railway HTTPS.
