import { createReadStream, createWriteStream, existsSync, openSync, realpathSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createInterface } from 'readline/promises';

const CONSENT_GATE_RELATIVE_PATH = join('installer', 'consent-gate.mjs');

async function promptStream(input, output) {
  const readline = createInterface({ input, output, terminal: true });
  try {
    const answer = await readline.question('Enable unattended Bypass Permissions mode? [y/N] ');
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

export async function promptControllingTty() {
  const fd = openSync('/dev/tty', 'r+');
  const input = createReadStream(null, { fd, autoClose: false });
  const output = createWriteStream(null, { fd, autoClose: true });
  return promptStream(input, output);
}

export async function resolveInstallerConsent({
  envValue,
  stdinIsTTY,
  stdoutIsTTY,
  platform,
  promptStdio = () => promptStream(process.stdin, process.stdout),
  promptTty = promptControllingTty,
  reportDefault = console.warn,
  grantCommand = 'node installer/consent-gate.mjs --grant',
}) {
  if (envValue === '1') return { answerYes: true, source: 'scripted-installer-opt-in' };
  if (envValue === '0') return { answerYes: false, source: 'scripted-installer-opt-out' };

  if (stdinIsTTY && stdoutIsTTY) {
    return { answerYes: await promptStdio(), source: 'interactive-installer' };
  }
  if (platform !== 'win32') {
    try {
      return { answerYes: await promptTty(), source: 'interactive-installer' };
    } catch {
      // A genuinely headless process has no controlling terminal.
    }
  }

  reportDefault(`No interactive terminal was available. Unattended mode remains disabled. To grant consent later, run: ${grantCommand}`);
  return { answerYes: false, source: 'non-interactive-default' };
}

export function requireConsentGateFile(installDir) {
  const filePath = join(installDir, CONSENT_GATE_RELATIVE_PATH);
  if (!existsSync(filePath)) {
    throw new Error(`Required installer file missing: ${filePath}`);
  }
  return filePath;
}

export function consentFailureMessage(answerYes, result) {
  if (!answerYes) {
    return 'Revoke NOT recorded - the existing grant still stands.';
  }
  if (result.folderReady !== true || result.bypassReady !== true) {
    return 'Grant not applied, nothing recorded; previous consent state still governs.';
  }
  return 'Safety preflight applied but consent NOT recorded - previous state governs; on a fresh install no agents will be created until this is fixed and re-run.';
}

export function installerConsentOutcome({ answerYes, source, result, installDir }) {
  if (result.existingState === 'lost') {
    return {
      level: 'warn',
      message: `Consent record at ${join(installDir, '.claude-consent.json')} is unreadable. Agents will run with permission gates engaged until it is repaired. To repair, run: node installer/consent-gate.mjs --grant (or --revoke).`,
    };
  }
  if (result.preserved && result.existingValue === true) {
    return {
      level: 'ok',
      message: `Existing unattended-mode consent preserved (granted ${result.existingDecidedAt}, source ${result.existingSource}); no change.`,
    };
  }
  if (result.preserved && result.existingValue === false) {
    return {
      level: 'ok',
      message: `Existing unattended-mode opt-out preserved (${result.existingDecidedAt}, source ${result.existingSource}); no change.`,
    };
  }
  if (answerYes) {
    return { level: 'ok', message: 'Claude unattended-mode consent and preflight configured' };
  }
  if (source === 'non-interactive-default') {
    return {
      level: 'ok',
      message: 'No prior consent found and no interactive terminal was available. Defaulting to attended mode (permission gates on). To enable unattended mode later, run: node installer/consent-gate.mjs --grant',
    };
  }
  return {
    level: 'ok',
    message: 'Recorded unattended-mode opt-out; generated Claude agents will keep permission gates enabled',
  };
}

export async function runConsentCommand(args, { installDir, applyUnattendedConsent }) {
  const actions = args.filter((arg) => arg === '--grant' || arg === '--revoke');
  if (actions.length !== 1) {
    throw new Error('Expected exactly one of --grant or --revoke');
  }
  const command = actions[0] === '--grant';
  const result = await applyUnattendedConsent(command, installDir, { source: 'consent-command' });
  if (!result.ok) throw new Error(consentFailureMessage(command, result));
  return result;
}

export async function runConsentGate({
  answerYes,
  installDir,
  source,
  importPreflight,
  spawnOnboarding,
  exit,
  reportFailure,
}) {
  let result;
  try {
    const imported = await importPreflight();
    const preflight = imported.default ?? imported;
    result = preflight.applyUnattendedConsent(answerYes, installDir, { source });
    if (!result.ok) {
      reportFailure(consentFailureMessage(answerYes, result));
      exit(1);
      return false;
    }
  } catch (error) {
    reportFailure(`FAILED to persist unattended-mode consent: ${error instanceof Error ? error.message : String(error)}`);
    exit(1);
    return false;
  }

  await spawnOnboarding();
  return result;
}

const isDirect = process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isDirect) {
  const installDir = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    const imported = await import(pathToFileURL(join(installDir, 'dist', 'claude-preflight.js')).href);
    const preflight = imported.default ?? imported;
    const result = await runConsentCommand(process.argv.slice(2), {
      installDir,
      applyUnattendedConsent: preflight.applyUnattendedConsent,
    });
    if (!result.recorded) throw new Error('Consent command completed without recording a decision');
    console.log(process.argv.includes('--grant')
      ? 'Unattended mode granted; consent recorded.'
      : 'Unattended mode revoked; consent recorded.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
