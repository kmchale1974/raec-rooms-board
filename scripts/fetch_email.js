// ESM version (node >=18), Option A: username inline in workflow, password from secret
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const host   = process.env.IMAP_HOST || 'imap.gmail.com';
const user   = process.env.IMAP_USER;   // set inline in workflow
const pass   = process.env.IMAP_PASS;   // from secret GMAILIMAP
const folder = process.env.IMAP_FOLDER || 'INBOX';
const outCsv = process.env.OUT_CSV || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');

if (!user || !pass) {
  console.error('Missing IMAP_USER or IMAP_PASS env vars.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(outCsv), { recursive: true });

const client = new ImapFlow({ host, secure: true, auth: { user, pass } });

try {
  await client.connect();
  await client.mailboxOpen(folder);

  // Find newest message by INTERNALDATE
  let newest;
  for await (const msg of client.fetch({ all: true }, { uid: true, internalDate: true })) {
    if (!newest || msg.internalDate > newest.internalDate) newest = msg;
  }
  if (!newest) {
    console.log('No emails found.');
    process.exit(0);
  }

  // Download full raw message (RFC822)
  let raw;
  try {
    const full = await client.download(newest.uid, '', { uid: true });
    const chunks = [];
    for await (const ch of full.content) chunks.push(ch);
    raw = Buffer.concat(chunks);
  } catch (e) {
    console.error('Failed to download full message:', e.message);
    process.exit(0);
  }

  // Parse MIME, extract first .csv attachment
  const parsed = await simpleParser(raw);
  const atts = parsed.attachments || [];
  if (!atts.length) {
    console.log('Full message parsed, but no attachments found.');
    process.exit(0);
  }
  console.log('Attachments seen:', atts.map(a => `${a.filename || '(no name)'} [${a.contentType}]`).join(' | '));

  const csv = atts.find(a => (a.filename || '').toLowerCase().endsWith('.csv'));
  if (!csv) {
    console.log('No .csv attachment found in newest email.');
    process.exit(0);
  }

  fs.writeFileSync(outCsv, csv.content);
  console.log('Saved CSV to', outCsv, '(', csv.filename, ')');
} finally {
  try { await client.logout(); } catch {}
}
