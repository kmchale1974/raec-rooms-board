// scripts/fetch_email.js
// ESM file – run by GitHub Actions job. Requires only "imapflow" in dependencies.
//
// ENV VARS (set in workflow):
//   IMAP_USER  - Gmail address (plain, not a secret is fine)
//   IMAP_PASS  - Gmail App Password (from repo Secrets)
//   OUT_CSV    - where to write the latest CSV, e.g. data/inbox/latest.csv
//
// Exit codes: non-zero if no CSV found or any fatal error.

import { ImapFlow } from 'imapflow';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const IMAP_HOST = 'imap.gmail.com';
const IMAP_PORT = 993;

function assertEnv(name, secret = false) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name} env var${secret ? ' (Gmail App Password)' : ''}.`);
    process.exit(1);
  }
  return v;
}

const IMAP_USER = assertEnv('IMAP_USER');
const IMAP_PASS = assertEnv('IMAP_PASS', true);
const OUT_CSV = assertEnv('OUT_CSV');

const SUBJECT = 'AC Daily Facility Report';
// Accepts names like: "AC - Daily Facility Global Schedule_ 8-00-31 AM_15812-990.csv"
const CSV_NAME_RE = /^AC\s*-\s*Daily\s*Facility\s*Global\s*Schedule_.*\.csv$/i;

// Search the last N days
const LOOKBACK_DAYS = 7;

function sinceDate(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  // Gmail IMAP wants day-Mon-YYYY (RFC 3501). But ImapFlow allows JS Date directly.
  return d;
}

async function ensureDirFor(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

function pickCsvPartFromBodyStructure(bodyStructure) {
  // bodyStructure can be an array (multipart) or a single part descriptor
  // We’ll flatten and scan for any text/* or application/* with a .csv filename.
  const parts = [];

  function walk(node, prefix = '') {
    if (!node) return;
    if (Array.isArray(node)) {
      // multipart: array of subparts + params at the end (object)
      for (let i = 0; i < node.length; i++) {
        const sub = node[i];
        // ImapFlow returns structured objects; but some servers give arrays.
        walk(sub, prefix ? `${prefix}.${i + 1}` : String(i + 1));
      }
    } else if (typeof node === 'object') {
      if (node.part || node.type) {
        // ImapFlow bodystructure object
        const partId = node.part || prefix || '1';
        const name =
          node.disposition?.params?.filename ||
          node.params?.name ||
          node.params?.filename ||
          '';
        const type = `${node.type || ''}/${node.subtype || ''}`.toLowerCase();
        parts.push({ partId, name, type, node });
      }

      // Some servers embed child nodes in .childNodes or .childParts
      if (node.childNodes) {
        node.childNodes.forEach((sub, idx) =>
          walk(sub, `${prefix}${prefix ? '.' : ''}${idx + 1}`)
        );
      }
      if (node.childParts) {
        node.childParts.forEach((sub, idx) =>
          walk(sub, `${prefix}${prefix ? '.' : ''}${idx + 1}`)
        );
      }

      // ImapFlow multipart lists can be in node.childNodes or node.childParts; but also in node[0..n] if server returns array structures
      if (Array.isArray(node)) {
        node.forEach((sub, idx) =>
          walk(sub, `${prefix}${prefix ? '.' : ''}${idx + 1}`)
        );
      }
    }
  }

  walk(bodyStructure);

  // Prefer filename match; allow text/plain or application/octet-stream
  const scored = parts
    .map((p) => {
      const hasCsvName = p.name && CSV_NAME_RE.test(p.name);
      const csvishType =
        p.type === 'text/plain' ||
        p.type === 'application/octet-stream' ||
        p.type === 'text/csv' ||
        p.type === 'application/csv';
      let score = 0;
      if (hasCsvName) score += 10;
      if (csvishType) score += 2;
      return { ...p, score };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0] || null;
}

async function searchForCandidate(client, mailbox) {
  // 1) Try exact subject within lookback window
  const since = sinceDate(LOOKBACK_DAYS);
  console.log(`Searching "${mailbox}" since ${since.toDateString()} for subject "${SUBJECT}"...`);
  let uids = await client.search(
    { since, header: [['subject', SUBJECT]] },
    { uid: true }
  );

  // If none, broaden to: any message since LOOKBACK_DAYS with CSV attachment filename pattern
  if (!uids?.length) {
    console.log('No subject matches; broadening to any message SINCE with CSV attachment name pattern…');

    // We have to fetch envelopes+bodystructure for a recent slice and test filenames.
    const allRecentUids = await client.search({ since }, { uid: true });
    if (!allRecentUids?.length) return null;

    // Fetch in descending UID order (newest first)
    const recent = allRecentUids.sort((a, b) => b - a).slice(0, 50);
    for await (const msg of client.fetch(recent, { envelope: true, bodyStructure: true, uid: true, internalDate: true })) {
      // Scan bodystructure for a csv-like filename
      const csvPart = pickCsvPartFromBodyStructure(msg.bodyStructure);
      if (csvPart) {
        return {
          uid: msg.uid,
          date: msg.internalDate,
          subject: msg.envelope?.subject || '(no subject)',
          csvPart
        };
      }
    }
    return null;
  }

  // If we found subject matches, pick the newest
  uids = uids.sort((a, b) => b - a);
  const newestUid = uids[0];
  const [msg] = await client.fetchOne(newestUid, { envelope: true, bodyStructure: true, uid: true, internalDate: true });
  // Ensure it actually has a CSV attachment that matches our pattern
  const csvPart = pickCsvPartFromBodyStructure(msg.bodyStructure);
  if (!csvPart) return null;
  return {
    uid: msg.uid,
    date: msg.internalDate,
    subject: msg.envelope?.subject || '(no subject)',
    csvPart
  };
}

async function downloadPartToFile(client, uid, partId, filename, destPath) {
  await ensureDirFor(destPath);
  console.log(`Downloading CSV part ${partId} (${filename})…`);
  const dl = await client.download(uid, partId);
  if (!dl || !dl.content) {
    throw new Error('Download stream missing');
  }
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(destPath);
    dl.content.pipe(w);
    dl.content.on('error', reject);
    w.on('finish', resolve);
    w.on('error', reject);
  });
  const stats = await fsp.stat(destPath);
  if (!stats.size) {
    throw new Error('Downloaded file is empty');
  }
}

async function findCsvAndDownload(client) {
  // Try INBOX, then [Gmail]/All Mail
  const mailboxes = ['INBOX', '[Gmail]/All Mail'];

  for (const box of mailboxes) {
    await client.mailboxOpen(box, { readOnly: true }).catch(() => {});
    try {
      const candidate = await searchForCandidate(client, box);
      if (candidate) {
        const { uid, date, subject, csvPart } = candidate;
        console.log(`Chosen message uid=${uid} | ${new Date(date).toString()} | ${subject}`);
        console.log(`CSV part: ${csvPart.name || '(no filename)'} (${csvPart.type})`);
        await downloadPartToFile(client, uid, csvPart.partId, csvPart.name || 'report.csv', OUT_CSV);
        return true;
      }
    } catch (err) {
      console.warn(`Search in "${box}" failed: ${err.message}`);
      // continue to next mailbox
    }
  }
  return false;
}

async function main() {
  console.log(`Connecting to Gmail as ${IMAP_USER}…`);
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false // keep Action logs cleaner; set to console for verbose
  });

  try {
    await client.connect();

    const ok = await findCsvAndDownload(client);
    if (!ok) {
      console.error('No suitable "AC Daily Facility Report" CSV found in INBOX or [Gmail]/All Mail.');
      process.exit(1);
    }

    console.log(`Saved CSV → ${OUT_CSV}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    try { await client.logout(); } catch {}
  }
}

main();
