// scripts/fetch_email.js
// ESM version: username baked-in; only IMAP_PASS is required as a secret.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---- Config (baked username) ----
const host   = process.env.IMAP_HOST   || 'imap.gmail.com';
const user   = process.env.IMAP_USER   || 'raecroominfo.board@gmail.com'; // baked-in default
const pass   = process.env.IMAP_PASS;                                     // <-- set as GitHub Secret
const folder = process.env.IMAP_FOLDER || 'INBOX';
const outCsv = process.env.OUT_CSV     || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');

if (!pass) {
  console.error('Missing IMAP_PASS (Gmail App Password). Set it as a GitHub Actions secret.');
  process.exit(1);
}

// Ensure output dir exists
fs.mkdirSync(path.dirname(outCsv), { recursive: true });

const client = new ImapFlow({
  host,
  port: 993,
  secure: true,
  logger: false, // set to console for verbose logs
  auth: { user, pass }
});

try {
  console.log(`Connecting to ${host} as ${user}…`);
  await client.connect();

  console.log(`Opening mailbox: ${folder}`);
  const lock = await client.getMailboxLock(folder);
  try {
    const status = client.mailbox; // current mailbox status
    if (!status || typeof status.exists !== 'number' || status.exists === 0) {
      console.log('Mailbox is empty. Nothing to fetch.');
      process.exit(0);
    }

    // Find the newest message (max UID) quickly
    // We'll attempt newest first, and parse for a CSV attachment.
    // If none found, we’ll walk backward up to a few messages.
    const newestUid = status.uidNext - 1;
    const TRY_BACK = 8; // how many messages backwards to try
    let foundCsv = null;

    for (let uid = newestUid; uid > 0 && uid >= newestUid - TRY_BACK; uid--) {
      // Download the full raw message
      try {
        const dl = await client.download(uid, '', { uid: true });
        const chunks = [];
        for await (const chunk of dl.content) chunks.push(chunk);
        const raw = Buffer.concat(chunks);

        const parsed = await simpleParser(raw);
        const attachments = parsed.attachments || [];

        // Prefer first .csv attachment
        const csvAtt = attachments.find(a =>
          (a.filename || '').toLowerCase().endsWith('.csv') ||
          (a.contentType || '').toLowerCase().includes('/csv')
        );

        if (csvAtt) {
          foundCsv = {
            filename: csvAtt.filename || 'attachment.csv',
            content: csvAtt.content
          };
          console.log(`Found CSV on UID ${uid}: ${foundCsv.filename}`);
          break;
        }
      } catch (err) {
        // Non-fatal: just try the next older message
        console.warn(`UID ${uid}: failed to parse or download (${err?.message || err})`);
      }
    }

    if (!foundCsv) {
      console.log('No .csv attachment found in the last few messages.');
      process.exit(0);
    }

    fs.writeFileSync(outCsv, foundCsv.content);
    console.log(`Saved CSV to ${outCsv} ( ${foundCsv.filename} )`);
  } finally {
    lock.release();
  }

  await client.logout();
} catch (err) {
  console.error('IMAP error:', err?.message || err);
  process.exit(1);
}
