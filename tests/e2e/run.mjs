// End-to-end suite. Loads the real extension into a fresh temporary browser profile, maps mail.google.com to a
// loopback fixture, and drives the real side panel by clicking its buttons. It never contacts real Gmail.
//   node tests/e2e/run.mjs [scenario-name-filter ...]
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixtureHtml, mkThread } from './fixture.mjs';

const root = process.env.INBOXFOUNDRY_EXTENSION || resolve(import.meta.dirname, '../..');
const CANDIDATES = [
  process.env.INBOXFOUNDRY_CHROME,
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  'chromium', 'chromium-browser', 'brave-browser', 'google-chrome-for-testing'
].filter(Boolean);
const browserPath = CANDIDATES.find(path => spawnSync(path, ['--version'], { stdio: 'ignore' }).status === 0);
if (!browserPath) {
  console.error('No Chromium-family browser found. Set INBOXFOUNDRY_CHROME. Branded Chrome 137+ cannot load unpacked extensions from the command line.');
  process.exit(2);
}
const delay = ms => new Promise(done => setTimeout(done, ms));

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.next = 1;
    this.pending = new Map();
    this.ready = new Promise((ok, no) => {
      this.socket.addEventListener('open', ok, { once: true });
      this.socket.addEventListener('error', () => no(new Error('CDP connection failed')), { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Page.javascriptDialogOpening') {
        this.call('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
        return;
      }
      if (!message.id || !this.pending.has(message.id)) return;
      const entry = this.pending.get(message.id);
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) entry.no(new Error(message.error.message));
      else entry.ok(message.result);
    });
  }

  async call(method, params = {}, timeoutMs = 15000) {
    await this.ready;
    const id = this.next++;
    return new Promise((ok, no) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        no(new Error(`TIMEOUT ${method}`));
      }, timeoutMs);
      this.pending.set(id, { ok, no, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

async function evaluate(client, expression, timeoutMs = 20000) {
  const result = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, timeoutMs);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function waitFor(check, what, timeoutMs = 30000, every = 200) {
  const end = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
    await delay(every);
  }
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function listFiles(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath ?? entry.path, entry.name));
}

