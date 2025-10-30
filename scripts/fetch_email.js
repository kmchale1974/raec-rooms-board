import fs from 'fs';
import path from 'path';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const host   = process.env.IMAP_HOST || 'imap.gmail.com';
const user   = process.env.IMAP_USER || 'raecroominfo.board@gmail.com'; // baked-in
const pass   = process.env.IMAP_PASS; // GitHub Secret
const folder = process.env.IMAP_FOLDER || 'INBOX'; // force INBOX
const outCsv = process.env.OUT_CSV || 'data/inbox/latest.csv';

if (!pass) {
  console.error('Missing IMAP_PASS env var (Gmail App Password).');
  process.exit(1);
}

fs.mkdirSync(path.dirname(outCsv), { recursive: true });

const client = new ImapFlow({ host, secure: true, auth: { user, pass } });

(async () => {
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder);
    try {
      // list basic metadata so we can pick the truly latest by INTERNALDATE
      const metas = [];
      for await (const msg of client.fetch({ seq: '1:*' }, { uid:true, envelope:true, internalDate:true })) {
        metas.push({
          uid: msg.uid,
          when: msg.internalDate,
          subj: msg.envelope?.subject || '(no subject)',
          from: msg.envelope?.from?.map(a=>a.address).join(',') || ''
        });
      }
      if (!metas.length) {
        console.log('No emails in folder:', folder);
        process.exit(0);
      }
      metas.sort((a,b)=> b.when - a.when);
      const newest = metas[0];
      console.log('Newest email →', newest.when.toISOString(), '|', newest.subj, '| uid', newest.uid);

      // fetch BODYSTRUCTURE first so we can locate attachments without downloading whole message
      const bsIt = client.fetch({ uid: newest.uid }, { uid:true, bodyStructure:true }, { uid:true });
      const first = (await bsIt.next()).value;
      if (!first?.bodyStructure) {
        console.log('No BODYSTRUCTURE on newest message.');
        process.exit(0);
      }

      // flatten structure to parts
      function flatten(struct, path='') {
        if (!struct) return [];
        if (Array.isArray(struct)) {
          return struct.flatMap((s, i)=> flatten(s, path ? `${path}.${i+1}` : `${i+1}`));
        }
        const me = [{ struct, path }];
        if (Array.isArray(struct.childNodes)) {
          return me.concat(flatten(struct.childNodes, path));
        }
        return me;
      }

      const parts = flatten(first.bodyStructure);
      // prefer .csv attachments
      const csvPart = parts.find(p => {
        const s = p.struct;
        const name = (s.parameters?.name || s.dispositionParameters?.filename || '').toLowerCase();
        const ct = `${(s.type||'')}/${(s.subtype||'')}`.toLowerCase();
        return name.endsWith('.csv') || ct.includes('csv');
      });

      if (!csvPart) {
        console.log('No CSV attachment found on newest email.');
        process.exit(0);
      }

      const nameGuess = csvPart.struct.parameters?.name || csvPart.struct.dispositionParameters?.filename || 'attachment.csv';
      console.log(`Downloading CSV part ${csvPart.path} (${nameGuess})…`);

      const dl = await client.download(newest.uid, csvPart.path, { uid:true });
      const bufs = [];
      for await (const ch of dl.content) bufs.push(ch);
      const rawPart = Buffer.concat(bufs);

      // If it’s base64 in a message/rfc822 part, we’ll let mailparser normalize
      // but usually ImapFlow gives decoded content already. Try parse; if fail, just write.
      try {
        const parsed = await simpleParser(rawPart);
        // find first csv attachment in parsed
        const att = (parsed.attachments || []).find(a => (a.filename||'').toLowerCase().endsWith('.csv'));
        if (att?.content) {
          fs.writeFileSync(outCsv, att.content);
        } else {
          // fallback: write the rawPart as-is
          fs.writeFileSync(outCsv, rawPart);
        }
      } catch {
        fs.writeFileSync(outCsv, rawPart);
      }

      console.log('Saved CSV to', outCsv, '(', nameGuess, ')');
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    console.error('fetch_email failed:', e.message || e);
    process.exit(1);
  }
})();
