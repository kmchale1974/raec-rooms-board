// scripts/fetch_email.js
import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import pino from 'pino';
import { simpleParser } from 'mailparser';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.PRETTY_LOGS
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined
});

// --- Config from env / defaults ---
const IMAP_HOST   = process.env.IMAP_HOST   || 'imap.gmail.com';
const IMAP_PORT   = Number(process.env.IMAP_PORT || 993);
const IMAP_SECURE = process.env.IMAP_SECURE ? process.env.IMAP_SECURE === 'true' : true;
const IMAP_USER   = process.env.IMAP_USER   || 'raecroominfo.board@gmail.com';
const IMAP_PASS   = process.env.IMAP_PASS; // REQUIRED

const OUT_CSV     = process.env.OUT_CSV || 'data/inbox/latest.csv';

if (!IMAP_PASS) {
  log.error('No password configured. Set IMAP_PASS as a secret/environment variable.');
  process.exit(1);
}

const SEARCH_SUBJECT     = process.env.SEARCH_SUBJECT || 'AC Daily Facility';
const SEARCH_DAYS        = Number(process.env.SEARCH_DAYS || 30);
const SEARCH_IN_ALLMAIL  = (process.env.SEARCH_IN_ALLMAIL || 'true') === 'true';

// ---------- Helpers ----------
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function ensureOpen(client, mailbox) {
  await client.mailboxOpen(mailbox, { readOnly: true });
}

async function searchRaw(client, mailbox, raw) {
  await ensureOpen(client, mailbox);
  const criteria = { 'x-gm-raw': raw };
  const uids = (await client.search(criteria)) || [];
  log.info(`[${mailbox}] RAW "${raw}" -> ${uids.length} matches`);
  return uids;
}

async function searchSince(client, mailbox, sinceDate) {
  await ensureOpen(client, mailbox);
  const criteria = { since: sinceDate };
  const uids = (await client.search(criteria)) || [];
  log.info(`[${mailbox}] SINCE ${sinceDate.toISOString().slice(0, 10)} -> ${uids.length} matches`);
  return uids;
}

async function fetchMessages(client, mailbox, uids) {
  if (!Array.isArray(uids) || uids.length === 0) return [];
  await ensureOpen(client, mailbox);
  const sorted = [...uids].sort((a, b) => b - a); // newest first
  const out = [];
  for (const uid of sorted) {
    const msg = await client.fetchOne(uid, { source: true, envelope: true, internalDate: true, uid: true });
    if (!msg?.source) continue;
    const parsed = await simpleParser(msg.source);
    out.push({
      mailbox,
      uid,
      subject: parsed.subject || msg.envelope?.subject || '',
      date: msg.internalDate,
      attachments: parsed.attachments || []
    });
  }
  return out;
}

function pickCsvAttachments(messages) {
  return messages
    .flatMap(m => (m.attachments || []).map(att => ({ msg: m, att })))
    .filter(({ att }) => {
      const name = (att.filename || '').toLowerCase();
      const type = (att.contentType || '').toLowerCase();
      return name.endsWith('.csv') || type.includes('text/csv') || type.includes('application/vnd.ms-excel');
    })
    .sort((a, b) => new Date(b.msg.date) - new Date(a.msg.date));
}

// ---------- Main ----------
(async () => {
  log.info(`Connecting to Gmail as ${IMAP_USER}…`);

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: IMAP_SECURE,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false
  });

  try {
    await client.connect();

    const mailboxes = ['INBOX', ...(SEARCH_IN_ALLMAIL ? ['[Gmail]/All Mail'] : [])];

    const newerThanRaw = `subject:"${SEARCH_SUBJECT}" has:attachment newer_than:${SEARCH_DAYS}d`;
    const wideRaw      = `has:attachment newer_than:${Math.max(SEARCH_DAYS * 2, 60)}d`;
    const sinceDate    = daysAgo(Math.max(SEARCH_DAYS * 3, 90));

    // Collect UIDs per mailbox
    const uidMap = new Map(); // mailbox -> Set(uids)
    for (const m of mailboxes) {
      const u1 = await searchRaw(client, m, newerThanRaw);
      const u2 = await searchRaw(client, m, wideRaw);
      const u3 = await searchSince(client, m, sinceDate);
      uidMap.set(m, new Set([...(u1 || []), ...(u2 || []), ...(u3 || [])]));
    }

    // Fetch exactly those UIDs per mailbox
    let allMessages = [];
    for (const [mbox, set] of uidMap.entries()) {
      const list = Array.from(set);
      if (list.length === 0) continue;
      const msgs = await fetchMessages(client, mbox, list);
      allMessages.push(...msgs);
    }

    // De-dup cross-mailbox by subject+date
    const seen = new Set();
    const unique = [];
    for (const m of allMessages) {
      const key = `${(m.subject || '').trim()}__${new Date(m.date).toISOString()}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(m);
      }
    }
    unique.sort((a, b) => new Date(b.date) - new Date(a.date));

    const csvs = pickCsvAttachments(unique);
    if (csvs.length === 0) {
      log.warn('No CSV attachment found in candidate messages.');
      process.exit(1);
    }

    const latest = csvs[0];
    const bytes = latest.att.content?.length || 0;
    const outPath = OUT_CSV;

    // Ensure folder exists, then write
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, latest.att.content);

    log.info(
      {
        mailbox: latest.msg.mailbox,
        uid: latest.msg.uid,
        subject: latest.msg.subject,
        date: latest.msg.date,
        attachment: latest.att.filename || '(no name)',
        size: bytes,
        saved: outPath
      },
      'Saved latest CSV attachment'
    );

    process.exit(0);
  } catch (err) {
    if (err?.authenticationFailed || /No password configured/i.test(String(err))) {
      log.error('Authentication failed: IMAP_PASS is missing or incorrect.');
    } else {
      log.error({ err }, 'Failed to fetch email.');
    }
    process.exit(1);
  } finally {
    try { await client.logout(); } catch {}
  }
})();
