const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

const password = process.env.BROWSER_PASSWORD || 'Cacademarde2.0';
const { server } = require('../server');
let origin;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('browser page requires a valid session', async () => {
  const response = await fetch(`${origin}/app/`);
  assert.equal(response.status, 401);
});

test('login grants access to the browser page', async () => {
  const denied = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'not-the-password' }),
  });
  assert.equal(denied.status, 401);

  const login = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie);

  const page = await fetch(`${origin}/app/`, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Remote Chromium page/);
});
