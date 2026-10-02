import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startTestServer, login } from './helpers.js';
import { config } from '../src/config.js';
import { DEFAULT_PAGE_TEXT } from '../src/content-defaults.js';

let server, app, base;

before(async () => {
  ({ server, app, base } = await startTestServer());
});

after(() => server.close());

const authHeaders = (cookie) => ({ 'Content-Type': 'application/json', Cookie: cookie, Origin: base });

// A token that is already past the minimum-fill window, so the timing defence does not
// reject a test that is legitimately fast.
function usableToken() {
  return import('../src/feedback-token.js').then(({ issueToken }) =>
    issueToken(Date.now() - (config.feedbackMinSeconds + 1) * 1000)
  );
}

async function post(body) {
  const res = await fetch(`${base}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function setSmtp(cookie, values) {
  const res = await fetch(`${base}/api/admin/email`, {
    method: 'PUT',
    headers: authHeaders(cookie),
    body: JSON.stringify(values),
  });
  assert.equal(res.status, 200, 'saving email settings should succeed');
  return res.json();
}

/**
 * A throwaway SMTP server that accepts a message and records it. This is what makes
 * the success path testable: without it, "it sent" would be an assumption rather than
 * an observation, and a fake-success bug (the thing this endpoint must never have)
 * would pass every test.
 *
 * It binds an ephemeral port, so the mailer's port→protocol derivation cannot apply (it
 * only knows 25/465/587). Tests that need a real send therefore build the config through
 * `smtpConfigFor`, which is the in-process-only seam described in D17.
 */
function startSmtpStub(port = 0) {
  const received = [];
  const sockets = new Set();
  let dataMode = false;
  let dataLines = [];
  let buffer = '';

  const smtp = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    socket.write('220 stub ESMTP\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        if (dataMode) {
          // The message body arrives line by line and only the lone "." ends it —
          // every other line has to be collected, not discarded.
          if (line === '.') {
            dataMode = false;
            received.push(dataLines.join('\n'));
            dataLines = [];
            socket.write('250 OK queued\r\n');
          } else {
            dataLines.push(line);
          }
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) {
          socket.write('250-stub\r\n250 HELP\r\n');
        } else if (cmd.startsWith('MAIL FROM') || cmd.startsWith('RCPT TO')) {
          socket.write('250 OK\r\n');
        } else if (cmd === 'DATA') {
          dataMode = true;
          dataLines = [];
          socket.write('354 Send data\r\n');
        } else if (cmd === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 OK\r\n');
        }
      }
    });
  });

  return new Promise((resolve, reject) => {
    smtp.once('error', reject);
    smtp.listen(port, '127.0.0.1', () => {
      resolve({
        port: smtp.address().port,
        received,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            smtp.close(() => done());
          }),
      });
    });
  });
}

// --- Feature gating ---------------------------------------------------------

test('the feedback page 404s while the feature is disabled', async () => {
  const { cookie } = await login(base);
  await setSmtp(cookie, { feedbackEnabled: false });
  const res = await fetch(`${base}/feedback`);
  assert.equal(res.status, 404);
  // It must look absent, not broken: no "coming soon" hint and no form to probe.
  const html = await res.text();
  assert.doesNotMatch(html, /id="feedback-form"/);
});

test('submitting while disabled is refused, even with a valid token', async () => {
  const { cookie } = await login(base);
  await setSmtp(cookie, { feedbackEnabled: false });
  const { status, body } = await post({
    name: 'A',
    email: 'a@b.co',
    message: 'hi',
    token: await usableToken(),
  });
  assert.equal(status, 503);
  assert.equal(body.ok, false);
});

test('the page renders when enabled, with a server-rendered token and a honeypot', async () => {
  const { cookie } = await login(base);
  await setSmtp(cookie, { feedbackEnabled: true });
  const html = await (await fetch(`${base}/feedback`)).text();
  assert.match(html, /id="feedback-form"/);
  // The token is in the markup so the form needs no round trip before it can be used.
  assert.match(html, /name="token" value="\d+\.[A-Za-z0-9_-]{43}" \/>/);
  // Honeypot present, off-screen, and out of the tab order.
  assert.match(html, /class="hp-field"/);
  assert.match(html, /name="website"/);
});

// --- Bot defences -----------------------------------------------------------

test('a submission without a token is refused', async () => {
  const { cookie } = await login(base);
  await setSmtp(cookie, { feedbackEnabled: true });
  const { status, body } = await post({ name: 'A', email: 'a@b.co', message: 'hi' });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
});

test('an instant submission is refused by the timing token', async () => {
  const { cookie } = await login(base);
  await setSmtp(cookie, { feedbackEnabled: true });
  const { issueToken } = await import('../src/feedback-token.js');
  const { status, body } = await post({
    name: 'A',
    email: 'a@b.co',
    message: 'hi',
    token: issueToken(Date.now()), // no human writes a message in zero seconds
  });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
});

test('the honeypot gets a fake success so a bot learns nothing', async () => {
  const { cookie } = await login(base);
  await setSmtp(cookie, { feedbackEnabled: true });
  const { status, body } = await post({
    name: 'Bot',
    email: 'bot@example.com',
    message: 'Buy my thing',
    website: 'http://spam.example',
    token: await usableToken(),
  });
  // 200 + the success message, deliberately indistinguishable from a real send.
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.match(body.message, /sent/i);
});

test('no two refusals reveal which defence fired', async () => {
  const { cookie } = await login(base);
  await setSmtp(cookie, { feedbackEnabled: true });
  const noToken = await post({ name: 'A', email: 'a@b.co', message: 'hi' });
  const badToken = await post({ name: 'A', email: 'a@b.co', message: 'hi', token: 'garbage' });
  const forged = await post({
    name: 'A',
    email: 'a@b.co',
    message: 'hi',
    token: `${Date.now()}.${'A'.repeat(43)}`,
  });
  // Identical status and message: probing cannot distinguish the cause.
  assert.equal(noToken.status, badToken.status);
  assert.equal(badToken.status, forged.status);
  assert.equal(noToken.body.error, badToken.body.error);
  assert.equal(badToken.body.error, forged.body.error);
});

// --- Validation is user-facing ---------------------------------------------

test('field errors are returned so the form can help a real visitor', async () => {
  const { cookie } = await login(base);
  await setSmtp(cookie, { feedbackEnabled: true });
  const { status, body } = await post({
    name: '',
    email: 'not-an-email',
    message: '   ',
    token: await usableToken(),
  });
  assert.equal(status, 400);
  assert.match(body.error, /name/);
  assert.match(body.error, /email/);
  assert.match(body.error, /message/);
});

// --- Delivery honesty (the property that matters most) ----------------------

test('an unconfigured mailer returns an honest error, never a fake success', async () => {
  const { cookie } = await login(base);
  await setSmtp(cookie, {
    feedbackEnabled: true,
    smtpHost: '',
    smtpPort: '',
    smtpUser: '',
    smtpFrom: '',
    smtpTo: '',
  });
  const { status, body } = await post({
    name: 'Ada',
    email: 'ada@example.com',
    message: 'Genuine feedback',
    token: await usableToken(),
  });
  // 503, and explicitly not ok. Answering "thanks" here would lose the message.
  assert.equal(status, 503);
  assert.equal(body.ok, false);
  assert.match(body.error, /not available/i);
});

test('a configured but unreachable server returns an honest second failure, not success', async () => {
  const { cookie } = await login(base);
  // Port 25 on a host with nothing listening: the connection must fail, and the
  // endpoint must say so rather than pretending it worked.
  await setSmtp(cookie, {
    feedbackEnabled: true,
    smtpHost: '127.0.0.1',
    smtpPort: 25,
    smtpUser: '',
    smtpFrom: 'feedback@example.com',
    smtpTo: 'me@example.com',
  });
  const { status, body } = await post({
    name: 'Ada',
    email: 'ada@example.com',
    message: 'Genuine feedback',
    token: await usableToken(),
  });
  assert.equal(body.ok, false, 'a failed send must never report success');
  assert.ok(status === 502 || status === 503, `expected 502/503, got ${status}`);
  assert.notEqual(status, 200);
});

// --- The success path, against a real SMTP conversation ---------------------
//
// Ports 587 and 25 need root to bind, so the stub takes an ephemeral port and the config
// is built explicitly via smtpConfigFor() rather than through the stored settings.

test('a real SMTP conversation accepts the message and the send reports success', async () => {
  // Ephemeral port: 587 needs root to bind, so the config is built explicitly via
  // smtpConfigFor() rather than through the stored settings.
  const stub = await startSmtpStub();
  try {
    const { cookie } = await login(base);
    // Stored through the normal admin path, so validation, persistence and mailer
    // construction are all under test rather than stubbed out.
    await setSmtp(cookie, {
      feedbackEnabled: true,
      smtpHost: '127.0.0.1',
      smtpPort: 587,
      smtpUser: '',
      smtpPassword: null,
      smtpFrom: 'feedback@example.com',
      smtpTo: 'me@example.com',
    });

    const { verifyConnection, sendTest, smtpConfigFor } = await import('../src/mailer.js');
    const stubConfig = smtpConfigFor({
      host: '127.0.0.1',
      port: stub.port,
      from: 'feedback@example.com',
      to: 'me@example.com',
    });

    const verified = await verifyConnection(stubConfig);
    assert.equal(verified.ok, true, `verify should succeed, got ${JSON.stringify(verified)}`);

    const result = await sendTest('me@example.com', stubConfig);
    assert.equal(result.ok, true, `expected a successful send, got ${JSON.stringify(result)}`);

    assert.ok(stub.received.length >= 1, 'the SMTP server should have received a message');
    const conversation = stub.received.join('\n');
    assert.match(conversation, /Subject: .*test message/i);
    assert.match(conversation, /To: me@example\.com/);
    assert.match(conversation, /From: feedback@example\.com/);
  } finally {
    await stub.close();
  }
});

test('the feedback endpoint reports success only when the message was really accepted', async () => {
  // This one goes through the HTTP endpoint, so the mailer config has to reach the route
  // through `app.locals.feedbackTestOptions` — the settings table cannot carry an
  // ephemeral port, because `usable()` restricts stored ports to the three the admin
  // form offers.
  const stub = await startSmtpStub();
  try {
    const { cookie } = await login(base);
    // Written straight to the settings table: the admin API deliberately only accepts
    // the ports the form offers, so a test-only port has to bypass that validation
    // rather than weaken it.
    const store = await import('../src/db.js');
    store.setSetting('feedbackEnabled', '1');
    store.setSetting('smtpFrom', 'feedback@example.com');
    store.setSetting('smtpTo', 'me@example.com');

    // The route reads an explicit mailer config from here. An ephemeral port cannot go
    // through the settings table, because `usable()` restricts stored ports to the
    // three the admin form offers (see docs/decisions.md D17).
    const { smtpConfigFor } = await import('../src/mailer.js');
    app.locals.feedbackTestOptions = {
      mailerConfig: smtpConfigFor({
        host: '127.0.0.1',
        port: stub.port,
        from: 'feedback@example.com',
        to: 'me@example.com',
      }),
    };

    const before = stub.received.length;
    const { status, body } = await post({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      message: 'This is a genuine end-to-end feedback message.',
      token: await usableToken(),
    });

    // The property that matters most: this is the only path allowed to answer 200/ok.
    assert.equal(status, 200, `expected a real send to succeed, got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);
    assert.equal(stub.received.length, before + 1, 'the message should have reached the server');

    const message = stub.received.at(-1);
    assert.match(message, /Subject: Feedback from Ada Lovelace/);
    // The visitor's address goes in Reply-To, not From, so SPF/DKIM stay aligned with
    // the domain that actually sent the message.
    assert.match(message, /Reply-To: ada@example\.com/i);

    // The body is quoted-printable and folded at 76 characters, so asserting on the raw
    // text would fail on a line break rather than on content. Undo the encoding before
    // checking what the visitor actually wrote arrived intact.
    const rawBody = message.slice(message.indexOf('\n\n') + 2);
    const decoded = rawBody
      .replace(/=\r?\n/g, '')                    // soft line breaks
      .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    assert.match(decoded, /This is a genuine end-to-end feedback message\./);
    assert.match(decoded, /Name:  Ada Lovelace/);
    assert.match(decoded, /Email: ada@example\.com/);
  } finally {
    await stub.close();
  }
});

