// A tiny SMTP capture server for local testing.
//
// Run it, submit the feedback form at http://localhost:3100/feedback, and the message
// it produces is printed here (and written to /tmp/feedback-capture/). Nothing else on
// the machine needs to receive mail, so a real send can be verified end to end without
// pointing the app at anyone's real mail server.
//
//   node scripts/capture-smtp.mjs            # listens on 587
//   node scripts/capture-smtp.mjs 465        # implicit TLS — not supported here
//
// Ports: the admin form only accepts 25 / 465 / 587, and of those only 587 is bindable
// without root. 25 also needs root, and 465 would require a TLS certificate. So 587 is
// the default, and it is the one the app's admin panel should be set to. (2525 is
// accepted as an argument for completeness, but you would then have to bypass the admin
// form to configure it — it is not a shortcut.)
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.argv[2] || 587);
const outDir = '/tmp/feedback-capture';
fs.mkdirSync(outDir, { recursive: true });

let count = 0;

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  socket.write('220 capture ESMTP ready\r\n');

  let buffer = '';
  let dataMode = false;
  let message = [];

  socket.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      if (dataMode) {
        if (line === '.') {
          dataMode = false;
          count += 1;
          const body = message.join('\n');
          const file = path.join(outDir, `message-${String(count).padStart(3, '0')}.txt`);
          fs.writeFileSync(file, body);
          console.log(`\n${'='.repeat(70)}\nMESSAGE ${count}  ->  ${file}\n${'='.repeat(70)}\n`);
          // Un-stuff the leading dots so what is shown is what the visitor wrote.
          console.log(body.replace(/^\.\./gm, '.'));
          console.log(`${'='.repeat(70)}\n`);
          message = [];
          socket.write('250 OK queued\r\n');
        } else {
          message.push(line);
        }
        continue;
      }

      const cmd = line.toUpperCase();
      if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) {
        socket.write('250-capture\r\n250 HELP\r\n');
      } else if (cmd.startsWith('MAIL FROM') || cmd.startsWith('RCPT TO')) {
        socket.write('250 OK\r\n');
      } else if (cmd === 'DATA') {
        dataMode = true;
        message = [];
        socket.write('354 Send data\r\n');
      } else if (cmd === 'QUIT') {
        socket.write('221 Bye\r\n');
        socket.end();
      } else {
        socket.write('250 OK\r\n');
      }
    }
  });

  socket.on('error', () => {});
});

server.on('error', (err) => {
  if (err.code === 'EACCES') {
    console.error(`\nCannot bind port ${port}: permission denied.`);
    // Port 587 is the only one that is both permitted by the admin form and bindable
    // without root, so it is the accurate suggestion — not an arbitrary high port.
    console.error('The admin form accepts 25, 465 and 587. Of those, 587 works without root.');
    console.error(`Try:  node scripts/capture-smtp.mjs 587   (then set the admin port to 587)\n`);
  } else {
    console.error(err.message);
  }
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`SMTP capture listening on 127.0.0.1:${port}`);
  console.log(`Messages are printed here and saved to ${outDir}/`);
  console.log(`Submit the form at http://localhost:3100/feedback\n`);
});
