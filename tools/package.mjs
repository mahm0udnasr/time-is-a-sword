#!/usr/bin/env node
/**
 * package.mjs — build the ZIP to upload to the Chrome Web Store / Edge Add-ons.
 *
 *   node tools/package.mjs            → dist/time-is-a-sword-<version>.zip
 *   node tools/package.mjs --no-tests → skip running the tests first
 *
 * Runs the tests, checks the manifest, then zips only the files the extension
 * needs (manifest.json at the root). No dependencies: a minimal ZIP writer
 * (deflate + CRC-32) is included below.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** What goes in the package. Folders are included recursively. */
const INCLUDE = [
  'manifest.json', 'background', 'blocked', 'content', 'data', 'fonts', 'icons',
  'images', 'options', 'popup', 'shared', 'vendor', 'LICENSE', 'THIRD_PARTY_NOTICES.md'
];
/** Never packaged, even inside included folders. */
const EXCLUDE = [/^icons\/original\//, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /\.swp$/];

// ---------------------------------------------------------------------------
// 1. Tests

if (!process.argv.includes('--no-tests')) {
  console.log('Running tests…');
  const r = spawnSync(process.execPath, [join(root, 'tests', 'run.mjs')], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('\nTests failed: not packaging.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 2. Manifest sanity checks (the things the store rejects)

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const problems = [];
if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) problems.push(`invalid version "${manifest.version}"`);
if (!manifest.name || manifest.name.length > 75) problems.push('name missing or longer than 75 characters');
if (!manifest.description || manifest.description.length > 132) problems.push('description missing or longer than 132 characters');
if (!manifest.icons?.['128']) problems.push('a 128×128 icon is required');
if (problems.length) {
  console.error('Manifest problems:\n  - ' + problems.join('\n  - '));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Collect files

function walk(path, out) {
  const st = statSync(path);
  if (st.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name), out);
  else out.push(path);
  return out;
}

const files = INCLUDE.flatMap((p) => {
  const full = join(root, p);
  if (!existsSync(full)) throw new Error(`Missing: ${p}`);
  return walk(full, []);
})
  .map((full) => ({ full, name: relative(root, full).split(sep).join('/') }))
  .filter(({ name }) => !EXCLUDE.some((re) => re.test(name)));

// ---------------------------------------------------------------------------
// 4. Minimal ZIP writer

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS date/time for the ZIP headers (a fixed date keeps builds reproducible). */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const local = [];
const central = [];
let offset = 0;
for (const { full, name } of files) {
  const data = readFileSync(full);
  const deflated = deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  const body = useDeflate ? deflated : data;
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4); // version needed
  lh.writeUInt16LE(0x0800, 6); // UTF-8 names
  lh.writeUInt16LE(useDeflate ? 8 : 0, 8);
  lh.writeUInt16LE(DOS_TIME, 10);
  lh.writeUInt16LE(DOS_DATE, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(body.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);
  local.push(lh, nameBuf, body);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4); // made by
  ch.writeUInt16LE(20, 6); // needed
  ch.writeUInt16LE(0x0800, 8);
  ch.writeUInt16LE(useDeflate ? 8 : 0, 10);
  ch.writeUInt16LE(DOS_TIME, 12);
  ch.writeUInt16LE(DOS_DATE, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(body.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28);
  ch.writeUInt32LE(offset, 42);
  central.push(ch, nameBuf);

  offset += lh.length + nameBuf.length + body.length;
}
const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', `time-is-a-sword-${manifest.version}.zip`);
writeFileSync(out, Buffer.concat([...local, centralBuf, end]));

const kb = (statSync(out).size / 1024).toFixed(0);
console.log(`\nPackaged ${files.length} files → ${relative(root, out)} (${kb} KB)`);
console.log('Upload it at https://chrome.google.com/webstore/devconsole (and Edge Add-ons).');
