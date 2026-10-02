import { test } from 'node:test';
import assert from 'node:assert/strict';
// `src/config.js` reads authConfig at import time and requires ADMIN_PASSWORD, so the
// test env has to be set before the first import — the same reason test/helpers.js
// exists and is imported first everywhere else.
import './helpers.js';
import { issueToken, checkToken } from '../src/feedback-token.js';
import { validateFeedback, validateSmtpSettings, isValidEmail } from '../src/validate.js';
import { smtpPublicConfig, smtpFromSettings, buildFeedbackEmail, isConfigured } from '../src/mailer.js';
import { config } from '../src/config.js';

// --- Timing token -----------------------------------------------------------

test('a fresh token is accepted', () => {
  // Move "now" past the minimum-fill window so the token is legitimately eligible.
  const issued = Date.now() - (config.feedbackMinSeconds + 1) * 1000;
  const result = checkToken(issueToken(issued));
  assert.equal(result.ok, true);
  assert.ok(result.ageMs >= config.feedbackMinSeconds * 1000);
});

test('a token from the future is rejected as malformed', () => {
  // Guards the too-fast check: a future timestamp would otherwise make ageMs negative
  // and sail through the window check.
  const future = Date.now() + 10 * 60 * 1000;
  assert.deepEqual(checkToken(issueToken(future)).reason, 'malformed');
});

test('a submission that arrives too fast is rejected', () => {
  // Issued just now: no human has written a message in this time.
  assert.deepEqual(checkToken(issueToken(Date.now())).reason, 'too-fast');
});

test('an expired token is rejected', () => {
  const old = Date.now() - config.feedbackTokenTtlMs - 1000;
  assert.deepEqual(checkToken(issueToken(old)).reason, 'expired');
});

test('a tampered signature is rejected without trusting the timestamp', () => {
  const token = issueToken(Date.now() - 10_000);
  const [issued] = token.split('.');
  // Swap the MAC for a well-formed but wrong one: the signature must be checked
  // before anything about the timestamp is believed.
  const forged = `${issued}.${'A'.repeat(43)}`;
  assert.deepEqual(checkToken(forged).reason, 'bad-signature');
});

test('a re-signed timestamp cannot be forged without the secret', () => {
  // An attacker who edits the timestamp invalidates the MAC, which is the whole point.
  const token = issueToken(Date.now() - 10_000);
  const mac = token.split('.')[1];
  const edited = `${Number(token.split('.')[0]) - 5000}.${mac}`;
  assert.deepEqual(checkToken(edited).reason, 'bad-signature');
});

test('missing and malformed tokens are rejected distinctly (for logging)', () => {
  assert.deepEqual(checkToken(undefined).reason, 'missing');
  assert.deepEqual(checkToken('').reason, 'missing');
  assert.deepEqual(checkToken('not-a-token').reason, 'malformed');
  assert.deepEqual(checkToken('abc.def').reason, 'malformed');
  assert.deepEqual(checkToken('123.456.789').reason, 'malformed');
  assert.deepEqual(checkToken(null).reason, 'missing');
});

test('a JSON-encoded cookie-style value cannot slip through', () => {
  // cookie-parser can hand back objects for `j:`-prefixed cookies; the token is read
  // from the request body here, but the same defence applies.
  assert.equal(checkToken({ issued: 1 }).ok, false);
  assert.equal(checkToken([1, 2]).ok, false);
  assert.equal(checkToken(12345).ok, false);
});

// --- Feedback validation ----------------------------------------------------

test('a complete submission validates', () => {
  const { ok, value, honeypotTripped } = validateFeedback({
    name: 'Ada',
    email: 'ada@example.com',
    message: 'A real message.',
  });
  assert.equal(ok, true);
  assert.equal(honeypotTripped, false);
  assert.equal(value.name, 'Ada');
  assert.equal(value.email, 'ada@example.com');
  assert.equal(value.message, 'A real message.');
});

test('name, email and message are all required', () => {
  for (const missing of ['name', 'email', 'message']) {
    const input = { name: 'Ada', email: 'ada@example.com', message: 'hi' };
    delete input[missing];
    const { ok, errors } = validateFeedback(input);
    assert.equal(ok, false, `${missing} should be required`);
    assert.ok(errors.some((e) => e.includes(missing)), `error should mention ${missing}`);
  }
});

test('a whitespace-only message is not a message', () => {
  const { ok, errors } = validateFeedback({ name: 'Ada', email: 'a@b.co', message: '   \n\t ' });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('message')));
});

test('a whitespace-only name is not a name', () => {
  const { ok } = validateFeedback({ name: '   ', email: 'a@b.co', message: 'hi' });
  assert.equal(ok, false);
});

test('the honeypot is reported, not rejected', () => {
  // The route turns this into a fake success, so validation must not fail it — a
  // rejection would tell the bot which field gave it away.
  const { ok, honeypotTripped, value } = validateFeedback({
    name: 'Bot',
    email: 'bot@example.com',
    message: 'spam',
    website: 'http://spam.example',
  });
  assert.equal(ok, true);
  assert.equal(honeypotTripped, true);
  assert.equal(value.name, 'Bot');
});

