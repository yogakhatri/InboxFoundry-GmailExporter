const $ = id => document.getElementById(id);
const schema = globalThis.InboxFoundry.schema;
const gmailQueryEngine = globalThis.InboxFoundry.gmailQuery;
const filterEngine = globalThis.InboxFoundry.filterEngine;
const attachmentAnalysis = globalThis.InboxFoundry.attachmentAnalysis;
const localFileAnalysis = globalThis.InboxFoundry.localFileAnalysis;
const ocrEngine = globalThis.InboxFoundry.ocrEngine;
const textIntelligence = globalThis.InboxFoundry.textIntelligence;
const exportEngine = globalThis.InboxFoundry.exportEngine;
let initialized = false;
let privacyAcknowledged = false;
let attachmentWorkspaceJobId = null;
let localFileResults = [];
let localAnalysisController = null;
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]); }
const STARTERS = {
  invoices: { email: { includeTerms: ['invoice','receipt','statement'], fields: ['subject','body','attachmentNames'] }, attachments: { action:'matching', typeGroups:['pdf','spreadsheet'], filenameInclude:['invoice','receipt','statement'] } },
  contracts: { email: { includeTerms: ['contract','agreement','signed'], fields: ['subject','body','attachmentNames'] }, attachments: { action:'matching', typeGroups:['pdf','document'], filenameInclude:['contract','agreement','signed'] } },
  realestate: { email: { includeTerms: ['closing','escrow','purchase agreement','inspection','title'], fields: ['subject','body','attachmentNames'] }, attachments: { action:'matching', typeGroups:['pdf','document','spreadsheet'] }, output:{ folderTemplate:'{batch}/{senderDomain}/{date} - {subject}' } },
  resumes: { email: { includeTerms: ['resume','résumé','cv','application'], fields: ['subject','body','attachmentNames'] }, attachments: { action:'matching', typeGroups:['pdf','document'] } },
  travel: { email: { includeTerms: ['itinerary','quotation','voucher','booking','rate'], fields: ['subject','body','attachmentNames'] }, attachments: { action:'matching', typeGroups:['pdf','document','spreadsheet','emailCalendarContact'] } },
  insurance: { email: { includeTerms: ['claim','policy','adjuster','loss','settlement'], fields: ['subject','body','attachmentNames'] }, attachments: { action:'matching', typeGroups:['pdf','document','image'] } },
  procurement: { email: { includeTerms: ['quotation','quote','purchase order','vendor','rfq'], fields: ['subject','body','attachmentNames'] }, attachments: { action:'matching', typeGroups:['pdf','document','spreadsheet'] } },
  projects: { email: { includeTerms: ['approval','approved','deliverable','milestone','sign-off'], fields: ['subject','body','attachmentNames'] }, attachments: { action:'matching', typeGroups:['pdf','document','spreadsheet','presentation','archive'] } },
  education: { email: { includeTerms: ['account','transcript','certificate','course','offboarding'], fields: ['subject','body','attachmentNames'] }, attachments: { action:'matching', typeGroups:['pdf','document','spreadsheet'] } },
  research: { email: { includeTerms: ['paper','preprint','manuscript','research'], fields: ['subject','body','attachmentNames'] }, attachments: { action:'matching', typeGroups:['pdf'] } },
  spreadsheets: { email: { requireMatchingAttachment:true }, attachments: { action:'matching', typeGroups:['spreadsheet'] } }
};

function list(id) { return schema.normalizeStringList($(id).value); }
function checked(container) { return [...$(container).querySelectorAll('input:checked')].map(input => input.value); }
function bytes(id) { const n = Number($(id).value); return Number.isFinite(n) && n >= 0 && $(id).value !== '' ? Math.round(n * 1024 * 1024) : null; }
function numberOrNull(id) { const value = $(id).value; const n = Number(value); return value !== '' && Number.isFinite(n) ? n : null; }
function setList(id, values) { $(id).value = (values || []).join('\n'); }
function setChecks(container, values) { const selected = new Set(values || []); for (const input of $(container).querySelectorAll('input')) input.checked = selected.has(input.value); }

