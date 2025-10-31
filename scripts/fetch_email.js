// scripts/fetch_email.js
// ESM module (package.json should include: "type": "module")

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ImapFlow } from 'imapflow';

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

const CSV_NAME_RE = /AC\s*-\s*Daily\s*Facility\s*Global\s*Schedule.*\.csv$/i;

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

  // 1) exact CivicPlus name pattern
  const byPattern = parts.find(p => {
    const name =
      p?.disposition?.params?.filename ||
      p?.parameters?.name ||
      '';
    return CSV_NAME_RE.test(name);
  });
  if (byPattern) return byPattern;

  // 2) any *.csv attachment
  const byExt = parts.find(p => {
    const name =
      p?.disposition?.params?.filename ||
      p?.parameters?.name ||
      '';
    return /\.csv$/i.test(name);
  });
  if (byExt) return byExt;

  // 3) weak type guesser fallback
  const byType = parts.find(
    p =>
      (p.type?.toLowerCase?.() === 'text' && p.subtype?.toLowerCase?.() === 'csv') ||
      (p.type?.toLowerCase?.() === 'application' && p.subtype?.toLowerCase?.() === 'octet-stream')
  );
  return byType || null;
}

async function tryMailbox(client, mailboxName, sinceDate) {
  try {
    await client.mailboxOpen(mailboxName);
  } catch (e) {
    console.warn(`Cannot open mailbox "${mailboxName}": ${e?.message || e}`);
    return null;
  }

  // Prefer exact subject
  let uids = [];
  try {
    uids = await client.search({
      since: sinceDate,
      header: ['subject', 'AC Daily Facility Report'],
    });
  } catch (e) {
    console.warn(`Subject search failed in "${mailboxName}": ${e?.message || e}`);
  }

  // If that failed, scan recent since-date messages
  if (!Array.isArray(uids) || uids.length === 0) {
    try {
      const bySince = await client.search({ since: sinceDate });
      if (Array.isArray(bySince) && bySince.length) {
        uids = bySince.slice(-100); // last ~100 to be safe
      }
    } catch (e) {
      console.warn(`SINCE search failed in "${mailboxName}": ${e?.message || e}`);
      uids = [];
    }
  }

  // Newest → oldest: pick first message with a CSV that matches
  for (let i = uids.length - 1; i >= 0; i--) {
    const uid = uids[i];
    let msg;
    try {
      msg = await client.fetchOne(uid, { envelope: true, bodyStructure: true }, { uid: true });
    } catch (e) {
      console.warn(`fetchOne uid=${uid} failed in "${mailboxName}": ${e?.message || e}`);
      continue;
    }
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

function isAllMailBox(meta) {
  // Prefer specialUse tag
  if (meta?.specialUse && String(meta.specialUse).toLowerCase().includes('\\all')) return true;
  // Name heuristics (covers localized variants sometimes labeled in English)
  const name = (meta?.name || '').toLowerCase();
  return /all.?mail/.test(name) || name === '[gmail]/all mail';
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
    // Discover All Mail dynamically
    const boxes = [];
    for await (const box of client.list()) {
      boxes.push(box);
    }
    const allMailCandidates = boxes.filter(isAllMailBox).map(b => b.name);

    // Build mailbox try order
    const mailboxOrder = ['INBOX', ...allMailCandidates];
    // Ensure uniqueness
    const seen = new Set();
    const MAILBOXES = mailboxOrder.filter(n => {
      const key = n.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    let found = null;
    let foundMailbox = null;

    for (const mb of MAILBOXES) {
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
  } catch (err) {
    console.error('fetch_email failed:', err?.message || err);
    process.exit(1);
  } finally {
    try { await client.logout(); } catch {}
  }
}

main();
