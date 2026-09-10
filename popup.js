const $ = (id) => document.getElementById(id);
let optionsInitialized = false;

async function activeGmailTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith('https://mail.google.com/')) throw new Error('Open Gmail first.');
  return tab;
}

async function send(type, extra = {}) {
  try {
    const tab = await activeGmailTab();
    const response = await chrome.tabs.sendMessage(tab.id, { type, ...extra });
    if (response?.ok === false) throw new Error(response.error || 'The extension could not complete that action.');
    return response;
  } catch (e) {
    showNotice(e.message?.includes('Receiving end does not exist')
      ? 'Reload the Gmail tab once after installing or updating the extension.'
      : (e.message || 'Unable to connect to Gmail.'));
    $('status').textContent = 'Needs attention';
    return null;
  }
}

function showNotice(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

function setControls(r) {
  const running = !!r?.running;
  $('start').disabled = running;
  $('stop').disabled = !running;
  $('resume').disabled = running || !['stopped', 'interrupted', 'failed'].includes(r?.jobStatus);
  $('reset').disabled = running;
  $('downloadAttachments').disabled = running;
}

async function refresh() {
  const r = await send('GET_STATUS');
  if (!r) { setControls(null); return; }
  showNotice('');
  $('status').textContent = r.running ? (r.status || 'Running') : (r.status || 'Idle');
  $('threads').textContent = r.scanned || 0;
  $('messages').textContent = r.messages || 0;
  $('attachments').textContent = r.attachments || 0;
  $('attachmentFailures').textContent = r.attachmentFailures || 0;
  if (!optionsInitialized || r.running) {
    $('downloadAttachments').checked = r.downloadAttachments !== false;
    optionsInitialized = true;
  }
  setControls(r);
}

$('start').onclick = async () => {
  $('status').textContent = 'Starting…';
  await send('START_EXPORT', {
    options: {
      downloadAttachments: $('downloadAttachments').checked,
      includeAllThreadMessages: true,
      keywords: []
    }
  });
  await refresh();
};

$('stop').onclick = async () => { await send('STOP_EXPORT'); await refresh(); };
$('resume').onclick = async () => { await send('RESUME_EXPORT'); await refresh(); };
$('workspace').onclick = async () => {
  try {
    const tab = await activeGmailTab();
    const response = await chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL', tabId: tab.id });
    if (!response?.ok) throw new Error(response?.error || 'Could not open the workspace.');
    window.close();
  } catch (error) { showNotice(error.message); }
};
$('export').onclick = async () => { await send('DOWNLOAD_JSON'); await refresh(); };
$('reset').onclick = async () => {
  if (!confirm('Permanently delete saved export progress and email data from extension storage? Downloaded files will not be deleted.')) return;
  await send('RESET_EXPORT');
  await refresh();
};

$('version').textContent = `v${chrome.runtime.getManifest().version}`;
refresh();
const refreshTimer = setInterval(refresh, 1000);
window.addEventListener('unload', () => clearInterval(refreshTimer));
