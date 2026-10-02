import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import './helpers.js';
import { startTestServer, login } from './helpers.js';
import { buildFeedbackEmail, sendFeedback, sendConcurrency, smtpConfigFor } from '../src/mailer.js';
import { fieldsThisSaveWouldClear } from '../public/js/email-config.js';

// `sendFeedback` reads the settings table even when handed an explicit config (it needs
// the stored sender/recipient as fallbacks), so the DB has to exist. Starting a throwaway
// server is the cheapest way to get a migrated in-memory DB.
let testServer;
before(async () => {
  ({ server: testServer } = await startTestServer());
});
after(() => testServer?.close());

// --- Audit fixes (regression guards) ---------------------------------------
//
// Each of these pins a fix for a finding from the security audit, so the specific
// mistake cannot come back unnoticed.

test('NUL and C0 controls are stripped from header-bound values', () => {
  // Header injection needs CR/LF, which was already handled. NUL and the other C0
  // controls are a different class: JS `\s` does not match NUL, so it survived into
  // the header block and produced malformed MIME downstream.
  const { subject, body } = buildFeedbackEmail({
    name: 'Ada\u0000Lovelace\u0007',
    email: 'a@b.co',
    message: 'hi',
  });
  assert.equal(subject.includes('\u0000'), false, 'NUL must not reach the subject');
  assert.equal(subject.includes('\u0007'), false, 'BEL must not reach the subject');
  assert.equal(body.includes('\u0000'), false, 'NUL must not reach the body');
  assert.match(subject, /Ada Lovelace/, 'the visible text should survive, minus the control');
});

test('only newlines remain in the body — no other control characters', () => {
  const { body } = buildFeedbackEmail({ name: 'A\u0000B', email: 'a@b.co', message: 'x\u0007y' });
  // U+000A is the body's line separator and is expected. Anything else would be a
  // control character that survived stripping.
  const others = [...body].filter((c) => {
    const code = c.charCodeAt(0);
    return code < 32 && c !== '\n';
  });
  assert.deepEqual(others, [], `unexpected control characters: ${others.map((c) => c.charCodeAt(0)).join(', ')}`);
});

test('control characters cannot reach a header line', () => {
  // The specific finding: header-bound values must carry no C0 control at all.
  const { subject } = buildFeedbackEmail({ name: 'Ada\u0000\u0007Lovelace', email: 'a@b.co', message: 'hi' });
  const controls = [...subject].filter((c) => c.charCodeAt(0) < 32);
  assert.deepEqual(controls, [], 'the subject must be free of control characters');

  // And the address echoed into the body is emitted through the same function.
  const { body } = buildFeedbackEmail({ name: 'A', email: 'a\u0000@b.co', message: 'hi' });
  const emailLine = body.split('\n').find((l) => l.startsWith('Email:'));
  assert.equal(/[\u0000-\u001f\u007f]/.test(emailLine), false, 'the Email line must be clean');
});

test('the concurrency cap is exported and reports sane state', () => {
  const state = sendConcurrency();
  assert.equal(typeof state.inFlight, 'number');
  assert.equal(typeof state.waiting, 'number');
  assert.ok(state.max > 0 && state.max <= 32, 'the cap should be small and finite');
  assert.equal(state.inFlight, 0, 'nothing should be in flight outside a send');
});

/**
 * An SMTP server that accepts connections and then stalls forever after the greeting.
 *
 * Used only by the concurrency test. A black-hole address is not reliable for this: a
 * local firewall usually refuses TEST-NET-1 in ~100ms, so the slot frees before the
 * next request arrives and the cap is never exercised. This holds each slot open
 * deterministically, which is the only way to observe the bound.
 */
