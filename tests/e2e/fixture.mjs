// A Gmail-shaped page served on loopback under the mail.google.com name. It is written from knowledge of
// Gmail's markup and is deliberately awkward: buttons ignore bare clicks, old conversation views stay in
// the page but hidden, and thread IDs sit on an inner element. It is not Gmail. See docs/TESTING.md.

export const mkThread = (id, extra = {}) => ({ id, subject: `Thread ${id}`, sender: `sender-${id}@example.test`, senderName: `Sender ${id}`, ...extra });

export function fixtureHtml(options) {
  const data = JSON.stringify(options).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="${options.lang || 'en'}"><head><meta charset="utf-8"><title>Inbox (3) - owner@example.test - Gmail</title>
<style>body{font:14px system-ui;margin:0}td{padding:6px}#views>div{padding:8px}.hidden{display:none}</style></head>
<body><div role="main"><div id="toolbar"></div><div id="list"></div><div id="views"></div></div><script>
const O = ${data};
window.O = O; window.__olderPresses = 0; window.__linkClicks = 0; window.__lastSearch = null; window.__renders = 0;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const threadHash = id => 'FMfcg' + (String(id).replace(/[^A-Za-z0-9]/g, 'x') + 'Z').padEnd(27, '0');
const allThreads = () => O.pages.flat();
const read = new Set();
function view() {
  const parts = location.hash.replace(/^#/, '').split('/').filter(Boolean);
  let thread = null;
  if (parts.length && /^FMfcg/.test(parts.at(-1))) thread = parts.pop();
  let page = 1;
  if (parts.length && /^p\\d+$/.test(parts.at(-1)) && !O.noUrlPaging) page = Number(parts.pop().slice(1));
  else if (parts.length && /^p\\d+$/.test(parts.at(-1))) parts.pop();
  return { base: '#' + (parts.join('/') || 'inbox'), page, thread };
}
function pagesNow() {
  if (!O.unreadView) return O.pages;
  const size = O.pageSize || 4;
  const left = allThreads().filter(t => !read.has(t.id));
  const pages = [];
  for (let i = 0; i < left.length; i += size) pages.push(left.slice(i, i + size));
  return pages;
}
function pressable(el, handler) {
  // Real Gmail buttons listen for mouse down and up. A bare element.click() does nothing here.
  let armed = false;
  el.addEventListener('mousedown', () => { armed = true; });
  el.addEventListener('mouseup', () => { if (armed) handler(); armed = false; });
}
function drawToolbar(v) {
  const pages = pagesNow();
  const last = v.page >= pages.length;
  const bar = document.getElementById('toolbar');
  if (v.thread && !O.readingPane) {
    bar.innerHTML = '<div role="button" id="back" aria-label="Back to Inbox">Back</div>';
    pressable(bar.firstChild, () => { location.hash = v.page > 1 ? v.base + '/p' + v.page : v.base; });
    return;
  }
  if (O.noOlderButton) { bar.innerHTML = ''; return; }
  const total = O.unreadView ? allThreads().filter(t => !read.has(t.id)).length : allThreads().length;
  const size = (pages[0] || []).length;
  bar.innerHTML = '<div class="Dj">' + (O.hideRange ? '' : '1–' + size + ' of ' + (O.manyTotal ? 'many' : total)) + '</div>' +
    '<div class="h0"><div role="button" aria-label="Newer">&lt;</div><div role="button" id="older" aria-label="' + esc(O.olderLabel || 'Older') + '"' + (last ? ' aria-disabled="true"' : '') + '>&gt;</div></div>';
  if (O.hideRange) bar.querySelector('.Dj').remove();
  pressable(document.getElementById('older'), () => {
    window.__olderPresses++;
    const now = view();
    if (now.page < pagesNow().length) location.hash = now.base + '/p' + (now.page + 1);
  });
}
function drawList(v) {
  const rows = pagesNow()[v.page - 1] || [];
  const list = document.getElementById('list');
  // Simulates a list that is slow to draw, or never comes back, after some conversations were opened.
  if (O.blackout && (window.__opens || 0) >= O.blackout.afterOpens && !v.thread) {
    window.__blackoutUntil ||= Date.now() + O.blackout.ms;
    if (Date.now() < window.__blackoutUntil) {
      list.classList.add('hidden');
      setTimeout(render, Math.min(1000, window.__blackoutUntil - Date.now()));
      return;
    }
  }
  list.classList.toggle('hidden', !!v.thread && !O.readingPane);
  if (window.__listKey === JSON.stringify([v.base, v.page, rows.map(r => r.id)])) return;
  window.__listKey = JSON.stringify([v.base, v.page, rows.map(r => r.id)]);
  window.__renders++;
  if (!rows.length) { list.innerHTML = '<div class="TC">No conversations</div>'; return; }
  list.innerHTML = '<table><tbody>' + rows.map(t => {
    const span = O.noIds ? '' : ' data-thread-id="#thread-f:' + esc(t.id) + '" data-legacy-thread-id="' + esc(t.id) + '"' + (t.lastId ? ' data-legacy-last-message-id="' + esc(t.lastId) + '"' : '');
    const unread = t.unread && !read.has(t.id) ? ' zE' : ' yO';
    const count = t.messages && t.messages.length > 1 ? '<span class="bx0">' + t.messages.length + '</span>' : '';
    return '<tr class="zA' + unread + '" data-open="' + esc(t.opensAs || t.id) + '"><td><input type="checkbox"' + (t.ticked ? ' checked' : '') + '></td><td><span class="yP" email="' + esc(t.sender) + '">' + esc(t.senderName) + '</span>' + count + '</td><td><span class="bog"><span class="bqe"' + span + '>' + esc(t.subject) + '</span></span></td><td><span class="xW">' + esc(t.listDate || 'Aug 30') + '</span></td></tr>';
  }).join('') + '</tbody></table>';
  list.querySelectorAll('tr.zA').forEach(row => row.addEventListener('click', event => {
    if (event.target.tagName === 'INPUT') return;
    const now = view();
    location.hash = (now.page > 1 ? now.base + '/p' + now.page : now.base) + '/' + threadHash(row.dataset.open);
  }));
}
function attachmentHtml(t, a, index) {
  const url = location.origin + '/mail/u/0?ui=2&ik=abc&view=att&th=' + encodeURIComponent(t.id) + '&attid=0.' + index + '&disp=safe&name=' + encodeURIComponent(a.name);
  const name = '<span class="aV3">' + esc(a.name) + '</span><div class="SaH2Ve">' + esc(a.size || '24 KB') + '</div>';
  if (a.mode === 'drive') return '<span class="aZo"><a href="https://drive.google.com/file/d/x/view">' + name + '</a></span>';
  if (a.mode === 'none') return '<span class="aZo">' + name + '</span>';
  if (a.mode === 'link') return '<span class="aZo"><a class="aQy" href="' + esc(url) + '">' + name + '</a></span>';
  if (a.mode === 'click') return '<span class="aZo">' + name + '<div class="aQw"><div role="button" class="click-download" aria-label="Download attachment ' + esc(a.name) + '" data-url="' + esc(url) + '" data-name="' + esc(a.name) + '"></div><div role="button" aria-label="Add to Drive"></div></div></span>';
  return '<span class="aZo" download_url="application/octet-stream:' + esc(a.name) + ':' + esc(url) + '">' + name + '</span>';
}
function messageHtml(t, m, index) {
  if (m.hiddenUnreadable) return '<div role="listitem" class="kv"></div>';
  const id = m.id || ('18f00000000' + index + t.id).replace(/[^0-9a-f]/g, 'a').slice(0, 16);
  const attachments = (m.attachments || []).map((a, i) => attachmentHtml(t, a, i)).join('');
  const body = m.noBody ? '' : '<div class="ii gt"><div class="a3s aiL">' + (m.bodyHtml || esc(m.body || ('Body of ' + t.subject + ' message ' + (index + 1)))) + '</div></div>';
  const card = attachments ? '<div class="hq gt"><div class="aQH">' + attachments + '</div></div>' : '';
  const sender = m.sender || t.sender;
  return '<div role="listitem"><div class="adn ads" data-message-id="#msg-f:' + esc(id) + '" data-legacy-message-id="' + esc(id) + '"><div class="gE"><span class="gD" email="' + esc(sender) + '" name="' + esc(m.senderName || t.senderName) + '">' + esc(m.senderName || t.senderName) + '</span> <span class="hb">to <span class="g2" email="owner@example.test" name="me">me</span></span></div><span class="g3" title="' + esc(m.date || t.date || 'Sat, Aug 29, 2026, 9:00 AM') + '">Aug 29</span>' + body + card + '</div></div>';
}
function drawThread(v) {
  const views = document.getElementById('views');
  for (const child of views.children) child.classList.add('hidden');
  if (!v.thread) return;
  const t = allThreads().find(item => threadHash(item.id) === v.thread);
  if (!t) return;
  read.add(t.id);
  window.__opens = (window.__opens || 0) + 1;
  const box = document.createElement('div');
  const messages = t.messages || [{ attachments: t.attachments, bodyHtml: t.bodyHtml, noBody: t.noBody }];
  const stack = t.collapseAfterFirst && messages.length > 2;
  const permission = O.noIds ? '' : ' data-thread-perm-id="thread-f:' + esc(t.id) + '" data-legacy-thread-id="' + esc(t.id) + '"';
  const render = showAll => {
    const shown = stack && !showAll ? [messages[0], messages.at(-1)] : messages;
    const middle = stack && !showAll ? '<div class="kQ" role="button"><span class="adx">' + (messages.length - 2) + '</span></div>' : '';
    const html = shown.map((m, i) => messageHtml(t, m, messages.indexOf(m))).join('');
    box.innerHTML = '<h2 class="hP"' + permission + '>' + esc(t.subject) + '</h2>' + (middle ? html.replace('</div></div>', '</div></div>' + middle) : html);
    const more = box.querySelector('.kQ');
    if (more) pressable(more, () => render(true));
    box.querySelectorAll('.click-download').forEach(button => pressable(button, () => {
      const a = document.createElement('a');
      a.href = button.dataset.url;
      a.download = button.dataset.name;
      document.body.append(a);
      a.click();
      a.remove();
    }));
    box.querySelectorAll('.a3s a, .a3s img').forEach(el => el.addEventListener('click', () => { window.__linkClicks++; }));
  };
  render(false);
  views.append(box);
  document.title = t.subject + ' - owner@example.test - Gmail';
}
function render() {
  const v = view();
  drawToolbar(v);
  drawList(v);
  const hadThread = !!v.thread;
  if (hadThread && O.threadLatencyMs) setTimeout(() => { drawThread(v); }, O.threadLatencyMs);
  else drawThread(v);
}
addEventListener('hashchange', () => {
  const v = view();
  if (location.hash.startsWith('#search/')) window.__lastSearch = decodeURIComponent(location.hash.slice(8).split('/')[0]);
  if (O.ignoreUrlPaging && !v.thread) { /* list stays as it is */ }
  setTimeout(render, v.thread ? 0 : (O.pageLatencyMs || 0));
});
window.__rerender = () => { window.__listKey = null; render(); };
if (!location.hash) location.hash = '#inbox';
render();
</script></body></html>`;
}