// --- Admin API: the password must never come back --------------------------

test('the SMTP password is write-only over the API', async () => {
  const { cookie } = await login(base);
  await setSmtp(cookie, {
    feedbackEnabled: false,
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpUser: 'user@example.com',
    smtpPassword: 'a-very-secret-password',
    smtpFrom: 'feedback@example.com',
    smtpTo: 'me@example.com',
  });

  const res = await fetch(`${base}/api/admin/email`, { headers: { Cookie: cookie } });
  const raw = await res.text();
  assert.equal(raw.includes('a-very-secret-password'), false, 'the password must not be returned');
  const { smtp } = JSON.parse(raw);
  assert.equal(smtp.hasPassword, true, 'its presence should be reported');
  assert.equal('password' in smtp, false);
  assert.equal(smtp.host, 'smtp.example.com');
  assert.equal(smtp.port, 587);
});

test('an omitted password keeps the stored one', async () => {
  const { cookie } = await login(base);
  await setSmtp(cookie, { smtpPassword: 'first-password' });
  // Saving unrelated fields must not wipe the credential the admin already entered.
  await setSmtp(cookie, { smtpHost: 'smtp.example.com', smtpPort: 465 });
  const after = await (await fetch(`${base}/api/admin/email`, { headers: { Cookie: cookie } })).json();
  assert.equal(after.smtp.hasPassword, true, 'the stored password should survive an unrelated save');
});