async function withBrowser(options, body, flags = []) {
  const temp = await mkdtemp(join(tmpdir(), 'inboxfoundry-e2e-'));
  const key = join(temp, 'k.pem');
  const cert = join(temp, 'c.pem');
  spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-subj', '/CN=mail.google.com', '-addext', 'subjectAltName=DNS:mail.google.com'], { stdio: 'ignore' });
  const hits = [];
  const serverState = { failNext: new Map() };
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    const url = new URL(request.url, 'https://mail.google.com');
    if (url.pathname.startsWith('/tracker') || url.pathname.startsWith('/page') || url.pathname.startsWith('/evil')) {
      hits.push(request.url);
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html>landing');
      return;
    }
    if (url.searchParams.get('view') === 'att') {
      const name = url.searchParams.get('name') || 'file.bin';
      hits.push(`att:${name}`);
      const failures = serverState.failNext.get(name) || 0;
      if (failures > 0) {
        serverState.failNext.set(name, failures - 1);
        response.writeHead(500);
        response.end('nope');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` });
      response.end(`contents of ${name}`);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(fixtureHtml(options));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  const downloads = join(temp, 'downloads');
  const profile = join(temp, 'profile');
  await mkdir(join(profile, 'Default'), { recursive: true });
  await mkdir(downloads);
  await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true }, profile: { default_content_setting_values: { automatic_downloads: 1 } } }));
  const child = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-proxy-server', '--ignore-certificate-errors', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--disable-extensions-except=${root}`, `--load-extension=${root}`, '--host-resolver-rules=MAP mail.google.com 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost', ...flags, `https://mail.google.com:${port}/mail/u/0/#inbox`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const clients = [];
  const track = client => {
    clients.push(client);
    return client;
  };
  try {
    const ws = await waitFor(() => stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1], 'DevTools');
    const base = ws.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '');
    const targets = async () => (await fetch(`${base}/json/list`)).json();
    const browser = track(new Cdp(ws));
    const gmailTarget = await waitFor(async () => (await targets()).find(target => target.type === 'page' && target.url.startsWith('https://mail.google.com:')), 'Gmail page');
    const workerTarget = await waitFor(async () => (await targets()).find(target => target.type === 'service_worker' && target.url.endsWith('/background.js')), 'service worker');
    const gmail = track(new Cdp(gmailTarget.webSocketDebuggerUrl));
    let worker = track(new Cdp(workerTarget.webSocketDebuggerUrl));
    const workerUrl = new URL(workerTarget.url);
    const origin = `${workerUrl.protocol}//${workerUrl.host}`;

    const made = await browser.call('Target.createTarget', { url: `${origin}/sidepanel.html`, background: true });
    const panelTarget = await waitFor(async () => (await targets()).find(target => target.id === made.targetId), 'panel target');
    const panel = track(new Cdp(panelTarget.webSocketDebuggerUrl));
    await panel.call('Page.enable');
    if (!panelTarget.url.includes('sidepanel')) await panel.call('Page.navigate', { url: `${origin}/sidepanel.html` });
    await waitFor(async () => evaluate(panel, `location.href.includes('sidepanel') && document.readyState === 'complete' && !!document.getElementById('start') && typeof activeGmailTab === 'function'`), 'panel ready');
    // A real side panel shares Gmail's window, so Gmail is its active tab. This test page is its own target, so point the lookup there.
    await evaluate(panel, `activeGmailTab = async () => (await chrome.tabs.query({ url: 'https://mail.google.com/*' }))[0]; 0`);

    const ui = {
      click: id => evaluate(panel, `document.getElementById(${JSON.stringify(id)}).click()`),
      set: (id, value) => evaluate(panel, `(() => { const e = document.getElementById(${JSON.stringify(id)}); if (e.type === 'checkbox') e.checked = ${JSON.stringify(value)}; else e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`),
      text: id => evaluate(panel, `document.getElementById(${JSON.stringify(id)}).textContent`),
      visible: id => evaluate(panel, `(() => { const e = document.getElementById(${JSON.stringify(id)}); return !!e && e.getClientRects().length > 0; })()`),
      disabled: id => evaluate(panel, `document.getElementById(${JSON.stringify(id)}).disabled`),
      intent: value => evaluate(panel, `document.querySelector('input[name="intent"][value="${value}"]').click()`),
      formats: values => evaluate(panel, `(() => { for (const i of document.querySelectorAll('#formats input')) i.checked = ${JSON.stringify(values)}.includes(i.value); document.getElementById('formats').dispatchEvent(new Event('change', { bubbles: true })); })()`),
      async consent() {
        await this.click('acknowledge');
        await waitFor(async () => !(await this.disabled('start')), 'Start to enable');
      },
      notice: () => evaluate(panel, `document.getElementById('notice').hidden ? '' : document.getElementById('noticeText').textContent`),
      warnings: () => evaluate(panel, `[...document.querySelectorAll('#warnings li')].map(item => item.textContent)`)
    };
    const job = () => evaluate(panel, `currentJob`);
    const untilJob = async (states, timeoutMs = 60000) => {
      const result = await waitFor(async () => {
        const value = await job();
        return value && states.includes(value.status) ? value : null;
      }, `job state ${states.join('/')}`, timeoutMs, 250);
      await evaluate(panel, `tick()`, 30000);
      return result;
    };
    const directStart = async config => {
      const id = await evaluate(panel, `(async () => { const tab = await activeGmailTab(); const r = await command('START_SCAN', { config: ${JSON.stringify(config)} }, tab.id); await setCurrentJob(r.jobId); return r.jobId; })()`, 30000);
      return id;
    };
    const untilNotice = text => waitFor(async () => (await ui.notice()).includes(text), `notice containing "${text}"`, 60000);
    await body({
      gmail, panel, browser, ui, job, untilJob, directStart, untilNotice, hits, serverState, downloads, port, targets, origin, temp,
      get worker() { return worker; },
      set worker(value) { worker = track(value); }
    });
  } finally {
    clients.forEach(client => client.close());
    child.kill('SIGKILL');
    await new Promise(done => {
      server.close(done);
      server.closeAllConnections?.();
    });
    await delay(150);
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

const SIX = prefix => [...'abcdef'].map(letter => mkThread(`${prefix}${letter}`));
const scenarios = {};
const scenario = (name, options, body, flags) => { scenarios[name] = { options, body, flags }; };

// ---- First use ----

scenario('fresh install: consent is reachable and enables Start', { pages: [[mkThread('a')]] }, async ({ ui, gmail }) => {
  check(await ui.visible('consent'), 'consent card must be visible');
  check(await ui.visible('acknowledge'), 'consent button must be visible');
  check(await ui.disabled('start'), 'Start must wait for consent');
  check(await evaluate(gmail, 'true'), 'gmail alive');
  await ui.consent();
  check(!(await ui.visible('consent')), 'consent hides after accepting');
});

scenario('search form drives the real Gmail query', { pages: [[mkThread('a')]] }, async ({ ui, gmail, untilJob }) => {
  await ui.consent();
  await ui.intent('both');
  await ui.set('fFrom', 'vendor@example.com');
  await ui.set('fKeywords', 'invoice');
  await ui.set('fAfter', '2026-01-01');
  await ui.set('fBefore', '2026-01-31');
  const preview = await ui.text('queryPreview');
  equal(preview, 'invoice from:vendor@example.com after:2026/01/01 before:2026/02/01', 'query preview');
  await ui.click('start');
  await untilJob(['ready']);
  equal(await evaluate(gmail, 'window.__lastSearch'), preview, 'the search Gmail received');
});

scenario('errors stay on screen', { pages: [[mkThread('a')]] }, async ({ ui, panel }) => {
  await ui.consent();
  await ui.set('fAfter', '2026-02-01');
  await ui.set('fBefore', '2026-01-01');
  await ui.click('start');
  await waitFor(async () => (await ui.notice()).includes('after'), 'error notice');
  await delay(4000);
  check((await ui.notice()).includes('after'), 'the error must survive several status polls');
  await evaluate(panel, `document.getElementById('noticeClose').click()`);
  equal(await ui.notice(), '', 'dismiss clears the error');
});

// ---- Finding and saving ----

scenario('nothing downloads before review; only ticked files are saved', {
  pages: [[
    mkThread('one', { subject: 'Invoice one', attachments: [{ name: 'invoice-1.pdf' }, { name: 'photo.png', size: '900 KB' }] }),
    mkThread('two', { subject: 'Invoice two', attachments: [{ name: 'invoice-2.pdf' }] }),
    mkThread('three', { subject: 'No files' })
  ]]
}, async ({ ui, panel, untilJob, untilNotice, hits, downloads, job }) => {
  await ui.consent();
  await ui.set('fFileType', 'pdf');
  await ui.click('start');
  const done = await untilJob(['ready']);
  equal(done.counters.matched, 2, 'threads requiring a matching file');
  equal(hits.filter(hit => hit.startsWith('att:')), [], 'no file may download during the scan');
  const rows = await evaluate(panel, `[...document.querySelectorAll('#fileList .file-row')].map(row => ({ name: row.querySelector('.file-name').textContent, checked: row.querySelector('input')?.checked }))`);
  equal(rows.find(row => row.name === 'photo.png').checked, false, 'non-matching file starts unticked');
  equal(rows.find(row => row.name === 'invoice-1.pdf').checked, true, 'matching file starts ticked');
  await evaluate(panel, `[...document.querySelectorAll('#fileList .file-row')].find(row => row.querySelector('.file-name').textContent === 'invoice-2.pdf').querySelector('input').click()`);
  await delay(200);
  await ui.click('save');
  await untilNotice('Saved to Downloads');
  equal((await job()).status, 'ready', 'job returns to ready');
  equal(hits.filter(hit => hit.startsWith('att:')).sort(), ['att:invoice-1.pdf'], 'only the ticked file downloads');
  const files = await listFiles(downloads);
  check(files.some(file => /InboxFoundry\/Batch 001 [\d-]+\/00001 - Invoice one\/Message-001\/invoice-1\.pdf$/.test(file)), `file in its folder: ${files}`);
  check(files.some(file => file.endsWith('attachments.csv')), 'attachment list saved next to the files');
});

scenario('attachment edge cases: same names, link and click routes, Drive, long names', {
  pages: [[
    mkThread('files', {
      subject: 'Many files',
      attachments: [
        { name: 'report.pdf' },
        { name: 'report.pdf', size: '30 KB' },
        { name: 'via-link.pdf', mode: 'link' },
        { name: 'via-click.pdf', mode: 'click' },
        { name: 'drive-doc.pdf', mode: 'drive' },
        { name: 'nothing.pdf', mode: 'none' },
        { name: `${'very long name '.repeat(20)}.pdf` },
        { name: 'dangerous<>:"|?*name.pdf' }
      ]
    })
  ]]
}, async ({ ui, untilJob, untilNotice, downloads, panel }) => {
  await ui.consent();
  await ui.click('start');
  await untilJob(['ready']);
  const states = await evaluate(panel, `(async () => { const rows = []; for await (const f of jobStore().iterateAttachments(currentJob.id)) rows.push([f.fileName.slice(0, 12), f.state, f.driveLink]); return rows; })().catch(() => null)`.replace('jobStore()', 'store'));
  equal(states.filter(row => row[1] === 'unavailable').length, 2, 'Drive link and uncontrolled file are reported, not lost');
  await ui.click('save');
  await untilNotice('Saved to Downloads');
  const saved = (await listFiles(downloads)).filter(file => /\.pdf$/.test(file));
  equal(saved.length, 6, `six downloadable files saved, including both same-named ones: ${saved}`);
  check(saved.filter(file => /report( \(1\))?\.pdf$/.test(file)).length === 2, 'same-named files are both kept');
  check(saved.some(file => /via-click\.pdf$/.test(file) && file.includes('/Message-001/')), `click route lands in its folder: ${saved}`);
  const longest = saved.map(file => file.slice(file.indexOf('InboxFoundry/'))).sort((a, b) => b.length - a.length)[0];
  check(longest.length <= 200, `paths stay short: ${longest.length}: ${longest}`);
  check(saved.some(file => /very long name.*\.pdf$/.test(file)), 'long name keeps its extension');
});

scenario('failed downloads are reported and retry succeeds', {
  pages: [[mkThread('a', { subject: 'Flaky', attachments: [{ name: 'flaky.pdf' }] })]]
}, async ({ ui, untilJob, untilNotice, serverState, downloads, panel }) => {
  serverState.failNext.set('flaky.pdf', 1);
  await ui.consent();
  await ui.click('start');
  await untilJob(['ready']);
  await ui.click('save');
  await untilNotice('failed');
  check(!(await ui.disabled('retryFailed')), 'retry becomes available');
  equal(await ui.text('filesProblem'), '1', 'problem counted');
  await ui.click('retryFailed');
  await waitFor(async () => (await listFiles(downloads)).some(file => file.endsWith('flaky.pdf')), 'retried file on disk');
  await waitFor(async () => (await evaluate(panel, `store.attachmentCounts(currentJob.id).then(c => c.complete)`)) === 1, 'state becomes complete');
});

// ---- Pagination ----

scenario('all pages: 18 threads across 3 pages with slow page changes', {
  pages: [SIX('p1'), SIX('p2'), SIX('p3')], pageLatencyMs: 400
}, async ({ ui, untilJob, gmail }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  const done = await untilJob(['ready'], 120000);
  equal(done.counters.matched, 18, 'every thread captured');
  equal(done.partialReasons, [], 'complete run is not partial');
  equal(await evaluate(gmail, 'window.__olderPresses'), 2, 'Older pressed exactly once per page');
});

scenario('translated Older label still paginates (German)', {
  pages: [SIX('p1'), SIX('p2')], olderLabel: 'Ältere', lang: 'de', hideRange: true
}, async ({ ui, untilJob }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  const done = await untilJob(['ready'], 90000);
  equal(done.counters.matched, 12, 'both pages captured');
  equal(done.partialReasons, [], 'end confirmed by the disabled button');
});

scenario('unknown language: position-based Older still paginates', {
  pages: [SIX('p1'), SIX('p2')], olderLabel: 'zzqqxx', hideRange: true
}, async ({ ui, untilJob }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  const done = await untilJob(['ready'], 90000);
  equal(done.counters.matched, 12, 'both pages captured');
});

scenario('no Older button at all: URL paging, with the end proven by an empty page', {
  pages: [SIX('p1'), SIX('p2')], noOlderButton: true
}, async ({ ui, untilJob }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  const done = await untilJob(['ready'], 90000);
  equal(done.counters.matched, 12, 'both pages captured');
  equal(done.partialReasons, [], 'empty next page proves the end');
});

scenario('paging impossible: the run says it cannot confirm completeness', {
  pages: [SIX('p1'), SIX('p2')], noOlderButton: true, noUrlPaging: true
}, async ({ ui, untilJob }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  const done = await untilJob(['ready'], 90000);
  equal(done.counters.matched, 6, 'first page captured');
  check(done.partialReasons.includes('pagination-end-unconfirmed'), 'never claims completeness it cannot show');
  check((await ui.warnings()).some(text => text.includes('last page')), 'the user is told');
});

scenario('Gmail tab stays responsive at page boundaries', {
  pages: [SIX('p1'), SIX('p2')], pageLatencyMs: 2500
}, async ({ ui, untilJob, gmail }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    await evaluate(gmail, '1+1', 4000);
    const status = await evaluate(gmail, 'window.__olderPresses');
    if (status > 1) throw new Error('pressed Older more than once for one page');
    const value = await evaluate(gmail, 'location.hash');
    if (value.endsWith('/p2') && (await ui.text('matched')) === '12') break;
    await delay(400);
  }
  await untilJob(['ready'], 30000);
});

// ---- Row identity ----

scenario('identical sender, subject and date are separate threads (IDs on inner element)', {
  pages: [[mkThread('r1', { sender: 'r@x.test', senderName: 'R', subject: 'Daily' }), mkThread('r2', { sender: 'r@x.test', senderName: 'R', subject: 'Daily' }), mkThread('r3', { sender: 'r@x.test', senderName: 'R', subject: 'Daily' }), mkThread('other')]]
}, async ({ ui, untilJob }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  equal((await untilJob(['ready'])).counters.matched, 4, 'all four captured');
});

scenario('no Gmail IDs anywhere: nothing lost across pages', {
  noIds: true,
  pages: [
    [mkThread('a', { sender: 'r@x.test', senderName: 'R', subject: 'Daily' }), mkThread('b', { sender: 'r@x.test', senderName: 'R', subject: 'Daily' })],
    [mkThread('c', { sender: 'r@x.test', senderName: 'R', subject: 'Daily' })]
  ]
}, async ({ ui, untilJob }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  equal((await untilJob(['ready'], 60000)).counters.matched, 3, 'duplicates are kept apart');
});

// ---- Failure handling ----

scenario('an unreadable conversation is skipped, reported and retried', {
  pages: [[mkThread('a'), mkThread('poison', { noBody: true }), mkThread('c')]]
}, async ({ ui, untilJob, job }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  let done = await untilJob(['ready'], 90000);
  equal(done.counters.matched, 2, 'threads after the bad one are captured');
  equal(done.counters.failed, 1, 'the bad one is counted');
  check(done.partialReasons.includes('threads-failed'), 'batch is marked partial');
  check((await ui.warnings()).some(text => text.includes('could not be read')), 'the user is told');
  check(await ui.disabled('resume') === true, 'ready batch has no resume');
  done = await job();
  equal(done.status, 'ready', 'finished');
});

scenario('many failures in a row stop the job instead of walking the mailbox', {
  pages: [[...'abcdefgh'].map(letter => mkThread(`bad${letter}`, { noBody: true }))]
}, async ({ ui, untilJob }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  const done = await untilJob(['failed'], 120000);
  equal(done.counters.failed, 5, 'stops after five in a row');
  check(!(await ui.disabled('resume')), 'can be resumed');
});

scenario('reaching the limit is partial and resumable', {
  pages: [[mkThread('a'), mkThread('b'), mkThread('c')]]
}, async ({ ui, untilJob, untilNotice }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.set('maxThreads', '1');
  await ui.click('start');
  const stopped = await untilJob(['stopped']);
  equal(stopped.counters.matched, 1, 'stops at the limit');
  check(stopped.partialReasons.includes('limit-matched'), 'marked partial');
  await ui.click('resume');
  await untilNotice('Raise');
  await ui.set('maxThreads', '10');
  await ui.click('resume');
  equal((await untilJob(['ready'])).counters.matched, 3, 'resume finishes the rest with no repeats');
});

scenario('Stop then Resume never repeats or loses a thread', {
  pages: [SIX('p1')]
}, async ({ ui, untilJob, panel }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  await waitFor(async () => Number(await ui.text('matched')) >= 1, 'first capture');
  await ui.click('stop');
  const stopped = await untilJob(['stopped']);
  check(stopped.counters.matched < 6, 'stopped early');
  await ui.click('resume');
  const done = await untilJob(['ready'], 60000);
  equal(done.counters.matched, 6, 'all captured once');
  const keys = await evaluate(panel, `(async () => { const k = []; for await (const t of store.iterateThreads(currentJob.id)) k.push(t.threadKey); return k; })()`);
  equal(new Set(keys).size, 6, 'no duplicate rows');
});

scenario('Gmail reload mid-scan: job is interrupted, then resumes without repeats', {
  pages: [SIX('p1')]
}, async ({ ui, untilJob, gmail, panel }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  await waitFor(async () => Number(await ui.text('matched')) >= 2, 'captures');
  await gmail.call('Page.reload', { ignoreCache: true });
  const interrupted = await untilJob(['interrupted'], 30000);
  check(interrupted.lastError.includes('reloaded'), 'explains what happened');
  await delay(500);
  await ui.click('resume');
  const done = await untilJob(['ready'], 60000);
  equal(done.counters.matched, 6, 'finishes all');
  const keys = await evaluate(panel, `(async () => { const k = []; for await (const t of store.iterateThreads(currentJob.id)) k.push(t.threadKey); return k; })()`);
  equal(new Set(keys).size, 6, 'no repeats');
});

scenario('service worker restart mid-scan does not disturb the job', {
  pages: [SIX('p1')]
}, async ctx => {
  const { ui, untilJob, browser, targets } = ctx;
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  await waitFor(async () => Number(await ui.text('matched')) >= 1, 'first capture');
  const worker = (await targets()).find(target => target.type === 'service_worker');
  await browser.call('Target.closeTarget', { targetId: worker.id });
  equal((await untilJob(['ready'], 60000)).counters.matched, 6, 'job finishes');
});

scenario('moving Gmail to another list mid-scan does not mix mail', {
  pages: [SIX('p1')]
}, async ({ ui, untilJob, gmail }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  await waitFor(async () => Number(await ui.text('matched')) >= 1, 'first capture');
  await evaluate(gmail, `location.hash = '#sent'`);
  await delay(100);
  await evaluate(gmail, `location.hash = '#sent'`);
  const stopped = await untilJob(['interrupted'], 30000);
  check(stopped.lastError.includes('different list'), `explains: ${stopped.lastError}`);
  check(stopped.counters.matched < 6, 'stopped before finishing');
  await ui.click('resume');
  equal((await untilJob(['ready'], 60000)).counters.matched, 6, 'resume returns to the list and finishes');
});

scenario('a second Gmail tab cannot run alongside the first', {
  pages: [SIX('p1')]
}, async ({ ui, browser, targets, port, panel, job }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  await waitFor(async () => Number(await ui.text('matched')) >= 1, 'first capture');
  const second = await browser.call('Target.createTarget', { url: `https://mail.google.com:${port}/mail/u/0/#inbox`, background: true });
  await waitFor(async () => (await targets()).some(target => target.id === second.targetId && target.url.includes('mail.google')), 'second tab');
  await delay(800);
  const firstJob = (await job()).id;
  const result = await evaluate(panel, `(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
    const other = tabs.find(tab => tab.id !== currentJob.ownerTabId);
    await ensureInjected(other.id);
    return chrome.tabs.sendMessage(other.id, { type: 'START_SCAN', config: readConfig() });
  })()`, 30000);
  equal(result.ok, false, 'second job refused');
  check(result.error.includes('another Gmail tab'), `explains: ${result.error}`);
  equal((await job()).id, firstJob, 'first job unaffected');
});

scenario('empty view reports no rows instead of failing or claiming success', {
  pages: [[]]
}, async ({ ui, untilJob }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  const done = await untilJob(['ready'], 30000);
  equal(done.counters.inspected, 0, 'nothing opened');
  check(done.partialReasons.includes('no-rows-found'), 'reported');
});

// ---- Mail content the page can present ----

scenario('links in an email body are never clicked or treated as files', {
  pages: [[mkThread('news', {
    subject: 'Newsletter',
    bodyHtml: '<a href="/tracker?a" target="_blank" title="Download our app">Get it</a> <a href="/tracker?b" target="_blank"><img title="Download on the App Store" alt="b" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a> <a href="/tracker?c" target="_blank" aria-label="Download the report">x</a> <a href="/evil.bin" download="payroll.pdf">y</a> <div class="aZo" download_url="application/pdf:fake.pdf:https://mail.google.com/evil">z</div>'
  })]]
}, async ({ ui, untilJob, untilNotice, gmail, hits, panel }) => {
  await ui.consent();
  await ui.intent('both');
  await ui.click('start');
  await untilJob(['ready']);
  const count = await evaluate(panel, `store.attachmentCounts(currentJob.id).then(c => Object.values(c).reduce((a, b) => a + b, 0))`);
  equal(count, 0, 'nothing in the body counts as an attachment');
  await ui.click('save');
  await untilNotice('Saved to Downloads');
  equal(await evaluate(gmail, 'window.__linkClicks'), 0, 'no link was clicked');
  equal(hits, [], 'no sender URL was contacted');
});

scenario('long collapsed threads are expanded; an unreadable message is flagged', {
  pages: [[
    mkThread('long', { collapseAfterFirst: true, messages: [{ body: 'one' }, { body: 'two' }, { body: 'three' }, { body: 'four' }, { body: 'five' }] }),
    mkThread('holes', { messages: [{ body: 'visible' }, { hiddenUnreadable: true }] })
  ]]
}, async ({ ui, untilJob, panel }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  const done = await untilJob(['ready'], 60000);
  const threads = await evaluate(panel, `(async () => { const t = []; for await (const r of store.iterateThreads(currentJob.id)) t.push([r.threadKey, r.messageCount, r.warnings]); return t; })()`);
  equal(threads.find(row => row[0] === 'long')[1], 5, 'all five messages captured');
  check(threads.find(row => row[0] === 'holes')[2].length > 0, 'missing message flagged');
  equal(done.counters.incomplete, 1, 'counted as incomplete');
  check(done.partialReasons.includes('threads-incomplete'), 'batch marked partial');
});

scenario('reading pane layout works', {
  readingPane: true, pages: [SIX('p1'), SIX('p2')]
}, async ({ ui, untilJob, panel }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  const done = await untilJob(['ready'], 90000);
  equal(done.counters.matched, 12, 'every thread captured');
  const subjects = await evaluate(panel, `(async () => { const s = []; for await (const r of store.iterateRecords(currentJob.id)) s.push(r.record.subject + '|' + r.record.messages[0].bodyTextRaw); return s; })()`);
  check(subjects.every(value => value.includes(value.split('|')[0])), 'each record holds its own body, never the previous pane');
  equal(new Set(subjects).size, 12, 'no record repeats another');
});

scenario('an unread search that shrinks while reading loses nothing', {
  unreadView: true, pageSize: 4, pages: [[...'abcdefghijklmn'].map(letter => mkThread(letter, { unread: true }))]
}, async ({ ui, untilJob }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.set('customQuery', 'is:unread');
  await ui.click('start');
  const done = await untilJob(['ready'], 150000);
  equal(done.counters.matched, 14, 'all unread mail captured');
  equal(done.counters.unread, 14, 'unread count kept');
  check((await ui.warnings()).some(text => text.includes('marked as read')), 'the read-state change is stated');
});

scenario('localized dates parse; date filter never drops mail it cannot read', {
  lang: 'fr',
  pages: [[
    mkThread('fr', { date: 'sam. 29 août 2026, 10:32' }),
    mkThread('old', { date: 'lun. 5 janv. 2015, 08:00' }),
    mkThread('mystery', { date: 'not a date at all', messages: [{ id: 'zz', body: 'x', date: '???' }] })
  ]]
}, async ({ untilJob, directStart, ui, panel }) => {
  await ui.consent();
  await directStart({ source: { mode: 'current-page', pacingMs: 50 }, email: { dateFrom: '2026-01-01', dateTo: '2026-12-31' }, attachments: { action: 'none' } });
  const done = await untilJob(['ready']);
  const rows = await evaluate(panel, `(async () => { const r = []; for await (const t of store.iterateThreads(currentJob.id)) r.push([t.threadKey, t.outcome, t.date, t.warnings]); return r; })()`);
  equal(rows.find(row => row[0] === 'fr')[1], 'matched', 'French date inside the range is kept');
  check(rows.find(row => row[0] === 'fr')[2].startsWith('2026-08-29'), `French date read correctly: ${rows.find(row => row[0] === 'fr')[2]}`);
  equal(rows.find(row => row[0] === 'old')[1], 'rejected', 'French date outside the range is rejected');
  equal(rows.find(row => row[0] === 'mystery')[1], 'matched', 'an unreadable date is kept, not dropped');
  check(rows.find(row => row[0] === 'mystery')[3].includes('date-unverified'), 'and flagged');
  equal(done.counters.matched, 2, 'counts');
});

// ---- Repeat exports ----

scenario('repeat exports skip saved mail forever, but pick up new replies', {
  pages: [[mkThread('a', { messages: [{ id: '18f0000000000001', body: 'first' }] }), mkThread('b'), mkThread('c')]]
}, async ({ ui, untilJob, untilNotice, gmail, job, panel }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.set('incremental', true);
  const counts = [];
  for (let round = 0; round < 3; round++) {
    const previous = (await job())?.id;
    await ui.click('start');
    await waitFor(async () => (await job())?.id !== previous, 'new batch');
    const done = await untilJob(['ready']);
    counts.push(done.counters.matched);
    await ui.click('save');
    await untilNotice('Saved to Downloads');
    await evaluate(panel, `document.getElementById('noticeClose').click()`);
    await waitFor(async () => !(await ui.disabled('start')), 'Start after saving');
  }
  equal(counts, [3, 0, 0], 'saved mail is skipped in every later batch, not only the next one');
  await evaluate(gmail, `(() => { O.pages[0][0].messages.push({ id: '18f0000000000002', body: 'a new reply' }); __rerender(); })()`);
  const previous = (await job()).id;
  await ui.click('start');
  await waitFor(async () => (await job())?.id !== previous, 'new batch');
  const done = await untilJob(['ready']);
  equal(done.counters.matched, 1, 'a thread with a new reply is exported again');
});

scenario('no batch is ever deleted automatically', {
  pages: [[mkThread('a')]]
}, async ({ ui, untilJob, job, panel }) => {
  await ui.consent();
  await ui.intent('emails');
  for (let round = 0; round < 5; round++) {
    const previous = (await job())?.id;
    await ui.click('start');
    await waitFor(async () => (await job())?.id !== previous, 'new batch');
    await untilJob(['ready']);
  }
  equal(await evaluate(panel, `store.listJobs().then(j => j.length)`), 5, 'all five batches kept');
});

// ---- Output ----

const UNICODE_THREAD = mkThread('uni', {
  subject: 'Résumé — नमस्ते — 日本語 <b>&amp;',
  senderName: 'Zoë Müller',
  sender: 'zoe@example.test',
  messages: [{ id: '18f0000000000011', body: 'Grüße aus München. यह एक परीक्षण है। これはテストです。\n=SUM(A1)', attachments: [{ name: 'résumé.pdf' }] }, { id: '18f0000000000012', body: 'Reply', date: 'Sat, Aug 30, 2026, 9:00 AM' }]
});

scenario('every format is correct, including non-Latin text', { pages: [[UNICODE_THREAD, mkThread('b')]] }, async ({ ui, untilJob, untilNotice, downloads, temp }) => {
  await ui.consent();
  await ui.intent('both');
  await ui.click('start');
  await untilJob(['ready']);
  await ui.formats(['archive', 'html', 'csv', 'json', 'mbox', 'emlzip', 'manifest']);
  await ui.click('save');
  await untilNotice('Saved to Downloads');
  const files = await listFiles(downloads);
  const find = name => {
    const hit = files.find(file => file.endsWith(`/${name}`));
    check(hit, `${name} missing from ${files}`);
    return hit;
  };
  const json = JSON.parse(await readFile(find('emails.json'), 'utf8'));
  equal(json.formatVersion, 3, 'format version');
  equal(json.threads.length, 2, 'threads');
  equal(json.job.isPartial, false, 'complete');
  check(json.threads[0].messages[0].bodyTextRaw.includes('नमस्ते') === false && json.threads[0].messages[0].bodyTextRaw.includes('यह एक'), 'Hindi body intact');
  check(json.threads[0].messages[0].fromName === 'Zoë Müller', 'display name kept');
  equal(json.threads[0].messages[0].dateIso.slice(0, 10), '2026-08-29', 'date');
  check(!('rawThreadText' in json.threads[0]) && !('bodyTextNormalized' in json.threads[0].messages[0]), 'no duplicated bodies');
  const hash = createHash('sha256').update(JSON.stringify(json.threads[0])).digest('hex');
  equal(json.integrity.threads[0].sha256, hash, 'per-thread hash verifies');

  const html = await readFile(find('emails.html'), 'utf8');
  check(html.includes('これはテストです') && html.includes('&lt;b&gt;') && !html.includes('<b>&amp;'), 'HTML escaped and Unicode intact');
  const csv = await readFile(find('emails.csv'), 'utf8');
  check(csv.startsWith('﻿') && csv.includes('Grüße'), 'CSV has a BOM for spreadsheets');
  const mbox = await readFile(find('emails.mbox'), 'utf8');
  check((mbox.match(/^From /gm) || []).length === 3, 'three messages in MBOX');
  const ids = [...mbox.matchAll(/^Message-ID: (.*)\r$/gm)].map(match => match[1]);
  equal(new Set(ids).size, 3, 'unique message IDs');
  check(mbox.includes('From: =?UTF-8?B?') && mbox.includes('In-Reply-To:'), 'names encoded, thread linked');
  check(mbox.includes('Date: Sat, 29 Aug 2026') || mbox.includes('Date: Fri, 28 Aug 2026'), 'real date, not the export date');
  const manifest = await readFile(find('attachments.csv'), 'utf8');
  check(manifest.includes('résumé.pdf') && manifest.includes('complete'), 'file list has final state');

  for (const zipFile of [find('archive.zip'), find('emails-eml.zip')]) {
    const target = join(temp, `unzipped-${zipFile.split('/').pop()}`);
    await mkdir(target);
    // Python rather than macOS unzip, which can't create non-ASCII folder names.
    const unzip = spawnSync('python3', ['-m', 'zipfile', '-e', zipFile, target], { encoding: 'utf8' });
    equal(unzip.status, 0, `extract ${zipFile}: ${unzip.stderr}`);
    const sums = await readFile(join(target, 'CHECKSUMS.sha256'), 'utf8');
    for (const line of sums.trim().split('\n')) {
      const [expected, name] = [line.slice(0, 64), line.slice(66)];
      equal(createHash('sha256').update(await readFile(join(target, name))).digest('hex'), expected, `checksum of ${name}`);
    }
  }
});

scenario('privacy options remove what they promise', {
  pages: [[mkThread('p', { sender: 'alice@secret.test', messages: [{ body: 'Contact bob@secret.test now', bodyHtml: '<a href="mailto:bob@secret.test">bob@secret.test</a>' }] })]]
}, async ({ ui, untilJob, untilNotice, downloads }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.set('fFrom', 'alice@secret.test');
  await ui.set('redactAddresses', true);
  await ui.click('start');
  await untilJob(['ready']);
  await ui.formats(['json']);
  await ui.click('save');
  await untilNotice('Saved to Downloads');
  const file = (await listFiles(downloads)).find(name => name.endsWith('emails.json'));
  const text = await readFile(file, 'utf8');
  check(!text.includes('secret.test'), `no address may remain anywhere: ${text.match(/.{40}secret\.test.{20}/)?.[0]}`);
  check(text.includes('redacted-email'), 'placeholders present');
});

scenario('encryption writes no plain copy and decrypts back', {
  pages: [[mkThread('s', { messages: [{ body: 'top secret body' }] })]]
}, async ({ ui, untilJob, untilNotice, downloads, panel }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  await untilJob(['ready']);
  await ui.formats(['archive', 'csv']);
  await ui.set('encryptExport', true);
  await ui.set('encryptionPassphrase', 'short');
  await ui.click('save');
  await untilNotice('at least 10');
  await ui.set('encryptionPassphrase', 'correct horse battery');
  await ui.click('save');
  await untilNotice('Saved to Downloads');
  const files = await listFiles(downloads);
  equal(files.filter(file => /\.(zip|csv|json|html|mbox)$/.test(file)), [], 'no plain files');
  const encrypted = files.find(file => file.endsWith('.ifenc'));
  check(encrypted, 'encrypted file exists');
  const bytes = await readFile(encrypted);
  check(!bytes.includes('top secret body'), 'content is really encrypted');
  const base64 = bytes.toString('base64');
  const roundTrip = async passphrase => evaluate(panel, `(async () => {
    const raw = Uint8Array.from(atob(${JSON.stringify(base64)}), c => c.charCodeAt(0));
    try {
      const result = await exportEngine.decryptBlob(new Blob([raw]), ${JSON.stringify(passphrase)});
      return Array.from(new Uint8Array(await result.blob.arrayBuffer())).length;
    } catch { return 'rejected'; }
  })()`, 60000);
  equal(await roundTrip('the wrong passphrase'), 'rejected', 'wrong passphrase refused');
  check(await roundTrip('correct horse battery') > 100, 'right passphrase works');
  const truncated = await evaluate(panel, `(async () => {
    const raw = Uint8Array.from(atob(${JSON.stringify(base64)}), c => c.charCodeAt(0));
    try { await exportEngine.decryptBlob(new Blob([raw.slice(0, raw.length - 20)]), 'correct horse battery'); return 'accepted'; } catch { return 'rejected'; }
  })()`, 60000);
  equal(truncated, 'rejected', 'a damaged file is refused');
});

scenario('large job: 2,000 stored conversations export without the 64 MiB message limit', {
  pages: [[mkThread('a')]]
}, async ({ ui, untilJob, untilNotice, panel, downloads }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  await untilJob(['ready']);
  await evaluate(panel, `(async () => {
    const body = 'x'.repeat(100000);
    const job = currentJob;
    for (let i = 0; i < 2000; i++) {
      const id = job.id + ':bulk' + i;
      await store.putThreadBundle({
        thread: { id, jobId: job.id, seq: 10 + i, threadKey: 'bulk' + i, outcome: 'matched', subject: 'Bulk ' + i, messageCount: 1 },
        record: { id, jobId: job.id, seq: 10 + i, record: { recordId: 'r' + i, subject: 'Bulk ' + i, messages: [{ index: 1, from: 'a@b.test', bodyTextRaw: body }] } }
      });
    }
    await store.patchJob(job.id, { counters: { ...job.counters, matched: 2001 } });
  })()`, 180000);
  await ui.formats(['json']);
  await ui.click('save');
  await untilNotice('Saved to Downloads');
  const file = (await listFiles(downloads)).find(name => name.endsWith('emails.json'));
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  equal(parsed.threads.length, 2001, 'all conversations exported');
  check(await evaluate(panel, `document.querySelectorAll('#threadList .file-row').length <= 400`), 'review list is paged, not all rendered');
});

// ---- Filters and safety ----

scenario('wildcard rules work and cannot freeze the page', { pages: [[mkThread('a', { messages: [{ body: `order 123-INV here ${'a'.repeat(200000)}` }] })]] }, async ({ ui, untilJob, gmail }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.set('matchType', 'wildcard');
  await ui.set('includeTerms', '*a*a*a*a*a*a*a*b');
  await ui.click('start');
  const none = await untilJob(['ready']);
  equal(none.counters.matched, 0, 'no false match');
  await evaluate(gmail, '1+1', 3000);
  await ui.set('includeTerms', 'order*-INV');
  await ui.click('start');
  await waitFor(async () => (await ui.text('matched')) === '1', 'wildcard match', 30000);
});

scenario('page-provided text cannot break the panel', {
  pages: [[mkThread('xss', { subject: '<img src=x onerror="window.__pwned=1">', senderName: '"><script>window.__pwned=1</script>', attachments: [{ name: '<img src=x onerror=window.__pwned=1>.pdf' }] })]]
}, async ({ ui, untilJob, panel }) => {
  await ui.consent();
  await ui.intent('both');
  await ui.click('start');
  await untilJob(['ready']);
  await delay(300);
  equal(await evaluate(panel, 'window.__pwned ?? null'), null, 'nothing executed');
  check(await evaluate(panel, `document.querySelector('#threadList img') === null && document.querySelector('#fileList img') === null`), 'markup rendered as text');
});

scenario('selected rows and open conversation scopes', {
  pages: [[mkThread('tick1', { ticked: true }), mkThread('skip'), mkThread('tick2', { ticked: true })]]
}, async ({ ui, untilJob, gmail, job }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.set('scopeMode', 'selected');
  await ui.click('start');
  const first = await untilJob(['ready']);
  equal(first.counters.matched, 2, 'only ticked rows');
  await evaluate(gmail, `document.querySelector('tr.zA').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await waitFor(async () => evaluate(gmail, `!!document.querySelector('#views > div:not(.hidden) h2.hP')`), 'thread open');
  await ui.set('scopeMode', 'current-thread');
  await ui.click('start');
  await waitFor(async () => (await job()).id !== first.id, 'second batch');
  equal((await untilJob(['ready'])).counters.matched, 1, 'the open conversation only');
});

scenario('compatibility check reports counts and no mail content', {
  pages: [[mkThread('a', { subject: 'SECRET SUBJECT', messages: [{ body: 'SECRET BODY', attachments: [{ name: 'SECRET.pdf' }] }] })]]
}, async ({ ui, gmail }) => {
  await ui.consent();
  await ui.click('checkCompat');
  await waitFor(() => ui.visible('compatReport'), 'report');
  const listReport = JSON.parse(await ui.text('compatReport'));
  equal(listReport.list.rowsVisible, 1, 'row seen');
  equal(listReport.list.rowsWithGmailId, 1, 'id seen');
  await evaluate(gmail, `document.querySelector('tr.zA').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await waitFor(async () => evaluate(gmail, `!!document.querySelector('#views > div:not(.hidden) h2.hP')`), 'thread open');
  await ui.click('checkCompat');
  await waitFor(async () => (await ui.text('compatReport')).includes('conversation"'), 'conversation report');
  const text = await ui.text('compatReport');
  const report = JSON.parse(text);
  equal(report.conversation.attachmentsWithDirectUrl, 1, 'attachment url seen');
  check(!text.includes('SECRET'), 'no content in the report');
  await ui.click('copyDiagnostics');
  await waitFor(async () => (await ui.text('compatReport')).includes('extensionVersion'), 'diagnostics');
  check(!(await ui.text('compatReport')).includes('SECRET'), 'no content in diagnostics');
});

scenario('dark mode keeps text readable', { pages: [[mkThread('a')]] }, async ({ panel }) => {
  await panel.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await delay(200);
  const pairs = await evaluate(panel, `(() => {
    const lum = text => { const [r, g, b] = text.match(/[\\d.]+/g).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const bg = el => { for (let n = el; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (!/rgba\\(0, 0, 0, 0\\)|transparent/.test(c)) return c; } return 'rgb(255,255,255)'; };
    return ['#searchSection h2', '#start', '#resume', '#stop', '#fFrom', '.micro', '.eyebrow', 'label'].map(selector => { const el = document.querySelector(selector); return [selector, contrast(getComputedStyle(el).color, bg(el))]; });
  })()`);
  for (const [selector, ratio] of pairs) check(ratio >= 4.5, `${selector} contrast is ${ratio.toFixed(2)}`);
});

scenario('a list that is slow to come back loses nothing', { pages: [SIX('p1')], blackout: { afterOpens: 3, ms: 9000 } }, async ({ ui, untilJob }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  const done = await untilJob(['ready'], 90000);
  equal(done.counters.matched, 6, 'every thread captured after the list returned');
  equal(done.partialReasons, [], 'complete');
});

scenario('a list that never comes back is reported, not called complete', { pages: [SIX('p1')], blackout: { afterOpens: 3, ms: 100000000 } }, async ({ ui, untilJob }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  const done = await untilJob(['ready'], 90000);
  equal(done.counters.matched, 3, 'what was captured is kept');
  check(done.partialReasons.includes('pagination-end-unconfirmed'), `marked partial: ${done.partialReasons}`);
  check((await ui.warnings()).some(text => text.includes('last page')), 'the user is told');
});

scenario('a row that opens an already captured conversation is reported', { pages: [[mkThread('a'), mkThread('wrong', { opensAs: 'a' }), mkThread('c')]] }, async ({ ui, untilJob }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  const done = await untilJob(['ready'], 60000);
  equal(done.counters.matched, 2, 'the repeat is not stored twice');
  check(done.partialReasons.includes('rows-opened-same-conversation'), `marked partial: ${done.partialReasons}`);
  check((await ui.warnings()).some(text => text.includes('already captured')), 'the user is told');
});

scenario('many threads with similar IDs are all captured', { pages: [[...Array(25).keys()].map(index => mkThread(`n${index}`))] }, async ({ ui, untilJob }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.set('pacingMs', '100');
  await ui.click('start');
  const done = await untilJob(['ready'], 120000);
  equal([done.counters.matched, done.partialReasons], [25, []], 'all captured');
});

scenario('a hidden Gmail tab keeps working', { pages: [SIX('p1'), SIX('p2')] }, async ({ ui, untilJob, gmail, panel, browser, targets }) => {
  await ui.consent();
  await ui.intent('emails');
  await ui.click('start');
  await waitFor(async () => Number(await ui.text('matched')) >= 1, 'first capture');
  const page = (await targets()).find(target => target.url.includes('sidepanel'));
  await browser.call('Target.activateTarget', { targetId: page.id });
  await evaluate(panel, '0');
  const hidden = await evaluate(gmail, 'document.hidden');
  equal((await untilJob(['ready'], 120000)).counters.matched, 12, `finishes (document.hidden was ${hidden})`);
});

// Over five minutes hidden, past the point where Chrome limits timers to one a minute. Run with INBOXFOUNDRY_SLOW=1.
if (process.env.INBOXFOUNDRY_SLOW) {
  scenario('tab hidden for over six minutes keeps working', { pages: [[...Array(190).keys()].map(index => mkThread(`slow${index}`))] }, async ({ ui, untilJob, gmail, panel, browser, targets }) => {
    await ui.consent();
    await ui.intent('emails');
    await ui.set('pacingMs', '2000');
    await ui.click('start');
    await waitFor(async () => Number(await ui.text('matched')) >= 1, 'first capture');
    const page = (await targets()).find(target => target.url.includes('sidepanel'));
    await browser.call('Target.activateTarget', { targetId: page.id });
    await evaluate(panel, '0');
    console.log(`        document.hidden = ${await evaluate(gmail, 'document.hidden')}`);
    // Measures whether the browser really throttled this hidden page's own timers.
    await evaluate(gmail, `(() => { window.__maxGap = 0; let last = Date.now(); const tick = () => { const now = Date.now(); window.__maxGap = Math.max(window.__maxGap, now - last); last = now; setTimeout(tick, 1000); }; tick(); })()`);
    const done = await untilJob(['ready', 'failed'], 2400000);
    const evidence = await evaluate(panel, `(async () => { const o = {}; for await (const t of store.iterateThreads(currentJob.id)) o[t.outcome] = (o[t.outcome] || 0) + 1; return { outcomes: o, counters: currentJob.counters, events: (await store.getEvents(currentJob.id)).slice(-6).map(e => [e.type, e.detail]) }; })()`);
    const page2 = await evaluate(gmail, `({ hash: location.hash, rows: document.querySelectorAll('tr.zA').length, opens: window.__opens, maxPageTimerGapMs: window.__maxGap, olderDisabled: document.getElementById('older')?.getAttribute('aria-disabled'), toolbar: document.getElementById('toolbar').textContent.slice(0, 40) })`, 120000).catch(error => String(error));
    console.log(`        evidence ${JSON.stringify(evidence)}\n        page ${JSON.stringify(page2)}`);
    equal([done.status, done.counters.matched, done.partialReasons], ['ready', 190, []], `finished everything, failed=${done.counters.failed}`);
  });
}

if (process.env.INBOXFOUNDRY_SHOTS) {
  scenario('screenshots', { pages: [[mkThread('one', { subject: 'Invoice for August', attachments: [{ name: 'invoice.pdf' }, { name: 'company-logo.png', size: '12 KB' }] }), mkThread('two', { subject: 'Signed contract', unread: true, attachments: [{ name: 'contract.pdf' }] })]] }, async ({ ui, panel, browser, untilJob, targets }) => {
    const page = (await targets()).find(target => target.url.includes('sidepanel'));
    const shot = async name => {
      await browser.call('Target.activateTarget', { targetId: page.id });
      await panel.call('Emulation.setDeviceMetricsOverride', { width: 400, height: 1300, deviceScaleFactor: 1, mobile: false });
      await delay(400);
      const { data } = await panel.call('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(process.env.INBOXFOUNDRY_SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
    };
    await panel.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await shot('1-first-run');
    await ui.consent();
    await ui.set('fFrom', 'vendor@example.com');
    await ui.set('fKeywords', 'invoice');
    await shot('2-search');
    await ui.click('start');
    await untilJob(['ready']);
    await delay(500);
    await evaluate(panel, `document.getElementById('searchSection').hidden = true`);
    await shot('3-review');
    await panel.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await shot('4-review-dark');
  });
}

// ---- Runner ----

const filters = process.argv.slice(2).map(value => value.toLowerCase());
const names = Object.keys(scenarios).filter(name => !filters.length || filters.some(filter => name.toLowerCase().includes(filter)));
const failures = [];
const started = Date.now();
for (const name of names) {
  const { options, body, flags } = scenarios[name];
  const t0 = Date.now();
  try {
    await withBrowser(options, body, flags);
    console.log(`  pass  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (error) {
    failures.push(name);
    console.log(`  FAIL  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)\n        ${String(error.message).split('\n').slice(0, 4).join('\n        ')}`);
  }
}
console.log(`\n${names.length - failures.length}/${names.length} passed in ${((Date.now() - started) / 1000).toFixed(0)}s using ${browserPath}`);
process.exit(failures.length ? 1 : 0);
