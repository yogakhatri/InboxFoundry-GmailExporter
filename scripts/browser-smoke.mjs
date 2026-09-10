import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const chromeCandidates = [...new Set([
  process.env.INBOXFOUNDRY_CHROME,
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'brave-browser',
  'brave-browser-stable',
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'BraveSoftware/Brave-Browser/Application/brave.exe') : null,
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null,
  process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'BraveSoftware/Brave-Browser/Application/brave.exe') : null,
  process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe') : null
].filter(Boolean))];

const fixtureThreads = [
  {
    id: 'thread-invoice-001',
    subject: 'Invoice 1042 for August',
    sender: 'billing@example.test',
    date: 'Sat, 30 Aug 2026 09:00:00 +0530',
    body: 'Please review invoice 1042. Payment is due next week.',
    attachment: 'invoice-1042.pdf'
  },
  {
    id: 'thread-newsletter-002',
    subject: 'Weekly product newsletter',
    sender: 'news@example.test',
    date: 'Sat, 30 Aug 2026 10:00:00 +0530',
    body: 'Here are this week’s product updates.',
    attachment: 'header-image.png'
  },
  {
    id: 'thread-invoice-003',
    subject: 'Invoice 1043 approved',
    sender: 'accounts@example.test',
    date: 'Sat, 30 Aug 2026 11:00:00 +0530',
    body: 'Invoice 1043 has been approved for payment.',
    attachment: 'invoice-1043.xlsx'
  }
];