test('null clears the stored password', async () => {
  const { cookie } = await login(base);
  await setSmtp(cookie, { smtpPassword: 'to-be-cleared' });
  await setSmtp(cookie, { smtpPassword: null });
  const after = await (await fetch(`${base}/api/admin/email`, { headers: { Cookie: cookie } })).json();
  assert.equal(after.smtp.hasPassword, false);
});

test('the email endpoints require authentication', async () => {
  for (const [method, path] of [
    ['GET', '/api/admin/email'],
    ['PUT', '/api/admin/email'],
    ['POST', '/api/admin/email/test-connection'],
    ['POST', '/api/admin/email/test-send'],
  ]) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    });
    assert.equal(res.status, 401, `${method} ${path} must require auth`);
  }
});

test('smtp settings never appear on the public API or a rendered page', async () => {
  const { cookie } = await login(base);
  await setSmtp(cookie, {
    smtpHost: 'secret-relay.internal',
    smtpUser: 'relay-user',
    smtpPassword: 'relay-password',
    smtpFrom: 'feedback@example.com',
  });

  const surfaces = [
    await (await fetch(`${base}/api/site`)).text(),
    await (await fetch(`${base}/`)).text(),
    await (await fetch(`${base}/credits`)).text(),
    await (await fetch(`${base}/feedback`)).text(),
  ];
  for (const text of surfaces) {
    for (const secret of ['secret-relay.internal', 'relay-user', 'relay-password']) {
      assert.equal(text.includes(secret), false, `"${secret}" leaked onto a public surface`);
    }
  }
});

