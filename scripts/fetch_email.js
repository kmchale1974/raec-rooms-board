// ESM (Node 18+). Finds the newest email in the IMAP folder,
// scans its MIME structure for a CSV attachment, and downloads it.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ImapFlow } from 'imapflow';

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

const client = new ImapFlow({
  host,
  secure: true,
  auth: { user, pass }
});

function filenameOf(part = {}) {
  // Try headers first, then params
  const disp = part.dispositionParameters || {};
  const typep = part.parameters || {};
  return disp.filename || typep.name || '';
}

try {
  await client.connect();
  await client.mailboxOpen(folder);

  // 1) Find newest message UID by INTERNALDATE
  let newest = null;
  for await (const msg of client.fetch({ all: true }, { uid: true, internalDate: true })) {
    if (!newest || msg.internalDate > newest.internalDate) newest = msg;
  }
  if (!newest) {
    console.log('No emails found.');
    process.exit(0);
  }

  // 2) Fetch BODYSTRUCTURE to locate CSV attachment part
  const fetchRes = await client.fetchOne(newest.uid, { bodyStructure: true }, { uid: true });
  const bs = fetchRes?.bodyStructure;
  if (!bs) {
    console.log('No BODYSTRUCTURE available.');
    process.exit(0);
  }

  // walk the structure to find first CSV attachment
  const stack = [bs];
  let csvPart = null;
  while (stack.length && !csvPart) {
    const node = stack.pop();

    if (Array.isArray(node.childNodes)) {
      for (const child of node.childNodes) stack.push(child);
    }

    const type = (node.type || '').toLowerCase();        // e.g. "text"
    const subType = (node.subtype || '').toLowerCase();  // e.g. "csv", "plain"
    const disp = (node.disposition || '').toLowerCase(); // "attachment" or "inline"
    const name = filenameOf(node).toLowerCase();

    const isCsvByMime = (type === 'text' && subType === 'csv') ||
                        (type === 'application' && subType === 'vnd.ms-excel'); // some systems use this
    const isCsvByName = name.endsWith('.csv');

    if ((disp === 'attachment' || name) && (isCsvByMime || isCsvByName)) {
      csvPart = node;
      break;
    }
  }

  if (!csvPart) {
    console.log('No CSV attachment found in newest email.');
    process.exit(0);
  }

  const partId = csvPart.part;
  const filename = filenameOf(csvPart) || 'attachment.csv';
  console.log(`Downloading CSV part ${partId} (${filename})…`);

  // 3) Download that specific MIME part
  const { content } = await client.download(newest.uid, partId, { uid: true });
  const chunks = [];
  for await (const chunk of content) chunks.push(chunk);
  const buf = Buffer.concat(chunks);

  fs.writeFileSync(outCsv, buf);
  console.log('Saved CSV to', outCsv, '(', filename, ')');
} finally {
  try { await client.logout(); } catch {}
}
