// scripts/fetch_email.js
// ESM module (package.json should include: "type": "module")

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ImapFlow } from 'imapflow';

const {
  IMAP_USER,
  IMAP_PASS,
  OUT_CSV = 'data/inbox/latest.csv',
} = process.env;

if (!IMAP_USER) {
  console.error('Missing IMAP_USER env var (Gmail address).');
  process.exit(1);
}
if (!IMAP_PASS) {
  console.error('Missing IMAP_PASS env var (Gmail App Password).');
  process.exit(1);
}

// Prefer the CivicPlus export filename; fallback to any .csv
const CSV_NAME_RE = /AC\s*-\s*Daily\s*Facility\s*Global\s*Schedule.*\.csv$/i;

async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function flattenParts(struct) {
  const out = [];
  (function walk(node) {
    if (!node) return;
    if (Array.isArray(node.childNodes) && node.childNodes.length) {
      node.childNodes.forEach(walk);
      return;
    }
    out.push({
      part: node.part,
      type: node.type,
      subtype: node.subtype,
      parameters: node.parameters || {},
      disposition: node.disposition || {},
    });
  })(struct);
  return out;
}

function pickCsvPart(parts) {
  if (!Array.isArray(parts) || !parts.length) return null;

  // Best: exact CivicPlus pattern
  const byPattern = parts.find(p => {
    const name = p?.disposition?.params?.filename || p?.parameters?.name || '';
    return CSV_NAME_RE.test(name);
  });
  if (byPattern) return byPattern;

  // Next: any .csv filename
  const byExt = parts.find(p => {
    const name = p?.disposition?.params?.filename || p?.parameters?.name || '';
    return /\.csv$/i.test(name);
  });
  if (byExt) return byExt;

  // Last: CSV-like content types
  const byType = parts.find(
    p =>
      (p.type?.toLowerCase?.() === 'text' && p.subtype?.toLowerCase?.() === 'csv') ||
      (p.type?.toLowerCase?.() === 'application' && p.subtype?.toLowerCase?.() === 'octet-stream')
  );
  return byType || null;
}

async function downloadCsv(client, uid, partId, outFile) {
  const dl = await client.download(uid, partId, { uid: true });
  if (!dl?.content) throw new Error('download() returned no content stream');
  await ensureDir(outFile);
  await pipeline(dl.content, createWriteStream(outFile));
}

async function findAllMailBox(client) {
  // Try the official special-use discovery (\All)
  try {
    const found = [];
    for await (const box of client.list()) {
      // ImapFlow returns .path and .specialUse (array of strings) when available
      const su = (box.specialUse || []).map(s => s.toLowerCase());
      if (su.includes('\\all') || su.includes('all')) {
        found.push(box.path);
      }
    }
    if (found.length) {
      // First match wins; also log what we picked
      console.log(`Discovered All Mail via special-use: ${found[0]}`);
      return found[0];
    }
  } catch (e) {
    console.warn(`Special-use discovery failed: ${e?.message || e}`);
  }

  // Fallback: try common localized names (as a last resort)
  const candidates = [
    '[Gmail]/All Mail',
    'All Mail',
    '[Google Mail]/All Mail',
    '[Gmail]/Tous les messages',
    '[Gmail]/Alle Nachrichten',
    '[Gmail]/Todos',
    '[Gmail]/Posta in arrivo', // unlikely All Mail, but we tried earlier
  ];
  for (const name of candidates) {
    try {
      await client.mailboxOpen(name);
      console.log(`Opened candidate All Mail: ${name}`);
      return name;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

async function searchNewestCsvInMailbox(client, mailboxPath) {
  await client.mailboxOpen(mailboxPath);
  console.log(`Opened mailbox: ${mailboxPath}`);

  // Try tighter query first (subject + has:attachment + csv filename)
  let uids = await client.search({
    // last 14 days; adjust if you want longer
    gmailRaw:
      'newer_than:14d has:attachment filename:csv subject:"AC Daily Facility Report"',
  });

  // Looser: any CSV in last 14d
  if (!uids?.length) {
    uids = await client.search({
      gmailRaw: 'newer_than:14d has:attachment filename:csv',
    });
  }

  if (!uids?.length) return null;

  // Walk newest → oldest to find a message that actually has a CSV attachment
  for (let i = uids.length - 1; i >= 0; i--) {
    const uid = uids[i];
    let msg;
    try {
      msg = await client.fetchOne(
        uid,
        { envelope: true, bodyStructure: true },
        { uid: true }
      );
    } catch (e) {
      console.warn(`fetchOne uid=${uid} failed: ${e?.message || e}`);
      continue;
    }
    const parts = flattenParts(msg?.bodyStructure);
    const csvPart = pickCsvPart(parts);
    if (csvPart?.part) {
      const subj = msg?.envelope?.subject || '(no subject)';
      const when = msg?.envelope?.date ? new Date(msg.envelope.date) : null;
      const filename =
        csvPart.disposition?.params?.filename ||
        csvPart.parameters?.name ||
        '(no filename)';
      return { uid, partId: csvPart.part, subject: subj, date: when, filename };
    }
  }
  return null;
}

async function main() {
  console.log(`Connecting to Gmail as ${IMAP_USER}…`);
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false, // set to console for very verbose logs
  });

  await client.connect();

  try {
    // 1) Try INBOX
    let chosen = await searchNewestCsvInMailbox(client, 'INBOX');

    // 2) If not in INBOX, try the discovered All Mail
    if (!chosen) {
      const allMail = await findAllMailBox(client);
      if (allMail) {
        chosen = await searchNewestCsvInMailbox(client, allMail);
      } else {
        console.warn('Could not discover an All Mail mailbox over IMAP.');
      }
    }

    if (!chosen) {
      console.error(
        'No suitable "AC Daily Facility Report" CSV found in INBOX or All Mail (last 14 days).'
      );
      process.exit(1);
    }

    console.log(
      `Chosen message uid=${chosen.uid} | ${chosen.date || 'unknown date'} | ${chosen.subject}`
    );
    console.log(`Attachment: ${chosen.filename} (part ${chosen.partId})`);

    await downloadCsv(client, chosen.uid, chosen.partId, OUT_CSV);
    console.log(`Saved CSV to ${OUT_CSV}`);
  } catch (err) {
    console.error('fetch_email failed:', err?.message || err);
    process.exit(1);
  } finally {
    try {
      await client.logout();
    } catch {}
  }
}

main();
