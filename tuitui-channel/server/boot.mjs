import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const stateDir = process.env.TUITUI_STATE_DIR || join(homedir(), '.claude', 'channels', 'tuitui');
const bootLog = join(stateDir, 'boot.log');
mkdirSync(dirname(bootLog), { recursive: true });

function log(line) {
  appendFileSync(bootLog, `${new Date().toISOString()} ${line}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
}

log(`[BOOT] tuitui-channel boot.mjs start pid=${process.pid}`);
log(`[BOOT] marker=2026-03-23-v2-runtime-probe`);
log(`[BOOT] env TUITUI_DM_POLICY=${process.env.TUITUI_DM_POLICY || ''} TUITUI_STATE_DIR=${process.env.TUITUI_STATE_DIR || ''}`);

process.on('uncaughtException', (err) => {
  log(`[BOOT] uncaughtException ${err?.stack || err}`);
});
process.on('unhandledRejection', (err) => {
  log(`[BOOT] unhandledRejection ${err?.stack || err}`);
});

await import('./index.mjs');
log('[BOOT] imported index.mjs successfully');
