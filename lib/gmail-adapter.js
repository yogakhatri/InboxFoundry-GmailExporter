(function initGmailAdapter(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), gmailAdapter: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createGmailAdapterModule() {
  'use strict';

  /** Every Gmail-specific selector lives here. When Gmail changes its page, this is the table to update. */
  const SELECTORS = Object.freeze({
    listRows: 'tr.zA',
    rowIdentity: '[data-legacy-thread-id], [data-thread-id]',
    rowLastMessage: '[data-legacy-last-message-id]',
    rowSender: '.yP, .zF',
    rowSubject: '.bog',
    rowDate: '.xW',
    rowCount: '.bx0',
    rowSelected: 'input[type="checkbox"]:checked, [role="checkbox"][aria-checked="true"]',
    buttons: '[role="button"], button',
    paginationPair: '.h0 [role="button"]',
    paginationRange: '.Dj, .ts',
    subject: 'h2.hP',
    threadPermId: '[data-thread-perm-id]',
    messageBlocks: 'div[role="listitem"], .adn, .kv',
    body: '.a3s',
    collapsedStack: '.adx, .kQ',
    collapsedHeader: '.gE, .gF',
    trimmed: '.ajR',
    attachmentLeaf: '.aZo, [download_url], [data-attachment-id]',
    attachmentContainer: '.aQH',
    attachmentName: '[data-attachment-name], .aV3',
    attachmentSize: '.SaH2Ve',
    attachmentLink: 'a[href*="view=att"], a[download][href]',
    driveLink: 'a[href*="drive.google.com"], a[href*="docs.google.com"]',
    attachmentControl: '[role="button"], button, a',
    sender: '.gD[email]',
    recipients: '.hb [email], .g2[email]',
    anyAddress: '[email]',
    date: '.g3[title], .g3',
    header: '.gE, .gF, .iw'
  });

  // Exact labels only: substring matching would also catch words like "folder" or "shareholder".
  const OLDER_LABELS = new Set([
    'older', 'ältere', 'plus anciens', 'plus anciennes', 'anteriores', 'más antiguos', 'más antiguas', 'antigos', 'mais antigos',
    'più vecchi', 'meno recenti', 'precedenti', 'ouder', 'äldre', 'ældre', 'eldre', 'vanhemmat', 'starsze', 'starší', 'régebbi',
    'mai vechi', 'starije', 'starejše', 'παλαιότερα', 'по-стари', 'старые', 'старіші', 'daha eski', 'lebih lama', 'cũ hơn',
    'पुराने', 'পুরনো', 'पुराना', 'பழையவை', 'పాతవి', 'เก่ากว่า', 'ישנים יותר', 'أقدم', 'قدیمی‌تر', '古い順', '古い', '以前', '更早', '较早', '較舊', '이전'
  ]);
  const DOWNLOAD_WORDS = [
    'download', 'herunterladen', 'télécharger', 'descargar', 'scaricare', 'baixar', 'transferir', 'downloaden', 'ladda ned', 'hämta',
    'hent', 'lataa', 'pobierz', 'stáhnout', 'stiahnuť', 'letöltés', 'descărca', 'preuzmi', 'prenesi', 'λήψη', 'изтегляне', 'скачать',
    'завантажити', 'indir', 'unduh', 'tải xuống', 'डाउनलोड', 'ডাউনলোড', 'பதிவிறக்கு', 'డౌన్‌లోడ్', 'ดาวน์โหลด', 'הורדה', 'تنزيل', 'دانلود',
    'ダウンロード', '下载', '下載', '다운로드'
  ];
  const ALLOWED_DOWNLOAD_HOST = /^(?:mail\.google\.com|[a-z0-9-]+\.googleusercontent\.com)$/i;
  const THREAD_SEGMENT = /^[A-Za-z0-9_-]{16,}$/;
  // Chrome runs a long-hidden page's timers about once a minute, so Gmail itself renders slowly there.
  const HIDDEN_TAB_TIMEOUT_MS = 150000;
  const SIZE_FACTORS = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, к: 1024, м: 1024 ** 2, г: 1024 ** 3 };

  /** Splits a Gmail URL hash into the list it belongs to and its page, ignoring any open conversation. */
  function parseView(hash) {
    const segments = String(hash ?? '').replace(/^#/, '').split('/').filter(Boolean);
    let page = 1;
    const queryView = ['search', 'label', 'category', 'advanced-search', 'create-filter'].includes(segments[0]);
    const minimum = queryView ? 2 : 1;
    if (segments.length > minimum && THREAD_SEGMENT.test(segments.at(-1))) segments.pop();
    const pageMatch = segments.length > minimum ? segments.at(-1).match(/^p(\d+)$/) : null;
    if (pageMatch) {
      page = Number(pageMatch[1]);
      segments.pop();
    }
    return { base: `#${segments.join('/') || 'inbox'}`, page };
  }

  /** A form of a list hash that stays equal when Gmail re-encodes the same search. */
  function comparableBase(base) {
    let text = String(base ?? '').replace(/\+/g, ' ');
    try {
      text = decodeURIComponent(text);
    } catch {
      // Keep the raw hash if it is not valid percent-encoding.
    }
    return text.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  }

  function parseSizeBytes(text) {
    const matches = [...String(text ?? '').matchAll(/(\d[\d.,  ]*)\s*([kmgкмг]?)(?:b|o|б|bytes?|байт)(?![\p{L}])/giu)];
    const match = matches.at(-1);
    if (!match) return null;
    let digits = match[1].replace(/[  ]/g, '');
    if (/^\d{1,3}(,\d{3})+$/.test(digits)) digits = digits.replace(/,/g, '');
    else if (/^\d{1,3}(\.\d{3})+$/.test(digits)) digits = digits.replace(/\./g, '');
    else digits = digits.replace(/,/g, '.');
    const amount = Number(digits);
    const factor = SIZE_FACTORS[match[2].toLocaleLowerCase()];
    return Number.isFinite(amount) && factor ? Math.round(amount * factor) : null;
  }

  function isAllowedDownloadUrl(value) {
    try {
      const url = new URL(String(value ?? ''));
      return url.protocol === 'https:' && ALLOWED_DOWNLOAD_HOST.test(url.hostname);
    } catch {
      return false;
    }
  }

  function create(options = {}) {
    const documentRef = options.documentRef || globalThis.document;
    const locationRef = options.locationRef || globalThis.location;
    const historyRef = options.historyRef || globalThis.history;
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const resolveDate = options.resolveDate || (() => ({ iso: null, source: 'unknown' }));
    const onStage = options.onStage || (() => {});
    const isHidden = options.isHidden || (() => false);
    const pressed = new WeakSet();

    const all = (selector, scope = documentRef) => [...scope.querySelectorAll(selector)];
    const text = element => (element?.innerText || element?.textContent || '').trim();
    const squeeze = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    const inBody = element => !!element.closest?.(SELECTORS.body);

    function isVisible(element) {
      return !!element && element.getClientRects().length > 0;
    }

    /** Gmail buttons often respond to mouse down and up rather than a bare click, so send the full gesture. */
    function press(element) {
      element.scrollIntoView?.({ block: 'center' });
      const view = documentRef.defaultView;
      for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
        element.dispatchEvent(new view.MouseEvent(type, { bubbles: true, cancelable: true, view }));
      }
    }

    /** Polls without ever spinning. A hidden tab's slow timers can't time it out before it has looked a few times. */
    async function waitFor(predicate, timeout = 12000, interval = 160) {
      const startedAt = Date.now();
      let checks = 0;
      for (;;) {
        const value = predicate();
        if (value) return value;
        checks++;
        const limit = isHidden() ? Math.max(timeout, HIDDEN_TAB_TIMEOUT_MS) : timeout;
        if (Date.now() - startedAt >= limit && checks >= 3) return null;
        await sleep(interval);
      }
    }

    function visibleRows() {
      return all(SELECTORS.listRows).filter(isVisible);
    }

    function rowIdentity(row) {
      const holder = row.matches?.(SELECTORS.rowIdentity) ? row : row.querySelector(SELECTORS.rowIdentity);
      return holder?.getAttribute('data-legacy-thread-id') || holder?.getAttribute('data-thread-id') || null;
    }

    function rowComposite(row) {
      return [SELECTORS.rowSender, SELECTORS.rowSubject, SELECTORS.rowDate].map(selector => squeeze(text(row.querySelector(selector)))).join('|');
    }

    /** Rows with no Gmail ID get a page-specific key; opening them then reveals the real ID, so duplicates can't hide mail. */
    function listRows(page = 1) {
      const occurrences = new Map();
      return visibleRows().map(element => {
        const id = rowIdentity(element);
        let key = id;
        if (!key) {
          const composite = rowComposite(element);
          const occurrence = (occurrences.get(composite) || 0) + 1;
          occurrences.set(composite, occurrence);
          key = `weak:p${page}:${composite}#${occurrence}`;
        }
        const lastHolder = element.matches?.(SELECTORS.rowLastMessage) ? element : element.querySelector(SELECTORS.rowLastMessage);
        const count = Number(text(element.querySelector(SELECTORS.rowCount)).replace(/\D/g, ''));
        return {
          element,
          key,
          strong: !!id,
          lastMessageId: lastHolder?.getAttribute('data-legacy-last-message-id') || null,
          unread: !!element.classList?.contains('zE'),
          countHint: Number.isFinite(count) && count > 0 ? count : null,
          selected: !!element.querySelector(SELECTORS.rowSelected) || element.getAttribute('aria-selected') === 'true' || !!element.classList?.contains('x7')
        };
      });
    }

    function listSignature() {
      return visibleRows().slice(0, 5).map(row => rowIdentity(row) || rowComposite(row)).join('||');
    }

    function isThreadOpen() {
      return all(SELECTORS.subject).some(isVisible);
    }

    function threadIdentity() {
      if (!isThreadOpen()) return null;
      const subject = all(SELECTORS.subject).find(isVisible);
      const permanent = all(SELECTORS.threadPermId).find(isVisible);
      const id = permanent?.getAttribute('data-thread-perm-id') || subject?.getAttribute('data-thread-perm-id') ||
        subject?.getAttribute('data-legacy-thread-id');
      return id || `${locationRef.hash}|${squeeze(text(subject))}`;
    }

    function realThreadId() {
      const subject = all(SELECTORS.subject).find(isVisible);
      const permanent = all(SELECTORS.threadPermId).find(isVisible);
      return permanent?.getAttribute('data-thread-perm-id') || subject?.getAttribute('data-thread-perm-id') ||
        subject?.getAttribute('data-legacy-thread-id') || null;
    }

    function messageBlocks() {
      const blocks = all(SELECTORS.messageBlocks).filter(block => isVisible(block) && !inBody(block));
      // Keep only outermost message containers, since Gmail nests .adn inside role=listitem.
      return blocks.filter(block => !blocks.some(other => other !== block && other.contains(block)));
    }

    function bodiesOf(block) {
      const bodies = all(SELECTORS.body, block).filter(isVisible);
      return bodies.filter(body => !bodies.some(other => other !== body && other.contains(body)));
    }

    async function openThread(row) {
      const previous = threadIdentity();
      press(row);
      const opened = await waitFor(() => {
        const identity = threadIdentity();
        return identity && identity !== previous ? identity : null;
      }, 12000, 120);
      if (!opened) return false;
      await waitFor(() => messageBlocks().length > 0, 6000, 120);
      return true;
    }

    async function expandThread() {
      for (let pass = 0; pass < 25; pass++) {
        let clicked = 0;
        for (const stack of all(SELECTORS.collapsedStack).filter(item => isVisible(item) && !inBody(item) && !pressed.has(item))) {
          pressed.add(stack);
          press(stack);
          clicked++;
        }
        for (const block of messageBlocks()) {
          if (bodiesOf(block).length || pressed.has(block)) continue;
          pressed.add(block);
          press(block.querySelector(SELECTORS.collapsedHeader) || block);
          clicked++;
        }
        for (const control of all(SELECTORS.trimmed).filter(item => isVisible(item) && !pressed.has(item))) {
          pressed.add(control);
          press(control);
          clicked++;
        }
        if (!clicked) break;
        await sleep(250);
      }
      // Give messages that were just expanded a moment to fetch and render.
      await waitFor(() => messageBlocks().every(block => bodiesOf(block).length > 0), 2500, 150);
    }

    function attachmentCards(block) {
      const leaves = all(SELECTORS.attachmentLeaf, block).filter(card => !inBody(card));
      const cards = leaves.filter(card => !leaves.some(other => other !== card && card.contains(other)));
      if (cards.length) return cards;
      return all(SELECTORS.attachmentContainer, block).filter(card => !inBody(card) && (card.querySelector(SELECTORS.attachmentName) || text(card)));
    }

    function parseDownloadUrlAttribute(card) {
      const value = card.getAttribute?.('download_url') || card.querySelector?.('[download_url]')?.getAttribute('download_url');
      if (!value) return { name: null, url: null };
      const match = value.match(/^[^:]*:(.*?):(https?:\/\/.*)$/i);
      return match ? { name: match[1], url: match[2] } : { name: null, url: null };
    }

    function downloadControl(card) {
      return all(SELECTORS.attachmentControl, card).find(element => {
        const label = [element.getAttribute('aria-label'), element.getAttribute('data-tooltip'), element.getAttribute('title')]
          .filter(Boolean).join(' ').toLocaleLowerCase();
        return DOWNLOAD_WORDS.some(word => label.includes(word));
      }) || null;
    }

    function describeAttachment(card, ordinal) {
      const parsed = parseDownloadUrlAttribute(card);
      const named = card.querySelector(SELECTORS.attachmentName);
      const link = card.matches?.(SELECTORS.attachmentLink) ? card : card.querySelector(SELECTORS.attachmentLink);
      const fileName = named?.getAttribute('data-attachment-name') || text(named) || parsed.name ||
        link?.getAttribute('download') || `attachment-${ordinal}`;
      const url = [parsed.url, link?.href].find(isAllowedDownloadUrl) || null;
      const sizeText = text(card.querySelector(SELECTORS.attachmentSize)) || text(card).replace(fileName, ' ');
      const control = downloadControl(card);
      const drive = !url && !!card.querySelector(SELECTORS.driveLink);
      return { ordinal, fileName, sizeBytes: parseSizeBytes(sizeText), url, canClick: !!control, driveLink: drive };
    }

    function extractThread() {
      const locales = [documentRef.documentElement?.lang, globalThis.navigator?.language];
      const blocks = messageBlocks();
      const captured = blocks.filter(block => bodiesOf(block).length > 0);
      const messages = captured.map((block, position) => {
        const bodies = bodiesOf(block);
        const sender = all(SELECTORS.sender, block).find(element => !inBody(element)) ||
          all(SELECTORS.anyAddress, block).find(element => !inBody(element));
        const from = squeeze(sender?.getAttribute('email'));
        const addresses = [
          ...all(SELECTORS.recipients, block),
          ...all(SELECTORS.anyAddress, block)
        ].filter(element => !inBody(element)).map(element => squeeze(element.getAttribute('email'))).filter(Boolean);
        const dateElement = block.querySelector(SELECTORS.date);
        const dateText = dateElement?.getAttribute('title') || text(dateElement);
        const idHolder = block.hasAttribute?.('data-legacy-message-id') || block.hasAttribute?.('data-message-id')
          ? block : block.querySelector('[data-legacy-message-id], [data-message-id]');
        const messageId = idHolder?.getAttribute('data-legacy-message-id') || idHolder?.getAttribute('data-message-id') || null;
        const resolved = resolveDate(dateText, messageId, locales);
        return {
          index: position + 1,
          messageId,
          from,
          fromName: squeeze(sender?.getAttribute('name')) || null,
          recipients: [...new Set(addresses.filter(address => address !== from))],
          date: squeeze(dateText),
          dateIso: resolved.iso,
          dateSource: resolved.source,
          rawHeaderText: text(block.querySelector(SELECTORS.header)),
          bodyTextRaw: bodies.map(body => body.innerText || body.textContent || '').join('\n'),
          bodyHtmlRaw: bodies.map(body => body.innerHTML || '').join('\n'),
          attachments: attachmentCards(block).map((card, offset) => describeAttachment(card, offset + 1))
        };
      });
      const subject = all(SELECTORS.subject).find(isVisible);
      return {
        threadId: realThreadId(),
        subject: squeeze(text(subject)) || squeeze(documentRef.title.replace(/ - .*Gmail.*/i, '')),
        url: locationRef.href,
        messages,
        messagesNotExpanded: blocks.length - captured.length
      };
    }

    /** Finds a download control again for the rare attachment with no direct URL. Only ever inside its own card. */
    function attachmentControlFor(messageIndex, ordinal) {
      const block = messageBlocks().filter(item => bodiesOf(item).length > 0)[messageIndex - 1];
      const card = block ? attachmentCards(block)[ordinal - 1] : null;
      return card ? downloadControl(card) : null;
    }

    function olderControl() {
      const visible = all(SELECTORS.buttons).filter(isVisible);
      const labelled = visible.find(element => {
        const labels = [element.getAttribute('aria-label'), element.getAttribute('data-tooltip'), element.getAttribute('title')];
        return labels.some(label => label && OLDER_LABELS.has(label.trim().toLocaleLowerCase()));
      });
      if (labelled) return { element: labelled, method: 'label' };
      const pair = all(SELECTORS.paginationPair).filter(isVisible);
      return pair.length >= 2 ? { element: pair.at(-1), method: 'position' } : null;
    }

    function isDisabled(element) {
      return element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('disabled');
    }

    function paginationRange() {
      for (const element of all(SELECTORS.paginationRange).filter(isVisible)) {
        const numbers = text(element).replace(/[  ]/g, ' ').match(/\d[\d.,]*/g)?.map(value => Number(value.replace(/[.,]/g, '')));
        if (numbers?.length >= 2) return { start: numbers[0], end: numbers[1], total: numbers.length >= 3 ? numbers[2] : null };
      }
      return null;
    }

    function pageHash(base, page) {
      return page > 1 ? `${base}/p${page}` : base;
    }

    /**
     * Moves to the next page of results, confirming it really changed. The result separates a proven last
     * page ('end') from not being able to tell ('unconfirmed'), so a job never claims completeness it can't show.
     */
    async function nextPage() {
      const { base, page } = parseView(locationRef.hash);
      const previous = listSignature();
      const changed = timeout => waitFor(() => {
        const signature = listSignature();
        return signature && signature !== previous && !isThreadOpen() ? true : null;
      }, timeout, 150);

      const control = olderControl();
      if (control && isDisabled(control.element)) return { status: 'end', method: `${control.method}-disabled` };
      const range = paginationRange();
      if (range?.total && range.end >= range.total) return { status: 'end', method: 'range' };

      if (control) {
        press(control.element);
        if (await changed(7000)) return { status: 'advanced', method: control.method };
      }
      // Language-independent fallback: Gmail addresses list pages directly in the URL.
      const target = pageHash(base, page + 1);
      if (locationRef.hash !== target) locationRef.hash = target;
      if (await changed(9000)) return { status: 'advanced', method: 'url' };
      // An empty list may only be slow to draw, so give it longer before calling it the end.
      if (!await waitFor(() => visibleRows().length > 0, 8000, 200)) {
        locationRef.hash = pageHash(base, page);
        return { status: 'end', method: 'empty-page' };
      }
      return { status: 'unconfirmed', method: 'none' };
    }

    function backControl() {
      return all(SELECTORS.buttons).filter(isVisible).find(element => {
        const label = (element.getAttribute('aria-label') || element.getAttribute('data-tooltip') || '').toLocaleLowerCase();
        return label.startsWith('back to ');
      });
    }

    /** Returns to a list. Succeeds once no conversation fills the view, because a list may legitimately be empty now. */
    async function returnToList(listHash) {
      onStage('Returning to the list…');
      const settled = timeout => waitFor(() => !isThreadOpen() || visibleRows().length > 0, timeout, 120);
      if (locationRef.hash !== listHash) locationRef.hash = listHash;
      if (await settled(9000)) return true;
      const back = backControl();
      if (back) {
        press(back);
        if (await settled(6000)) return true;
      }
      historyRef.back();
      if (await settled(6000)) return true;
      throw new Error('Could not return to the Gmail list. Go back to the list and resume.');
    }

    function waitForRows(timeout = 8000) {
      return waitFor(() => (visibleRows().length ? true : null), timeout, 150);
    }

    function search(query) {
      const value = String(query ?? '').trim();
      if (!value) throw new Error('Enter at least one Gmail search filter.');
      const target = `#search/${encodeURIComponent(value)}`;
      if (locationRef.hash !== target) locationRef.hash = target;
      return target;
    }

    /** Read-only and content-free: counts and yes/no answers that can be shared safely in a bug report. */
    function compatibilityReport() {
      const rows = visibleRows();
      const report = {
        language: documentRef.documentElement?.lang || null,
        view: isThreadOpen() ? 'conversation' : 'list',
        list: {
          rowsVisible: rows.length,
          rowsWithGmailId: rows.filter(rowIdentity).length,
          rowsWithSender: rows.filter(row => row.querySelector(SELECTORS.rowSender)).length,
          rowsWithSubject: rows.filter(row => row.querySelector(SELECTORS.rowSubject)).length,
          olderControl: olderControl()?.method || 'not found',
          rangeReadable: !!paginationRange()
        }
      };
      if (isThreadOpen()) {
        const thread = extractThread();
        const attachments = thread.messages.flatMap(message => message.attachments);
        report.conversation = {
          threadIdFound: !!thread.threadId,
          messageBlocks: messageBlocks().length,
          messagesWithBody: thread.messages.length,
          messagesNotExpanded: thread.messagesNotExpanded,
          sendersFound: thread.messages.filter(message => message.from).length,
          recipientsFound: thread.messages.filter(message => message.recipients.length).length,
          messageIdsFound: thread.messages.filter(message => message.messageId).length,
          datesDisplayed: thread.messages.filter(message => message.dateSource === 'displayed').length,
          datesFromMessageId: thread.messages.filter(message => message.dateSource === 'message-id').length,
          datesUnknown: thread.messages.filter(message => message.dateSource === 'unknown').length,
          attachments: attachments.length,
          attachmentsWithDirectUrl: attachments.filter(item => item.url).length,
          attachmentsWithControl: attachments.filter(item => item.canClick).length,
          attachmentsWithSize: attachments.filter(item => item.sizeBytes != null).length,
          driveLinks: attachments.filter(item => item.driveLink).length
        };
      }
      return report;
    }

    return {
      listRows, listSignature, isThreadOpen, openThread, expandThread, extractThread, attachmentControlFor,
      press, nextPage, paginationRange, returnToList, waitForRows, waitFor, search, compatibilityReport
    };
  }

  return { parseView, comparableBase, parseSizeBytes, isAllowedDownloadUrl, create };
});
