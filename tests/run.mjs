// Runs every test file in this folder: `node tests/run.mjs`
// (Plain Node, no dependencies. The extension itself does not use this folder.)
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const dir = new URL('.', import.meta.url).pathname;
let failed = 0;
for (const f of readdirSync(dir).filter((n) => n.endsWith('.test.mjs')).sort()) {
  const r = spawnSync(process.execPath, [dir + f], { encoding: 'utf8' });
  const last = (r.stdout.trim().split('\n').pop() || '').trim();
  const ok = r.status === 0 && last === 'all passed';
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f}`);
  if (!ok) console.log(r.stdout.split('\n').filter((l) => l.startsWith('FAIL')).join('\n') || r.stderr);
}
process.exitCode = failed ? 1 : 0;
