// scripts/fetch_email.js
// ESM file (package.json should contain { "type": "module" })

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

const NAME_HINT = /AC\s*-\s*Daily\s*Facility\s*Global\s*Schedule/i;

async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function get(obj, ...keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) obj = obj[k];
    else return undefined;
  }
  return obj;
}

function flattenParts(struct) {
  const out = [];
  const walk = (node) => {
    if (!node) return;

    // Multipart containers (varies by version/host)
    const kids = node.childNodes || node.children || node.parts || [];
    if (Array.isArray(kids) && kids.length) {
      kids.forEach(walk);
      return;
    }

    // Leaf
    out.push({
      part: node.part || node.partId || '?',
      type: (node.type || '').toLowerCase(),
      subtype: (node.subtype || '').toLowerCase(),
      parameters: node.parameters || {},
      disposition: node.disposition || {},
      id: node.id,
      description: node.description,
      size: node.size || 0,
    });
  };
  walk(struct);
  return out;
}

function filenameFromPart(p) {
  const disp = p?.disposition || {};
  const dp = disp.params || disp.parameters || {};
  const pp = p?.parameters || {};

  // Try all the likely places, plus some fallbacks Gmail occasionally uses
  return (
    dp.filename ||
    dp.name ||
    pp.name ||
    p?.id ||
    p?.description ||
    '' // return empty string if nothing found
  ).toString();
}

function isProbablyAttachment(p) {
  const disp = (p?.disposition?.type || '').toLowerCase();
  // Gmail sometimes omits disposition entirely; treat text/plain+base64-ish as candidates
  return (
    disp === 'attachment' ||
    disp === 'inline' ||
    (!disp && p.size > 1024) // heuristic fallback
  );
}

function looksLikeCsvByMime(p) {
  // Plenty of variants; text/plain BASE64 is common for these reports
  if (p.type === 'text' && (p.subtype === 'csv' || p.subtype === 'comma-separated-values' || p.subtype === 'plain')) {
    return true;
  }
  if (p.type === 'application' && (p.subtype === 'csv' || p.subtype === 'vnd.ms-excel' || p.subtype === 'octet-stream')) {
    return true;
  }
  return false;
}

function looksLikeCsvByName(name) {
  if (!name) return false;
  if (/\.csv$/i.test(name)) return true;
  // Name hints (CivicRec sometimes plays games with names)
  if (NAME_HINT.test(name)) return true;
  if (/(schedule|facility|global|daily)/i.test(name) && /\.txt$/i.test(name) === false) return true;
  return false;
}

function pickCsvPart(parts) {
  if (!Array.isArray(parts) || !parts.length) return null;

  // 1) Exact/obvious CSV filename
  let m = parts.find((p) => looksLikeCsvByName(filenameFromPart(p)));
  if (m) return m;

  // 2) CSV-ish MIME (often text/plain for these)
  m = parts.find((p) => looksLikeCsvByMime(p) && isProbablyAttachment(p));
  if (m) return m;

  // 3) Heuristic: any sizeable “attachment-like” text/plain
  m = parts.find((p) => isProbablyAttachment(p) && p.size > 5 * 1024 && p.type === 'text');
  if (m) return m;

  return null;
}

