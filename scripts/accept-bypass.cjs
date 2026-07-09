// One-time interactive acceptance of Claude Code's "Bypass Permissions" gate.
// Drives a real PTY (same lib the daemon uses) so the acceptance is cached
// machine-wide and daemon agents never see the gate again.
const pty = require('node-pty');
const os = require('os');

const binary = 'claude.cmd';
const args = ['--dangerously-skip-permissions'];
const cwd = process.argv[2] || process.cwd();

console.log(`[accept] spawning ${binary} ${args.join(' ')} in ${cwd}`);

const p = pty.spawn(binary, args, {
  name: 'xterm-color',
  cols: 120,
  rows: 40,
  cwd,
  env: process.env,
});

let buf = '';
let acceptedBypass = false;
let acceptedTrust = false;
let sawPrompt = false;

function strip(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b[()][0-9A-B]/g, '').replace(/\x1b\][0-9;]*\x07?/g, '').replace(/\r/g, ' ');
}

p.onData((d) => {
  buf += d;
  const recent = strip(buf.slice(-4000));

  if (!acceptedBypass && recent.includes('Bypass Permissions')) {
    acceptedBypass = true;
    console.log('[accept] BYPASS gate detected -> sending Down+Enter (Yes, I accept) in 700ms');
    setTimeout(() => { try { p.write('\x1b[B'); } catch {} }, 700);
    setTimeout(() => { try { p.write('\r'); } catch {} }, 1100);
  } else if (!acceptedTrust && (recent.includes('Do you trust') || recent.includes('trust the files'))) {
    acceptedTrust = true;
    console.log('[accept] TRUST prompt detected -> sending Enter (accept) in 700ms');
    setTimeout(() => { try { p.write('\r'); } catch {} }, 700);
  }

  // Signs we are PAST the gates and at the live prompt.
  if (!sawPrompt && (recent.includes('? for shortcuts') || recent.includes('Bypass Permissions on') || recent.includes('/help for') || recent.includes('Welcome'))) {
    sawPrompt = true;
    console.log('[accept] ✅ reached live UI (gate cleared). Exiting claude cleanly in 1.5s.');
    setTimeout(() => { try { p.write('\x03'); } catch {}; setTimeout(() => { try { p.write('\x03'); } catch {} }, 400); }, 1500);
  }
});

p.onExit(({ exitCode }) => {
  console.log(`[accept] claude exited code=${exitCode} | acceptedBypass=${acceptedBypass} sawPrompt=${sawPrompt}`);
  console.log('[accept] ---- last screen (stripped) ----');
  console.log(strip(buf.slice(-1200)).replace(/\s+/g, ' ').trim());
  process.exit(0);
});

// Safety timeout
setTimeout(() => {
  console.log('[accept] timeout reached, killing pty');
  try { p.write('\x03'); } catch {}
  setTimeout(() => { try { p.kill(); } catch {}; process.exit(0); }, 1500);
}, 30000);