function readConfig() {
  return schema.normalizeConfig({
    source: { mode: $('scopeMode').value, gmailQuery: gmailQuery(), incremental: $('incremental').checked, pacingMs: Number($('pacingMs').value) || 300, maxMatchedThreads: Math.min(250, Math.max(1, Number($('maxThreads').value) || 250)) },
    email: {
      includeTerms: list('includeTerms'), excludeTerms: list('excludeTerms'), includeMode: $('includeMode').value,
      matchType: $('matchType').value, caseSensitive: $('caseSensitive').checked, wholeWord: $('wholeWord').checked,
      fields: checked('fields'), threadMode: $('threadMode').value, senderInclude: list('senderInclude'), senderExclude: list('senderExclude'),
      recipientInclude: list('recipientInclude'), recipientExclude: list('recipientExclude'),
      domainInclude: list('domainInclude'), domainExclude: list('domainExclude'), subjectInclude: list('subjectInclude'), subjectExclude: list('subjectExclude'),
      dateFrom: $('dateFrom').value, dateTo: $('dateTo').value, attachmentPresence: $('attachmentPresence').value,
      minMessages: numberOrNull('minMessages'), maxMessages: numberOrNull('maxMessages'),
      requireMatchingAttachment: $('requireMatchingAttachment').checked, exclusionsOverride: true, ruleScope: $('ruleScope').value
    },
    attachments: {
      action: $('attachmentAction').value, typeGroups: checked('fileTypes'), customExtensions: list('customExtensions'),
      filenameInclude: list('filenameInclude'), filenameExclude: list('filenameExclude'), includeMode: $('attachmentIncludeMode').value, matchType: $('attachmentMatchType').value,
      caseSensitive: $('attachmentCaseSensitive').checked, includeInline: $('includeInline').checked, excludeClutter: $('excludeClutter').checked, minBytes: bytes('minMb'), maxBytes: bytes('maxMb'), unknownSize: 'include',
      maxDownloads: Math.min(500, Math.max(0, Number($('maxDownloads').value) || 0))
    },
    destination: { type: $('destinationType').value, rootFolder: $('rootFolder').value.trim() || 'InboxFoundry' },
    output: { formats: checked('formats'), contentMode: $('contentMode').value, includeRawHtml: $('includeRawHtml').checked, includeGmailUrls: $('includeGmailUrls').checked, includeInternalIds: $('includeInternalIds').checked, redactAddresses: $('redactAddresses').checked, prettyJson: true,
      autoExportOnComplete: $('autoComplete').checked, autoExportOnStop: $('autoStop').checked, folderTemplate: $('folderTemplate').value.trim() || '{batch}/{index} - {subject}', splitRecords: numberOrNull('splitRecords') }
  });
}

function writeConfig(input) {
  const c = schema.normalizeConfig(input);
  $('scopeMode').value = c.source.mode || 'current-view';
  $('incremental').checked = !!c.source.incremental;
  $('pacingMs').value = String(c.source.pacingMs || 300);
  $('gmailQuery').value = c.source.gmailQuery || '';
  for (const id of ['queryFrom','queryTo','querySubject','queryFilename','queryAfter','queryBefore','queryLabel','queryCategory','queryLarger','querySmaller','queryStatus']) $(id).value = '';
  for (const id of ['queryAttachment','queryAnywhere']) $(id).checked = false;
  setList('includeTerms', c.email.includeTerms); setList('excludeTerms', c.email.excludeTerms); $('includeMode').value = c.email.includeMode;
  $('matchType').value = c.email.matchType; $('caseSensitive').checked = c.email.caseSensitive; $('wholeWord').checked = c.email.wholeWord;
  setChecks('fields', c.email.fields); $('threadMode').value = c.email.threadMode; setList('senderInclude', c.email.senderInclude); setList('senderExclude', c.email.senderExclude);
  setList('recipientInclude', c.email.recipientInclude); setList('recipientExclude', c.email.recipientExclude);
  setList('domainInclude', c.email.domainInclude); setList('domainExclude', c.email.domainExclude); setList('subjectInclude', c.email.subjectInclude); setList('subjectExclude', c.email.subjectExclude);
  $('dateFrom').value = c.email.dateFrom; $('dateTo').value = c.email.dateTo; $('attachmentPresence').value = c.email.attachmentPresence || 'any'; $('minMessages').value = c.email.minMessages ?? ''; $('maxMessages').value = c.email.maxMessages ?? ''; $('ruleScope').value = c.email.ruleScope || 'single-message'; $('requireMatchingAttachment').checked = c.email.requireMatchingAttachment;
  $('attachmentAction').value = c.attachments.action; setChecks('fileTypes', c.attachments.typeGroups); setList('customExtensions', c.attachments.customExtensions);
  setList('filenameInclude', c.attachments.filenameInclude); setList('filenameExclude', c.attachments.filenameExclude); $('includeInline').checked = c.attachments.includeInline;
  $('excludeClutter').checked = c.attachments.excludeClutter !== false;
  $('attachmentIncludeMode').value = c.attachments.includeMode || 'any'; $('attachmentMatchType').value = c.attachments.matchType || 'contains'; $('attachmentCaseSensitive').checked = !!c.attachments.caseSensitive;
  $('minMb').value = c.attachments.minBytes == null ? '' : c.attachments.minBytes / 1048576; $('maxMb').value = c.attachments.maxBytes == null ? '' : c.attachments.maxBytes / 1048576;
  $('maxThreads').value = c.source.maxMatchedThreads; $('maxDownloads').value = c.attachments.maxDownloads; setChecks('formats', c.output.formats);
  $('includeRawHtml').checked = c.output.includeRawHtml; $('includeGmailUrls').checked = c.output.includeGmailUrls !== false; $('includeInternalIds').checked = c.output.includeInternalIds !== false; $('autoComplete').checked = c.output.autoExportOnComplete; $('autoStop').checked = c.output.autoExportOnStop;
  $('redactAddresses').checked = !!c.output.redactAddresses;
  $('contentMode').value = c.output.contentMode || 'full';
  $('folderTemplate').value = c.output.folderTemplate || '{batch}/{index} - {subject}';
  $('destinationType').value = c.destination?.type || 'downloads'; $('rootFolder').value = c.destination?.rootFolder || 'InboxFoundry';
  $('splitRecords').value = c.output.splitRecords ?? '';
  summarize();
}

