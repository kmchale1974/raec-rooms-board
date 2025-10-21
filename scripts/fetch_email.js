// scripts/fetch_email.js
// Robust CSV fetcher for Gmail via IMAP (no mailparser). Finds the real CSV part dynamically.

import fs from 'fs';
import path from 'path';
import { ImapFlow } from 'imapflow';

const IMAP_HOST = process.env.IMAP_HOST || 'imap.gmail.com';
const IMAP_USER = 'raecroominfo.board@gmail.com'; // baked-in per your preference
const IMAP_PASS = process.env.IMAP_PASS;           // set this in Actions secrets

const OUT_CSV   = process.env.OUT_CSV || 'data/inbox/latest.csv';
const INBOX     = process.env.IMAP_FOLDER || 'INBOX';

if (!IMAP_PASS) {
  console.error('Missing IMAP_PASS env var (Gmail App Password).');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });

/** Walk a BODYSTRUCTURE tree to find parts that look like CSV attachments. */
function* walkParts(node, prefix = '') {
  if (!node) return;
  if (Array.isArray(node.childNodes) && node.childNodes.length) {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      const childId = prefix ? `${prefix}.${i+1}` : `${i+1}`;
      yield* walkParts({ ...child, part: child.part || childId }, childId);
    }
  }
  // Some servers set node.part; if not, we pass along computed childId via recursion above
  yield node;
}

function pickCsvPart(bodyStructure) {
  let best = null;

  for (const part of walkParts(bodyStructure)) {
    const disp = (part.disposition || '').toUpperCase(); // 'ATTACHMENT' or 'INLINE' or ''
    const type = (part.type || '').toUpperCase();         // 'TEXT', 'APPLICATION', etc
    const subtype = (part.subtype || '').toUpperCase();   // 'PLAIN', 'OCTET-STREAM', etc

    const params = part.parameters || part.params || {};
    const dparams = part.dispositionParameters || {};
    const name = (params.name || dparams.filename || '').toString();

    const looksCsvName = name.toLowerCase().endsWith('.csv');
    const looksCsvMime =
      (type === 'TEXT' && subtype === 'CSV') ||
      (type === 'APPLICATION' && subtype === 'CSV') ||
      (type === 'TEXT' && subtype === 'PLAIN' && looksCsvName) ||
      (type === 'APPLICATION' && subtype === 'OCTET-STREAM' && looksCsvName);

    if ((disp === 'ATTACHMENT' || looksCsvName) && (looksCsvName || looksCsvMime)) {
      // Prefer explicit ATTACHMENT disposition; if multiple, pick the longest filename (heuristic)
      if (!best) best = part;
      else {
        const bestName = ((best.parameters?.name) || (best.dispositionParameters?.filename) || '').toString();
        if (disp === 'ATTACHMENT' && (best.disposition || '').toUpperCase() !== 'ATTACHMENT') best = part;
        else if (name.length > bestName.length) best = part;
      }
    }
  }
  return best;
}

function decodeBody(buffer, encoding) {
  const enc = (encoding || '').toUpperCase();
  if (enc === 'BASE64') {
    // raw buffer contains ASCII base64; decode
    const b64 = buffer.toString('ascii');
    return Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  }
  if (enc === 'QUOTED-PRINTABLE') {
    // very rare for CSV, but handle simply
    const str = buffer.toString('utf8')
      .replace(/=\r?\n/g, '')        // soft line breaks
      .replace(/=([A-F0-9]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(str, 'utf8');
  }
  // 7BIT/8BIT/BINARY: already raw text
  return buffer;
}

async function main() {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: 993,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false
  });

  try {
    await client.connect();
    await client.mailboxOpen(INBOX);

    // Find newest message by INTERNALDATE
    let newest = null;
    for await (const msg of client.fetch({ all: true }, { uid: true, internalDate: true })) {
      if (!newest || (msg.internalDate > newest.internalDate)) newest = msg;
    }
    if (!newest) {
      console.log('No emails in INBOX.');
      return;
    }

    // Get BODYSTRUCTURE so we can locate the CSV reliably
    const [bsResp] = await client.fetch(newest.uid, { uid: true, bodyStructure: true });
    const bodyStructure = bsResp?.bodyStructure;
    if (!bodyStructure) {
      console.log('No BODYSTRUCTURE; falling back to no-op.');
      return;
    }

    // Find the CSV part (by filename/MIME)
    const csvPart = pickCsvPart(bodyStructure);
    if (!csvPart || !csvPart.part) {
      console.log('No CSV attachment found in newest email.');
      return;
    }

    const filename =
      csvPart.parameters?.name ||
      csvPart.dispositionParameters?.filename ||
      'attachment.csv';

    console.log(`Found CSV part ${csvPart.part} (${filename}) — encoding=${csvPart.encoding}`);

    // Download that exact part
    const dl = await client.download(newest.uid, csvPart.part, { uid: true });
    const chunks = [];
    for await (const ch of dl.content) chunks.push(ch);
    const raw = Buffer.concat(chunks);
    const decoded = decodeBody(raw, csvPart.encoding);

    // Save CSV
    fs.writeFileSync(OUT_CSV, decoded);
    console.log(`Saved CSV to ${OUT_CSV} (${filename})`);
  } catch (err) {
    console.error('fetch_email failed:', err.message || err);
    process.exit(1);
  } finally {
    try { await client.logout(); } catch {}
  }
}

main();
