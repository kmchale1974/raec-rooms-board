// scripts/fetch_email.js
// ESM module. Ensure your package.json includes: { "type": "module" }

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

  // 1) Prefer exact CivicPlus pattern
  let match = parts.find(p => CIVICPLUS_RE.test(filenameFromPart(p)));
  if (match) return match;

  // 2) Any filename ending in .csv
  match = parts.find(p => /\.csv$/i.test(filenameFromPart(p)));
  if (match) return match;

  // 3) CSV-ish content types
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

async function searchNewestCsvInMailbox(client, mailboxPath, days = 60, maxFetch = 200) {
  try {
    await client.mailboxOpen(mailboxPath);
    console.log(`Opened mailbox: ${mailboxPath}`);
  } catch (e) {
    console.warn(`Cannot open mailbox "${mailboxPath}": ${e?.message || e}`);
    return null;
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Broad, robust search: last N days, any message
  let uids = [];
  try {
    uids = await client.search({ since });
  } catch (e) {
    console.warn(`IMAP SEARCH failed in "${mailboxPath}": ${e?.message || e}`);
    return null;
  }

  if (!uids?.length) {
    console.log(`No messages found in ${mailboxPath} since ${since.toISOString()}`);
    return null;
  }

  // Consider only the most recent chunk (cap to maxFetch)
  const subset = uids.slice(-maxFetch);

  // Walk newest → oldest
  for (let i = subset.length - 1; i >= 0; i--) {
    const uid = subset[i];
    let msg;
    try {
      msg = await client.fetchOne(uid, { envelope: true, bodyStructure: true }, { uid: true });
    } catch (e) {
      console.warn(`fetchOne uid=${uid} failed: ${e?.message || e}`);
      continue;
    }

    const subj = msg?.envelope?.subject || '(no subject)';
    const when = msg?.envelope?.date ? new Date(msg.envelope.date) : null;
    const parts = flattenParts(msg?.bodyStructure);
    const csvPart = pickCsvPart(parts);

    // Log what we’re evaluating (helps debug)
    const fn = csvPart ? filenameFromPart(csvPart) : '';
    console.log(
      `Consider uid=${uid} | ${when?.toISOString() || 'no date'} | "${subj}" | ` +
      (csvPart ? `CSV: ${fn}` : 'no CSV')
    );

    if (csvPart?.part) {
      return {
        uid,
        partId: csvPart.part,
        subject: subj,
        date: when,
        filename: fn || '(no filename)',
      };
    }
  }

  return null;
}

async function main() {
  console.log(`Connecting to Gmail as ${IMAP_USER}…`);
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: 993,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false, // set to console for verbose logs
  });

  await client.connect();

  try {
    // 1) INBOX first
    let chosen = await searchNewestCsvInMailbox(client, 'INBOX');

    // 2) If not there, try All Mail (we’ll use the common Gmail name)
    if (!chosen) {
      chosen = await searchNewestCsvInMailbox(client, '[Gmail]/All Mail');
    }

    if (!chosen) {
      console.error(
        'No suitable "AC Daily Facility Global Schedule" CSV found (checked INBOX then [Gmail]/All Mail, last 60 days).'
      );
      process.exit(1);
    }

    console.log(
      `Chosen uid=${chosen.uid} | ${chosen.date || 'unknown date'} | ${chosen.subject}`
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
