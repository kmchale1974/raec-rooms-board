import fs from 'fs';
import path from 'path';
import { ImapFlow } from 'imapflow';

const host = process.env.IMAP_HOST || 'imap.gmail.com';
const user = process.env.IMAP_USER;   // raecroominfo.board@gmail.com
const pass = process.env.IMAP_PASS;   // App password (16 chars)
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

// Find newest message
let newest;
for await (const msg of client.fetch({ all: true }, { bodyStructure: true, uid: true, internalDate: true })) {
  if (!newest || msg.internalDate > newest.internalDate) newest = msg;
}
if (!newest) { console.log('No emails found.'); process.exit(0); }

// Find a CSV attachment
function walk(node, pathArr = [], out = []) {
  if (!node) return out;
  if (node.disposition?.type?.toLowerCase() === 'attachment') {
    const filename = node.disposition?.params?.filename || node.parameters?.name || 'file';
    out.push({ path: pathArr.join('.'), filename });
  }
  (node.childNodes || []).forEach((c, i) => walk(c, pathArr.concat(i + 1), out));
  return out;
}
const parts = walk(newest.bodyStructure).filter(p => p.filename.toLowerCase().endsWith('.csv'));
if (!parts.length) { console.log('Newest email has no CSV.'); process.exit(0); }

// Download the first CSV attachment
const part = parts[0];
const dl = await client.download(newest.uid, part.path);
const chunks = [];
for await (const ch of dl.content) chunks.push(ch);
await client.logout();

fs.writeFileSync(outCsv, Buffer.concat(chunks));
console.log('Saved CSV to', outCsv);
