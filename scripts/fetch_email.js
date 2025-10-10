import fs from 'fs';
import path from 'path';
import { ImapFlow } from 'imapflow';

const host   = process.env.IMAP_HOST || 'imap.gmail.com';
const user   = process.env.IMAP_USER;   // raecroominfo.board@gmail.com
const pass   = process.env.IMAP_PASS;   // 16-char app password
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

// Get newest message
let newest;
for await (const msg of client.fetch({ all: true }, { bodyStructure: true, uid: true, internalDate: true })) {
  if (!newest || msg.internalDate > newest.internalDate) newest = msg;
}
if (!newest) {
  console.log('No emails found.');
  process.exit(0);
}

// Walk BODYSTRUCTURE collecting any part that looks like an attachment with a filename
function walk(node, out = [], idxPrefix = '') {
  if (!node) return out;
  const partId = node.part || idxPrefix || '';
  const filename = node.disposition?.params?.filename || node.parameters?.name || '';
  const ct = (node.type && node.subtype) ? `${node.type}/${node.subtype}` : '';
  if (filename) out.push({ partId, filename, ct, node });

  if (Array.isArray(node.childNodes)) {
    node.childNodes.forEach((child, i) => {
      const nextPrefix = idxPrefix ? `${idxPrefix}.${i + 1}` : String(i + 1);
      walk(child, out, nextPrefix);
    });
  }
  return out;
}

const attachments = walk(newest.bodyStructure);
if (!attachments.length) {
  console.log('No attachments found in newest email.');
  await client.logout();
  process.exit(0);
}
console.log('Attachments seen:', attachments.map(a => `${a.filename} [${a.ct}] (part=${a.partId||'?'})`).join(' | '));

// Pick first CSV-looking attachment
const csvAtt = attachments.find(a => a.filename.toLowerCase().endsWith('.csv'));
if (!csvAtt) {
  console.log('Newest email has attachments but no .csv file. Available:', attachments.map(a => a.filename).join(', '));
  await client.logout();
  process.exit(0);
}

// Build candidate part IDs to try.
// Prefer the reported node.part; also try simple numeric parts (2,3,4) and any
// dotted part ids we saw while walking.
const candidateParts = Array.from(new Set([
  csvAtt.partId,
  '2', '3', '4',
  ...attachments.map(a => a.partId).filter(Boolean)
])).filter(Boolean);

let saved = false;
for (const part of candidateParts) {
  try {
    const dl = await client.download(newest.uid, part);
    if (!dl || !dl.content) {
      console.log(`Part ${part}: no content, trying next…`);
      continue;
    }
    const chunks = [];
    for await (const ch of dl.content) chunks.push(ch);
    fs.writeFileSync(outCsv, Buffer.concat(chunks));
    console.log(`Saved CSV (${csvAtt.filename}) from part ${part} to ${outCsv}`);
    saved = true;
    break;
  } catch (e) {
    console.log(`Part ${part}: download failed (${e.message}), trying next…`);
  }
}

await client.logout();

if (!saved) {
  console.log('Failed to download CSV after trying candidates:', candidateParts.join(', '));
  process.exit(0);
}