function startStallingSmtp() {
  const sockets = new Set();
  const smtp = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('220 stalling ESMTP\r\n');
    // Accept the greeting and then never advance: no 250, no DATA, nothing. The client
    // waits on its greeting/socket timeout, which is what we want to measure.
  });
  return new Promise((resolve, reject) => {
    smtp.once('error', reject);
    smtp.listen(0, '127.0.0.1', () => {
      resolve({
        port: smtp.address().port,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            smtp.close(() => done());
          }),
      });
    });
  });
}

test('concurrent sends cannot exceed the cap, and all slots are released', async () => {
  const stalling = await startStallingSmtp();
  const { max } = sendConcurrency();
  const config = smtpConfigFor({
    host: '127.0.0.1',
    port: stalling.port,
    from: 'feedback@example.com',
    to: 'me@example.com',
    // Short timeouts so the test measures the *slot gate*, not nodemailer's 20s default
    // socket timeout. The gate's behaviour is independent of how long a slot is held.
    timeouts: { connection: 1500, greeting: 1500, socket: 1500 },
  });

  try {
    // Overshoot the cap: the extra calls must wait in the queue rather than open more
    // sockets.
    const attempts = Array.from({ length: max + 3 }, (_, i) =>
      sendFeedback({ name: `Load ${i}`, email: 'load@example.com', message: 'probe', config })
    );

    // Wait for the slots to actually fill rather than assuming a fixed delay: poll until
    // either the cap is reached or the sends finish. The honest signal that the gate
    // works is that `waiting` becomes non-zero — the overshoot must be queued, not
    // connected.
    const deadline = Date.now() + 5000;
    let mid = sendConcurrency();
    while (mid.waiting === 0 && mid.inFlight < max && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      mid = sendConcurrency();
    }

    assert.ok(mid.inFlight > 0, 'at least one send should be occupying a slot');
    assert.ok(mid.inFlight <= max, `in flight ${mid.inFlight} exceeded the cap ${max}`);
    assert.ok(
      mid.waiting > 0,
      `expected the overshoot to be queued (inFlight=${mid.inFlight}, waiting=${mid.waiting}, max=${max})`
    );

    // Now let them all fail out (their timeouts bound this).
    const results = await Promise.all(attempts);
    for (const r of results) {
      // Never a fabricated success, whatever the reason.
      assert.equal(r.ok, false, `expected failure, got ${JSON.stringify(r)}`);
    }
  } finally {
    await stalling.close();
  }

  // The queue must drain so a later visitor is not starved.
  assert.equal(sendConcurrency().inFlight, 0, 'all slots should be released');
  assert.equal(sendConcurrency().waiting, 0, 'the queue should be drained');
});

test('a refused-due-to-load submission is not reported as success', async () => {
  const { server, base } = await startTestServer();
  const { cookie } = await login(base);
  try {
    const res = await fetch(`${base}/api/admin/email`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
      body: JSON.stringify({ feedbackEnabled: true, smtpHost: '', smtpPort: '', smtpFrom: '', smtpTo: '' }),
    });
    assert.equal(res.status, 200);

    const { issueToken } = await import('../src/feedback-token.js');
    const { config } = await import('../src/config.js');
    const token = issueToken(Date.now() - (config.feedbackMinSeconds + 1) * 1000);

    const submit = await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', email: 'a@b.co', message: 'hi', token }),
    });
    const body = await submit.json();
    assert.equal(body.ok, false, 'an undeliverable message must never report success');
    assert.ok(submit.status === 502 || submit.status === 503, `got ${submit.status}`);
  } finally {
    server.close();
  }
});

// --- Admin email panel guard (the D19 regression) ---------------------------
//
// This is the destructive bug the browser found and the suite did not: a panel that
// rendered without loading would save empty inputs over a working SMTP config.

test('a save that would wipe stored SMTP values is detected', () => {
  const server = { smtpHost: '127.0.0.1', smtpPort: '25', smtpFrom: 'a@b.co', smtpTo: 'c@d.co' };
  const blank = { smtpHost: '', smtpPort: '', smtpFrom: '', smtpTo: '' };
  // smtpTo is deliberately absent: blank means "use the From address", which the UI
  // documents as valid, so guarding it would block a supported configuration.
  assert.deepEqual(fieldsThisSaveWouldClear(blank, server), ['smtpFrom', 'smtpHost', 'smtpPort']);
});

