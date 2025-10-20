// scripts/fetch_email.js
// Node 20+, package.json should have: { "type": "module" }
import fs from 'fs';
import path from 'path';
import { ImapFlow } from 'imapflow';

const IMAP_HOST   = process.env.IMAP_HOST   || 'imap.gmail.com';
const IMAP_USER   = process.env.IMAP_USER   || 'raecroominfo.board@gmail.com';
const IMAP_PASS   = process.env.IMAP_PASS; // REQUIRED (Gmail App Password, 16 chars, no spaces)
const IMAP_FOLDER = process.env.IMAP_FOLDER || 'INBOX';
const OUT_CSV     = process.env.OUT_CSV     || 'data/inbox/latest.csv';

if (!IMAP_PASS) {
  console.error('Missing IMAP_PASS env var (Gmail App Password).');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });

function log(...args){ console.log(...args); }
function err(...args){ console.error(...args); }

async function findNewestMessageWithCsv(client) {
  // Open mailbox
  const box = await client.mailboxOpen(IMAP_FOLDER);
  if (!box.exists) {
    log(`Mailbox "${IMAP_FOLDER}" is empty.`);
    return null;
  }

  // Fetch recent messages (last 50 UIDs) newest-first
  const startUid = Math.max(1, box.uidNext - 50);
  const range = `${startUid}:*`;

  const candidates = [];
  for await (const msg of client.fetch(range, { uid: true, envelope: true, internalDate: true, bodyStructure: true })) {
    candidates.push(msg);
  }
  candidates.sort((a, b) => b.uid - a.uid); // newest first

  // Look for first message that has a CSV attachment
  for (const msg of candidates) {
    const csvParts = [];
    const walk = (node, prefix = '') => {
      // node.part could be undefined for non-leaf; ImapFlow gives "part" on leafs
      const partNo = node.part || prefix || '';
      const disp = node.disposition && node.disposition.type ? node.disposition.type.toUpperCase() : '';
      const filename = (node.disposition && node.disposition.params && node.disposition.params.filename) ||
                       (node.params && node.params.name) || '';
      const type = `${(node.type || '').toUpperCase()}/${(node.subtype || '').toUpperCase()}`;

      // Consider as attachment if it has a filename or disposition attachment
      const isAttachment = filename || disp === 'ATTACHMENT';

      const looksCsv = (filename && filename.toLowerCase().endsWith('.csv')) ||
                       type === 'TEXT/CSV' ||
                       // Some Gmail exports show as text/plain but with .csv name
                       (type === 'TEXT/PLAIN' && filename && filename.toLowerCase().endsWith('.csv'));

      if (node.childNodes && node.childNodes.length) {
        // multipart/* container
        node.childNodes.forEach((child, idx) => walk(child, partNo ? `${partNo}.${idx+1}` : String(idx+1)));
      } else {
        if (isAttachment && looksCsv) {
          csvParts.push({ part: partNo, filename: filename || '(no filename)', type, disp });
        }
      }
    };

    if (msg.bodyStructure) {
      walk(msg.bodyStructure);
    }

    if (csvParts.length) {
      // Return the first csv part (they're rare to be multiple)
      const p = csvParts[0];
      return { uid: msg.uid, internalDate: msg.internalDate, part: p.part, filename: p.filename, type: p.type };
    }
  }

  return null;
}

async function downloadPartToFile(client, uid, part, outPath) {
  // Try download; retry once if needed
  const attempt = async (n) => {
    try {
      const dl = await client.download(uid, part, { uid: true });
      const chunks = [];
      for await (const ch of dl.content) chunks.push(ch);
      const buf = Buffer.concat(chunks);
      fs.writeFileSync(outPath, buf);
      return true;
    } catch (e) {
      err(`Download attempt ${n} failed for UID ${uid} part ${part}: ${e.message}`);
      return false;
    }
  };

  if (await attempt(1)) return;
  // brief backoff
  await new Promise(r => setTimeout(r, 500));
  if (await attempt(2)) return;

  throw new Error(`Unable to download UID ${uid} part ${part}`);
}

async function main() {
  const client = new ImapFlow({
    host: IMAP_HOST,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false
  });

  try {
    await client.connect();
    log(`Connected to ${IMAP_HOST} as ${IMAP_USER}`);
    const found = await findNewestMessageWithCsv(client);

    if (!found) {
      log('No CSV attachment found in the last ~50 messages.');
      // Write an empty file so downstream steps don’t break
      if (!fs.existsSync(OUT_CSV)) fs.writeFileSync(OUT_CSV, '');
      return;
    }

    log(`Found CSV: UID=${found.uid} part=${found.part} filename="${found.filename}" type=${found.type}`);
    log(`Downloading CSV part ${found.part} (UID ${found.uid}) → ${OUT_CSV}…`);

    await downloadPartToFile(client, found.uid, found.part, OUT_CSV);

    log(`Saved CSV to ${OUT_CSV} (${found.filename})`);
  } catch (e) {
    err('fetch_email failed:', e.message);
    process.exitCode = 1;
  } finally {
    try { await client.logout(); } catch {}
  }
}

main();
