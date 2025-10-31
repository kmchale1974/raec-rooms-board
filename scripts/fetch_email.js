// scripts/fetch_email.js
// ESM module (package.json should contain: { "type": "module" })

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

// Typical CivicPlus filename pattern
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
      size: node.size || 0,
    });
  })(struct);
  return out;
}

function filenameFromPart(p) {
  const d = p?.disposition || {};
  const dp = d.params || d.parameters || {};
  const pp = p?.parameters || {};
  return (
    dp.filename ||
    dp.name ||
    pp.name ||
    ''
  );
}

function isAttachment(p) {
  const disp = (p?.disposition?.type || '').toLowerCase();
  return disp === 'attachment' || disp === 'inline'; // Gmail often sets inline for attachments
}

function looksLikeCsv(p) {
  const fn = filenameFromPart(p);
  const hasCsvName = /\.csv$/i.test(fn) || CIVICPLUS_RE.test(fn);
  const isCsvMime =
    (p.type === 'text' && (p.subtype === 'csv' || p.subtype === 'comma-separated-values')) ||
    (p.type === 'application' && (p.subtype === 'vnd.ms-excel' || p.subtype === 'csv'));

  // As a fallback, treat any non-zero-sized attachment with a plausible name as CSV
  const genericMaybe =
    isAttachment(p) &&
    p.size > 0 &&
    /(schedule|facility|global|daily)/i.test(fn || '');

  return hasCsvName || isCsvMime || genericMaybe;
}

function pickCsvPart(parts) {
  if (!Array.isArray(parts)) return null;

  // 1) Exact CivicPlus name
  let match = parts.find(p => CIVICPLUS_RE.test(filenameFromPart(p)));
  if (match) return match;

  // 2) Any .csv filename
  match = parts.find(p => /\.csv$/i.test(filenameFromPart(p)));
  if (match) return match;

  // 3) CSV-ish MIME types
  match = parts.find(p => looksLikeCsv(p));
  if (match) return match;

  return null;
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

async function listUids(client, mailbox, queryDesc, query) {
  const ok = await tryOpen(client, mailbox);
  if (!ok) return [];
  try {
    const uids = await client.search(query);
    const n = Array.isArray(uids) ? uids.length : 0;
    console.log(`[${mailbox}] ${queryDesc} → ${n} matches`);
    return uids || [];
  } catch (e) {
    console.warn(`[${mailbox}] search failed (${queryDesc}): ${e?.message || e}`);
    return [];
  }
}

async function pickNewestCsvFromUids(client, mailbox, uids, label) {
  if (!uids?.length) {
    console.log(`(${label} @ ${mailbox}) No UIDs to fetch.`);
    return null;
  }
  // Scan newest first, but cap the volume to keep builds fast
  const subset = uids.slice(-400);
  const candidates = [];

  try {
    for await (const msg of client.fetch(
      subset,
      { uid: true, envelope: true, bodyStructure: true, internalDate: true },
      { uid: true }
    )) {
      const uid = msg?.uid;
      const subject = (msg?.envelope?.subject || '(no subject)').toString();
      const when = msg?.internalDate ? new Date(msg.internalDate) : null;
      const parts = flattenParts(msg?.bodyStructure);

      // Briefly log the discovered filenames for debugging
      const names = parts
        .map(p => filenameFromPart(p))
        .filter(Boolean)
        .slice(0, 5);
      if (names.length) {
        console.log(`[${label} @ ${mailbox}] uid=${uid} name(s): ${names.join(' | ')}`);
      }

      const csvPart = pickCsvPart(parts);
      if (csvPart?.part) {
        const fn = filenameFromPart(csvPart) || '(no filename)';
        candidates.push({
          uid,
          whenMs: when ? when.getTime() : 0,
          partId: csvPart.part,
          filename: fn,
          subject
        });
        console.log(`[${label} @ ${mailbox}] uid=${uid} → CSV match: ${fn}`);
      } else {
        console.log(`[${label} @ ${mailbox}] uid=${uid} → no CSV part`);
      }
    }
  } catch (e) {
    console.warn(`[${label} @ ${mailbox}] fetch failed: ${e?.message || e}`);
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.whenMs - a.whenMs);
  return candidates[0];
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
    const mailboxes = ['INBOX', '[Gmail]/All Mail'];

    // Strategies (we try each in BOTH mailboxes before moving on)
    const strategies = [
      {
        desc: 'subject+attach(21d)',
        queryDesc: 'gmailRaw "subject:"AC Daily Facility" has:attachment newer_than:21d"',
        query: { gmailRaw: 'subject:"AC Daily Facility" has:attachment newer_than:21d' },
      },
      {
        desc: 'attach(60d)',
        queryDesc: 'gmailRaw "has:attachment newer_than:60d"',
        query: { gmailRaw: 'has:attachment newer_than:60d' },
      },
      {
        desc: 'since(90d)',
        makeQuery: () => ({ since: new Date(Date.now() - 90 * 24 * 3600 * 1000) }),
        queryDesc: 'SEARCH since 90 days',
      }
    ];

    let chosen = null;

    for (const strat of strategies) {
      for (const mb of mailboxes) {
        const query = strat.query || strat.makeQuery?.();
        const uids = await listUids(client, mb, strat.queryDesc, query);
        if (!uids.length) continue;

        const found = await pickNewestCsvFromUids(client, mb, uids, strat.desc);
        if (found) {
          chosen = found;
          break;
        }
      }
      if (chosen) break; // stop trying strategies
      console.log(`No CSV found via strategy "${strat.desc}", trying next…`);
    }

    if (!chosen) {
      console.error('No attachments that look like the Facility CSV were found in matched messages across all strategies and mailboxes.');
      process.exit(1);
    }

    console.log(
      `Chosen uid=${chosen.uid} | "${chosen.subject}" | ${new Date(chosen.whenMs).toISOString()}`
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