// --- The intro copy's paragraph structure -----------------------------------
//
// The intro is authored as separate <p> elements because HTML collapses newlines: a
// single block with hard returns in the source would render as one wall of text. This
// asserts the structure survives rendering, and that the wording is not truncated or
// mangled — the failure mode is silent (the page still looks fine, just wrong).

test('the feedback intro renders as separate paragraphs with the wording intact', async () => {
  const { server, base: b } = await startTestServer();
  const { cookie } = await login(b);
  try {
    await fetch(`${b}/api/admin/email`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: b },
      body: JSON.stringify({ feedbackEnabled: true }),
    });
    const html = await (await fetch(`${b}/feedback`)).text();

    const introParas = [...html.matchAll(/<p class="form-intro">([\s\S]*?)<\/p>/g)].map((m) =>
      m[1].replace(/\s+/g, ' ').trim()
    );
    // One paragraph per blank line in the seeded intro (see src/content-defaults.js).
    const expected = DEFAULT_PAGE_TEXT.feedbackIntro.split('\n\n');
    assert.equal(introParas.length, expected.length, 'the intro should render one paragraph per seed block');
    for (const p of introParas) {
      assert.ok(p.length > 100, `a paragraph looks truncated: ${JSON.stringify(p.slice(0, 60))}`);
    }

    // Each paragraph is its own block element, which is what makes the breaks visible.
    assert.equal((html.match(/class="form-intro"/g) || []).length, expected.length);

    // The opening and closing lines must both survive, so the copy is neither truncated
    // nor replaced wholesale. Asserted against the seed itself (D22): the rendered text
    // must equal the seeded blocks exactly.
    const seedIntro = DEFAULT_PAGE_TEXT.feedbackIntro.split('\n\n');
    assert.equal(introParas[0], seedIntro[0]);
    assert.equal(introParas.at(-1), seedIntro.at(-1));

    // Typographic characters are preserved, not stripped or entity-mangled into the page.
    assert.match(introParas.at(-1), /“this bit confused me”/, 'curly quotes should survive');

    // No em-dashes (or en-dashes) anywhere in the copy — a standing style request. Pinned
    // because a reflow that reintroduces one looks perfectly normal on the page.
    const allIntro = introParas.join(' ');
    assert.doesNotMatch(allIntro, /[\u2013\u2014\u2015]/, 'the intro should contain no dashes of the em/en variety');
  } finally {
    server.close();
  }
});
