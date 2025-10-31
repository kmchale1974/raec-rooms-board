// scripts/fetch_email.js
// ESM module (package.json should have: { "type": "module" })

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ImapFlow } from 'imapflow';

const {
  IMAP_HOST = 'imap.gmail.com',
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

const CIVICPLUS_RE = /AC\s*-\s*Daily\s*Facility\s*Global\s*Schedule.*\.csv$/i;

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
      type: (node.type || '').toLowerCase(),
      subtype: (node.subtype || '').toLowerCase(),
      parameters: node.parameters || {},
      disposition: node.disposition || {},
    });
  })(struct);
  return out;
}

function filenameFromPart(p) {
  return (
    p?.disposition?.params?.filename ||
    p?.parameters?.name ||
    ''
  );
}

function pickCsvPart(parts) {
  if (!Array.isArray(parts)) return null;

  // 1) Prefer the CivicPlus naming
  let match = parts.find(p => CIVICPLUS_RE.test(filenameFromPart(p)));
  if (match) return match;

  // 2) Any filename ending with .csv
  match = parts.find(p => /\.csv$/i.test(filenameFromPart(p)));
  if (match) return match;

  // 3) CSV-ish type fallback
  match = parts.find(p => {
    const t = p.type; const s = p.subtype;
    return (t === 'text' && s === 'csv') || (t === 'application' && s === 'vnd.ms-excel');
  });
  if (match) return match;

  // 4) Last-ditch: octet-stream with a plausible name
  match = parts.find(p => p.type === 'application' && p.subtype === 'octet-stream' && /schedule|facility|global/i.test(filenameFromPart(p)));
  return match || null;
}

async function downloadCsv(client, uid, partId, outFile) {
  const dl = await client.download(uid, partId, { uid: true });
  if (!dl?.content) throw new Error('download() returned no content stream');
  await ensureDir(outFile);
  await pipeline(dl.content, createWriteStream(outFile));
}

async function tryOpen(client, mailbox) {
  try {
    await client.mailboxOpen(mailbox);
    console.log(`Opened mailbox: ${mailbox}`);
    return true;
  } catch (e) {
    console.warn(`Cannot open mailbox "${mailbox}": ${e?.message || e}`);
    return false;
  }
}

async function pickNewestCsvFromUids(client, uids, label) {
  if (!uids?.length) {
    console.log(`(${label}) No UIDs to fetch.`);
    return null;
  }

  // limit how many to fetch (newest first)
  const subset = uids.slice(-800); // big enough but bounded
  const candidates = [];

  try {
    for await (const msg of client.fetch(subset, {
      uid: true,
      envelope: true,
      bodyStructure: true,
      internalDate: true
    }, { uid: true })) {
      const uid = msg?.uid;
      const subject = (msg?.envelope?.subject || '(no subject)').toString();
      const when = msg?.internalDate ? new Date(msg.internalDate) : null;
      const parts = flattenParts(msg?.bodyStructure);
      const csvPart = pickCsvPart(parts);
      const fn = csvPart ? filenameFromPart(csvPart) : '';

      console.log(
        `[${label}] uid=${uid} | ${when ? when.toISOString() : 'no-date'} | "${subject}" | ` +
        (csvPart ? `CSV: ${fn}` : 'no CSV')
      );

      if (csvPart?.part) {
        candidates.push({
          uid,
          whenMs: when ? when.getTime() : 0,
          partId: csvPart.part,
          filename: fn || '(no filename)',
          subject
        });
      }
    }
  } catch (e) {
    console.warn(`[${label}] fetch failed: ${e?.message || e}`);
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.whenMs - a.whenMs);
  return candidates[0];
}

async function searchWithGmailRaw(client, mailbox, raw) {
  // Opens mailbox, then runs Gmail raw search; returns UIDs (might be empty)
  const ok = await tryOpen(client, mailbox);
  if (!ok) return [];
  try {
    // imapflow supports gmailRaw param on search
    const uids = await client.search({ gmailRaw: raw });
    console.log(`[${mailbox}] gmailRaw "${raw}" → ${uids?.length || 0} matches`);
    return uids || [];
  } catch (e) {
    console.warn(`[${mailbox}] gmailRaw search failed: ${e?.message || e}`);
    return [];
  }
}

async function searchSince(client, mailbox, sinceDate) {
  const ok = await tryOpen(client, mailbox);
  if (!ok) return [];
  try {
    const uids = await client.search({ since: sinceDate });
    console.log(`[${mailbox}] SEARCH since ${sinceDate.toISOString()} → ${uids?.length || 0} matches`);
    return uids || [];
  } catch (e) {
    console.warn(`[${mailbox}] SEARCH failed: ${e?.message || e}`);
    return [];
  }
}

async function main() {
  console.log(`Connecting to Gmail as ${IMAP_USER}…`);
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: 993,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false
  });

  await client.connect();
  try {
    // 1) Tight Gmail search first: correct subject + has:attachment, last 21d
    const rawKey = 'subject:"AC Daily Facility" has:attachment newer_than:21d';

    let uids = [];
    // INBOX then All Mail
    uids = (await searchWithGmailRaw(client, 'INBOX', rawKey));
    if (!uids.length) {
      uids = (await searchWithGmailRaw(client, '[Gmail]/All Mail', rawKey));
    }

    // 2) If nothing, widen: any message with attachment, last 60d
    if (!uids.length) {
      const altRaw = 'has:attachment newer_than:60d';
      uids = (await searchWithGmailRaw(client, 'INBOX', altRaw));
      if (!uids.length) {
        uids = (await searchWithGmailRaw(client, '[Gmail]/All Mail', altRaw));
      }
    }

    // 3) Last resort: plain IMAP since (90d), we’ll filter by bodystructure
    if (!uids.length) {
      const since = new Date(Date.now() - 90 * 24 * 3600 * 1000);
      uids = (await searchSince(client, 'INBOX', since));
      if (!uids.length) {
        uids = (await searchSince(client, '[Gmail]/All Mail', since));
      }
    }

    if (!uids.length) {
      console.error('No messages matched any search (subject or since); cannot find CSV.');
      process.exit(1);
    }

    // Examine newest messages first (by UID order)
    let chosen = await pickNewestCsvFromUids(client, uids, 'pick');
    if (!chosen) {
      console.error('No attachments that look like the Facility CSV were found in matched messages.');
      process.exit(1);
    }

    console.log(
      `Chosen uid=${chosen.uid} | ${new Date(chosen.whenMs).toISOString()} | "${chosen.subject}"`
    );
    console.log(`Attachment: ${chosen.filename} (part ${chosen.partId})`);

    await downloadCsv(client, chosen.uid, chosen.partId, OUT_CSV);
    console.log(`Saved CSV to ${OUT_CSV}`);
  } catch (err) {
    console.error('fetch_email failed:', err?.message || err);
    process.exit(1);
  } finally {
    try { await client.logout(); } catch {}
  }
}

main();
