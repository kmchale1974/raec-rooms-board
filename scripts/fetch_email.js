// scripts/fetch_email.js
import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import pino from 'pino';
import { simpleParser } from 'mailparser';

const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.PRETTY_LOGS ? {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard' }
  } : undefined
});

// --- Config from env / defaults ---
const IMAP_HOST = process.env.IMAP_HOST || 'imap.gmail.com';
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const IMAP_SECURE = process.env.IMAP_SECURE ? process.env.IMAP_SECURE === 'true' : true;
const IMAP_USER = process.env.IMAP_USER || 'raecroominfo.board@gmail.com';
const IMAP_PASS = process.env.IMAP_PASS; // <-- REQUIRED (GitHub Secret)

if (!IMAP_PASS) {
  log.error('No password configured. Set IMAP_PASS as a secret/environment variable.');
  process.exit(1);
}

const SEARCH_SUBJECT = process.env.SEARCH_SUBJECT || 'AC Daily Facility';
const SEARCH_DAYS = Number(process.env.SEARCH_DAYS || 30);
const SEARCH_IN_ALLMAIL = (process.env.SEARCH_IN_ALLMAIL || 'true') === 'true';

// ---------- Helpers ----------
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  // normalize 00:00 local to be safe
  d.setHours(0, 0, 0, 0);
  return d;
}

async function openMailbox(client, label) {
  await client.mailboxOpen(label, { readOnly: true });
}

async function searchRaw(client, mailboxLabel, raw) {
  // Gmail raw queries via X-GM-RAW
  await openMailbox(client, mailboxLabel);
  const criteria = { 'x-gm-raw': raw };
  const uids = (await client.search(criteria)) || [];
  log.info(`[${mailboxLabel}] RAW "${raw}" -> ${uids.length} matches`);
  return uids;
}

async function searchSince(client, mailboxLabel, sinceDate) {
  await openMailbox(client, mailboxLabel);
  const criteria = { since: sinceDate }; // Standard IMAP SINCE
  const uids = (await client.search(criteria)) || [];
  log.info(`[${mailboxLabel}] SINCE ${sinceDate.toISOString().slice(0, 10)} -> ${uids.length} matches`);
  return uids;
}

async function fetchMessages(client, uids) {
  const results = [];
  if (!Array.isArray(uids) || uids.length === 0) return results;

  // newest first
  const sorted = [...uids].sort((a, b) => b - a);

  for (const uid of sorted) {
    const msg = await client.fetchOne(uid, { source: true, envelope: true, internalDate: true, uid: true });
    if (!msg?.source) continue;

    const parsed = await simpleParser(msg.source);
    results.push({
      uid,
      subject: parsed.subject || msg.envelope?.subject || '',
      date: msg.internalDate,
      attachments: parsed.attachments || []
    });
  }
  return results;
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

    const mailboxesToSearch = ['INBOX', ...(SEARCH_IN_ALLMAIL ? ['[Gmail]/All Mail'] : [])];

    const newerThanRaw = `subject:"${SEARCH_SUBJECT}" has:attachment newer_than:${SEARCH_DAYS}d`;
    const wideRaw = `has:attachment newer_than:${Math.max(SEARCH_DAYS * 2, 60)}d`;
    const sinceDate = daysAgo(Math.max(SEARCH_DAYS * 3, 90));

    let allUids = [];
    for (const mbox of mailboxesToSearch) {
      const u1 = await searchRaw(client, mbox, newerThanRaw);
      const u2 = await searchRaw(client, mbox, wideRaw);
      const u3 = await searchSince(client, mbox, sinceDate);
      allUids.push(...u1, ...u2, ...u3);
    }

    // Dedup UID list (UIDs are per-mailbox; but since we fetch after opening each mailbox separately,
    // we only dedup within this combined pool)
    const seenUIDs = new Set();
    const uniqueUids = [];
    for (const u of allUids) {
      if (!seenUIDs.has(u)) {
        seenUIDs.add(u);
        uniqueUids.push(u);
      }
    }

    // We need to fetch per mailbox (UID space is per mailbox). To keep this simple and robust,
    // do another pass but fetch per-mailbox separately and combine.
    let allMessages = [];
    for (const mbox of mailboxesToSearch) {
      await openMailbox(client, mbox);
      // Re-run a quick broad search to get the mailbox's UIDs and intersect with uniqueUids:
      const mailboxUids = (await client.search({ all: true })) || [];
      const intersect = mailboxUids.filter(u => seenUIDs.has(u));
      const msgs = await fetchMessages(client, intersect);
      allMessages.push(...msgs);
    }

    // De-dup by subject+date (cross-mailbox safety)
    const seenKey = new Set();
    const uniqueMessages = [];
    for (const m of allMessages) {
      const key = `${m.subject}__${new Date(m.date).toISOString()}`;
      if (!seenKey.has(key)) {
        seenKey.add(key);
        uniqueMessages.push(m);
      }
    }
    uniqueMessages.sort((a, b) => new Date(b.date) - new Date(a.date));

    const csvs = pickCsvAttachments(uniqueMessages);
    if (csvs.length === 0) {
      log.warn('No CSV attachment could be extracted from any candidate message.');
      process.exit(1);
    }

    const latest = csvs[0];
    log.info({
      subject: latest.msg.subject,
      date: latest.msg.date,
      attachment: latest.att.filename || '(no name)',
      size: latest.att.content?.length || 0
    }, 'Found CSV attachment');

    // If you want to save it:
    // import { writeFileSync } from 'node:fs';
    // writeFileSync('latest.csv', latest.att.content);

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
