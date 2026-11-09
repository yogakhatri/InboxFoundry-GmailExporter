// Fast static checks that catch whole classes of mistakes without a browser.
import { spawnSync } from 'node:child_process';
import { readdir, readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = file => readFile(resolve(root, file), 'utf8');
const exists = file => access(resolve(root, file)).then(() => true, () => false);
const errors = [];

const manifest = JSON.parse(await read('manifest.json'));
const packageJson = JSON.parse(await read('package.json'));

// Syntax of every first-party script.
const scripts = ['background.js', 'content.js', 'sidepanel.js', ...(await readdir(resolve(root, 'lib'))).map(file => join('lib', file))];
for (const file of scripts) {
  const result = spawnSync(process.execPath, ['--check', resolve(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) errors.push(`syntax error in ${file}: ${result.stderr}`);
}

// Manifest.
if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
if (manifest.version !== packageJson.version) errors.push('manifest.json and package.json versions must match');
const expectedPermissions = ['downloads', 'scripting', 'sidePanel', 'storage', 'unlimitedStorage'];
if (JSON.stringify([...manifest.permissions].sort()) !== JSON.stringify(expectedPermissions)) errors.push(`permissions must be exactly: ${expectedPermissions}`);
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['https://mail.google.com/*'])) errors.push('host access must stay limited to Gmail');
if (manifest.content_scripts) errors.push('the Gmail script must only be injected on demand');
const csp = manifest.content_security_policy?.extension_pages || '';
if (/unsafe-eval|unsafe-inline|https?:/.test(csp)) errors.push('extension CSP must not allow eval, inline, or remote code');
for (const file of [manifest.background.service_worker, manifest.side_panel.default_path, ...Object.values(manifest.icons)]) {
  if (!await exists(file)) errors.push(`manifest references a missing file: ${file}`);
}

// The panel: scripts exist, no inline or remote code, every referenced element exists, every element is used.
const html = await read('sidepanel.html');
const panel = await read('sidepanel.js');
if (/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(html)) errors.push('sidepanel.html must not contain inline scripts');
for (const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/gi)) {
  if (/^(?:https?:)?\/\//i.test(match[1])) errors.push(`remote resource in sidepanel.html: ${match[1]}`);
  else if (!await exists(match[1])) errors.push(`sidepanel.html references a missing file: ${match[1]}`);
}
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
for (const match of panel.matchAll(/\$\('([^']+)'\)/g)) {
  if (!ids.has(match[1])) errors.push(`sidepanel.js references missing #${match[1]}`);
}
const decorativeIds = new Set(['intentChoices', 'threadsPanel', 'filesPanel', 'moreOptions', 'toolsSection']);
for (const id of ids) {
  if (!decorativeIds.has(id) && !panel.includes(`'${id}'`)) errors.push(`#${id} in sidepanel.html is not wired to anything`);
}
if (/\.innerHTML\s*=/.test(panel)) errors.push('sidepanel.js must not use innerHTML; mail text must never become markup');

// Injected files.
const injected = panel.match(/const CONTENT_FILES = \[([\s\S]*?)\]/)?.[1] ?? '';
const injectedFiles = [...injected.matchAll(/'([^']+)'/g)].map(match => match[1]);
if (injectedFiles.at(-1) !== 'content.js') errors.push('content.js must be injected last');
for (const file of injectedFiles) if (!await exists(file)) errors.push(`injected file is missing: ${file}`);

// Boundaries.
const content = await read('content.js');
if (/querySelector(?:All)?\s*\(/.test(content)) errors.push('Gmail selectors belong in lib/gmail-adapter.js, not content.js');
if (/\.click\(\)/.test(content)) errors.push('content.js must not call click() directly');
for (const file of scripts) {
  const source = await read(file);
  if (/\bfetch\(|XMLHttpRequest|WebSocket\(|sendBeacon|EventSource/.test(source)) errors.push(`${file} must not make network requests`);
}
const packageScript = await read('scripts/package.mjs');
for (const file of [...scripts, 'sidepanel.html', 'sidepanel.css', 'manifest.json']) {
  if (!packageScript.includes(`'${file.replace(/\\/g, '/')}'`)) errors.push(`release package is missing ${file}`);
}

// Links in the README.
const readme = await read('README.md');
for (const match of readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
  const target = match[1].split('#')[0];
  if (target && !/^(?:https?:|mailto:)/i.test(target) && !await exists(target)) errors.push(`README links to a missing file: ${target}`);
}

if (errors.length) {
  console.error(errors.map(error => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validated InboxFoundry v${manifest.version} (${scripts.length} scripts).`);
}
