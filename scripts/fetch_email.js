/**
 * Fetch CSV attachments from Gmail (INBOX only) for messages matching:
 *   subject:"AC Daily Facility" has:attachment newer_than:30d
 *
 * Outputs CSVs to: out/attachments/
 * Exits with code 1 if nothing was extracted (to match your previous behavior).
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');
const path = require('path');

const imapUser = process.env.IMAP_USER || 'raecroominfo.board@gmail.com';
const imapPass = process.env.IMAP_PASS;

async function main() {
  if (!imapUser || !imapPass) {
    console.error(
      `Missing credentials:
  IMAP_USER: ${imapUser ? 'set' : 'missing'}
  IMAP_PASS: ${imapPass ? 'set' : 'missing'}`
    );
    process.exit(2);
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: imapUser, pass: imapPass },
    logger: false, // set to console for verbose
    // gzip/deflate compression is auto-negotiated by Gmail; ImapFlow handles it
  });

  const OUT_DIR = path.join(process.cwd(), 'out', 'attachments');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let saved = 0;

  try {
    console.log(`Connecting to Gmail as ${imapUser}…`);
    await client.connect();

    // --- INBOX only to avoid duplicate messages from [Gmail]/All Mail
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Prefer Gmail's X-GM-RAW search (fast & accurate)
      // ImapFlow supports a "gmailRaw" prop in the search query object.
      // Fallback to broader search if the server doesn't support it (very unlikely on Gmail).
      let messageUids = [];
      try {
        messageUids = await client.search({
          gmailRaw: 'subject:"AC Daily Facility" has:attachment newer_than:30d',
        });
        console.log(`[INBOX] gmailRaw matched ${messageUids.length} messages`);
      } catch (e) {
        console.warn('gmailRaw search failed, falling back to broader search…', e?.message || e);
        // Fallback: last 60 days and filter by subject locally
        const since = new Date();
        since.setDate(since.getDate() - 60);
        const fallbackUids = await client.search({ since });
        console.log(`[INBOX] fallback date search found ${fallbackUids.length} messages`);

        // Narrow down by checking subject headers quickly
        const chunks = client.fetch(fallbackUids, { envelope: true }, { uid: true });
        for await (const msg of chunks) {
          const subj = (msg.envelope?.subject || '').toLowerCase();
          if (subj.includes('ac daily facility')) {
            messageUids.push(msg.uid);
          }
        }
        console.log(`[INBOX] filtered to ${messageUids.length} messages by subject`);
      }

      // Process newest first
      messageUids.sort((a, b) => b - a);

      for (const uid of messageUids) {
        // Fetch the full RFC822 to parse attachments reliably
        const msgData = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
        if (!msgData?.source) continue;

        const parsed = await simpleParser(msgData.source);

        const subject = parsed.subject || '(no subject)';
        const dateStr = parsed.date ? parsed.date.toISOString() : '';
        console.log(`Examining UID ${uid} — "${subject}" — ${dateStr}`);

        if (!parsed.attachments || parsed.attachments.length === 0) {
          continue;
        }

        for (const att of parsed.attachments) {
          const isCSV =
            (att.contentType || '').toLowerCase().includes('csv') ||
            (att.filename || '').toLowerCase().endsWith('.csv');

          if (!isCSV) continue;

          // Build a safe filename
          const safeSubject = subject
            .replace(/[^\w\s.-]/g, '')
            .replace(/\s+/g, '_')
            .slice(0, 80);

          const base = att.filename
            ? att.filename.replace(/[^\w\s.-]/g, '_')
            : `${safeSubject || 'attachment'}.csv`;

          const outPath = path.join(OUT_DIR, base);
          fs.writeFileSync(outPath, att.content);
          saved++;
          console.log(`Saved CSV -> ${outPath}`);
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error('Failed to fetch/parse emails:', err);
    process.exit(1);
  } finally {
    try {
      await client.logout();
    } catch (_) {}
  }

  if (saved === 0) {
    console.error('No CSV attachment could be extracted from any candidate message.');
    process.exit(1);
  } else {
    console.log(`Done. Saved ${saved} CSV file(s) to ${OUT_DIR}`);
  }
}

main();