test('an empty honeypot does not trip it', () => {
  for (const v of ['', '   ', undefined]) {
    const { honeypotTripped } = validateFeedback({ name: 'A', email: 'a@b.co', message: 'hi', website: v });
    assert.equal(honeypotTripped, false, `honeypot value ${JSON.stringify(v)} should not trip`);
  }
});

test('length caps are enforced', () => {
  const long = 'x'.repeat(4001);
  assert.equal(validateFeedback({ name: 'A', email: 'a@b.co', message: long }).ok, false);
  assert.equal(validateFeedback({ name: 'x'.repeat(121), email: 'a@b.co', message: 'hi' }).ok, false);
  assert.equal(validateFeedback({ name: 'A', email: `${'x'.repeat(255)}@b.co`, message: 'hi' }).ok, false);
});

test('email validation accepts real addresses and rejects junk', () => {
  for (const good of ['a@b.co', 'first.last@sub.example.com', 'user+tag@example.co.uk', "o'brien@example.com"]) {
    assert.equal(isValidEmail(good), true, `${good} should be valid`);
  }
  for (const bad of ['', 'not-an-email', 'a@b', 'a@.com', '@example.com', 'a b@example.com', 'a@b .com', null, 42]) {
    assert.equal(isValidEmail(bad), false, `${JSON.stringify(bad)} should be invalid`);
  }
});

test('extra fields in the body are not echoed into the stored value', () => {
  const { value } = validateFeedback({
    name: 'Ada',
    email: 'a@b.co',
    message: 'hi',
    isAdmin: true,
    token: 'whatever',
  });
  assert.deepEqual(Object.keys(value).sort(), ['email', 'message', 'name']);
});

// --- SMTP settings ----------------------------------------------------------

test('the protocol is derived from the port, not set independently', () => {
  // The two must agree or the connection silently hangs; deriving is the fix.
  assert.equal(validateSmtpSettings({ smtpPort: 465 }).value.smtpSecure, '1');
  assert.equal(validateSmtpSettings({ smtpPort: 587 }).value.smtpSecure, '0');
  assert.equal(validateSmtpSettings({ smtpPort: 25 }).value.smtpSecure, '0');
  // A client-supplied secure flag cannot override the port.
  assert.equal(validateSmtpSettings({ smtpPort: 465, smtpSecure: '0' }).value.smtpSecure, '1');
});

test('the port must be a real port number, but need not be a preset', () => {
  // Presets (25/465/587) are the labelled options. Any valid port is accepted, because
  // all three presets are privileged and a strict allow-list made a local capture server
  // unreachable and blocked providers on non-standard ports.
  for (const port of [25, 465, 587, 2525, 8025, 1024]) {
    assert.equal(validateSmtpSettings({ smtpPort: port }).ok, true, `port ${port} should be accepted`);
  }
  for (const port of [0, -1, 65536, 99999, 'abc', 1.5, '']) {
    // '' is the documented "not set" value and is allowed; everything else here is not.
    const { ok } = validateSmtpSettings({ smtpPort: port });
    if (port === '') assert.equal(ok, true, 'empty string means not set');
    else assert.equal(ok, false, `port ${JSON.stringify(port)} should be rejected`);
  }
});

test('implicit TLS is derived from the port for any port, not just the presets', () => {
  assert.equal(validateSmtpSettings({ smtpPort: 465 }).value.smtpSecure, '1', '465 is implicit TLS');
  for (const port of [587, 25, 2525, 8025]) {
    assert.equal(validateSmtpSettings({ smtpPort: port }).value.smtpSecure, '0', `${port} is STARTTLS-capable`);
  }
  // A client-supplied flag cannot override the derived value.
  assert.equal(validateSmtpSettings({ smtpPort: 465, smtpSecure: '0' }).value.smtpSecure, '1');
});

test('a host with a scheme, port or path is rejected', () => {
  // A common mistake that otherwise surfaces much later as a confusing dial error.
  for (const host of ['http://smtp.example.com', 'smtp.example.com:587', 'smtp.example.com/path', 'smtp example']) {
    assert.equal(validateSmtpSettings({ smtpHost: host }).ok, false, `${host} should be rejected`);
  }
  assert.equal(validateSmtpSettings({ smtpHost: 'smtp.example.com' }).ok, true);
});

test('addresses are validated where present but may be blank', () => {
  assert.equal(validateSmtpSettings({ smtpFrom: 'not-an-email' }).ok, false);
  assert.equal(validateSmtpSettings({ smtpTo: 'not-an-email' }).ok, false);
  assert.equal(validateSmtpSettings({ smtpFrom: '' }).ok, true);
});

