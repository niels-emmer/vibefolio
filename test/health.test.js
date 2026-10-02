import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// config.js reads env at import; set env before dynamically importing it.
process.env.ADMIN_PASSWORD = 'test-password';
process.env.DB_PATH = ':memory:';
const { isPrivateAddress, checkUrl, assertPublicHost } = await import('../src/health.js');

// --- isPrivateAddress unit tests ------------------------------------------

test('isPrivateAddress blocks IPv4 private ranges', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '0.0.0.0', '100.64.0.1', '224.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, `expected ${ip} private`);
  }
});

test('isPrivateAddress allows public IPv4', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '192.169.0.1']) {
    assert.equal(isPrivateAddress(ip), false, `expected ${ip} public`);
  }
});

test('isPrivateAddress blocks IPv6 private/loopback/link-local', () => {
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:192.168.1.1']) {
    assert.equal(isPrivateAddress(ip), true, `expected ${ip} private`);
  }
});

test('isPrivateAddress blocks hex-encoded IPv4-mapped/compatible IPv6', () => {
  // ::ffff:7f00:1 == 127.0.0.1, ::ffff:c0a8:101 == 192.168.1.1, etc.
  for (const ip of [
    '::ffff:7f00:1', // 127.0.0.1
    '::ffff:c0a8:101', // 192.168.1.1
    '::ffff:a00:1', // 10.0.0.1
    '::7f00:1', // IPv4-compatible 127.0.0.1
    '0:0:0:0:0:ffff:7f00:1', // fully expanded mapped
    '0:0:0:0:0:0:7f00:1', // fully expanded compatible
    '::ffff:127.0.0.1',
    '::127.0.0.1',
    '2002:7f00:1::', // 6to4 embeds 127.0.0.1
    '2001:0000:4136:e378:8000:63bf:3fff:fdd2', // Teredo
  ]) {
    assert.equal(isPrivateAddress(ip), true, `expected ${ip} private`);
  }
});

test('isPrivateAddress allows public IPv6 and public mapped IPv4', () => {
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '::ffff:808:808']) {
    assert.equal(isPrivateAddress(ip), false, `expected ${ip} public`);
  }
});

// --- checkUrl behaviour against a local mock server ------------------------

let server, base;
const routes = {
  '/up': 200,
  '/down': 500,
  '/missing': 404,
  '/notallowed': 405,
};

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/up' });
      return res.end();
    }
    if (req.url === '/methodhead') {
      // HEAD rejected, GET accepted.
      if (req.method === 'HEAD') {
        res.writeHead(403);
        return res.end();
      }
      res.writeHead(200);
      return res.end('ok');
    }
    const status = routes[req.url];
    if (status === undefined) { res.writeHead(404); return res.end(); }
    res.writeHead(status);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const opts = { allowPrivate: true }; // allow loopback in tests

test('checkUrl returns up for 2xx', async () => {
  const r = await checkUrl(`${base}/up`, 3000, opts);
  assert.equal(r.status, 'up');
});

test('checkUrl returns down for 5xx', async () => {
  const r = await checkUrl(`${base}/down`, 3000, opts);
  assert.equal(r.status, 'down');
});

test('checkUrl follows a redirect', async () => {
  const r = await checkUrl(`${base}/redirect`, 3000, opts);
  assert.equal(r.status, 'up');
});

test('checkUrl falls back HEAD->GET on 403', async () => {
  const r = await checkUrl(`${base}/methodhead`, 3000, opts);
  assert.equal(r.status, 'up');
});

test('checkUrl marks a private host unknown when SSRF protection is on', async () => {
  const r = await checkUrl(`${base}/up`, 3000, { allowPrivate: false });
  assert.equal(r.status, 'unknown');
});

test('assertPublicHost throws for a private host when not allowed', async () => {
  await assert.rejects(assertPublicHost(new URL('http://169.254.169.254/'), false));
  await assert.rejects(assertPublicHost(new URL('http://localhost:1/'), false));
});

test('checkUrl returns down on a network error (connection refused)', async () => {
  // Port 1 is almost never listening → ECONNREFUSED.
  const r = await checkUrl('http://127.0.0.1:1/', 3000, opts);
  assert.equal(r.status, 'down');
});
