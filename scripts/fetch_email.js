// scripts/fetch_email.js
// ESM module. Ensure package.json includes: { "type": "module" }

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ImapFlow } from 'imapflow';

const {
  IMAP_HOST = 'imap.gmail.com',
  IMAP_USER,
  IMAP_PASS,
  OUT_CSV = 'data/inbox/latest.csv',
} = process.env;

if (!IMAP_USER) {
  console.error('Missing IMAP_USER env var (Gmail address).');
  process.exit(1);
}
if (!IMAP_PASS) {
  console.error('Missing IMAP_PASS env var (Gmail App Password).');
  process.exit(1);
}

// Matches the CivicPlus CSV name we usually get, but we’ll still accept any .csv
const CIVICPLUS_RE = /AC\s*-\s*Daily\s*Facility\s*Global\s*Schedule.*\.csv$/i;

async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function flattenParts(struct) {
  const out = [];
  (function walk(node) {
    if (!node) return;
    if (Array.isArray(node.childNodes) && node.childNodes.length) {
      node.childNodes.forEach(walk);
      return;
    }
    out.push({
      part: node.part,
      type: node.type,
      subtype: node.subtype,
      parameters: node.parameters || {},
      disposition: node.disposition || {},
    });
  })(struct);
  return out;
}

function filenameFromPart(p) {
  return (
    p?.disposition?.params?.filename ||
    p?.parameters?.name ||
    ''
  );
}

function pickCsvPart(parts) {
  if (!Array.isArray(parts)) return null;

  // 1) Prefer exact CivicPlus file naming
  let match = parts.find(p => CIVICPLUS_RE.test(filenameFromPart(p)));
  if (match) return match;

  // 2) Any filename ending in .csv
  match = parts.find(p => /\.csv$/i.test(filenameFromPart(p)));
  if (match) return match;

  // 3) CSV-like content types (fallback)
  match = parts.find(p => {
    const t = (p.type || '').toLowerCase();
    const s = (p.subtype || '').toLowerCase();
    return (t === 'text' && s === 'csv') || (t === 'application' && s === 'octet-stream');
  });

  return match || null;
}

async function downloadCsv(client, uid, partId, outFile) {
  const dl = await client.download(uid, partId, { uid: true });
  if (!dl?.content) throw new Error('download() returned no content stream');
  await ensureDir(outFile);
  await pipeline(dl.content, createWriteStream(outFile));
}

async function openMailbox(client, name) {
  await client.mailboxOpen(name);
  console.log(`Opened mailbox: ${name}`);
}

async function searchNewestCsvViaFetch(client, mailbox, days = 90, maxFetch = 300) {
  try {
    await openMailbox(client, mailbox);
  } catch (e) {
    console.warn(`Cannot open mailbox "${mailbox}": ${e?.message || e}`);
    return null;
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  let uids = [];
  try {
    // Broad search: everything since date (we’ll filter by attachment later)
    uids = await client.search({ since });
  } catch (e) {
    console.warn(`IMAP SEARCH failed in "${mailbox}": ${e?.message || e}`);
    return null;
  }

  if (!uids?.length) {
    console.log(`No messages found in ${mailbox} since ${since.toISOString()}`);
    return null;
  }

  // Limit how many we fetch for speed; newest first
  const subset = uids.slice(-maxFetch);

  // Pull envelope, bodyStructure, internalDate for the subset in bulk
  const candidates = [];
  try {
    for await (const msg of client.fetch(subset, {
      uid: true,
      envelope: true,
      bodyStructure: true,
      internalDate: true
    }, {uid: true})) {
      const uid = msg?.uid;
      const subject = msg?.envelope?.subject || '(no subject)';
      const whenMs = msg?.internalDate ? new Date(msg.internalDate).getTime() : 0;

      const parts = flattenParts(msg?.bodyStructure);
      const csvPart = pickCsvPart(parts);
      const fn = csvPart ? filenameFromPart(csvPart) : '';
      console.log(
        `Consider uid=${uid} | ${msg?.internalDate || 'no date'} | "${subject}" | ` +
        (csvPart ? `CSV: ${fn}` : 'no CSV')
      );

      if (csvPart?.part) {
        candidates.push({
          uid,
          partId: csvPart.part,
          subject,
          whenMs,
          filename: fn || '(no filename)'
        });
      }
    }
  } catch (e) {
    console.warn(`fetch() failed in "${mailbox}": ${e?.message || e}`);
  }

  if (!candidates.length) return null;

  // Newest by internal date
  candidates.sort((a, b) => b.whenMs - a.whenMs);
  return candidates[0];
}

async function main() {
  console.log(`Connecting to Gmail as ${IMAP_USER}…`);
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: 993,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false
  });

  await client.connect();

  try {
    // Try INBOX first
    let chosen = await searchNewestCsvViaFetch(client, 'INBOX', 90, 400);

    // Then the canonical Gmail All Mail
    if (!chosen) {
      chosen = await searchNewestCsvViaFetch(client, '[Gmail]/All Mail', 180, 600);
    }

    if (!chosen) {
      console.error(
        'No suitable "AC Daily Facility Global Schedule" CSV found (checked INBOX then [Gmail]/All Mail).'
      );
      process.exit(1);
    }

    console.log(
      `Chosen uid=${chosen.uid} | ${new Date(chosen.whenMs).toISOString()} | ${chosen.subject}`
    );
    console.log(`Attachment: ${chosen.filename} (part ${chosen.partId})`);

    await downloadCsv(client, chosen.uid, chosen.partId, OUT_CSV);
    console.log(`Saved CSV to ${OUT_CSV}`);
  } catch (err) {
    console.error('fetch_email failed:', err?.message || err);
    process.exit(1);
  } finally {
    try { await client.logout(); } catch {}
  }
}

main();
