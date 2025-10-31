// scripts/fetch_email.js (core idea)
import { ImapFlow } from 'imapflow';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const RAW_QUERY = 'subject:"AC Daily Facility" newer_than:60d (has:attachment OR filename:csv)';

function* walkParts(bs, basePath = '') {
  if (!bs) return;
  const parts = bs.childNodes || bs.parts || [];
  if (!parts.length) {
    // leaf
    yield { ...bs, path: bs.part || basePath || '1' };
  } else {
    for (const [i, p] of parts.entries()) {
      const next = p.part || `${basePath ? basePath + '.' : ''}${i + 1}`;
      yield* walkParts({ ...p, part: next });
    }
  }
}

function looksLikeCsvPart(p) {
  const ct = (p.type && p.subtype) ? `${p.type}/${p.subtype}`.toLowerCase() : '';
  const name = (p.dispositionParameters?.filename || p.parameters?.name || '').toLowerCase();
  const disp = (p.disposition || '').toLowerCase(); // may be 'inline'
  const isCsvCT = ct === 'text/csv' || ct === 'application/csv';
  const isPlainMaybeCsv = ct === 'text/plain' && name.endsWith('.csv');
  const isOctetMaybeCsv = ct === 'application/octet-stream' && name.endsWith('.csv');
  return isCsvCT || isPlainMaybeCsv || isOctetMaybeCsv || name.endsWith('.csv');
}

function looksLikeZip(p) {
  const ct = (p.type && p.subtype) ? `${p.type}/${p.subtype}`.toLowerCase() : '';
  const name = (p.dispositionParameters?.filename || p.parameters?.name || '').toLowerCase();
  return ct === 'application/zip' || name.endsWith('.zip');
}

async function saveStreamToFile(stream, outfile) {
  await fs.promises.mkdir(path.dirname(outfile), { recursive: true });
  const out = fs.createWriteStream(outfile);
  await new Promise((resolve, reject) => {
    stream.pipe(out).on('finish', resolve).on('error', reject);
  });
}

(async () => {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: 'raecroominfo.board@gmail.com',
      pass: process.env.RAEC_IMAP_PASS
    },
    logger: false
  });

  await client.connect();

  // Search INBOX then All Mail (newest first), stop at first good CSV
  const mailboxes = ['INBOX', '[Gmail]/All Mail'];
  let downloaded = 0;

  for (const mbox of mailboxes) {
    await client.mailboxOpen(mbox, { readOnly: true });

    // Use X-GM-RAW to leverage filename:csv etc.
    const uids = await client.search({ gmailRaw: RAW_QUERY });
    // newest first
    uids.sort((a, b) => b - a);

    for (const uid of uids) {
      // Fetch BODYSTRUCTURE and envelope only
      const msg = await client.fetchOne(uid, { envelope: true, bodyStructure: true });
      if (!msg?.bodyStructure) continue;

      // 1) try CSV parts directly
      const csvParts = [];
      for (const p of walkParts(msg.bodyStructure)) {
        if (looksLikeCsvPart(p)) csvParts.push(p);
      }

      for (const p of csvParts) {
        const filename = p.dispositionParameters?.filename || p.parameters?.name || `message-${uid}-${p.path}.csv`;
        const stream = await client.download(uid, p.part || p.path);
        await saveStreamToFile(stream, path.join('downloads', filename));
        console.log(`[OK] Saved CSV: ${filename} from UID ${uid} (${mbox})`);
        downloaded++;
      }
      if (downloaded) break;

      // 2) try ZIPs (optional): pull out CSV inside zip
      const zipParts = [];
      for (const p of walkParts(msg.bodyStructure)) {
        if (looksLikeZip(p)) zipParts.push(p);
      }
      for (const p of zipParts) {
        const zipName = p.dispositionParameters?.filename || p.parameters?.name || `message-${uid}-${p.path}.zip`;
        const tmpZip = path.join('downloads', zipName);
        const stream = await client.download(uid, p.part || p.path);
        await saveStreamToFile(stream, tmpZip);

        // Optional: unzip CSVs (needs a zip lib; placeholder here)
        // e.g., use 'adm-zip' or 'unzipper' to extract only *.csv to downloads/
        // const zip = new AdmZip(tmpZip);
        // zip.getEntries().filter(e => e.entryName.toLowerCase().endsWith('.csv'))
        //   .forEach(e => fs.writeFileSync(path.join('downloads', path.basename(e.entryName)), e.getData()));

        console.log(`[OK] Saved ZIP: ${zipName} from UID ${uid} (${mbox})`);
        // set downloaded++ if you extracted a CSV
      }

      if (downloaded) break;
    }
    if (downloaded) break;
  }

  await client.logout();

  if (downloaded === 0) {
    console.error('No CSV attachment could be extracted from any candidate message.');
    process.exit(1);
  } else {
    process.exit(0);
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