test('a password containing control characters is rejected', () => {
  // This value goes into an SMTP AUTH exchange; a newline is how a second command is
  // smuggled in.
  for (const pw of ['abc\r\nQUIT', 'abc\ndef', 'abc\0def']) {
    assert.equal(validateSmtpSettings({ smtpPassword: pw }).ok, false, 'should reject control chars');
  }
  assert.equal(validateSmtpSettings({ smtpPassword: 'a-normal-password' }).ok, true);
});

test('an omitted password is left alone, null clears it', () => {
  // The distinction is what lets the admin save other fields without retyping it.
  assert.equal('smtpPassword' in validateSmtpSettings({ smtpHost: 'x.com' }).value, false);
  assert.equal(validateSmtpSettings({ smtpPassword: null }).value.smtpPassword, '');
});

// --- Mailer -----------------------------------------------------------------

test('the password is never in the public config', () => {
  const all = {
    smtpHost: 'smtp.example.com',
    smtpPort: '587',
    smtpSecure: '0',
    smtpUser: 'user@example.com',
    smtpPassword: 'super-secret-value',
    smtpFrom: 'feedback@example.com',
    smtpTo: 'me@example.com',
  };
  const pub = smtpPublicConfig(all);
  const serialised = JSON.stringify(pub);
  assert.equal(serialised.includes('super-secret-value'), false, 'the password must never be returned');
  assert.equal(pub.hasPassword, true, 'but its presence is reported');
  assert.equal('password' in pub, false);
});

test('hasPassword is false when nothing is stored', () => {
  assert.equal(smtpPublicConfig({}).hasPassword, false);
});

test('configuration requires a usable host and a real port', () => {
  assert.equal(isConfigured(smtpFromSettings({})), false, 'nothing configured');
  assert.equal(isConfigured(smtpFromSettings({ smtpHost: 'smtp.example.com' })), false, 'port missing');
  assert.equal(isConfigured(smtpFromSettings({ smtpHost: 'smtp.example.com', smtpPort: '0' })), false, 'port out of range');
  assert.equal(isConfigured(smtpFromSettings({ smtpHost: 'smtp.example.com', smtpPort: '65536' })), false, 'port out of range');
  assert.equal(isConfigured(smtpFromSettings({ smtpHost: 'smtp.example.com', smtpPort: '587' })), true);
  // A non-preset port is fine — the local capture server needs one that is unprivileged.
  assert.equal(isConfigured(smtpFromSettings({ smtpHost: '127.0.0.1', smtpPort: '2525' })), true);
  // Credentials are optional: a local relay may accept mail without auth.
  assert.equal(isConfigured(smtpFromSettings({ smtpHost: 'relay.local', smtpPort: '25' })), true);
});

test('a host that is not a hostname is not "configured"', () => {
  assert.equal(isConfigured(smtpFromSettings({ smtpHost: 'http://x.com', smtpPort: '587' })), false);
  assert.equal(isConfigured(smtpFromSettings({ smtpHost: 'a b', smtpPort: '587' })), false);
});

test('the email body is plain text with the visitor input intact', () => {
  const { subject, body } = buildFeedbackEmail({
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    message: 'Line one.\nLine two.',
    siteTitle: 'vibefolio',
  });
  assert.equal(subject, 'Feedback from Ada Lovelace');
  assert.match(body, /Name:\s+Ada Lovelace/);
  assert.match(body, /Email: ada@example\.com/);
  assert.match(body, /Line one\.\nLine two\./);
  // Plain text only: no HTML, so no escaping question arises.
  assert.equal(body.includes('<'), false);
});

test('a bare dot in the message cannot terminate the SMTP DATA block', () => {
  // RFC 5321 §4.5.2 dot-stuffing. nodemailer does this too; the assertion pins it so
  // a dependency change cannot silently remove the protection.
  const { body } = buildFeedbackEmail({ name: 'A', email: 'a@b.co', message: 'before\n.\nafter' });
  assert.match(body, /^\.\.$/m, 'a lone dot should be escaped to two dots');
});

test('CRLF in the name cannot break into the headers', () => {
  const { subject, body } = buildFeedbackEmail({
    name: 'Ada\r\nBcc: victim@example.com',
    email: 'a@b.co',
    message: 'hi',
  });
  // The newline is collapsed, so the injected text stays *inside* the existing line
  // rather than starting a new header. Asserting the absence of the word "Bcc" would
  // be wrong: it is legitimate text inside a single-line subject. What matters is
  // that no line break survives, so nothing becomes a header or a new body line.
  assert.equal(/[\r\n]/.test(subject), false, 'the subject must be a single line');
  assert.equal(/[\r\n]/.test(body.split('\n')[0]), false, 'the Name line must be one line');
  // ...and it cannot become a recipient or a header fold.
  assert.equal(body.startsWith('Name:  Ada Bcc: victim@example.com\n'), true);
});

test('a header value is length-capped so a paste cannot flood the header block', () => {
  const { subject } = buildFeedbackEmail({ name: 'x'.repeat(5000), email: 'a@b.co', message: 'hi' });
  assert.ok(subject.length < 200, `subject should be capped, got ${subject.length}: ${subject}`);
});
