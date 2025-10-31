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

// Search parameters
const SEARCH_SUBJECT = process.env.SEARCH_SUBJECT || 'AC Daily Facility';
const SEARCH_DAYS = Number(process.env.SEARCH_DAYS || 30);
const SEARCH_IN_ALLMAIL = (process.env.SEARCH_IN_ALLMAIL || 'true') === 'true'; // search [Gmail]/All Mail too

// Helpers
function formatSinceDays(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const day = String(d.getDate()).padStart(2, '0');
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${day}-${monthNames[d.getMonth()]}-${d.getFullYear()}`;
}

async function searchAndFetch(client, mailboxLabel, rawQuery) {
  await client.mailboxOpen(mailboxLabel, { readOnly: true });
  const uids = await client.search({ or: [ ['x-gm-raw', rawQuery] ] });
  log.info(`[${mailboxLabel}] ${rawQuery} -> ${uids.length} matches`);
  const results = [];

  // Fetch newest first
  uids.sort((a, b) => b - a);

  for (const uid of uids) {
    const msg = await client.fetchOne(uid, { source: true, envelope: true, internalDate: true, uid: true });
    if (!msg?.source) continue;

    const parsed = await simpleParser(msg.source);
    const hasAttachments = (parsed.attachments || []).length > 0;

    results.push({
      uid,
      subject: parsed.subject || msg.envelope?.subject || '',
      date: msg.internalDate,
      hasAttachments,
      attachments: parsed.attachments || []
    });
  }

  return results;
}

(async () => {
  log.info(`Connecting to Gmail as ${IMAP_USER}…`);

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: IMAP_SECURE,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false, // set to console for wire logs
    // gzip/deflate compression is auto-handled by Gmail; ImapFlow negotiates if supported
  });

  try {
    await client.connect();

    const newerThanRaw = `subject:"${SEARCH_SUBJECT}" has:attachment newer_than:${SEARCH_DAYS}d`;
    const sinceRaw = `has:attachment newer_than:${Math.max(SEARCH_DAYS * 2, 60)}d`; // fallback breadth
    const sinceDateLiteral = formatSinceDays(Math.max(SEARCH_DAYS * 3, 90));

    let allResults = [];

    // 1) INBOX targeted search
    allResults.push(...await searchAndFetch(client, 'INBOX', newerThanRaw));
    allResults.push(...await searchAndFetch(client, 'INBOX', sinceRaw));
    allResults.push(...await searchAndFetch(client, 'INBOX', `SINCE ${sinceDateLiteral}`)); // fallback

    // 2) Optionally, search [Gmail]/All Mail as well
    if (SEARCH_IN_ALLMAIL) {
      allResults.push(...await searchAndFetch(client, '[Gmail]/All Mail', newerThanRaw));
      allResults.push(...await searchAndFetch(client, '[Gmail]/All Mail', sinceRaw));
      allResults.push(...await searchAndFetch(client, '[Gmail]/All Mail', `SINCE ${sinceDateLiteral}`));
    }

    // Deduplicate by UID+mailbox isn’t reliable across mailboxes; use subject+date hash-ish
    const seen = new Set();
    const unique = [];
    for (const r of allResults) {
      const key = `${r.subject}__${new Date(r.date).toISOString()}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(r);
      }
    }

    // Sort newest first
    unique.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Filter to CSV attachments (or any attachment—adjust as needed)
    const csvCandidates = unique.flatMap(m => (m.attachments || []).map(att => ({ msg: m, att })))
      .filter(({ att }) => {
        const name = (att.filename || '').toLowerCase();
        const type = (att.contentType || '').toLowerCase();
        return name.endsWith('.csv') || type.includes('text/csv') || type.includes('application/vnd.ms-excel');
      });

    if (csvCandidates.length === 0) {
      log.warn('No CSV attachment could be extracted from any candidate message.');
      process.exit(1);
    }

    // If you want to save the latest CSV to disk, do it here:
    const latest = csvCandidates[0];
    log.info({
      subject: latest.msg.subject,
      date: latest.msg.date,
      attachment: latest.att.filename || '(no name)',
      size: latest.att.content?.length || 0
    }, 'Found CSV attachment');

    // Example: write to file system (uncomment if your runner needs an artifact)
    // import { writeFileSync } from 'node:fs';
    // writeFileSync('latest.csv', latest.att.content);

    // Success
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
