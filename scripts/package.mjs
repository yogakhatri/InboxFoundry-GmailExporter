import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const files = [
  'manifest.json', 'background.js', 'content.js',
  'sidepanel.html', 'sidepanel.css', 'sidepanel.js',
  'lib/attachment-analysis.js', 'lib/export-engine.js', 'lib/exporter.js', 'lib/filter-engine.js', 'lib/gmail-adapter.js',
  'lib/gmail-date.js', 'lib/gmail-query.js', 'lib/job-machine.js', 'lib/job-store.js', 'lib/path-safety.js',
  'lib/product-schema.js', 'lib/sha256.js',
  'assets/icon16.png', 'assets/icon32.png', 'assets/icon48.png', 'assets/icon128.png',
  'LICENSE', 'PRIVACY.md', 'SECURITY.md'
];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(name, crc, compressedSize, size) {
  const nameBytes = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(8, 8); header.writeUInt16LE(0, 10); header.writeUInt16LE(0x21, 12);
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressedSize, 18); header.writeUInt32LE(size, 22);
  header.writeUInt16LE(nameBytes.length, 26); header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBytes]);
}

function centralHeader(name, crc, compressedSize, size, offset) {
  const nameBytes = Buffer.from(name);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8); header.writeUInt16LE(8, 10); header.writeUInt16LE(0, 12); header.writeUInt16LE(0x21, 14);
  header.writeUInt32LE(crc, 16); header.writeUInt32LE(compressedSize, 20); header.writeUInt32LE(size, 24);
  header.writeUInt16LE(nameBytes.length, 28); header.writeUInt16LE(0, 30); header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34); header.writeUInt16LE(0, 36); header.writeUInt32LE(0, 38); header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, nameBytes]);
}

const localParts = [];
const centralParts = [];
let offset = 0;
for (const name of files) {
  if (name.startsWith('/') || name.includes('..') || name.includes('\\')) throw new Error(`Unsafe package path: ${name}`);
  const value = await readFile(resolve(root, name));
  const compressed = deflateRawSync(value, { level: 9 });
  const crc = crc32(value);
  const local = localHeader(name, crc, compressed.length, value.length);
  localParts.push(local, compressed);
  centralParts.push(centralHeader(name, crc, compressed.length, value.length, offset));
  offset += local.length + compressed.length;
}

const central = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
const archive = Buffer.concat([...localParts, central, end]);
const outputDir = resolve(root, 'dist');
const outputName = `inboxfoundry-v${manifest.version}.zip`;
await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, outputName), archive);
const sha256 = createHash('sha256').update(archive).digest('hex');
await writeFile(resolve(outputDir, `${outputName}.sha256`), `${sha256}  ${outputName}\n`);
console.log(`Created dist/${outputName} (${files.length} files, ${archive.length} bytes)`);
console.log(`SHA-256 ${sha256}`);