test('a save that keeps stored values is allowed', () => {
  const server = { smtpHost: '127.0.0.1', smtpPort: '25', smtpFrom: 'a@b.co', smtpTo: 'c@d.co' };
  assert.deepEqual(fieldsThisSaveWouldClear(server, server), []);
});

test('changing a value is not treated as wiping it', () => {
  const server = { smtpHost: 'old.example.com', smtpPort: '587', smtpFrom: 'a@b.co', smtpTo: 'c@d.co' };
  const changed = { smtpHost: 'new.example.com', smtpPort: '465', smtpFrom: 'a@b.co', smtpTo: 'c@d.co' };
  assert.deepEqual(fieldsThisSaveWouldClear(changed, server), []);
});

test('clearing a field the server does not hold is allowed', () => {
  // Nothing stored means nothing to lose — this is the case that makes the guard
  // usable on a fresh install.
  const server = { smtpHost: '', smtpPort: '', smtpFrom: '', smtpTo: '' };
  const blank = { smtpHost: '', smtpPort: '', smtpFrom: '', smtpTo: '' };
  assert.deepEqual(fieldsThisSaveWouldClear(blank, server), []);
});

test('a save that would clear only some fields reports exactly those', () => {
  const server = { smtpHost: '127.0.0.1', smtpPort: '25', smtpFrom: 'a@b.co', smtpTo: '' };
  const half = { smtpHost: '127.0.0.1', smtpPort: '', smtpFrom: 'a@b.co', smtpTo: '' };
  assert.deepEqual(fieldsThisSaveWouldClear(half, server), ['smtpPort']);
});

// The guard must not block a configuration the UI documents as valid, or an admin
// cannot configure SMTP at all — a false positive here is worse than the bug it prevents.
test('blanking the recipient is allowed: blank means "use the From address"', () => {
  const server = { smtpHost: '127.0.0.1', smtpPort: '587', smtpFrom: 'a@b.co', smtpTo: 'me@b.co' };
  const blankedTo = { smtpHost: '127.0.0.1', smtpPort: '587', smtpFrom: 'a@b.co', smtpTo: '' };
  assert.deepEqual(fieldsThisSaveWouldClear(blankedTo, server), [], 'blank smtpTo is a supported state');
});

test('a first-time save with nothing stored is always allowed', () => {
  const server = { smtpHost: '', smtpPort: '', smtpFrom: '', smtpTo: '' };
  const fillingIn = { smtpHost: 'smtp.example.com', smtpPort: '587', smtpFrom: 'a@b.co', smtpTo: '' };
  assert.deepEqual(fieldsThisSaveWouldClear(fillingIn, server), []);
});

test('a field can be cleared on purpose via allowClear', () => {
  const server = { smtpHost: 'old.example.com', smtpPort: '587', smtpFrom: 'a@b.co', smtpTo: '' };
  const clearing = { smtpHost: '', smtpPort: '587', smtpFrom: 'a@b.co', smtpTo: '' };
  // Without the flag it is refused...
  assert.deepEqual(fieldsThisSaveWouldClear(clearing, server), ['smtpHost']);
  // ...and with it, the deliberate clear goes through.
  assert.deepEqual(fieldsThisSaveWouldClear(clearing, server, { allowClear: ['smtpHost'] }), []);
});

// --- Admin panel script order (the D19 regression) --------------------------
//
// A static check, because no browser test loads admin.html and this bug was invisible to
// everything else: `admin.js` used to be a classic script while `feedback.js` was a
// deferred module, so admin.js could run showPanel() before the email hook existed. The
// panel then rendered blank, and a Save wrote those blanks over a working SMTP config.
// Ordering is the fix, so ordering is what this asserts.

