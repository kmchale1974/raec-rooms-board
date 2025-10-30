#!/usr/bin/env node
/**
 * Robust IMAP CSV fetcher for RAEC Daily Facility Report
 * Env:
 *   IMAP_USER  - Gmail address
 *   IMAP_PASS  - Gmail App Password
 *   OUT_CSV    - output file path (default: data/inbox/latest.csv)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { once } from 'events';
import { pipeline } from 'stream';
import { promisify } from 'util';
import { ImapFlow } from 'imapflow';

const streamPipeline = promisify(pipeline);

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const IMAP_USER = process.env.IMAP_USER || process.env.GMAIL_USER || '';
const IMAP_PASS = process.env.IMAP_PASS || '';
const OUT_CSV   = process.env.OUT_CSV || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');

// ---- Guard env ----
if (!IMAP_USER) {
  console.error('Missing IMAP_USER env var (Gmail address).');
  process.exit(1);
}
if (!IMAP_PASS) {
  console.error('Missing IMAP_PASS env var (Gmail App Password).');
  process.exit(1);
}

// ---- Helpers ----
function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function looksLikeCsvPart(part) {
  // Gmail often reports CSV as text/plain with a filename ending .csv
  const type = (part.type || '').toLowerCase();
  const subtype = (part.subtype || '').toLowerCase();
  const params = part.params || {};
  const disp = part.disposition || {};
  const filename =
    (disp.params && (disp.params.filename || disp.params.name)) ||
    params.name ||
    '';

  const hasCsvName = /\.csv$/i.test(filename);
  const isCsvMime = (type === 'text' && subtype === 'csv') ||
                    (type === 'application' && (subtype === 'vnd.ms-excel' || subtype === 'octet-stream')) ||
                    (type === 'text' && subtype === 'plain'); // fallback

  // prefer real csv extension if available
  return hasCsvName || isCsvMime;
}

function walkBodystructure(bstruct) {
  // Flatten parts and annotate with path number like "1.2"
  const out = [];
  const walk = (node, prefix = '') => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, prefix ? `${prefix}.${i+1}` : `${i+1}`));
      return;
    }
    const partId = prefix || '1';
    out.push({ partId, ...node });
    if (node.childNodes && node.childNodes.length) {
      node.childNodes.forEach((child, i) => walk(child, `${partId}.${i+1}`));
    } else if (node.parts && node.parts.length) {
      node.parts.forEach((child, i) => walk(child, `${partId}.${i+1}`));
    }
  };
  walk(bstruct, '');
  return out;
}

// Download a part with timeout+retry
async function downloadPartWithRetry(client, uid, partId, destPath, { retries = 2, timeoutMs = 60000 } = {}) {
  let attempt = 0;
  let lastErr;

  ensureDirFor(destPath);

  while (attempt <= retries) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Download timeout')), timeoutMs);

      // imapflow returns { content: stream, meta: {...} }
      const { content } = await client.download(uid, partId, { signal: controller.signal });

      const tmpPath = destPath + '.part';
      const write = fs.createWriteStream(tmpPath);
      await streamPipeline(content, write);
      clearTimeout(timer);

      // atomically replace
      fs.renameSync(tmpPath, destPath);

      const size = fs.statSync(destPath).size;
      console.log(`Saved CSV -> ${destPath} (${size} bytes)`);
      return;
    } catch (err) {
      lastErr = err;
      attempt++;
      console.warn(`Download attempt ${attempt} failed: ${err && err.message ? err.message : err}`);
      if (attempt > retries) break;

      // short backoff
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }

  throw lastErr || new Error('Failed to download part');
}

(async function main() {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    // Be generous with timeouts; Gmail can be slow delivering attachment streams
    socketTimeout: 120000,     // 120s
    greetingTimeout: 20000,
    authTimeout: 30000,
    disableCompression: false, // you can set true if you suspect COMPRESS issues
    logger: false
  });

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');

    // Get UIDs of messages we care about (fetch last ~100 and filter by subject)
    // Faster approach: search by SUBJECT
    const uids = await client.search({
      header: ['subject', 'AC Daily Facility Report']
    });

    if (!uids || !uids.length) {
      console.log('No "AC Daily Facility Report" emails found.');
      process.exit(0);
    }

    // newest UID
    const uid = uids[uids.length - 1];

    // Fetch BODYSTRUCTURE to locate csv part
    const { bodyStructure, envelope, internalDate } = await client.fetchOne(uid, { uid: true, bodyStructure: true, envelope: true, internalDate: true });

    const when = internalDate ? new Date(internalDate).toISOString() : 'unknown';
    const subj = envelope && envelope.subject || '(no subject)';
    console.log(`Newest email → ${when} | ${subj} | uid ${uid}`);

    if (!bodyStructure) {
      throw new Error('No BODYSTRUCTURE on newest message.');
    }

    // Flatten and find CSV-looking parts
    const parts = walkBodystructure(bodyStructure);
    const csvPart = parts.find(looksLikeCsvPart);

    if (!csvPart) {
      throw new Error('Could not find a CSV attachment on the newest message.');
    }

    const partId = csvPart.partId || '2';
    const disp = csvPart.disposition || {};
    const params = csvPart.params || {};
    const filename =
      (disp.params && (disp.params.filename || disp.params.name)) ||
      params.name ||
      'daily.csv';

    const outPath = OUT_CSV || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
    console.log(`Downloading CSV part ${partId} (${filename})…`);

    await downloadPartWithRetry(client, uid, partId, outPath, { retries: 3, timeoutMs: 90000 });

    console.log('fetch_email complete.');
  } catch (err) {
    console.error('fetch_email failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  } finally {
    try { await client.logout(); } catch {}
  }
})();
