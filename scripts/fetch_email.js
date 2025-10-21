// scripts/fetch_email.js
// Robust Gmail IMAP CSV fetcher (ESM). No mailparser needed.

import fs from 'fs';
import path from 'path';
import { ImapFlow } from 'imapflow';

const IMAP_HOST = process.env.IMAP_HOST || 'imap.gmail.com';
const IMAP_USER = 'raecroominfo.board@gmail.com'; // baked-in
const IMAP_PASS = process.env.IMAP_PASS;           // Actions secret
const INBOX     = process.env.IMAP_FOLDER || 'INBOX';
const OUT_CSV   = process.env.OUT_CSV || 'data/inbox/latest.csv';

if (!IMAP_PASS) {
  console.error('Missing IMAP_PASS env var (Gmail App Password).');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });

function* walkParts(node) {
  if (!node) return;
  // imapflow gives multipart nodes with childNodes[]
  if (Array.isArray(node.childNodes) && node.childNodes.length) {
    for (const child of node.childNodes) {
      yield* walkParts(child);
    }
  }
  yield node;
}

function pickCsvPart(bodyStructure) {
  let best = null;

  for (const part of walkParts(bodyStructure)) {
    // imapflow sets: part.type, part.subtype, part.encoding, part.disposition, part.parameters, part.dispositionParameters, part.part
    const disp = (part.disposition || '').toUpperCase();
    const type = (part.type || '').toUpperCase();
    const subtype = (part.subtype || '').toUpperCase();

    const params  = part.parameters || {};
    const dparams = part.dispositionParameters || {};
    const name = (params.name || dparams.filename || '').toString();
    const hasCsvName = name.toLowerCase().endsWith('.csv');

    const looksCsvMime =
      (type === 'TEXT' && subtype === 'CSV') ||
      (type === 'APPLICATION' && subtype === 'CSV') ||
      (type === 'TEXT' && subtype === 'PLAIN' && hasCsvName) ||
      (type === 'APPLICATION' && subtype === 'OCTET-STREAM' && hasCsvName);

    if ((disp === 'ATTACHMENT' || hasCsvName) && (hasCsvName || looksCsvMime)) {
      if (!best) best = part;
      else {
        const bestName = ((best.parameters?.name) || (best.dispositionParameters?.filename) || '').toString();
        if (disp === 'ATTACHMENT' && (best.disposition || '').toUpperCase() !== 'ATTACHMENT') best = part;
        else if (name.length > bestName.length) best = part; // heuristic
      }
    }
  }

  return best;
}

function decodeBody(buffer, encoding) {
  const enc = (encoding || '').toUpperCase();
  if (enc === 'BASE64') {
    const b64 = buffer.toString('ascii').replace(/\s+/g, '');
    return Buffer.from(b64, 'base64');
  }
  if (enc === 'QUOTED-PRINTABLE') {
    const str = buffer.toString('utf8')
      .replace(/=\r?\n/g, '')
      .replace(/=([A-F0-9]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(str, 'utf8');
  }
  return buffer; // 7BIT/8BIT/BINARY
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

    // 1) Find newest message by INTERNALDATE
    let newest = null;
    for await (const msg of client.fetch({ all: true }, { uid: true, internalDate: true })) {
      if (!newest || msg.internalDate > newest.internalDate) newest = msg;
    }
    if (!newest) {
      console.log('No emails in INBOX.');
      return;
    }

    // 2) Fetch BODYSTRUCTURE for that message (async iterator -> grab first)
    let bsResp = null;
    for await (const item of client.fetch(newest.uid, { uid: true, bodyStructure: true })) {
      bsResp = item;
      break;
    }
    const bodyStructure = bsResp?.bodyStructure;
    if (!bodyStructure) {
      console.log('No BODYSTRUCTURE on newest message.');
      return;
    }

    // 3) Find the actual CSV attachment part
    const csvPart = pickCsvPart(bodyStructure);
    if (!csvPart || !csvPart.part) {
      console.log('No CSV attachment found in newest email.');
      return;
    }

    const filename =
      csvPart.parameters?.name ||
      csvPart.dispositionParameters?.filename ||
      'attachment.csv';

    console.log(`Found CSV part ${csvPart.part} (${filename}) — encoding=${csvPart.encoding || '7BIT'}`);

    // 4) Download that part
    const dl = await client.download(newest.uid, csvPart.part, { uid: true });
    const chunks = [];
    for await (const ch of dl.content) chunks.push(ch);
    const raw = Buffer.concat(chunks);

    // 5) Decode if needed and write to disk
    const decoded = decodeBody(raw, csvPart.encoding);
    fs.writeFileSync(OUT_CSV, decoded);
    console.log(`Saved CSV to ${OUT_CSV} (${filename})`);
  } catch (err) {
    console.error('fetch_email failed:', err?.message || err);
    process.exit(1);
  } finally {
    try { await client.logout(); } catch {}
  }
}

main();