test('admin.html loads feedback.js before admin.js, both deferred', async () => {
  const { server, base } = await startTestServer();
  try {
    const html = await (await fetch(`${base}/admin`)).text();
    const feedbackAt = html.indexOf('/js/feedback.js');
    const adminAt = html.indexOf('/js/admin.js');
    assert.ok(feedbackAt !== -1, 'admin.html should load feedback.js');
    assert.ok(adminAt !== -1, 'admin.html should load admin.js');
    assert.ok(
      feedbackAt < adminAt,
      'feedback.js must load before admin.js, or the email panel can render blank'
    );

    // Both must be modules: a classic script executes during parse and would reintroduce
    // the race regardless of document order.
    const tags = [...html.matchAll(/<script([^>]*)\ssrc="([^"]*\/js\/(?:admin|feedback)\.js[^"]*)"/g)];
    assert.equal(tags.length, 2, 'expected exactly two tags for admin.js and feedback.js');
    for (const [, attrs, src] of tags) {
      assert.match(attrs, /type="module"/, `${src} must be type="module" so both defer in order`);
    }
  } finally {
    server.close();
  }
});

test('the admin email panel is identifiable so the client can self-load it', async () => {
  const { server, base } = await startTestServer();
  try {
    const html = await (await fetch(`${base}/admin`)).text();
    // feedback.js self-loads when this panel is already visible — the second line of
    // defence behind the script ordering.
    assert.match(html, /<section class="panel" id="email-panel">/);
  } finally {
    server.close();
  }
});

test('the token endpoint has a larger budget than submissions', async () => {
  // A shared budget would halve the effective allowance (each submission costs a token
  // fetch plus a post) and would make refreshToken() fail on an exhausted limiter.
  const { server, base: b } = await startTestServer();
  try {
    // The token endpoint must tolerate far more requests than the submission limit.
    const results = await Promise.all(
      Array.from({ length: 15 }, () => fetch(`${b}/api/feedback/token`).then((r) => r.status))
    );
    assert.ok(
      results.every((s) => s === 200),
      `every token request should succeed, got ${[...new Set(results)].join(',')}`
    );
  } finally {
    server.close();
  }
});

test('the drawer never links to a page that 404s', async () => {
  const { server, base: b } = await startTestServer();
  try {
    const html = await (await fetch(`${b}/`)).text();
    const links = /<p class="drawer-links">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
    assert.match(links, /href="\/credits"/);
    assert.equal((await fetch(`${b}/credits`)).status, 200);

    if (links.includes('/feedback')) {
      // The link is only rendered when the feature is on, so it must resolve.
      assert.equal((await fetch(`${b}/feedback`)).status, 200, 'a rendered Feedback link must resolve');
    } else {
      assert.equal((await fetch(`${b}/feedback`)).status, 404, 'no link, so the page must be absent');
    }
  } finally {
    server.close();
  }
});

test('the token endpoint is gated on the feature being enabled', async () => {
  // /feedback 404s when disabled, so its token endpoint must not quietly keep answering —
  // otherwise the API advertises a feature the pages deny exists.
  const { server, base: b } = await startTestServer();
  const { cookie } = await login(b);
  const auth = { 'Content-Type': 'application/json', Cookie: cookie, Origin: b };
  try {
    await fetch(`${b}/api/admin/email`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ feedbackEnabled: false }),
    });
    assert.equal((await fetch(`${b}/api/feedback/token`)).status, 404, 'disabled: token must 404');
    assert.equal((await fetch(`${b}/feedback`)).status, 404, 'disabled: page must 404');

    await fetch(`${b}/api/admin/email`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ feedbackEnabled: true }),
    });
    assert.equal((await fetch(`${b}/api/feedback/token`)).status, 200, 'enabled: token must be issued');
  } finally {
    server.close();
  }
});