async function gmailTab() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.id || !tab.url?.startsWith('https://mail.google.com/')) throw new Error('Open Gmail in the active tab.'); return tab; }
async function send(type, extra = {}) { try { const tab = await gmailTab(); const r = await chrome.tabs.sendMessage(tab.id, { type, ...extra }); if (!r?.ok) throw new Error(r?.error || 'Action failed.'); notice(''); return r; } catch (error) { notice(error.message?.includes('Receiving end') ? 'Reload Gmail once to activate this extension.' : error.message); return null; } }
function notice(message) { $('notice').textContent = message || ''; $('notice').hidden = !message; }
function summarize() { const c = readConfig(); $('emailSummary').textContent = c.email.includeTerms.length ? `${c.email.includeMode.toUpperCase()} · ${c.email.includeTerms.length} term${c.email.includeTerms.length === 1 ? '' : 's'}` : 'All emails'; $('attachmentSummary').textContent = ({ all:'Download all', matching:'Matching only', metadata:'Metadata only', none:'No files' })[c.attachments.action]; }
function formatBytes(value) { const n = Number(value); if (!Number.isFinite(n) || n < 0) return 'unknown size'; if (n < 1024) return `${n} B`; if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`; return `${(n / 1048576).toFixed(1)} MB`; }

function fileRow({ id, fileName, meta, state, kind, checked = false, selectable = true }) {
  const label = document.createElement('label'); label.className = `file-row${selectable ? '' : ' no-select'}`;
  const input = document.createElement('input'); input.type = 'checkbox'; input.checked = checked; input.dataset.kind = kind; input.dataset.id = String(id || ''); input.dataset.filename = String(fileName || 'attachment'); input.hidden = !selectable;
  const main = document.createElement('span'); main.className = 'file-main';
  const name = document.createElement('strong'); name.className = 'file-name'; name.textContent = fileName || 'Unnamed attachment';
  const detail = document.createElement('small'); detail.className = 'file-meta'; detail.textContent = meta || '';
  const badge = document.createElement('span'); badge.className = `state ${['failed','interrupted','erased'].includes(state) ? 'problem' : ''}`; badge.textContent = state || 'detected';
  main.append(name, detail); label.append(input, main, badge); return label;
}

async function loadAttachmentWorkspace(jobId = attachmentWorkspaceJobId) {
  attachmentWorkspaceJobId = jobId || null;
  $('attachmentWorkspace').replaceChildren(); $('downloadWorkspace').replaceChildren();
  if (!jobId) { $('attachmentWorkspaceSummary').textContent = 'No saved batch'; $('attachmentGroups').textContent = ''; return; }
  const [attachments, downloads] = await Promise.all([
    db('DB_GET_ATTACHMENTS', { jobId }), db('DB_GET_DOWNLOADS', { jobId })
  ]);
  for (const row of attachments.slice(0, 500)) {
    const groups = row.classification?.groups?.join(', ') || row.classification?.extension || 'other';
    const reasons = (row.reasons || []).join(', ');
    $('attachmentWorkspace').append(fileRow({ id:row.id, fileName:row.fileName, kind:'attachment', state:row.matched ? 'matched' : 'excluded', meta:`Message ${row.messageIndex || '?'} · ${formatBytes(row.sizeBytes)} · ${groups}${reasons ? ` · ${reasons}` : ''}` }));
  }
  if (!attachments.length) $('attachmentWorkspace').textContent = 'No saved attachment decisions yet.';
  const groups = attachmentAnalysis.analyze(attachments);
  const duplicateNames = groups.duplicateCandidateGroups.slice(0, 5).map(group => group.items.map(item => item.fileName).join(' × '));
  const versionNames = groups.versionCandidateGroups.slice(0, 5).map(group => group.items.map(item => item.fileName).join(' → '));
  $('attachmentGroups').textContent = [
    `${groups.duplicateCandidateGroups.length} metadata duplicate candidate group(s); ${groups.versionCandidateGroups.length} filename version family/families.`,
    duplicateNames.length ? `Duplicates: ${duplicateNames.join(' · ')}` : '',
    versionNames.length ? `Versions: ${versionNames.join(' · ')}` : '',
    'These are filename/known-size hints, not content-hash proof.'
  ].filter(Boolean).join(' ');
  for (const row of downloads.slice(0, 500)) {
    $('downloadWorkspace').append(fileRow({ id:row.id, fileName:row.fileName, kind:'download', state:row.state, meta:`${row.method || 'queued'}${row.error ? ` · ${row.error}` : ''}` }));
  }
  if (!downloads.length) $('downloadWorkspace').textContent = 'No download tasks yet.';
  const complete = downloads.filter(row => row.state === 'complete').length;
  const problems = downloads.filter(row => ['failed','interrupted'].includes(row.state)).length;
  $('attachmentWorkspaceSummary').textContent = `${attachments.length} files · ${complete} complete · ${problems} problems`;
}

function selectedFileNames() {
  return [...$('attachmentWorkspace').querySelectorAll('input[data-kind="attachment"]:checked')].map(input => input.dataset.filename).filter(Boolean);
}

function addSelectedNames(targetId) {
  const names = selectedFileNames();
  if (!names.length) return notice('Select at least one discovered attachment first.');
  const merged = [...new Set([...list(targetId), ...names])];
  setList(targetId, merged); summarize(); notice(`Added ${names.length} selected file name(s) to the ${targetId === 'filenameInclude' ? 'include' : 'exclude'} rules.`);
}

function renderLocalFileResults() {
  const container = $('localFileResults'); container.replaceChildren();
  const query = $('localFileSearch').value;
  const duplicates = localFileAnalysis.duplicateGroups(localFileResults);
  const matches = localFileAnalysis.search(localFileResults, query);
  $('localFileSummary').textContent = localFileResults.length ? `${localFileResults.length} files · ${duplicates.length} exact duplicate groups` : 'Opt-in · local only';
  for (const item of localFileResults) {
    const classification = item.insights?.classification;
    const sensitive = item.insights?.sensitive?.counts || {};
    const sensitiveSummary = Object.entries(sensitive).map(([type, count]) => `${type}: ${count}`).join(', ');
    const suggestions = item.insights?.structured;
    const structuredSummary = [
      ...(suggestions?.identifiers || []).slice(0, 5).map(value => `${value.field}: ${value.value}`),
      ...(suggestions?.amounts || []).slice(0, 3).map(value => `amount: ${value}`),
      ...(suggestions?.dates || []).slice(0, 3).map(value => `date: ${value}`)
    ].join(' · ');
    container.append(fileRow({
      id:item.sha256 || item.name, fileName:item.name, kind:'local-file',
      state:item.sha256 ? 'hashed' : 'hash skipped',
      meta:`${formatBytes(item.sizeBytes)} · ${item.type || item.extension || 'unknown type'} · ${item.textStatus.replaceAll('-', ' ')}${item.ocr?.confidence != null ? ` · OCR confidence ${Math.round(item.ocr.confidence)}%` : ''}${item.ocrStatus === 'failed' ? ` · OCR failed: ${item.ocrError}` : ''}${classification?.primary && classification.primary !== 'unclassified' ? ` · likely ${classification.primary} (${Math.round(classification.confidence * 100)}%)` : ''}${sensitiveSummary ? ` · possible sensitive patterns: ${sensitiveSummary}` : ''}${structuredSummary ? ` · suggestions: ${structuredSummary}` : ''}`,
      selectable:false
    }));
  }
  if (duplicates.length) {
    const heading = document.createElement('strong'); heading.textContent = 'Exact content duplicates'; container.append(heading);
    for (const group of duplicates) {
      const p = document.createElement('p'); p.className = 'micro'; p.textContent = `${group.items.map(item => item.name).join(' = ')} · SHA-256 ${group.sha256}`; container.append(p);
    }
  }
  if (query.trim()) {
    const heading = document.createElement('strong'); heading.textContent = `Text search: ${matches.reduce((sum, match) => sum + match.count, 0)} match(es) in ${matches.length} file(s)`; container.append(heading);
    for (const match of matches) {
      const sources = (match.sources || []).map(source => `${source.source}: ${source.count}`).join(', ');
      const p = document.createElement('p'); p.className = 'micro'; p.textContent = `${match.name} · ${match.count} match(es)${sources ? ` · ${sources}` : ''}${match.snippets.length ? ` · ${match.snippets.join(' … ')}` : ''}`; container.append(p);
    }
  }
  if (!localFileResults.length) container.textContent = 'No local files analyzed.';
  $('exportLocalAnalysis').disabled = !localFileResults.length;
  $('exportRedactedFiles').disabled = !localFileResults.some(item => item.text);
  $('clearLocalAnalysis').disabled = !localFileResults.length;
}

function validatedConfig() {
  const config = readConfig();
  if (!config.email.fields.length && config.email.includeTerms.length) throw new Error('Select at least one email field for keyword matching.');
  if (!config.output.formats.length) throw new Error('Select at least one export format.');
  if (config.attachments.minBytes != null && config.attachments.maxBytes != null && config.attachments.minBytes > config.attachments.maxBytes) throw new Error('Minimum file size cannot exceed maximum file size.');
  if (config.email.minMessages != null && config.email.maxMessages != null && config.email.minMessages > config.email.maxMessages) throw new Error('Minimum message count cannot exceed maximum message count.');
  if (config.email.matchType === 'regex') for (const term of [...config.email.includeTerms, ...config.email.excludeTerms]) if (!filterEngine.safeRegex(term, config.email.caseSensitive ? '' : 'i')) throw new Error(`Unsafe or invalid regular expression: ${term}`);
  if (config.attachments.matchType === 'regex') for (const term of [...config.attachments.filenameInclude, ...config.attachments.filenameExclude]) if (!filterEngine.safeRegex(term, config.attachments.caseSensitive ? '' : 'i')) throw new Error(`Unsafe or invalid filename regular expression: ${term}`);
  return config;
}

function gmailQuery() {
  return gmailQueryEngine.build({ raw:$('gmailQuery').value, from:$('queryFrom').value, to:$('queryTo').value,
    subject:$('querySubject').value, filename:$('queryFilename').value, after:$('queryAfter').value, before:$('queryBefore').value,
    label:$('queryLabel').value, category:$('queryCategory').value, largerMb:$('queryLarger').value, smallerMb:$('querySmaller').value,
    hasAttachment:$('queryAttachment').checked, status:$('queryStatus').value, inAnywhere:$('queryAnywhere').checked });
}

async function refresh() {
  const r = await send('GET_STATUS'); if (!r) return;
  $('status').textContent = r.status || 'Idle'; $('jobState').textContent = r.jobStatus || (r.running ? 'Running' : 'Idle');
  $('inspected').textContent = r.scanned || 0; $('matched').textContent = r.matched || 0; $('rejected').textContent = r.skipped || 0; $('messages').textContent = r.messages || 0; $('downloads').textContent = r.attachments || 0; $('downloadsComplete').textContent = r.downloadsComplete || 0;
  $('rate').textContent = r.running && r.elapsedSeconds > 0 ? `${r.ratePerMinute.toFixed(1)} threads/min · ${Math.round(r.elapsedSeconds)}s elapsed` : '';
  const max = r.config?.source?.maxMatchedThreads || 250; $('progressBar').style.width = `${Math.min(100, ((r.matched || 0) / max) * 100)}%`;
  $('start').disabled = !!r.running || !privacyAcknowledged; $('stop').disabled = !r.running; $('reset').disabled = !!r.running;
  $('resume').disabled = !!r.running || !['stopped','interrupted','failed'].includes(r.jobStatus);
  if (!initialized && r.config) { writeConfig(r.config); initialized = true; }
  if (r.jobId !== attachmentWorkspaceJobId) await loadAttachmentWorkspace(r.jobId);
  if (r.justStopped) $('previewResult').innerHTML = `<h2>Partial export ready</h2><p>${r.matched || 0} matched threads are safely checkpointed.</p>`;
}

async function db(type, extra = {}) { const r = await chrome.runtime.sendMessage({ type, ...extra }); if (!r?.ok) throw new Error(r?.error || 'Storage action failed'); return r.result; }
async function loadPresets() { const rows = await db('DB_LIST_PRESETS'); $('presets').innerHTML = '<option value="">Choose a preset…</option>' + rows.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join(''); }
async function loadJobs() { const rows = await db('DB_LIST_JOBS'); rows.sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); $('jobs').innerHTML = '<option value="">Choose a retained batch…</option>' + rows.map(job => `<option value="${escapeHtml(job.id)}">${escapeHtml(job.name)} · ${escapeHtml(job.status)}</option>`).join(''); }
async function loadStorageUsage() { const estimate = await db('DB_STORAGE_ESTIMATE'); $('storageUsage').textContent = estimate?.usage == null ? 'Storage estimate unavailable.' : `${(estimate.usage / 1048576).toFixed(2)} MB used by this extension origin.`; }

$('start').onclick = async () => { try { $('status').textContent = 'Starting…'; await send('START_EXPORT', { config: validatedConfig() }); await loadJobs(); await refresh(); } catch (error) { notice(error.message); } };
$('resume').onclick = async () => { $('status').textContent = 'Resuming…'; await send('RESUME_EXPORT'); await refresh(); };
$('stop').onclick = async () => { await send('STOP_EXPORT'); await refresh(); };
$('export').onclick = async () => { await send('DOWNLOAD_EXPORTS', { formats: checked('formats') }); };
$('retryDownloads').onclick = async () => { const status = await send('GET_STATUS'); if (!status?.jobId) return notice('No job is open.'); const r = await chrome.runtime.sendMessage({ type:'RETRY_INTERRUPTED_DOWNLOADS', jobId:status.jobId }); if (!r?.ok) return notice(r?.error || 'Retry failed.'); notice(r.resumed ? `Resumed ${r.resumed} interrupted download(s).` : 'No interrupted Chrome download is currently resumable.'); await loadAttachmentWorkspace(status.jobId); await refresh(); };
$('preview').onclick = async () => { try { const r = await send('PREVIEW_CURRENT_THREAD', { config: validatedConfig() }); if (!r) return; const files = (r.attachments || []).map(item => `<li>${escapeHtml(item.fileName)} — ${item.matched ? 'included' : `excluded (${escapeHtml((item.reasons || []).join(', '))})`}</li>`).join(''); $('previewResult').hidden = false; $('previewResult').innerHTML = `<h2>${r.matched ? 'This thread matches' : 'This thread does not match'}</h2><p>${escapeHtml(r.subject || '(No subject)')}</p><p>${r.messageCount} messages · ${r.attachmentCount} attachments · ${r.matchingAttachmentCount} matching files</p><p>Reason: ${escapeHtml((r.reasons || []).join(', '))}</p>${files ? `<ul>${files}</ul>` : ''}`; } catch (error) { notice(error.message); } };
$('dryRun').onclick = async () => { try { $('dryRun').disabled = true; const limit = Math.min(10, Math.max(1, Number($('sampleLimit').value) || 3)); const r = await send('DRY_RUN_SAMPLE', { config: validatedConfig(), limit }); if (!r) return; const rows = (r.results || []).map(item => `<li><strong>${escapeHtml(item.subject || `Item ${item.ordinal}`)}</strong> — ${item.error ? `error: ${escapeHtml(item.error)}` : item.matched ? 'matches' : `rejected (${escapeHtml((item.reasons || []).join(', '))})`} · ${item.messageCount || 0} message(s) · ${item.attachmentCount || 0} attachment(s)</li>`).join(''); $('previewResult').hidden = false; $('previewResult').innerHTML = `<h2>Dry run — nothing saved or downloaded</h2><p>${r.inspected} inspected · ${r.matched} matched · ${r.rejected} rejected · ${r.errors} errors</p><ol>${rows}</ol>`; } catch (error) { notice(error.message); } finally { $('dryRun').disabled = false; } };
$('estimate').onclick = async () => { const r = await send('GET_EXPORT_ESTIMATE'); if (!r) return; $('previewResult').hidden = false; $('previewResult').innerHTML = `<h2>Saved-output estimate</h2><p>${r.threads} threads · ${r.messages} messages · ${r.attachments} requested files</p><p>Canonical JSON is approximately ${(r.bytes / 1048576).toFixed(2)} MB before pretty-printing.</p>`; };
$('openSearch').onclick = async () => { const query = gmailQuery(); if (!query) return notice('Enter at least one Gmail search condition.'); await send('OPEN_GMAIL_QUERY', { query }); };
$('reset').onclick = async () => { if (!confirm('Delete the current InboxFoundry job and locally stored email records? Downloaded files remain on disk.')) return; await send('RESET_EXPORT'); await refresh(); };
$('savePreset').onclick = async () => { const name = $('presetName').value.trim(); if (!name) return notice('Enter a preset name.'); const presets = await db('DB_LIST_PRESETS'); if (presets.length >= 5) return notice('Free supports up to 5 saved presets.'); await db('DB_PUT_PRESET', { preset: { id: `preset-${Date.now()}`, name, config: readConfig(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }); await loadPresets(); };
$('loadPreset').onclick = async () => { const rows = await db('DB_LIST_PRESETS'); const p = rows.find(x => x.id === $('presets').value); if (p) writeConfig(p.config); };
$('deletePreset').onclick = async () => { if (!$('presets').value) return; await db('DB_DELETE_PRESET', { presetId: $('presets').value }); await loadPresets(); };
$('renamePreset').onclick = async () => { const id = $('presets').value; const name = $('presetName').value.trim(); if (!id || !name) return notice('Choose a preset and enter its new name.'); const rows = await db('DB_LIST_PRESETS'); const preset = rows.find(item => item.id === id); if (!preset) return; await db('DB_PUT_PRESET', { preset: { ...preset, name, updatedAt: new Date().toISOString() } }); await loadPresets(); };
$('duplicatePreset').onclick = async () => { const id = $('presets').value; const rows = await db('DB_LIST_PRESETS'); if (rows.length >= 5) return notice('Free supports up to 5 saved presets.'); const preset = rows.find(item => item.id === id); if (!preset) return notice('Choose a preset to duplicate.'); await db('DB_PUT_PRESET', { preset: { ...preset, id: `preset-${Date.now()}`, name: `${preset.name} copy`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }); await loadPresets(); };
$('exportPresets').onclick = async () => { const rows = await db('DB_LIST_PRESETS'); const blob = new Blob([JSON.stringify({ format:'InboxFoundryPresets', version:1, presets:rows }, null, 2)], { type:'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'inboxfoundry-presets.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); };
$('importPresets').onchange = async () => { try { const file = $('importPresets').files?.[0]; if (!file) return; const parsed = JSON.parse(await file.text()); if (parsed.format !== 'InboxFoundryPresets' || parsed.version !== 1 || !Array.isArray(parsed.presets)) throw new Error('This is not a supported InboxFoundry preset file.'); const existing = await db('DB_LIST_PRESETS'); const capacity = Math.max(0, 5 - existing.length); for (const preset of parsed.presets.slice(0, capacity)) await db('DB_PUT_PRESET', { preset: { id:`preset-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, name:String(preset.name || 'Imported preset').slice(0,80), config:schema.normalizeConfig(preset.config), createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() } }); await loadPresets(); notice(`Imported ${Math.min(capacity, parsed.presets.length)} preset(s).`); } catch (error) { notice(error.message); } finally { $('importPresets').value = ''; } };
$('loadStarter').onclick = () => { const preset = STARTERS[$('starterPreset').value]; if (!preset) return notice('Choose a starter workflow first.'); writeConfig(schema.normalizeConfig(preset)); };
$('loadJob').onclick = async () => { if (!$('jobs').value) return notice('Choose a retained batch first.'); const r = await send('LOAD_JOB', { jobId: $('jobs').value }); if (r) { initialized = false; await refresh(); } };
$('refreshAttachmentWorkspace').onclick = () => loadAttachmentWorkspace().catch(error => notice(error.message));
$('selectInterruptedDownloads').onclick = () => { for (const input of $('downloadWorkspace').querySelectorAll('input[data-kind="download"]')) input.checked = input.closest('.file-row')?.querySelector('.state')?.textContent === 'interrupted'; };
$('useSelectedIncludes').onclick = () => addSelectedNames('filenameInclude');
$('useSelectedExcludes').onclick = () => addSelectedNames('filenameExclude');
$('retrySelectedDownloads').onclick = async () => { const taskIds = [...$('downloadWorkspace').querySelectorAll('input[data-kind="download"]:checked')].map(input => input.dataset.id); if (!taskIds.length) return notice('Select at least one interrupted download task first.'); if (!attachmentWorkspaceJobId) return notice('No saved batch is open.'); const r = await chrome.runtime.sendMessage({ type:'RETRY_INTERRUPTED_DOWNLOADS', jobId:attachmentWorkspaceJobId, taskIds }); if (!r?.ok) return notice(r?.error || 'Retry failed.'); notice(`Resumed ${r.resumed} of ${r.requested} selected resumable task(s)${r.errors?.length ? `; ${r.errors.length} failed to resume` : ''}.`); await loadAttachmentWorkspace(); };
$('analyzeLocalFiles').onclick = async () => {
  try {
    const files = $('localFiles').files;
    if (!files?.length) return notice('Choose one or more local files first.');
    localAnalysisController = new AbortController();
    $('analyzeLocalFiles').disabled = true;
    $('cancelLocalAnalysis').disabled = false;
    $('localFileSummary').textContent = 'Analyzing locally…';
    const analyzed = await localFileAnalysis.analyzeFiles(files, {
      signal:localAnalysisController.signal,
      ocr:$('runOcr').checked,
      ocrEngine,
      ocrOptions:{ maxPagesPerPdf:Math.min(20, Math.max(1, Number($('ocrPages').value) || 10)) },
      onProgress:value => {
        const percent = Math.min(100, Math.round((value.progress ?? (value.totalBytes ? value.processedBytes / value.totalBytes : 0)) * 100));
        const activity = value.phase?.startsWith('ocr') ? `${value.status || 'recognizing text'} ${percent}%` : `hashing ${percent}%`;
        $('localFileSummary').textContent = `File ${value.fileIndex}/${value.fileCount} · ${activity}`;
      }
    });
    localFileResults = analyzed;
    renderLocalFileResults();
    const ocrCount = analyzed.filter(item => item.ocrStatus === 'extracted').length;
    notice(`Analyzed ${localFileResults.length} file(s) locally${ocrCount ? `; OCR extracted text from ${ocrCount}` : ''}. File contents were not stored or uploaded.`);
  } catch (error) {
    notice(error.message === 'analysis-cancelled' ? 'Local file analysis cancelled; previous inspector results were preserved.' : error.message);
    renderLocalFileResults();
  } finally {
    localAnalysisController = null;
    $('analyzeLocalFiles').disabled = false;
    $('cancelLocalAnalysis').disabled = true;
  }
};
$('cancelLocalAnalysis').onclick = () => { localAnalysisController?.abort(); $('cancelLocalAnalysis').disabled = true; $('localFileSummary').textContent = 'Cancelling…'; };
$('localFileSearch').oninput = renderLocalFileResults;
$('exportLocalAnalysis').onclick = () => { const report = localFileAnalysis.report(localFileResults, $('localFileSearch').value, { includeInsights:$('includeLocalInsights').checked }); const blob = new Blob([JSON.stringify(report, null, 2)], { type:'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `inboxfoundry-local-file-analysis-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); };
$('exportRedactedFiles').onclick = async () => { try { $('exportRedactedFiles').disabled = true; const { entries, manifest } = await localFileAnalysis.buildRedactionEntries(localFileResults, checked('redactionTypes')); const blob = new Blob([exportEngine.zipArchive(entries)], { type:'application/zip' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `inboxfoundry-redacted-text-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); notice(`Created ${manifest.files.length} redacted text copy/copies with hashes and a manifest. Review them before sharing.`); } catch (error) { notice(error.message); } finally { renderLocalFileResults(); } };
$('clearLocalAnalysis').onclick = () => { localFileResults = []; $('localFiles').value = ''; $('localFileSearch').value = ''; renderLocalFileResults(); notice('Local inspector memory cleared.'); };
$('diagnostics').onclick = async () => { await send('DOWNLOAD_DIAGNOSTICS'); };
$('encryptedExport').onclick = async () => { const passphrase = $('encryptionPassphrase').value; if (passphrase.length < 10) return notice('Use an encryption passphrase of at least 10 characters. It is never stored.'); const r = await send('DOWNLOAD_ENCRYPTED', { passphrase }); if (r) { $('encryptionPassphrase').value = ''; notice('Encrypted archive created. Keep the passphrase somewhere safe; InboxFoundry cannot recover it.'); } };
$('decryptArchive').onchange = async () => { try { const file = $('decryptArchive').files?.[0]; const passphrase = $('encryptionPassphrase').value; if (!file) return; if (passphrase.length < 10) throw new Error('Enter the archive passphrase above first.'); const plaintext = await exportEngine.decryptText(await file.text(), passphrase); JSON.parse(plaintext); const blob = new Blob([plaintext], { type:'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = file.name.replace(/\.ifenc$/i, '') + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); $('encryptionPassphrase').value = ''; notice('Archive decrypted locally.'); } catch (error) { notice('Could not decrypt the archive. Check the passphrase and file.'); } finally { $('decryptArchive').value = ''; } };
$('clearJobs').onclick = async () => { if (!confirm('Delete every locally retained InboxFoundry job and record? Downloaded files remain on disk.')) return; try { await db('DB_CLEAR_JOBS'); await send('CLEAR_MEMORY_STATE'); await loadJobs(); await loadStorageUsage(); notice('All retained jobs were deleted.'); } catch (error) { notice(error.message); } };
$('clearPresets').onclick = async () => { if (!confirm('Delete every saved filter preset?')) return; await db('DB_CLEAR_PRESETS'); await loadPresets(); notice('All saved presets were deleted.'); };
$('acknowledge').onclick = async () => { privacyAcknowledged = true; await chrome.storage.local.set({ inboxFoundryPrivacyAcknowledgedV1: true }); $('disclosure').hidden = true; await refresh(); };
document.addEventListener('input', summarize);
$('fileTypes').addEventListener('change', event => { if (event.target.value === 'all' && event.target.checked) for (const input of $('fileTypes').querySelectorAll('input:not([value=all])')) input.checked = false; else if (event.target.value !== 'all' && event.target.checked) $('fileTypes').querySelector('[value=all]').checked = false; if (!checked('fileTypes').length) $('fileTypes').querySelector('[value=all]').checked = true; });
$('version').textContent = `v${chrome.runtime.getManifest().version}`;
writeConfig(schema.DEFAULT_CONFIG);
renderLocalFileResults();
chrome.storage.local.get('inboxFoundryPrivacyAcknowledgedV1').then(value => { privacyAcknowledged = value.inboxFoundryPrivacyAcknowledgedV1 === true; $('disclosure').hidden = privacyAcknowledged; refresh(); });
Promise.all([loadPresets(), loadJobs(), loadStorageUsage()]).catch(error => notice(error.message));
const timer = setInterval(refresh, 1200); addEventListener('unload', () => clearInterval(timer));
