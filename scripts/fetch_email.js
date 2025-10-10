import fs from 'fs';
import path from 'path';
import { ImapFlow } from 'imapflow';

const host   = process.env.IMAP_HOST || 'imap.gmail.com';
const user   = process.env.IMAP_USER;
const pass   = process.env.IMAP_PASS;
const folder = process.env.IMAP_FOLDER || 'INBOX';
const outCsv = process.env.OUT_CSV || 'data/inbox/latest.csv';

if (!user || !pass) {
  console.error('Missing IMAP_USER or IMAP_PASS env vars.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(outCsv), { recursive: true });

const client = new ImapFlow({ host, secure: true, auth: { user, pass } });
await client.connect();
await client.mailboxOpen(folder);

// Pick the newest message by INTERNALDATE
let newest;
for await (const msg of client.fetch({ all: true }, { bodyStructure: true, uid: true, internalDate: true })) {
  if (!newest || msg.internalDate > newest.internalDate) newest = msg;
}
if (!newest) {
  console.log('No emails found.');
  process.exit(0);
}

// Walk BODYSTRUCTURE and collect all parts with a filename, regardless of disposition
function walk(node, prefix = '') {
  const found = [];
  if (!node) return found;

  // imapflow exposes: node.disposition?.type, node.disposition?.params, node.parameters?.name, node.part
  const dispType = node.disposition?.type || '';
  const dispName = node.disposition?.params?.filename || node.parameters?.name || '';
  const filename = dispName || '';

  // Prefer imapflow's node.part (like "2" or "2.1"); fallback to building from prefix
  const partId = node.part || (prefix || '').replace(/^\./, '');

  if (filename) {
    found.push({
      part: partId,
      filename,
      ct: (node.type && node.subtype) ? `${node.type}/${node.subtype}` : 'unknown/unknown',
      disp: dispType
    });
  }

  if (Array.isArray(node.childNodes)) {
    node.childNodes.forEach((child, idx) => {
      const childPrefix = prefix ? `${prefix}.${idx + 1}` : String(idx + 1);
      found.push(...walk(child, childPrefix));
    });
  }
  return found;
}

const attachments = walk(newest.bodyStructure);

// Log what we found for transparency
if (!attachments.length) {
  console.log('No attachments found in newest email.');
  await client.logout();
  process.exit(0);
}
console.log('Attachments seen:', attachments.map(a => `${a.filename} [${a.ct}]`).join(' | '));

// Find a CSV by filename (case-insensitive)
const csvPart = attachments.find(a => a.filename.toLowerCase().endsWith('.csv'));

if (!csvPart) {
  console.log('Newest email has attachments but no .csv file. Available:', attachments.map(a => a.filename).join(', '));
  await client.logout();
  process.exit(0);
}

// Download the CSV
const dl = await client.download(newest.uid, csvPart.part);
const chunks = [];
for await (const ch of dl.content) chunks.push(ch);
await client.logout();

fs.writeFileSync(outCsv, Buffer.concat(chunks));
console.log('Saved CSV to', outCsv);
