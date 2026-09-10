import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const errors = [];

const vendorManifest = JSON.parse(await readFile(resolve(root, 'vendor/ASSET_MANIFEST.json'), 'utf8'));
for (const [file, expectedHash] of Object.entries(vendorManifest.assets || {})) {
  try {
    const bytes = await readFile(resolve(root, file));
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== expectedHash) errors.push(`vendored asset hash mismatch: ${file}`);
  } catch {
    errors.push(`vendored asset is missing: ${file}`);
  }
}
if ((vendorManifest.packages || []).some(item => !item.name || !item.version || !item.license || !item.npmIntegrity)) {
  errors.push('every vendored package must record name, version, license, and npm integrity');
}

if (packageJson.scripts?.['test:browser'] !== 'node scripts/browser-smoke.mjs') {
  errors.push('package.json must expose the isolated browser gate as test:browser');
}
if (packageJson.scripts?.['test:release'] !== 'npm test && npm run test:browser') {
  errors.push('package.json must expose both automated layers as test:release');
}

if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '')) errors.push('manifest version must use x.y.z');
if (manifest.version !== packageJson.version) errors.push('manifest.json and package.json versions must match');
if (Number(manifest.minimum_chrome_version) < 114) errors.push('minimum_chrome_version must be 114 or newer for the side panel');

const expectedPermissions = ['downloads', 'sidePanel', 'storage', 'unlimitedStorage'];
const actualPermissions = [...(manifest.permissions || [])].sort();
if (JSON.stringify(actualPermissions) !== JSON.stringify(expectedPermissions)) {
  errors.push(`permissions must be exactly: ${expectedPermissions.join(', ')}`);
}

if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['https://mail.google.com/*'])) {
  errors.push('host_permissions must be limited to https://mail.google.com/*');
}

const referencedFiles = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.side_panel?.default_path,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  ...(manifest.content_scripts || []).flatMap(script => script.js || [])
].filter(Boolean);

for (const file of referencedFiles) {
  try {
    await access(resolve(root, file));
  } catch {
    errors.push(`manifest references missing file: ${file}`);
  }
}

for (const page of [manifest.action.default_popup, manifest.side_panel.default_path]) {
  const html = await readFile(resolve(root, page), 'utf8');
  if (/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(html)) errors.push(`inline extension-page script is not allowed: ${page}`);
  for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    if (/^(?:https?:)?\/\//i.test(match[1])) errors.push(`remote script is not allowed in ${page}: ${match[1]}`);
    else {
      try {
        await access(resolve(root, match[1]));
      } catch {
        errors.push(`${page} references missing script: ${match[1]}`);
      }
    }
  }
  for (const match of html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["']/gi)) {
    if (!/^(?:https?:)?\/\//i.test(match[1])) {
      try {
        await access(resolve(root, match[1]));
      } catch {
        errors.push(`${page} references missing stylesheet: ${match[1]}`);
      }
    }
  }
}

for (const [htmlFile, jsFile] of [[manifest.action.default_popup, 'popup.js'], [manifest.side_panel.default_path, 'sidepanel.js']]) {
  const html = await readFile(resolve(root, htmlFile), 'utf8');
  const js = await readFile(resolve(root, jsFile), 'utf8');
  const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]));
  for (const match of js.matchAll(/\$\(['"]([^'"]+)['"]\)/g)) {
    if (!ids.has(match[1])) errors.push(`${jsFile} references missing #${match[1]} in ${htmlFile}`);
  }
}

const background = await readFile(resolve(root, manifest.background.service_worker), 'utf8');
for (const call of background.matchAll(/importScripts\(([^)]+)\)/g)) {
  for (const quoted of call[1].matchAll(/["']([^"']+)["']/g)) {
    try { await access(resolve(root, quoted[1])); }
    catch { errors.push(`background importScripts references missing file: ${quoted[1]}`); }
  }
}

const content = await readFile(resolve(root, 'content.js'), 'utf8');
if (/querySelector(?:All)?\s*\(/.test(content)) {
  errors.push('Gmail DOM selectors must remain in lib/gmail-adapter.js, not content.js orchestration');
}
const gmailAdapter = await readFile(resolve(root, 'lib/gmail-adapter.js'), 'utf8');
for (const method of ['searchMessages','getVisibleThreads','openThread','expandThread','extractMessageMetadata','extractAttachments','downloadAttachment','getNextResultsPage','returnToSearchResults']) {
  if (!gmailAdapter.includes(method)) errors.push(`Gmail adapter surface is missing: ${method}`);
}
if (content.includes("`${state.job?.id || 'job'}-${folder}")) {
  errors.push('download task IDs must not contain subject-derived folder paths');
}
const diagnosticsBody = content.match(/async function downloadDiagnostics\(\)[\s\S]*?\n  const initialLoad/)?.[0] || '';
for (const forbidden of ['id: row.id', 'row.fileName', 'row.folder', 'row.finalPath', 'row.threadKey', 'row.messageId']) {
  if (diagnosticsBody.includes(forbidden)) errors.push(`sanitized diagnostics must not expose ${forbidden}`);
}

if (manifest.content_security_policy?.extension_pages !== "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'self'") {
  errors.push('extension page CSP must restrict scripts/workers to self and allow only WebAssembly compilation needed for local OCR');
}
if (manifest.content_security_policy?.extension_pages.includes("'unsafe-eval'")) {
  errors.push('extension page CSP must never permit ordinary unsafe-eval');
}

const sidepanelHtml = await readFile(resolve(root, manifest.side_panel.default_path), 'utf8');
if (!sidepanelHtml.includes('<script src="lib/ocr-engine.js"></script>')) {
  errors.push('side panel must load the local OCR engine explicitly');
}
const ocrEngine = await readFile(resolve(root, 'lib/ocr-engine.js'), 'utf8');
for (const required of [
  "vendor/tesseract/tesseract.min.js",
  "vendor/tesseract/worker.min.js",
  "vendor/tesseract/tesseract-core-simd-lstm.wasm.js",
  "vendor/tesseract/lang",
  "vendor/pdfjs/pdf.min.mjs",
  "vendor/pdfjs/pdf.worker.min.mjs",
  "cacheMethod:'none'",
  'isEvalSupported:false',
  'enableXfa:false',
  'useWorkerFetch:false',
  'useWasm:false'
]) {
  if (!ocrEngine.includes(required)) errors.push(`local OCR security configuration is missing: ${required}`);
}
if (/https?:\/\//i.test(ocrEngine)) errors.push('local OCR engine must not contain remote runtime URLs');
for (const notice of ['vendor/THIRD_PARTY_NOTICES.md', 'vendor/ASSET_MANIFEST.json']) {
  try { await access(resolve(root, notice)); }
  catch { errors.push(`OCR release metadata is missing: ${notice}`); }
}

const readme = await readFile(resolve(root, 'README.md'), 'utf8');
for (const match of readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
  const target = match[1].split('#')[0];
  if (!target || /^(?:https?:|mailto:)/i.test(target)) continue;
  try {
    await access(resolve(root, target));
  } catch {
    errors.push(`README references missing local file: ${target}`);
  }
}

if (errors.length) {
  console.error(errors.map(error => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validated InboxFoundry v${manifest.version} (${referencedFiles.length} manifest files).`);
}