function fixtureHtml() {
  const data = JSON.stringify(fixtureThreads).replace(/</g, '\\u003c');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Synthetic Gmail fixture</title>
<style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse;width:100%}td{padding:10px;border-bottom:1px solid #ddd}.message{padding:16px;border:1px solid #ddd}.a3s{white-space:pre-wrap}.aQH{margin-top:12px}</style>
</head><body><main id="app"></main><script>
const threads=${data};
const app=document.querySelector('#app');
const esc=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function list(){
  document.title='Inbox - Synthetic Gmail';
  app.innerHTML='<h1>Inbox</h1><table><tbody>'+threads.map(thread=>
    '<tr class="zA" data-legacy-thread-id="'+esc(thread.id)+'" tabindex="0">'+
    '<td><span class="zF" email="'+esc(thread.sender)+'">'+esc(thread.sender)+'</span></td>'+
    '<td><span class="bog">'+esc(thread.subject)+'</span></td><td><span class="xW">Aug 30</span></td></tr>'
  ).join('')+'</tbody></table>';
  app.querySelectorAll('tr.zA').forEach(row=>row.addEventListener('click',()=>{location.hash='#thread/'+row.dataset.legacyThreadId;}));
}
function thread(id){
  const item=threads.find(value=>value.id===id);
  if(!item){list();return;}
  document.title=item.subject+' - Synthetic Gmail';
  app.innerHTML='<button role="button" aria-label="Back to inbox">Back</button><h2 class="hP">'+esc(item.subject)+'</h2>'+
    '<div role="listitem" class="message" data-thread-perm-id="'+esc(item.id)+'" data-legacy-message-id="message-'+esc(item.id)+'">'+
    '<div class="gE"><span class="gD" email="'+esc(item.sender)+'">'+esc(item.sender)+'</span> to <span class="g2" email="owner@example.test">owner@example.test</span></div>'+
    '<span class="g3" title="'+esc(item.date)+'">Aug 30</span><div class="a3s">'+esc(item.body)+'</div>'+
    '<div class="aQH" data-attachment-id="attachment-'+esc(item.id)+'"><span class="aV3" data-attachment-name="'+esc(item.attachment)+'">'+esc(item.attachment)+'</span> 24 KB</div></div>';
  app.querySelector('button').addEventListener('click',()=>{location.hash='#inbox';});
}
function render(){const prefix='#thread/';location.hash.startsWith(prefix)?thread(decodeURIComponent(location.hash.slice(prefix.length))):list();}
addEventListener('hashchange',render);if(!location.hash)location.hash='#inbox';render();
</script></body></html>`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error(`CDP connection timed out: ${url}`)), 10000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolveReady(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); rejectReady(new Error(`CDP connection failed: ${url}`)); }, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve: resolveCall, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolveCall(message.result);
    });
  }

  async call(method, params = {}, timeoutMs = 15000) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveCall, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(client, expression, timeoutMs = 30000) {
  const result = await client.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  }, timeoutMs);
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'unknown exception';
    throw new Error(`Browser evaluation failed: ${detail}`);
  }
  return result.result?.value;
}

async function waitFor(fn, description, timeoutMs = 20000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function targets(baseUrl) {
  const response = await fetch(`${baseUrl}/json/list`);
  if (!response.ok) throw new Error(`Could not list Chrome targets (${response.status})`);
  return response.json();
}

async function targetClient(baseUrl, predicate, description, timeoutMs = 20000) {
  const target = await waitFor(async () => (await targets(baseUrl)).find(predicate), description, timeoutMs);
  return { target, client: new CdpClient(target.webSocketDebuggerUrl) };
}

function extensionCall(message) {
  return `(async()=>{
    const tabs=await chrome.tabs.query({url:'https://mail.google.com/*'});
    if(!tabs.length) throw new Error('Synthetic Gmail tab not found');
    return chrome.tabs.sendMessage(tabs[0].id,${JSON.stringify(message)});
  })()`;
}

async function runBrowser(browserPath, port, profileDir) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-quic',
    '--metrics-recording-only',
    '--no-proxy-server',
    '--ignore-certificate-errors',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--host-resolver-rules=MAP mail.google.com 127.0.0.1, EXCLUDE localhost',
    `https://mail.google.com:${port}/mail/u/0/#inbox`
  ];
  const child = spawn(browserPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });

  try {
    const wsUrl = await waitFor(() => stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], 'Chrome DevTools endpoint', 15000);
    const baseUrl = wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '');
    const browser = new CdpClient(wsUrl);
    const gmail = await targetClient(baseUrl, target => target.type === 'page' && target.url.startsWith('https://mail.google.com:'), 'synthetic Gmail page');
    const worker = await targetClient(baseUrl, target => target.type === 'service_worker' && target.url.endsWith('/background.js'), 'InboxFoundry service worker');

    await evaluate(worker.client, `chrome.storage.local.set({inboxFoundryPrivacyAcknowledgedV1:true})`);
    await waitFor(async () => {
      const value = await evaluate(worker.client, extensionCall({ type: 'GET_STATUS' }));
      return value?.ok && value.jobStatus === 'idle' ? value : null;
    }, 'content script readiness');

    const config = {
      source: { mode: 'current-page', pacingMs: 1200, maxMatchedThreads: 250 },
      email: {
        includeTerms: ['invoice'], includeMode: 'any', fields: ['subject', 'body'],
        threadMode: 'whole-thread', ruleScope: 'single-message'
      },
      attachments: { action: 'metadata', typeGroups: ['all'] },
      output: { formats: ['json'], autoExportOnComplete: false, autoExportOnStop: false }
    };
    const sample = await evaluate(worker.client, extensionCall({ type: 'DRY_RUN_SAMPLE', config, limit: 2 }));
    assert(sample?.ok, `DRY_RUN_SAMPLE failed: ${sample?.error || 'unknown error'}`);
    assert(sample.inspected === 2 && sample.matched === 1 && sample.rejected === 1 && sample.errors === 0, 'Dry-run sample counts are incorrect');
    const afterSample = await evaluate(worker.client, extensionCall({ type: 'GET_STATUS' }));
    const sampleJobs = await evaluate(worker.client, `InboxFoundry.jobStore.listJobs()`);
    assert(afterSample.jobStatus === 'idle' && afterSample.scanned === 0 && sampleJobs.length === 0, 'Dry run persisted job or counter state');

    const started = await evaluate(worker.client, extensionCall({ type: 'START_EXPORT', config }));
    assert(started?.ok, `START_EXPORT failed: ${started?.error || 'unknown error'}`);

    const firstCheckpoint = await waitFor(async () => {
      const value = await evaluate(worker.client, extensionCall({ type: 'GET_STATUS' }));
      return value?.jobStatus === 'failed' || (value?.running && value.scanned >= 1) ? value : null;
    }, 'first durable thread checkpoint', 30000);
    assert(firstCheckpoint.jobStatus !== 'failed', `Export failed before its first checkpoint: ${firstCheckpoint.status}`);
    assert(firstCheckpoint.matched === 1, 'The first invoice thread should match');

    const stoppedRequest = await evaluate(worker.client, extensionCall({ type: 'STOP_EXPORT' }));
    assert(stoppedRequest?.ok, 'STOP_EXPORT failed');
    const stopped = await waitFor(async () => {
      const value = await evaluate(worker.client, extensionCall({ type: 'GET_STATUS' }));
      return !value?.running && value?.jobStatus === 'stopped' ? value : null;
    }, 'safe partial stop', 30000);
    assert(stopped.scanned >= 1 && stopped.scanned < fixtureThreads.length, 'Stop did not preserve a partial batch');

    const estimate = await evaluate(worker.client, extensionCall({ type: 'GET_EXPORT_ESTIMATE' }));
    assert(estimate?.ok && estimate.threads === stopped.matched, 'Stopped batch is not immediately exportable');

    const resumed = await evaluate(worker.client, extensionCall({ type: 'RESUME_EXPORT' }));
    assert(resumed?.ok, `RESUME_EXPORT failed: ${resumed?.error || 'unknown error'}`);
    const completed = await waitFor(async () => {
      const value = await evaluate(worker.client, extensionCall({ type: 'GET_STATUS' }));
      return !value?.running && value?.jobStatus === 'completed' ? value : null;
    }, 'resumed batch completion', 45000);
    assert(completed.scanned === 3, `Expected 3 inspected threads, got ${completed.scanned}`);
    assert(completed.matched === 2, `Expected 2 matching threads, got ${completed.matched}`);
    assert(completed.skipped === 1, `Expected 1 rejected thread, got ${completed.skipped}`);
    assert(completed.messages === 2, `Expected 2 captured messages, got ${completed.messages}`);

    const rows = await evaluate(worker.client, `(async()=>{
      const jobs=await InboxFoundry.jobStore.listJobs();
      const job=jobs.find(value=>value.id===${JSON.stringify(completed.jobId)});
      const threads=await InboxFoundry.jobStore.getThreads(${JSON.stringify(completed.jobId)});
      return {job,threads};
    })()`);
    assert(rows.job?.status === 'completed', 'Completed job was not durable in IndexedDB');
    assert(rows.threads?.filter(row => row.outcome === 'matched').length === 2, 'Durable matched-record count is incorrect');
    assert(rows.threads?.filter(row => row.outcome === 'rejected').length === 1, 'Durable rejected-record count is incorrect');

    const extensionWorkerUrl = new URL(worker.target.url);
    const extensionOrigin = `${extensionWorkerUrl.protocol}//${extensionWorkerUrl.host}`;
    const extensionVersion = await evaluate(worker.client, 'chrome.runtime.getManifest().version');
    const sidePanelTarget = await browser.call('Target.createTarget', { url: `${extensionOrigin}/sidepanel.html` });
    const panel = await targetClient(baseUrl, target => target.id === sidePanelTarget.targetId, 'side-panel page');
    if (panel.target.url === 'about:blank') {
      await panel.client.call('Page.navigate', { url: `${extensionOrigin}/sidepanel.html` });
    }
    await evaluate(worker.client, `(async()=>{
      const tabs=await chrome.tabs.query({url:'https://mail.google.com/*'});
      if(!tabs.length) throw new Error('Synthetic Gmail tab disappeared before workspace validation');
      await chrome.tabs.update(tabs[0].id,{active:true});
      return true;
    })()`);
    const panelReady = await waitFor(async () => {
      const value = await evaluate(panel.client, `({url:location.href,ready:document.readyState,hasStart:!!document.querySelector('#start'),hasJobs:!!document.querySelector('#jobs'),startHandler:typeof document.querySelector('#start')?.onclick,jobOptions:document.querySelectorAll('#jobs option').length,version:document.querySelector('#version')?.textContent,title:document.title})`);
      return value.url.startsWith(`${extensionOrigin}/sidepanel.html`) && value.ready === 'complete' && value.jobOptions > 1 && value.startHandler === 'function' && value.version === `v${extensionVersion}` ? value : null;
    }, 'initialized side-panel workspace');
    assert(panelReady.hasStart && panelReady.hasJobs, 'Side-panel UI did not initialize');
    await browser.call('Target.activateTarget', { targetId:sidePanelTarget.targetId });
    const ocrResult = await evaluate(panel.client, `(async()=>{
      const canvas=document.createElement('canvas');
      canvas.width=1200;canvas.height=400;
      const context=canvas.getContext('2d');
      context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
      context.fillStyle='#000';context.font='bold 96px Arial, sans-serif';
      context.fillText('INVOICE 4827',90,240);
      const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('Synthetic OCR image failed')),'image/png'));
      const file=new File([blob],'synthetic-invoice.png',{type:'image/png'});
      context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
      context.fillStyle='#000';context.fillText('SCANNED 7391',90,240);
      const jpegBlob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('Synthetic PDF image failed')),'image/jpeg',0.95));
      const jpeg=new Uint8Array(await jpegBlob.arrayBuffer());
      const encoder=new TextEncoder();
      const nl=String.fromCharCode(10);
      const parts=[];const offsets=[0];let byteOffset=0;
      const add=value=>{const bytes=typeof value==='string'?encoder.encode(value):value;parts.push(bytes);byteOffset+=bytes.length;};
      const object=(number,body)=>{offsets[number]=byteOffset;add(number+' 0 obj'+nl+body+nl+'endobj'+nl);};
      add('%PDF-1.4'+nl);
      object(1,'<< /Type /Catalog /Pages 2 0 R >>');
      object(2,'<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
      object(3,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>');
      offsets[4]=byteOffset;add('4 0 obj'+nl+'<< /Type /XObject /Subtype /Image /Width 1200 /Height 400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length '+jpeg.length+' >>'+nl+'stream'+nl);add(jpeg);add(nl+'endstream'+nl+'endobj'+nl);
      const drawing='q 600 0 0 200 0 0 cm /Im0 Do Q';
      object(5,'<< /Length '+drawing.length+' >>'+nl+'stream'+nl+drawing+nl+'endstream');
      const xref=byteOffset;add('xref'+nl+'0 6'+nl+'0000000000 65535 f '+nl);
      for(let number=1;number<=5;number++)add(String(offsets[number]).padStart(10,'0')+' 00000 n '+nl);
      add('trailer'+nl+'<< /Size 6 /Root 1 0 R >>'+nl+'startxref'+nl+xref+nl+'%%EOF');
      const pdfFile=new File(parts,'synthetic-scan.pdf',{type:'application/pdf'});
      const session=await InboxFoundry.ocrEngine.createSession({maxTotalPages:2,maxPagesPerPdf:1,maxPixels:2000000,maxImageBytes:2000000,maxPdfBytes:2000000});
      try{return {image:await session.recognize(file),pdf:await session.recognize(pdfFile)};}finally{await session.terminate();}
    })()`, 180000);
    const normalizedImageOcr = String(ocrResult?.image?.text || '').replace(/\s+/g, ' ').toUpperCase();
    const normalizedPdfOcr = String(ocrResult?.pdf?.text || '').replace(/\s+/g, ' ').toUpperCase();
    assert(normalizedImageOcr.includes('INVOICE') && normalizedImageOcr.includes('4827'), `Bundled local image OCR returned unexpected text: ${JSON.stringify(ocrResult?.image?.text || '')}`);
    assert(normalizedPdfOcr.includes('SCANNED') && normalizedPdfOcr.includes('7391'), `Bundled scanned-PDF OCR returned unexpected text: ${JSON.stringify(ocrResult?.pdf?.text || '')}`);
    await browser.call('Target.closeTarget', { targetId: sidePanelTarget.targetId });
    panel.client.close();

    await browser.call('Target.closeTarget', { targetId: worker.target.id });
    worker.client.close();
    await gmail.client.call('Page.reload', { ignoreCache: true });
    await waitFor(async () => {
      const value = await evaluate(gmail.client, 'document.readyState');
      return value === 'complete';
    }, 'synthetic Gmail reload');
    const restarted = await targetClient(baseUrl, target => target.type === 'service_worker' && target.url.endsWith('/background.js'), 'restarted service worker', 30000);
    const restored = await waitFor(async () => {
      const value = await evaluate(restarted.client, extensionCall({ type: 'GET_STATUS' }));
      return value?.ok && value.jobStatus === 'completed' ? value : null;
    }, 'restored content-script job state', 30000);
    assert(restored.scanned === 3 && restored.matched === 2 && restored.skipped === 1, 'Reload did not restore durable counters');

    restarted.client.close();
    gmail.client.close();
    browser.close();
    return { browserPath, stoppedAt: stopped.scanned, completed: { scanned: completed.scanned, matched: completed.matched, skipped: completed.skipped } };
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolveExit => child.once('exit', resolveExit)),
      delay(3000).then(() => child.kill('SIGKILL'))
    ]);
  }
}

