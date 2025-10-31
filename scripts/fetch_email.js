// scripts/fetch_email.js
// ESM (package.json should have: { "type": "module" })

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
      size: node.size || 0,
    });
  })(struct);
  return out;
}

function filenameFromPart(p) {
  const disp = p?.disposition || {};
  const dp = disp.params || disp.parameters || {};
  const pp = p?.parameters || {};
  // Gmail often stuffs names in any of these
  return (dp.filename || dp.name || pp.name || '').toString();
}

function isAttachment(p) {
  // Gmail frequently uses "inline" for attachments as well
  const disp = (p?.disposition?.type || '').toLowerCase();
  return disp === 'attachment' || disp === 'inline';
}

function looksLikeCsv(p) {
  const fn = filenameFromPart(p);
  const hasCsvName = /\.csv$/i.test(fn) || CIVICPLUS_RE.test(fn);

  const isCsvMime =
    (p.type === 'text' && (p.subtype === 'csv' || p.subtype === 'comma-separated-values' || p.subtype === 'plain')) ||
    (p.type === 'application' && (p.subtype === 'vnd.ms-excel' || p.subtype === 'csv' || p.subtype === 'octet-stream'));

  // Heuristic: attachment, non-trivial size, and the (possibly missing) filename hints at schedule
  const genericMaybe =
    isAttachment(p) &&
    p.size > 1024 &&
    (/(schedule|facility|global|daily)/i.test(filenameFromPart(p)) ||
      // sometimes entirely missing name — allow generic if csv-ish mime
      isCsvMime);

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

  // 3) CSV-ish MIME or heuristic
  match = parts.find(looksLikeCsv);
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
    return Array.isArray(uids) ? uids : [];
  } catch (e) {
    console.warn(`[${mailbox}] search failed (${queryDesc}): ${e?.message || e}`);
    return [];
  }
}

function briefPart(p) {
  const fn = filenameFromPart(p);
  return `${p.part || '?'} ${p.type || ''}/${p.subtype || ''} size=${p.size} fn="${fn || '(none)'}" disp=${p?.disposition?.type || '(none)'}`;
}

async function inspectAndPick(client, mailbox, label, uids) {
  if (!uids?.length) return null;

  // Look at the newest ~300 to keep the run time predictable
  const subset = uids.slice(-300);
  let inspected = 0;
  const found = [];

  try {
    for await (const msg of client.fetch(
      subset,
      { uid: true, envelope: true, bodyStructure: true, internalDate: true },
      { uid: true }
    )) {
      inspected++;
      const uid = msg?.uid;
      const subject = (msg?.envelope?.subject || '(no subject)').toString();
      const whenIso = msg?.internalDate ? new Date(msg.internalDate).toISOString() : '(no date)';
      const parts = flattenParts(msg?.bodyStructure);

      // Log first few parts to see what Gmail is giving us
      const partSummaries = parts.slice(0, 6).map(briefPart).join(' | ');
      console.log(`[${label} @ ${mailbox}] uid=${uid} ${whenIso} subj="${subject}" parts: ${partSummaries}`);

      const csvPart = pickCsvPart(parts);
      if (csvPart?.part) {
        const fn = filenameFromPart(csvPart) || '(no filename)';
        console.log(`[${label} @ ${mailbox}] uid=${uid} → CSV PICK: part ${csvPart.part} "${fn}" ${csvPart.type}/${csvPart.subtype} size=${csvPart.size}`);
        found.push({
          uid,
          whenMs: msg?.internalDate ? new Date(msg.internalDate).getTime() : 0,
          partId: csvPart.part,
          filename: fn,
          subject
        });
      } else {
        console.log(`[${label} @ ${mailbox}] uid=${uid} → no CSV part recognized`);
      }
    }
  } catch (e) {
    console.warn(`[${label} @ ${mailbox}] fetch failed: ${e?.message || e}`);
  }

  if (!found.length) return null;
  found.sort((a, b) => b.whenMs - a.whenMs);
  return found[0];
}

