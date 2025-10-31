// scripts/fetch_email.js
// ESM module (package.json must include: "type": "module")

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { pipeline } from 'node:stream/promises';

const {
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

// CivicPlus CSV filenames look like:
// "AC - Daily Facility Global Schedule_ 8-00-31 AM_15812-990.csv"
const CSV_NAME_RE = /AC\s*-\s*Daily\s*Facility\s*Global\s*Schedule.*\.csv$/i;

const MAILBOX_CANDIDATES = ['INBOX', '[Gmail]/All Mail', 'All Mail'];

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

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
      part: node.part, // e.g. "2"
      type: node.type,
      subtype: node.subtype,
      parameters: node.parameters || {},
      disposition: node.disposition || {},
      id: node.id,
    });
  })(struct);
  return out;
}

function pickCsvPart(parts) {
  if (!Array.isArray(parts) || !parts.length) return null;

  // 1) Prefer an attachment whose filename matches our CivicPlus pattern
  const byPattern = parts.find(p => {
    const name =
      p?.disposition?.params?.filename ||
      p?.parameters?.name ||
      '';
    return CSV_NAME_RE.test(name);
  });
  if (byPattern) return byPattern;

  // 2) Otherwise any *.csv filename
  const byExt = parts.find(p => {
    const name =
      p?.disposition?.params?.filename ||
      p?.parameters?.name ||
      '';
    return /\.csv$/i.test(name);
  });
  if (byExt) return byExt;

  // 3) As a last resort, some systems send text/csv without filename; try type guess
  const byType = parts.find(
    p =>
      (p.type?.toLowerCase?.() === 'text' && p.subtype?.toLowerCase?.() === 'csv') ||
      (p.type?.toLowerCase?.() === 'application' && p.subtype?.toLowerCase?.() === 'octet-stream')
  );
  return byType || null;
}

async function tryMailbox(client, mbox, sinceDate) {
  await client.mailboxOpen(mbox);

  // First try subject search
  let uids = [];
  try {
    uids = await client.search({
      since: sinceDate, // MUST be a Date object; not a string
      header: ['subject', 'AC Daily Facility Report'],
    });
  } catch (e) {
    console.warn(`Subject search failed in "${mbox}": ${e?.message || e}`);
  }

  // If we didn’t get anything by subject, broaden:
  if (!Array.isArray(uids) || uids.length === 0) {
    try {
      // Grab recent UIDs since date
      const bySince = await client.search({ since: sinceDate });
      if (Array.isArray(bySince) && bySince.length) {
        // Limit to last ~75 to keep it efficient
        uids = bySince.slice(-75);
      }
    } catch (e) {
      console.warn(`SINCE search failed in "${mbox}": ${e?.message || e}`);
      uids = [];
    }
  }

  // Walk newest → oldest and pick the first with a matching CSV attachment
  for (let i = uids.length - 1; i >= 0; i--) {
    const uid = uids[i];
    const msg = await client.fetchOne(uid, { envelope: true, bodyStructure: true }, { uid: true });
    const env = msg?.envelope;
    const bs = msg?.bodyStructure;
    if (!bs) continue;

    const parts = flattenParts(bs);
    const csvPart = pickCsvPart(parts);
    if (csvPart?.part) {
      const subj = env?.subject || '(no subject)';
      const when = env?.date ? new Date(env.date) : null;
      const name =
        csvPart.disposition?.params?.filename ||
        csvPart.parameters?.name ||
        '(no filename)';
      return { uid, subject: subj, date: when, csvPartName: name, partId: csvPart.part };
    }
  }

  return null;
}

async function downloadCsv(client, mailbox, uid, partId, outFile) {
  await client.mailboxOpen(mailbox);
  const dl = await client.download(uid, partId, { uid: true });
  if (!dl?.content) throw new Error('download() returned no content stream');
  await ensureDir(outFile);
  await pipeline(dl.content, createWriteStream(outFile));
}

async function main() {
  const since = daysAgo(7);
  console.log(`Connecting to Gmail as ${IMAP_USER}…`);

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
  });

  await client.connect();

  try {
    // Try each mailbox in order
    let found = null;
    let foundMailbox = null;

    for (const mb of MAILBOX_CANDIDATES) {
      console.log(`Searching "${mb}" since ${since.toString()} for CSV…`);
      const hit = await tryMailbox(client, mb, since);
      if (hit) {
        found = hit;
        foundMailbox = mb;
        break;
      }
    }

    if (!found) {
      console.error('No suitable "AC Daily Facility Report" CSV found in any mailbox.');
      process.exit(1);
    }

    console.log(
      `Chosen: mailbox="${foundMailbox}" uid=${found.uid} | ${found.date || 'unknown date'} | ${found.subject}`
    );
    console.log(`Attachment: ${found.csvPartName} (part ${found.partId})`);

    await downloadCsv(client, foundMailbox, found.uid, found.partId, OUT_CSV);
    console.log(`Saved CSV to ${OUT_CSV}`);
  } finally {
    try { await client.logout(); } catch {}
  }
}

main().catch(err => {
  console.error('fetch_email failed:', err?.message || err);
  process.exit(1);
});