const tempRoot = await mkdtemp(join(tmpdir(), 'inboxfoundry-browser-smoke-'));
const keyPath = join(tempRoot, 'fixture.key');
const certPath = join(tempRoot, 'fixture.crt');
const opensslPath = process.env.INBOXFOUNDRY_OPENSSL || 'openssl';
const openssl = spawnSync(opensslPath, [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-keyout', keyPath, '-out', certPath, '-subj', '/CN=mail.google.com',
  '-addext', 'subjectAltName=DNS:mail.google.com'
], { encoding: 'utf8' });
if (openssl.status !== 0) {
  await rm(tempRoot, { recursive: true, force: true });
  throw new Error(`Could not create the local fixture certificate with ${opensslPath}: ${openssl.error?.message || openssl.stderr}`);
}

const server = createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (request, response) => {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'"
  });
  response.end(fixtureHtml());
});
await new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', resolveListen);
});

const candidateErrors = [];
let attempted = 0;
let successful = false;
try {
  for (const browserPath of chromeCandidates) {
    const check = spawnSync(browserPath, ['--version'], { encoding: 'utf8' });
    if (check.status !== 0) continue;
    attempted++;
    try {
      const result = await runBrowser(browserPath, server.address().port, join(tempRoot, `profile-${chromeCandidates.indexOf(browserPath)}`));
      console.log(`Browser smoke passed with ${result.browserPath}`);
      console.log(`Safe stop checkpoint: ${result.stoppedAt}/${fixtureThreads.length} threads`);
      console.log(`Completed: ${result.completed.scanned} scanned, ${result.completed.matched} matched, ${result.completed.skipped} rejected`);
      successful = true;
      break;
    } catch (error) {
      candidateErrors.push({ browserPath, error });
      console.warn(`Browser candidate failed (${browserPath}): ${error.message}`);
    }
  }
  if (!successful) {
    if (candidateErrors.length) throw new Error(candidateErrors.map(item => `${item.browserPath}: ${item.error.message}`).join('\n'));
    throw new Error(`No usable Chrome/Chromium browser was found (${attempted} candidate(s) launched). Set INBOXFOUNDRY_CHROME to an executable path.`);
  }
} finally {
  await new Promise(resolveClose => server.close(resolveClose));
  await rm(tempRoot, { recursive: true, force: true });
}
