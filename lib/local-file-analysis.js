(function initLocalFileAnalysis(root, factory) {
  const api = factory();
  root.InboxFoundry = { ...(root.InboxFoundry || {}), localFileAnalysis: api };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function createLocalFileAnalysis() {
  'use strict';

  const TEXT_EXTENSIONS = new Set(['txt','text','md','markdown','csv','tsv','json','jsonl','ndjson','xml','html','htm','css','js','mjs','cjs','log','eml','ics','vcf','sql','yaml','yml']);

  function extensionOf(name) {
    const match = String(name || '').normalize('NFKC').toLocaleLowerCase().match(/\.([^.\s]+)$/u);
    return match?.[1] || '';
  }

  function isTextLike(file) {
    const type = String(file?.type || '').toLocaleLowerCase();
    return type.startsWith('text/') || type.includes('json') || type.includes('xml') || type.includes('javascript') || TEXT_EXTENSIONS.has(extensionOf(file?.name));
  }

  function hex(bytes) {
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function analyzeFile(file, options = {}) {
    const cryptoApi = options.cryptoApi || globalThis.crypto;
    if (!file || typeof file.arrayBuffer !== 'function') throw new Error('A readable local file is required.');
    if (!cryptoApi?.subtle) throw new Error('Web Crypto is unavailable.');
    const hashEngine = options.hashEngine || globalThis.InboxFoundry?.sha256;
    const maxHashBytes = Number.isFinite(options.maxHashBytes) ? options.maxHashBytes : 2 * 1024 * 1024 * 1024;
    const maxTextBytes = Number.isFinite(options.maxTextBytes) ? options.maxTextBytes : 2 * 1024 * 1024;
    const officeParser = options.officeParser || globalThis.InboxFoundry?.officeParser;
    const isOffice = !!officeParser?.OFFICE_EXTENSIONS?.has(extensionOf(file?.name));
    const maxOfficeFileBytes = Number.isFinite(options.maxOfficeFileBytes) ? options.maxOfficeFileBytes : 50 * 1024 * 1024;
    const pdfParser = options.pdfParser || globalThis.InboxFoundry?.pdfParser;
    const isPdf = extensionOf(file?.name) === 'pdf' || String(file?.type || '').toLocaleLowerCase() === 'application/pdf';
    const maxPdfFileBytes = Number.isFinite(options.maxPdfFileBytes) ? options.maxPdfFileBytes : 64 * 1024 * 1024;
    const size = Number(file.size) || 0;
    const result = {
      name:String(file.name || 'unnamed-file'),
      type:String(file.type || ''),
      extension:extensionOf(file.name),
      sizeBytes:size,
      lastModified:Number(file.lastModified) || null,
      sha256:null,
      hashStatus:size > maxHashBytes ? 'skipped-size-limit' : 'complete',
      textStatus:'not-text-like',
      text:'',
      textCharacters:0,
      segments:[]
    };
    const textIntelligence = options.textIntelligence || globalThis.InboxFoundry?.textIntelligence;

    const chunkedHash = !!hashEngine && typeof file.slice === 'function';
    const needsParserBytes = (isTextLike(file) && size <= maxTextBytes) || (isOffice && size <= maxOfficeFileBytes) || (isPdf && size <= maxPdfFileBytes);
    let bytes = null;
    if ((!chunkedHash && size <= maxHashBytes) || needsParserBytes) bytes = new Uint8Array(await file.arrayBuffer());
    if (options.signal?.aborted) throw new Error('analysis-cancelled');
    if (size <= maxHashBytes) {
      if (chunkedHash && bytes) { result.sha256 = hashEngine.hashBytes(bytes); options.onProgress?.({ processedBytes:size, totalBytes:size }); }
      else if (chunkedHash) result.sha256 = await hashEngine.hashFile(file, { maxBytes:maxHashBytes, chunkSize:options.hashChunkSize, signal:options.signal, onProgress:options.onProgress });
      else { result.sha256 = hex(await cryptoApi.subtle.digest('SHA-256', bytes)); options.onProgress?.({ processedBytes:size, totalBytes:size }); }
    }
    if (options.signal?.aborted) throw new Error('analysis-cancelled');
    if (isTextLike(file)) {
      if (size > maxTextBytes) result.textStatus = 'skipped-size-limit';
      else {
        result.text = new TextDecoder('utf-8', { fatal:false }).decode(bytes);
        result.textCharacters = result.text.length;
        result.textStatus = 'extracted';
        result.segments = [{ source:'Text', text:result.text }];
      }
    } else if (isOffice) {
      if (size > maxOfficeFileBytes) result.textStatus = 'office-skipped-size-limit';
      else {
        try {
          const parsed = await officeParser.parseOffice(bytes, file.name, options.officeLimits || {});
          result.text = parsed.text;
          result.textCharacters = parsed.text.length;
          result.segments = parsed.segments || [];
          result.textStatus = parsed.truncated ? 'extracted-office-truncated' : 'extracted-office';
          result.office = { format:parsed.format, entryCount:parsed.entryCount, parsedEntryCount:parsed.parsedEntryCount, totalUncompressedBytes:parsed.totalUncompressedBytes, truncated:parsed.truncated };
        } catch (error) {
          result.textStatus = 'office-parse-failed';
          result.parseError = error?.message || String(error);
        }
      }
    } else if (isPdf && pdfParser) {
      if (size > maxPdfFileBytes) result.textStatus = 'pdf-skipped-size-limit';
      else {
        try {
          const parsed = await pdfParser.parsePdf(bytes, options.pdfLimits || {});
          result.text = parsed.text;
          result.textCharacters = parsed.text.length;
          result.segments = parsed.segments || [];
          result.textStatus = parsed.text ? (parsed.truncated ? 'extracted-pdf-truncated' : 'extracted-pdf') : 'pdf-no-searchable-text';
          result.pdf = { streamsSeen:parsed.streamsSeen, streamsParsed:parsed.streamsParsed, expandedBytes:parsed.expandedBytes, cmapCount:parsed.cmapCount || 0, cmapEntries:parsed.cmapEntries || 0, warnings:parsed.warnings, truncated:parsed.truncated };
        } catch (error) {
          result.textStatus = 'pdf-parse-failed';
          result.parseError = error?.message || String(error);
        }
      }
    }
    if (options.signal?.aborted) throw new Error('analysis-cancelled');
    if (result.text && textIntelligence) result.insights = textIntelligence.analyze(result.text);
    return result;
  }

  async function analyzeFiles(files, options = {}) {
    const selected = Array.from(files || []);
    const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : 200;
    const maxTotalTextCharacters = Number.isFinite(options.maxTotalTextCharacters) ? options.maxTotalTextCharacters : 20_000_000;
    if (selected.length > maxFiles) throw new Error(`Select no more than ${maxFiles} files at once.`);
    const results = [];
    let totalTextCharacters = 0;
    const ocrEngine = options.ocrEngine || globalThis.InboxFoundry?.ocrEngine;
    let ocrSession = null;
    let currentOcrContext = null;
    try {
      for (const [fileIndex, file] of selected.entries()) {
        if (options.signal?.aborted) throw new Error('analysis-cancelled');
        const progressContext = { fileIndex:fileIndex + 1, fileCount:selected.length, fileName:String(file.name || 'unnamed-file') };
        const result = await analyzeFile(file, { ...options, onProgress:progress => options.onProgress?.({ ...progress, ...progressContext }) });
        const ocrCandidate = ocrEngine?.candidateType?.(file);
        if (ocrCandidate) result.ocrStatus = options.ocr ? 'pending' : 'not-requested';
        const shouldOcr = options.ocr && ocrCandidate && (ocrCandidate === 'image' || !result.text);
        if (options.ocr && ocrCandidate === 'pdf' && result.text) result.ocrStatus = 'not-needed-searchable-text';
        if (shouldOcr) {
          try {
            currentOcrContext = progressContext;
            ocrSession ||= await ocrEngine.createSession({
              ...(options.ocrOptions || {}), signal:options.signal,
              onProgress:progress => options.onProgress?.({ ...progress, ...currentOcrContext })
            });
            const recognized = await ocrSession.recognize(file);
            result.text = recognized.text;
            result.textCharacters = recognized.text.length;
            result.segments = recognized.segments || [];
            result.textStatus = recognized.text ? (recognized.truncated ? 'extracted-ocr-truncated' : 'extracted-ocr') : 'ocr-no-text';
            result.ocrStatus = recognized.text ? 'extracted' : 'no-text';
            const { text, segments, ...metadata } = recognized;
            result.ocr = metadata;
            const textIntelligence = options.textIntelligence || globalThis.InboxFoundry?.textIntelligence;
            result.insights = result.text && textIntelligence ? textIntelligence.analyze(result.text) : undefined;
          } catch (error) {
            if (error?.message === 'analysis-cancelled') throw error;
            result.ocrStatus = 'failed';
            result.ocrError = error?.message || String(error);
          }
        }
        if (result.text && totalTextCharacters + result.text.length > maxTotalTextCharacters) {
          result.text = '';
          result.textCharacters = 0;
          result.segments = [];
          result.textStatus = 'skipped-total-text-limit';
        } else totalTextCharacters += result.text.length;
        results.push(result);
      }
    } finally {
      await ocrSession?.terminate?.();
    }
    return results;
  }

  function duplicateGroups(results = []) {
    const groups = new Map();
    for (const item of results) {
      if (!item?.sha256) continue;
      if (!groups.has(item.sha256)) groups.set(item.sha256, []);
      groups.get(item.sha256).push({ name:item.name, sizeBytes:item.sizeBytes, sha256:item.sha256 });
    }
    return [...groups.entries()].filter(([, items]) => items.length > 1).map(([sha256, items], index) => ({ id:`content-duplicate-${index + 1}`, sha256, items }));
  }

  function search(results = [], query = '') {
    const term = String(query || '').trim().toLocaleLowerCase();
    if (!term) return [];
    const matches = [];
    for (const item of results) {
      if (!item?.text) continue;
      const sourceMatches = [];
      let count = 0;
      const snippets = [];
      const segments = item.segments?.length ? item.segments : [{ source:'Document', text:item.text }];
      for (const segment of segments) {
        const haystack = segment.text.toLocaleLowerCase();
        let index = haystack.indexOf(term);
        let sourceCount = 0;
        const sourceSnippets = [];
        while (index >= 0 && count < 1000) {
          count++; sourceCount++;
          const snippet = segment.text.slice(Math.max(0, index - 60), Math.min(segment.text.length, index + term.length + 100)).replace(/\s+/g, ' ').trim();
          if (snippets.length < 3) snippets.push(snippet);
          if (sourceSnippets.length < 3) sourceSnippets.push(snippet);
          index = haystack.indexOf(term, index + Math.max(1, term.length));
        }
        if (sourceCount) sourceMatches.push({ source:segment.source || 'Document', count:sourceCount, snippets:sourceSnippets });
        if (count >= 1000) break;
      }
      if (count) matches.push({ name:item.name, count, snippets, sources:sourceMatches });
    }
    return matches;
  }

  function report(results = [], query = '', options = {}) {
    return {
      format:'InboxFoundryLocalFileAnalysis',
      version:1,
      generatedAt:new Date().toISOString(),
      privacy:options.includeInsights ? 'Generated locally. Full extracted text and search snippets are excluded; user-approved structured suggestions and findings are included.' : 'Generated locally from files explicitly selected by the user. Extracted text, snippets, and structured content suggestions are not included.',
      approvedInsightsIncluded:!!options.includeInsights,
      files:results.map(({ text, segments, insights, ...item }) => options.includeInsights ? { ...item, insights } : item),
      exactContentDuplicateGroups:duplicateGroups(results),
      search:{ query:String(query || ''), matches:search(results, query).map(({ snippets, sources, ...match }) => ({ ...match, sources:(sources || []).map(({ snippets:sourceSnippets, ...source }) => source) })) }
    };
  }

  function safeOutputName(value) {
    return String(value || 'file').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/^\.+/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || 'file';
  }

  async function sha256Text(value, cryptoApi = globalThis.crypto) {
    const bytes = new TextEncoder().encode(String(value ?? ''));
    const digest = await cryptoApi.subtle.digest('SHA-256', bytes);
    return hex(digest);
  }

  async function buildRedactionEntries(results = [], types = [], options = {}) {
    const textIntelligence = options.textIntelligence || globalThis.InboxFoundry?.textIntelligence;
    const cryptoApi = options.cryptoApi || globalThis.crypto;
    if (!textIntelligence) throw new Error('Local text intelligence is unavailable.');
    if (!types.length) throw new Error('Select at least one pattern type to redact.');
    const entries = [];
    const files = [];
    for (const [index, item] of results.filter(value => value?.text).entries()) {
      const redacted = textIntelligence.redact(item.text, types);
      const name = `${String(index + 1).padStart(3, '0')}-${safeOutputName(item.name)}.redacted.txt`;
      entries.push({ name, data:redacted.text });
      files.push({ sourceName:item.name, sourceSha256:item.sha256 || null, redactedFile:name, redactedSha256:await sha256Text(redacted.text, cryptoApi), redactionCount:redacted.redactionCount, counts:redacted.counts });
    }
    if (!entries.length) throw new Error('No extracted text is available to redact.');
    const manifest = { format:'InboxFoundryRedactionManifest', version:1, generatedAt:new Date().toISOString(), selectedPatternTypes:[...types], warning:'Automated redaction is best effort. Review every copy before sharing.', files };
    entries.push({ name:'REDACTION-MANIFEST.json', data:JSON.stringify(manifest, null, 2) });
    entries.push({ name:'README.txt', data:'InboxFoundry redacted text copies\n\nAutomated detection is best effort and can miss sensitive material or produce false positives. Review every file before sharing. Original files were not changed. REDACTION-MANIFEST.json records original and redacted hashes plus redaction counts.\n' });
    const checksums = [];
    for (const entry of entries) checksums.push(`${await sha256Text(entry.data, cryptoApi)}  ${entry.name}`);
    entries.push({ name:'CHECKSUMS.sha256', data:`${checksums.join('\n')}\n` });
    return { entries, manifest };
  }

  return { TEXT_EXTENSIONS, extensionOf, isTextLike, analyzeFile, analyzeFiles, duplicateGroups, search, report, safeOutputName, buildRedactionEntries };
});
