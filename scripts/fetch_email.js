// scripts/fetch_email.js
// ESM-friendly (package.json has "type":"module")

import fs from 'fs';
import path from 'path';
import { ImapFlow } from 'imapflow';

// ---- Config (username baked in; password via env secret) ----
const host   = process.env.IMAP_HOST   || 'imap.gmail.com';
const user   = process.env.IMAP_USER   || 'raecroominfo.board@gmail.com'; // baked-in username
const pass   = process.env.IMAP_PASS;  // <-- set this as a GitHub Actions secret
const folder = process.env.IMAP_FOLDER || 'INBOX';
const outCsv = process.env.OUT_CSV     || 'data/inbox/latest.csv';

// Basic guardrails
if (!pass) {
  console.error('Missing IMAP_PASS env var (Gmail App Password).');
  process.exit(1);
}

// Ensure output dir
fs.mkdirSync(path.dirname(outCsv), { recursive: true });

// Helper: walk Gmail BODYSTRUCTURE to find CSV parts
function* walkParts(node, prefix = '') {
  // Gmail returns either single part or an array for multipart
  if (!node) return;

  if (Array.isArray(node)) {
    // node is a multipart with child parts
    for (let i = 0; i < node.length; i++) {
      const child = node[i];
      const partNum = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      yield* walkParts(child, partNum);
    }
    return;
  }

  // Single part
  const partNum = prefix || '1';
  yield { partNum, part: node };

  // If this part has child parts, recurse
  if (Array.isArray(node.childNodes)) {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      const childNum = `${partNum}.${i + 1}`;
      yield* walkParts(child, childNum);
    }
  }
}

// Pick first part that looks like a CSV attachment
function findCsvPart(bodyStructure) {
  for (const { partNum, part } of walkParts(bodyStructure)) {
    // imapflow exposes fields like: type/subtype, disposition params, etc.
    const disp = (part.disposition || '').toLowerCase();
    const name =
      (part.dispositionParameters && (part.dispositionParameters.filename || part.dispositionParameters.name)) ||
      (part.parameters && part.parameters.name) ||
      '';
    const filename = String(name || '').trim();
    const subtype = (part.subtype || '').toLowerCase();
    const type = (part.type || '').toLowerCase();

    const looksLikeCsvName = filename.toLowerCase().endsWith('.csv');
    const looksLikeCsvMime =
      (type === 'text' && subtype === 'csv') ||
      (type === 'application' && subtype === 'vnd.ms-excel'); // sometimes exported this way

    const isAttachment = disp === 'attachment' || filename;

    if (isAttachment && (looksLikeCsvName || looksLikeCsvMime)) {
      return { partNum, filename: filename || 'attachment.csv' };
    }
  }
  return null;
}

const client = new ImapFlow({
  host,
  secure: true,
  auth: { user, pass },
  logger: false, // set to console for verbose logs
});

try {
  await client.connect();
  await client.mailboxOpen(folder);

  // Find newest message (by INTERNALDATE)
  let newest = null;
  for await (const msg of client.fetch({ all: true }, { uid: true, internalDate: true })) {
    if (!newest || msg.internalDate > newest.internalDate) newest = msg;
  }

  if (!newest) {
    console.log('No emails found in folder:', folder);
    process.exit(0);
  }

  // Fetch BODYSTRUCTURE for the newest UID
  const fetchRes = await client.fetch(newest.uid, { bodyStructure: true, uid: true }, { uid: true });
  let bodyStructure = null;
  for await (const item of fetchRes) {
    bodyStructure = item.bodyStructure;
  }
  if (!bodyStructure) {
    console.log('Newest email has no BODYSTRUCTURE; cannot locate attachments.');
    process.exit(0);
  }

  const csvInfo = findCsvPart(bodyStructure);
  if (!csvInfo) {
    console.log('Newest email has no .csv attachment.');
    process.exit(0);
  }

  console.log(`Downloading CSV part ${csvInfo.partNum} (${csvInfo.filename})…`);

  // Download that part’s content
  const dl = await client.download(newest.uid, csvInfo.partNum, { uid: true });
  const chunks = [];
  for await (const chunk of dl.content) chunks.push(chunk);
  const buf = Buffer.concat(chunks);

  fs.writeFileSync(outCsv, buf);
  console.log('Saved CSV to', outCsv, `(${csvInfo.filename})`);
} catch (err) {
  console.error('fetch_email failed:', err?.message || err);
  process.exit(1);
} finally {
  try { await client.logout(); } catch {}
}