function briefPart(p) {
  const fn = filenameFromPart(p) || '(no-filename)';
  const disp = p?.disposition?.type || '(no-disposition)';
  return `${p.part} ${p.type}/${p.subtype} size=${p.size} disp=${disp} fn="${fn}"`;
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

async function searchUids(client, mailbox, queryDesc, query) {
  const ok = await tryOpen(client, mailbox);
  if (!ok) return [];
  try {
    const uids = await client.search(query);
    console.log(`[${mailbox}] ${queryDesc} → ${uids?.length || 0} matches`);
    return Array.isArray(uids) ? uids : [];
  } catch (e) {
    console.warn(`[${mailbox}] search failed (${queryDesc}): ${e?.message || e}`);
    return [];
  }
}

async function inspectNewest(client, mailbox, label, uids) {
  if (!uids?.length) return null;

  const subset = uids.slice(-200); // newest window
  let newestPick = null;

  try {
    for await (const msg of client.fetch(
      subset,
      { uid: true, envelope: true, bodyStructure: true, internalDate: true },
      { uid: true }
    )) {
      const uid = msg?.uid;
      const subject = (msg?.envelope?.subject || '(no subject)').toString();
      const whenIso = msg?.internalDate ? new Date(msg.internalDate).toISOString() : '(no date)';
      const parts = flattenParts(msg?.bodyStructure);

      // Log parts we see
      console.log(`[${label} @ ${mailbox}] uid=${uid} ${whenIso} subj="${subject}"`);
      if (!parts.length) {
        console.log('  (no parts)');
        continue;
      }
      parts.forEach((p) => console.log('  ', briefPart(p)));

      const csv = pickCsvPart(parts);
      if (csv) {
        // prefer newest by internalDate
        const whenMs = msg?.internalDate ? new Date(msg.internalDate).getTime() : 0;
        if (!newestPick || whenMs > newestPick.whenMs) {
          newestPick = {
            uid,
            mailbox,
            whenMs,
            subject,
            partId: csv.part,
            filename: filenameFromPart(csv) || '(no-filename)',
            type: `${csv.type}/${csv.subtype}`,
            size: csv.size,
          };
        }
      }
    }
  } catch (e) {
    console.warn(`[${label} @ ${mailbox}] fetch failed: ${e?.message || e}`);
  }
  return newestPick;
}

async function bruteForcePick(client, mailbox) {
  // Absolute fallback: newest 50 messages, largest plausible “attachment-like” leaf
  const ok = await tryOpen(client, mailbox);
  if (!ok) return null;
  let uids = await client.search({ all: true });
  uids = Array.isArray(uids) ? uids.slice(-50) : [];
  if (!uids.length) return null;

  let candidate = null;
  for await (const msg of client.fetch(
    uids,
    { uid: true, envelope: true, bodyStructure: true, internalDate: true },
    { uid: true }
  )) {
    const parts = flattenParts(msg?.bodyStructure);
    const attachy = parts
      .filter((p) => isProbablyAttachment(p) && p.size > 1024)
      .sort((a, b) => b.size - a.size);
    if (!attachy.length) continue;

    const top = attachy[0];
    const whenMs = msg?.internalDate ? new Date(msg.internalDate).getTime() : 0;
    if (!candidate || whenMs > candidate.whenMs) {
      candidate = {
        uid: msg.uid,
        mailbox,
        whenMs,
        partId: top.part,
        filename: filenameFromPart(top) || '(no-filename)',
        subject: (msg?.envelope?.subject || '(no subject)').toString(),
        type: `${top.type}/${top.subtype}`,
        size: top.size,
      };
    }
  }
  return candidate;
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

    // Three strategies, both boxes
    const strategies = [
      {
        desc: 'subject+attach(21d)',
        qDesc: 'X-GM-RAW subject:"AC Daily Facility" has:attachment newer_than:21d',
        make: () => ({ gmailRaw: 'subject:"AC Daily Facility" has:attachment newer_than:21d' }),
      },
      {
        desc: 'attach(60d)',
        qDesc: 'X-GM-RAW has:attachment newer_than:60d',
        make: () => ({ gmailRaw: 'has:attachment newer_than:60d' }),
      },
      {
        desc: 'since(90d)',
        qDesc: 'SINCE 90 days',
        make: () => ({ since: new Date(Date.now() - 90 * 24 * 3600 * 1000) }),
      },
    ];

    let chosen = null;

    for (const strat of strategies) {
      for (const mb of mailboxes) {
        const uids = await searchUids(client, mb, strat.qDesc, strat.make());
        if (!uids.length) continue;
        const pick = await inspectNewest(client, mb, strat.desc, uids);
        if (pick) {
          chosen = { ...pick, strategy: strat.desc };
          break;
        }
      }
      if (chosen) break;
      console.log(`No CSV found via strategy "${strat.desc}", trying next…`);
    }

    if (!chosen) {
      console.log('No CSV found via normal strategies — trying brute-force on newest messages…');
      for (const mb of mailboxes) {
        const bf = await bruteForcePick(client, mb);
        if (bf) { chosen = { ...bf, strategy: 'bruteforce' }; break; }
      }
    }

    if (!chosen) {
      console.error('No attachments that look like the Facility CSV were found in matched messages across all strategies and mailboxes.');
      process.exit(1);
    }

    console.log(
      `Chosen [${chosen.strategy}] ${chosen.mailbox} uid=${chosen.uid} part=${chosen.partId} type=${chosen.type} size=${chosen.size} "${chosen.filename}" subj="${chosen.subject}"`
    );

    await ensureDir(OUT_CSV);
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