async function bruteForcePick(client, mailbox) {
  // Absolute last resort: scan the newest 50 messages in this mailbox and
  // pick the largest attachment that has a .csv filename OR looks attachment-ish.
  const ok = await tryOpen(client, mailbox);
  if (!ok) return null;

  // Get newest 50 UIDs in this mailbox
  let uids = await client.search({ all: true });
  uids = Array.isArray(uids) ? uids.slice(-50) : [];
  if (!uids.length) return null;

  const candidates = [];

  try {
    for await (const msg of client.fetch(
      uids,
      { uid: true, envelope: true, bodyStructure: true, internalDate: true },
      { uid: true }
    )) {
      const parts = flattenParts(msg?.bodyStructure);
      const attachments = parts.filter(p => isAttachment(p) && p.size > 512);
      if (!attachments.length) continue;

      // Prefer CSV-like names, else largest attachment
      const withCsvName = attachments.filter(a => /\.csv$/i.test(filenameFromPart(a)));
      const pick = (withCsvName[0] || attachments.sort((a, b) => b.size - a.size)[0]);
      if (pick?.part) {
        candidates.push({
          uid: msg.uid,
          whenMs: msg?.internalDate ? new Date(msg.internalDate).getTime() : 0,
          partId: pick.part,
          filename: filenameFromPart(pick) || '(no filename)',
          subject: (msg?.envelope?.subject || '(no subject)').toString(),
        });
        console.log(`[bruteforce @ ${mailbox}] uid=${msg.uid} → PICK part ${pick.part} "${filenameFromPart(pick) || '(no filename)'}"`);
      }
    }
  } catch (e) {
    console.warn(`[bruteforce @ ${mailbox}] fetch failed: ${e?.message || e}`);
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
  });

  await client.connect();
  try {
    const mailboxes = ['INBOX', '[Gmail]/All Mail'];

    // Strategies
    const strategies = [
      {
        desc: 'subject+attach(21d)',
        queryDesc: 'gmailRaw "subject:\\"AC Daily Facility\\" has:attachment newer_than:21d"',
        makeQuery: () => ({ gmailRaw: 'subject:"AC Daily Facility" has:attachment newer_than:21d' }),
      },
      {
        desc: 'attach(60d)',
        queryDesc: 'gmailRaw "has:attachment newer_than:60d"',
        makeQuery: () => ({ gmailRaw: 'has:attachment newer_than:60d' }),
      },
      {
        desc: 'since(90d)',
        queryDesc: 'SEARCH since 90 days',
        makeQuery: () => ({ since: new Date(Date.now() - 90 * 24 * 3600 * 1000) }),
      },
    ];

    let chosen = null;

    // For each strategy, search BOTH mailboxes and try to pick
    for (const strat of strategies) {
      for (const mb of mailboxes) {
        const q = strat.makeQuery();
        const uids = await listUids(client, mb, strat.queryDesc, q);
        if (!uids.length) continue;

        const pick = await inspectAndPick(client, mb, strat.desc, uids);
        if (pick) {
          chosen = { ...pick, mailbox: mb, strategy: strat.desc };
          break;
        }
      }
      if (chosen) break;
      console.log(`No CSV found via strategy "${strat.desc}", trying next…`);
    }

    // Brute-force as last resort
    if (!chosen) {
      console.log('No CSV found via normal strategies — trying brute-force on newest messages…');
      for (const mb of mailboxes) {
        const bf = await bruteForcePick(client, mb);
        if (bf) { chosen = { ...bf, mailbox: mb, strategy: 'bruteforce' }; break; }
      }
    }

    if (!chosen) {
      console.error('No attachments that look like the Facility CSV were found in matched messages across all strategies and mailboxes.');
      process.exit(1);
    }

    console.log(
      `Chosen [${chosen.strategy}] from ${chosen.mailbox} → uid=${chosen.uid} | "${chosen.subject}" | part ${chosen.partId} | ${chosen.filename}`
    );

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
