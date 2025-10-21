// scripts/fetch_email.js
// Robust Gmail CSV fetcher: looks back through recent messages,
// downloads raw MIME, parses attachments with mailparser.

import fs from 'fs';
import path from 'path';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

// ---- Config via env ----
const IMAP_HOST = process.env.IMAP_HOST || 'imap.gmail.com';
const IMAP_USER = process.env.IMAP_USER || 'raecroominfo.board@gmail.com'; // baked-in per your setup
const IMAP_PASS = process.env.IMAP_PASS; // REQUIRED (Gmail App Password)
const IMAP_FOLDER = process.env.IMAP_FOLDER || 'INBOX';
const OUT_CSV = process.env.OUT_CSV || 'data/inbox/latest.csv';

// How many recent emails to scan if the newest doesn't have a CSV:
const LOOKBACK = Number(process.env.LOOKBACK || 10);

if (!IMAP_PASS) {
  console.error('Missing IMAP_PASS env var (Gmail App Password).');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });

// Utility: download a full message (raw RFC822) by UID
async function downloadRaw(client, uid) {
  const dl = await client.download(uid, '', { uid: true }); // '' => entire message
  const chunks = [];
  for await (const ch of dl.content) chunks.push(ch);
  return Buffer.concat(chunks);
}

async function tryParseForCsv(rawBuf) {
  const parsed = await simpleParser(rawBuf);
  const atts = parsed.attachments || [];

  if (atts.length) {
    console.log('Attachments:', atts.map(a => `${a.filename || '(no name)'} [${a.contentType}]`).join(' | '));
  }

  // Accept .csv (case-insensitive)
  let csv = atts.find(a => (a.filename || '').toLowerCase().endsWith('.csv'));
  // Fallback: some senders set contentType text/csv but odd filename
  if (!csv) csv = atts.find(a => (a.contentType || '').toLowerCase() === 'text/csv');

  if (!csv) return null;

  return {
    filename: csv.filename || 'attachment.csv',
    content: csv.content, // Buffer
  };
}

async function main() {
  const client = new ImapFlow({
    host: IMAP_HOST,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
  });

  try {
    await client.connect();
    await client.mailboxOpen(IMAP_FOLDER);

    // Fetch last N UIDs, newest last, so we can iterate from newest → older
    const uids = [];
    for await (const msg of client.fetch({ seen: false, all: true }, { uid: true, internalDate: true })) {
      uids.push({ uid: msg.uid, date: msg.internalDate });
    }

    if (uids.length === 0) {
      console.log('No emails found.');
      return;
    }

    // Sort newest → oldest by internalDate
    uids.sort((a, b) => b.date - a.date);

    const sample = uids.slice(0, LOOKBACK);
    console.log(`Scanning ${sample.length} most recent message(s) for a CSV…`);

    let saved = false;

    for (const { uid, date } of sample) {
      try {
        // Download raw, parse attachments. This sidesteps BODYSTRUCTURE issues entirely.
        const raw = await downloadRaw(client, uid);
        const hit = await tryParseForCsv(raw);

        if (hit) {
          fs.writeFileSync(OUT_CSV, hit.content);
          console.log(`Saved CSV to ${OUT_CSV} (${hit.filename}) from UID ${uid} @ ${date.toISOString()}`);
          saved = true;
          break;
        } else {
          console.log(`UID ${uid}: no CSV attachment found, checking older message…`);
        }
      } catch (e) {
        console.log(`UID ${uid}: failed to parse (${e.message}), checking older message…`);
      }
    }

    if (!saved) {
      console.log('No CSV found in the recent messages scanned.');
    }
  } catch (err) {
    console.error('fetch_email failed:', err.message || err);
    process.exit(1);
  } finally {
    try { await client.logout(); } catch {}
  }
}

main();
