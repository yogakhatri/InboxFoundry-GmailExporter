(function initGmailAdapter(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), gmailAdapter: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createGmailAdapterModule() {
  'use strict';

  const SELECTORS = Object.freeze({
    listRows:'tr.zA, tr[role="main"]', rowSender:'.yP,.zF', rowSubject:'.bog', rowDate:'.xW',
    selectedRow:'input[type="checkbox"]:checked, [role="checkbox"][aria-checked="true"]', buttons:'[role="button"],button',
    threadView:'h2.hP, [data-thread-perm-id], div[role="listitem"] .a3s', subject:'h2.hP', threadId:'[data-thread-perm-id]',
    messageCandidates:'div[role="listitem"], .adn', messageListItems:'div[role="listitem"]', messageFallback:'.adn', body:'.a3s', collapsedHeader:'[role="button"], .gE, .gF',
    trimmed:'.ajR, [aria-label], [data-tooltip], [title]',
    attachmentCandidates:'[download], [download_url], [aria-label*="Download" i], [title*="Download" i], [data-tooltip*="Download" i]',
    attachmentCards:'.aQH, [data-attachment-id], .aZo', attachmentCard:'.aQH, [data-attachment-id], .aZo',
    attachmentContainer:'.aQH, [data-attachment-id], [download_url], .aZo, .aQy', attachmentName:'.aV3, [data-attachment-name], [download]',
    attachmentControls:'[download], [download_url], a[href], [role="button"], div', sender:'.gD[email], .gD, [email]',
    headerEmails:'.g2[email], .hb [email], span[email], [email]', date:'.g3[title], .g3', header:'.gE, .gF, .iw'
  });

  function create(options = {}) {
    const documentRef = options.documentRef || globalThis.document;
    const locationRef = options.locationRef || globalThis.location;
    const historyRef = options.historyRef || globalThis.history;
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const rawText = options.rawText || (element => (element?.innerText || element?.textContent || '').trim());
    const normalize = options.normalize || (value => String(value || '').replace(/\s+/g, ' ').trim());
    const sanitizeFileName = options.sanitizeFileName || (value => String(value || 'attachment'));
    const parseSizeBytes = options.parseSizeBytes || (() => null);
    const includeAllThreadMessages = options.includeAllThreadMessages || (() => true);
    const onStage = options.onStage || (() => {});

    function getVisibleThreads() {
      return [...documentRef.querySelectorAll(SELECTORS.listRows)].filter(row => row.offsetParent !== null && rawText(row));
    }
    function threadKey(row) {
      return row?.getAttribute('data-legacy-thread-id') || row?.getAttribute('data-thread-id') || row?.getAttribute('data-legacy-message-id') ||
        [rawText(row?.querySelector(SELECTORS.rowSender)), rawText(row?.querySelector(SELECTORS.rowSubject)), rawText(row?.querySelector(SELECTORS.rowDate))].join('|');
    }
    function isThreadSelected(row) { return !!row?.querySelector(SELECTORS.selectedRow) || row?.getAttribute('aria-selected') === 'true'; }
    function buttonByText(predicate) {
      return [...documentRef.querySelectorAll(SELECTORS.buttons)].find(element => predicate((element.getAttribute('aria-label') || '').toLowerCase(), (element.getAttribute('title') || '').toLowerCase()));
    }
    function nextResultsPageControl() { return buttonByText((aria, title) => aria.includes('older') || title.includes('older')); }
    function backToResultsControl() { return buttonByText((aria, title) => aria === 'back to inbox' || aria.startsWith('back to ') || title === 'back to inbox' || title.startsWith('back to ')); }
    function isDisabled(element) { return !element || element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('disabled') || element.classList.contains('amJ'); }
    async function waitFor(predicate, timeout = 12000, interval = 160) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeout) { const value = predicate(); if (value) return value; await sleep(interval); }
      return null;
    }
    function pageSignature() { return getVisibleThreads().slice(0, 5).map(threadKey).join('||'); }
    async function waitRowsChange(oldSignature) {
      return waitFor(() => { const rows = getVisibleThreads(); const signature = rows.slice(0, 3).map(threadKey).join('||'); return rows.length && signature && signature !== oldSignature ? rows : null; }, 15000, 300);
    }
    function isThreadView() { return !!documentRef.querySelector(SELECTORS.threadView); }
    async function waitForList(timeout = 15000) {
      return waitFor(() => { if (isThreadView()) return null; const rows = getVisibleThreads(); return rows.length ? rows : null; }, timeout, 220);
    }
    async function expandCollapsedMessages() {
      if (!includeAllThreadMessages()) return;
      for (let pass = 0; pass < 8; pass++) {
        let clicked = 0;
        for (const block of documentRef.querySelectorAll(SELECTORS.messageCandidates)) {
          if (block.querySelector(SELECTORS.body)) continue;
          const header = block.querySelector(SELECTORS.collapsedHeader);
          if (header && header.offsetParent !== null) { header.click(); clicked++; await sleep(220); }
        }
        if (!clicked) break;
        await sleep(300);
      }
    }
    function isTrimmedControl(element) {
      const aria = (element.getAttribute('aria-label') || '').toLowerCase();
      const tooltip = (element.getAttribute('data-tooltip') || element.getAttribute('title') || '').toLowerCase();
      return element.classList?.contains('ajR') || aria.includes('show trimmed content') || tooltip.includes('show trimmed content');
    }
    async function expandTrimmedContent() {
      for (let pass = 0; pass < 5; pass++) {
        const controls = [...documentRef.querySelectorAll(SELECTORS.trimmed)].filter(element => element.offsetParent !== null && isTrimmedControl(element));
        if (!controls.length) break;
        let clicked = 0;
        for (const control of controls) { try { control.click(); clicked++; await sleep(140); } catch (_) {} }
        if (!clicked) break;
        await sleep(300);
      }
    }
    async function expandThread() { await expandCollapsedMessages(); await expandTrimmedContent(); }
    function messageBlocks() {
      let blocks = [...documentRef.querySelectorAll(SELECTORS.messageListItems)].filter(block => block.querySelector(SELECTORS.body));
      if (!blocks.length) blocks = [...documentRef.querySelectorAll(SELECTORS.messageFallback)].filter(block => block.querySelector(SELECTORS.body));
      return blocks;
    }
    function attachmentName(element, container, fallbackIndex) {
      const direct = element?.getAttribute?.('download') || element?.getAttribute?.('data-attachment-name');
      if (direct) return sanitizeFileName(direct);
      const card = container || element?.closest?.(SELECTORS.attachmentContainer);
      const named = card?.querySelector?.(SELECTORS.attachmentName);
      const cardName = named?.getAttribute?.('data-attachment-name') || named?.getAttribute?.('download') || rawText(named);
      if (cardName) return sanitizeFileName(cardName);
      const label = element?.getAttribute?.('aria-label') || element?.getAttribute?.('title') || element?.getAttribute?.('data-tooltip') || '';
      const cleaned = label.replace(/^download attachment\s*/i, '').replace(/^download\s*/i, '').replace(/^attachment\s*/i, '').replace(/[()]/g, '').trim();
      return cleaned && !/^download$/i.test(cleaned) ? sanitizeFileName(cleaned) : `attachment-${fallbackIndex}`;
    }
    function directDownloadUrl(element) {
      if (!element) return null;
      const value = element.getAttribute?.('download_url') || element.closest?.('[download_url]')?.getAttribute?.('download_url');
      if (value) { const match = String(value).match(/https?:\/\/.*$/i); if (match) return match[0]; }
      if (element.hasAttribute?.('download')) {
        const link = element.closest?.('a[href]') || (element.matches?.('a[href]') ? element : null);
        const href = link?.href || element.getAttribute?.('href');
        if (href && /^https?:/i.test(href)) return href;
      }
      return null;
    }
    function isDownloadControl(element) {
      const label = [element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-tooltip')].filter(Boolean).join(' ').toLowerCase();
      if (label.includes('download all')) return false;
      return element.hasAttribute('download') || element.hasAttribute('download_url') || label.includes('download');
    }
    function extractAttachments() {
      const targets = []; const seen = new Set();
      messageBlocks().forEach((block, messageIndex) => {
        const candidates = [...block.querySelectorAll(SELECTORS.attachmentCandidates)];
        for (const card of block.querySelectorAll(SELECTORS.attachmentCards)) {
          const control = [...card.querySelectorAll(SELECTORS.attachmentControls)].find(isDownloadControl);
          if (control) candidates.push(control);
          else {
            const name = attachmentName(null, card, targets.length + 1); const key = `${messageIndex}|${name}|card-only`;
            if (!seen.has(key)) { seen.add(key); targets.push({ messageIndex:messageIndex + 1, name, sizeBytes:parseSizeBytes(rawText(card)), element:null, url:null, detectedOnly:true }); }
          }
        }
        for (const element of candidates) {
          if (!isDownloadControl(element)) continue;
          const card = element.closest(SELECTORS.attachmentCard); const name = attachmentName(element, card, targets.length + 1); const url = directDownloadUrl(element);
          const key = `${messageIndex}|${name}|${url || element.getAttribute('aria-label') || element.getAttribute('title') || element.outerHTML.slice(0, 80)}`;
          if (seen.has(key)) continue;
          seen.add(key); targets.push({ messageIndex:messageIndex + 1, name, sizeBytes:parseSizeBytes(rawText(card)), element, url, detectedOnly:false });
        }
      });
      return targets;
    }
    function attachmentsByMessage() {
      const grouped = new Map();
      for (const target of extractAttachments()) {
        if (!grouped.has(target.messageIndex)) grouped.set(target.messageIndex, []);
        const values = grouped.get(target.messageIndex);
        if (!values.some(item => item.fileName === target.name)) values.push({ fileName:target.name, sizeBytes:target.sizeBytes, detected:true, hasDirectUrl:!!target.url });
      }
      return grouped;
    }
    function extractMessageMetadata() {
      const groupedAttachments = attachmentsByMessage();
      return messageBlocks().map((block, index) => {
        const body = block.querySelector(SELECTORS.body); const sender = block.querySelector(SELECTORS.sender);
        const headerEmails = [...block.querySelectorAll(SELECTORS.headerEmails)].map(element => element.getAttribute('email')).filter(Boolean);
        const senderEmail = normalize(sender?.getAttribute('email') || sender?.getAttribute('data-hovercard-id') || rawText(sender));
        const date = block.querySelector(SELECTORS.date); const header = block.querySelector(SELECTORS.header); const bodyTextRaw = body?.innerText || body?.textContent || '';
        return { index:index + 1, messageId:block.getAttribute('data-legacy-message-id') || block.getAttribute('data-message-id') || null, from:senderEmail,
          recipients:[...new Set(headerEmails.filter(value => normalize(value) !== senderEmail))], date:date?.getAttribute('title') || rawText(date),
          rawHeaderText:header?.innerText || header?.textContent || '', bodyTextRaw, bodyTextNormalized:normalize(bodyTextRaw), bodyHtmlRaw:body?.innerHTML || '',
          attachments:groupedAttachments.get(index + 1) || [] };
      });
    }
    function extractThreadMetadata(fallbackKey) {
      const subject = normalize(rawText(documentRef.querySelector(SELECTORS.subject)) || documentRef.title.replace(/ - .*Gmail.*/i, ''));
      const permanentId = documentRef.querySelector(SELECTORS.threadId)?.getAttribute('data-thread-perm-id') || null;
      return { threadKey:permanentId || fallbackKey, subject, url:locationRef.href };
    }
    async function openThread(row) {
      row.scrollIntoView({ block:'center' }); await sleep(150); const previousUrl = locationRef.href; row.click();
      return !!await waitFor(() => isThreadView() && (locationRef.href !== previousUrl || documentRef.querySelector(SELECTORS.subject)), 12000, 220);
    }
    async function returnToSearchResults(listUrl, listHash) {
      onStage('Returning to email list…');
      try { if (listHash && locationRef.hash !== listHash) locationRef.hash = listHash; else if (listUrl && locationRef.href !== listUrl) historyRef.back(); } catch (_) { historyRef.back(); }
      let rows = await waitForList(9000);
      if (rows?.length) { await sleep(300); return rows; }
      const back = backToResultsControl();
      if (back && back.offsetParent !== null) { back.click(); rows = await waitForList(7000); if (rows?.length) { await sleep(300); return rows; } }
      if (listUrl && locationRef.href !== listUrl) { locationRef.assign(listUrl); rows = await waitForList(7000); if (rows?.length) { await sleep(300); return rows; } }
      throw new Error('InboxFoundry could not return to the Gmail email list. Return to the original search and resume this export.');
    }
    async function getNextResultsPage() {
      const previous = pageSignature(); const control = nextResultsPageControl();
      if (isDisabled(control)) return { advanced:false, done:true };
      control.click(); const rows = await waitRowsChange(previous);
      return { advanced:!!rows, done:false, rows, previousSignature:previous, currentSignature:pageSignature() };
    }
    function searchMessages(query) {
      const value = String(query || '').trim();
      if (!value) throw new Error('Enter at least one Gmail search filter.');
      locationRef.hash = `#search/${encodeURIComponent(value)}`;
    }
    async function downloadAttachment(target) {
      if (!target?.element) return false;
      target.element.scrollIntoView({ block:'center' }); await sleep(160); target.element.click(); return true;
    }
    return { selectors:SELECTORS, searchMessages, getVisibleThreads, threadKey, isThreadSelected, openThread, expandThread, expandCollapsedMessages, expandTrimmedContent,
      extractMessageMetadata, extractAttachments, extractThreadMetadata, downloadAttachment, getNextResultsPage, nextResultsPageControl, returnToSearchResults,
      waitFor, waitForList, waitRowsChange, pageSignature, isThreadView, isDisabled };
  }
  return { SELECTORS, create };
});
