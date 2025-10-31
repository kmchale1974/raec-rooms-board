// scripts/fetch_email.js
// ESM (ensure package.json has { "type": "module" })
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const {
  IMAP_HOST = 'imap.gmail.com',
  IMAP_USER,
  IMAP_PASS,
  OUT_CSV = 'data/inbox/latest.csv',
} = process.env;

if (!IMAP_USER) { console.error('Missing IMAP_USER env var (Gmail address).'); process.exit(1); }
if (!IMAP_PASS) { console.error('Missing IMAP_PASS env var (Gmail App Password).'); process.exit(1); }

function looksLikeCsvName(name = '') {
  return /\.csv$/i.test(name) || /(facility|schedule|global|daily)/i.test(name);
}
function looksLikeCsvMime(ct = '') {
  const t = ct.toLowerCase();
  return t.includes('text/csv') || t.includes('application/csv') || t.includes('vnd.ms-excel') || t.includes('octet-stream') || t.includes('text/plain');
}
async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}
async function saveStreamTo(filePath, stream) {
  await ensureDir(filePath);
  await pipeline(stream, createWriteStream(filePath));
}

async function* fetchCandidates(client, mailbox, strategies) {
  // strategies: array of {desc, query}
  for (const { desc, query } of strategies) {
    try {
      await client.mailboxOpen(mailbox);
      const uids = await client.search(query);
      console.log(`[${mailbox}] ${desc} -> ${uids.length} matches`);
      // newest first
      const ordered = uids.sort((a, b) => b - a);
      for (const uid of ordered) {
        yield { mailbox, desc, uid };
      }
    } catch (e) {
      console.warn(`[${mailbox}] search failed (${desc}): ${e?.message || e}`);
    }
  }
}

async function tryExtractCsvFromUid(client, uid) {
  // download full source and use mailparser to list attachments
  const src = await client.fetchOne(uid, { source: true, envelope: true, internalDate: true }, { uid: true });
  if (!src?.source) return null;

  const info = {
    uid,
    subject: (src?.envelope?.subject || '(no subject)').toString(),
    when: src?.internalDate ? new Date(src.internalDate).toISOString() : '(no date)'
  };

  // Parse the raw rfc822
  const parsed = await simpleParser(src.source);
  // Scan attachments, preferring obvious CSVs
  const atts = parsed.attachments || [];
  if (!atts.length) {
    console.log(`uid=${uid} "${info.subject}" @ ${info.when} (no attachments)`);
    return null;
  }

  // Try exact CSV by name first
  let pick = atts.find(a => looksLikeCsvName(a.filename || ''));
  // Then MIME-ish CSV
  if (!pick) pick = atts.find(a => looksLikeCsvMime(a.contentType));
  // Then biggest attachment as last resort
  if (!pick) pick = atts.sort((a,b) => (b.size||0) - (a.size||0))[0];

  if (!pick) {
    console.log(`uid=${uid} "${info.subject}" @ ${info.when} (attachments present but none suitable)`);
    return null;
  }

  console.log(`uid=${uid} "${info.subject}" @ ${info.when} -> attachment "${pick.filename || '(no name)'}" ct=${pick.contentType} size=${pick.size}`);

  return { info, attachment: pick };
}

async function main() {
  console.log(`Connecting to Gmail as ${IMAP_USER}…`);
  const client = new ImapFlow({
    host: IMAP_HOST, port: 993, secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS }
  });

  await client.connect();
  try {
    const strategies = [
      { desc: 'X-GM-RAW subject:"AC Daily Facility" has:attachment newer_than:30d', query: { gmailRaw: 'subject:"AC Daily Facility" has:attachment newer_than:30d' } },
      { desc: 'X-GM-RAW has:attachment newer_than:60d', query: { gmailRaw: 'has:attachment newer_than:60d' } },
      { desc: 'SINCE 90d', query: { since: new Date(Date.now() - 90*24*3600*1000) } },
      { desc: 'ALL (fallback newest first)', query: { all: true } }
    ];

    const mailboxes = ['INBOX', '[Gmail]/All Mail'];

    let saved = false;

    for (const mbox of mailboxes) {
      for await (const cand of fetchCandidates(client, mbox, strategies)) {
        const res = await tryExtractCsvFromUid(client, cand.uid);
        if (!res) continue;

        // Write to OUT_CSV
        await ensureDir(OUT_CSV);
        if (res.attachment.content) {
          await fs.writeFile(OUT_CSV, res.attachment.content);
        } else if (res.attachment.stream) {
          await saveStreamTo(OUT_CSV, res.attachment.stream);
        } else {
          // As a super-fallback, re-download just that body section is messy; mailparser should have given us content/stream.
          console.error(`Attachment for uid=${cand.uid} had no content stream/buffer.`);
          continue;
        }

        console.log(`Saved CSV to ${OUT_CSV} from uid=${cand.uid} "${res.info.subject}" (${res.attachment.filename || 'no-name'})`);
        saved = true;
        break; // stop after first successful save (newest-first order)
      }
      if (saved) break;
    }

    if (!saved) {
      console.error('No CSV attachment could be extracted from any candidate message.');
      process.exit(1);
    }
  } catch (e) {
    console.error('fetch_email failed:', e?.message || e);
    process.exit(1);
  } finally {
    try { await client.logout(); } catch {}
  }
}

main();
