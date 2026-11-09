(function initExporter(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), exporter: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createExporter() {
  'use strict';

  const load = (name, file) => globalThis.InboxFoundry?.[name] || (typeof require === 'function' ? require(file) : null);
  const engine = load('exportEngine', './export-engine.js');
  const paths = load('pathSafety', './path-safety.js');

  const REASON_TEXT = Object.freeze({
    'threads-failed': 'Some conversations could not be read.',
    'threads-incomplete': 'Some conversations may be missing messages.',
    'limit-matched': 'The matched-conversation safety limit was reached.',
    'limit-inspected': 'The inspected-conversation safety limit was reached.',
    'pagination-end-unconfirmed': 'InboxFoundry could not confirm it reached the last page.',
    'rows-opened-same-conversation': 'Some list rows opened a conversation that was already captured, so their own conversations may be missing.',
    'no-rows-found': 'No conversations were found in this view.',
    stopped: 'The scan was stopped before it finished.'
  });

  function partialReasons(job) {
    const reasons = [...(job.partialReasons || [])];
    if (job.status !== 'ready' && !reasons.includes('stopped') && job.scanFinishedAt == null) reasons.push('stopped');
    return reasons;
  }

  function sanitizedConfig(config) {
    const copy = JSON.parse(JSON.stringify(config));
    delete copy.source.selectedThreadKeys;
    if (copy.output.redactAddresses) {
      copy.source.gmailQuery = '[redacted]';
      copy.email.includeTerms = copy.email.includeTerms.map(() => '[redacted]');
      copy.email.excludeTerms = copy.email.excludeTerms.map(() => '[redacted]');
    }
    return copy;
  }

  function buildEnvelope(job, exportedAt, version) {
    const reasons = partialReasons(job);
    const output = job.config.output;
    const hideUrl = !output.includeGmailUrls || output.redactAddresses;
    return {
      formatVersion: 3,
      schemaVersion: job.schemaVersion,
      generator: { name: 'InboxFoundry', version },
      job: {
        id: job.id,
        name: job.name,
        status: job.status,
        isPartial: reasons.length > 0,
        partialReasons: reasons,
        partialExplanations: reasons.map(reason => REASON_TEXT[reason] || reason),
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        scanFinishedAt: job.scanFinishedAt
      },
      exportedAt,
      source: { mode: job.config.source.mode, url: hideUrl ? undefined : job.sourceUrl },
      config: sanitizedConfig(job.config),
      totals: { ...job.counters, matchedThreads: job.counters.matched }
    };
  }

  const README = (job, isPartial, extra) => `InboxFoundry export\n\nBatch: ${job.name}\nPartial: ${isPartial ? 'yes' : 'no'}\n\n${extra}\n\nCHECKSUMS.sha256 detects accidental corruption of the files in this package. It does not prove authenticity. This is a copy read from the Gmail web page, not Google's original message source.\n`;

  /** Writes the requested formats as { name, blob } files, reading mail from storage in small pages. */
  async function buildFiles(job, formats, options) {
    const { store, version = '', onProgress = () => {} } = options;
    const exportedAt = new Date().toISOString();
    const envelope = buildEnvelope(job, exportedAt, version);
    const excluded = new Set();
    let kept = 0;
    for await (const thread of store.iterateThreads(job.id)) {
      if (thread.outcome !== 'matched') continue;
      if (thread.excluded) excluded.add(thread.id);
      else kept++;
    }
    envelope.totals.matchedThreads = kept;
    envelope.totals.excludedInReview = excluded.size;

    const records = async function* records() {
      let done = 0;
      for await (const row of store.iterateRecords(job.id)) {
        if (excluded.has(row.id)) continue;
        done++;
        if (done % 25 === 0) onProgress(`Writing conversation ${done} of ${kept}…`);
        yield row.record;
      }
    };
    const attachments = () => store.iterateAttachments(job.id);
    const context = { exportedAt, jobId: job.id };
    const textBlob = async (chunks, type) => {
      const parts = [];
      for await (const piece of chunks) parts.push(piece);
      return new Blob(parts, { type });
    };
    const isPartial = envelope.job.isPartial;

    const files = [];
    for (const format of formats) {
      onProgress(`Preparing ${format}…`);
      if (format === 'json') files.push({ name: 'emails.json', blob: await textBlob(engine.jsonChunks(envelope, records()), 'application/json') });
      if (format === 'csv') files.push({ name: 'emails.csv', blob: await textBlob(engine.messagesCsvChunks(records()), 'text/csv') });
      if (format === 'html') files.push({ name: 'emails.html', blob: await textBlob(engine.htmlChunks(envelope, records()), 'text/html') });
      if (format === 'mbox') files.push({ name: 'emails.mbox', blob: await textBlob(engine.mboxChunks(records(), context), 'application/mbox') });
      if (format === 'manifest') files.push({ name: 'attachments.csv', blob: await textBlob(engine.attachmentsCsvChunks(attachments()), 'text/csv') });
      if (format === 'emlzip') {
        const zip = new engine.ZipBuilder();
        let threadOrdinal = 0;
        for await (const record of records()) {
          threadOrdinal++;
          const folder = `${String(threadOrdinal).padStart(5, '0')} - ${engine.archiveComponent(record.subject, 'No subject')}`;
          for (const [offset, message] of (record.messages || []).entries()) {
            await zip.add(`eml/${folder}/message-${String(offset + 1).padStart(3, '0')}.eml`, engine.reconstructedEml(record, message, context));
          }
        }
        if (!threadOrdinal) await zip.add('eml/EMPTY.txt', 'No conversations were selected.');
        await zip.add('README.txt', README(job, isPartial, 'These EML files are rebuilt from the Gmail page. Attachments are saved separately in their folders, not inside each message.'));
        await zip.addChecksums();
        files.push({ name: 'emails-eml.zip', blob: zip.finish() });
      }
      if (format === 'archive') {
        const zip = new engine.ZipBuilder();
        await zip.add('emails.json', engine.jsonChunks(envelope, records()));
        await zip.add('emails.csv', engine.messagesCsvChunks(records()));
        await zip.add('attachments.csv', engine.attachmentsCsvChunks(attachments()));
        await zip.add('emails.html', engine.htmlChunks(envelope, records()));
        await zip.add('README.txt', README(job, isPartial, 'emails.json is the most complete record. Open emails.html to read and search, or to print and save as PDF. Attachments are saved in their own folders, listed in attachments.csv.'));
        await zip.addChecksums();
        files.push({ name: 'archive.zip', blob: zip.finish() });
      }
    }
    return { files, isPartial, reasons: envelope.job.partialExplanations };
  }

  /** Bundles every file into one encrypted archive, so no plain copy of the mail is written. */
  async function encryptFiles(files, passphrase) {
    const zip = new engine.ZipBuilder();
    for (const file of files) await zip.addBlob(file.name, file.blob);
    await zip.addChecksums();
    const blob = await engine.encryptBlob(zip.finish(), passphrase, { contentName: 'inboxfoundry-export.zip' });
    return [{ name: 'export.ifenc', blob }];
  }

  function downloadPathFor(job, fileName) {
    return paths.relativeDownloadPath(job.config.destination.rootFolder, job.name, fileName);
  }

  return { REASON_TEXT, partialReasons, buildFiles, encryptFiles, downloadPathFor };
});
