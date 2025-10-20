// scripts/transform.mjs  (ESM)
// Reads CSV at data/inbox/latest.csv and writes events.json

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IN_CSV   = process.env.CSV_PATH || path.join(__dirname, '..', 'data', 'inbox', 'latest.csv');
const OUT_JSON = process.env.JSON_OUT || path.join(__dirname, '..', 'events.json');

function trim(s){ return (s ?? '').toString().trim(); }

// tiny CSV parser (quotes + commas)
function parseCSV(text){
  const rows=[]; let row=[]; let cur=''; let inQ=false;
  for (let i=0;i<text.length;i++){
    const ch=text[i];
    if(inQ){
      if(ch==='\"'){ if(text[i+1]==='\"'){cur+='\"'; i++;} else inQ=false; }
      else cur+=ch;
    }else{
      if(ch==='\"') inQ=true;
      else if(ch===','){ row.push(cur); cur=''; }
      else if(ch==='\n'){ row.push(cur); cur=''; rows.push(row); row=[]; }
      else if(ch==='\r'){/*ignore*/}
      else cur+=ch;
    }
  }
  if(cur.length||row.length){ row.push(cur); rows.push(row); }
  return rows;
}

function parseTimeRange(s){
  const m = trim(s).match(/(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
  if(!m) return null;
  return [toMin(m[1]), toMin(m[2])];
}
function toMin(t){
  const m = t.toLowerCase().match(/(\d{1,2}):(\d{2})\s*([ap]m)/);
  if(!m) return null;
  let h=+m[1], mm=+m[2]; const ap=m[3];
  if(ap==='pm'&&h!==12) h+=12;
  if(ap==='am'&&h===12) h=0;
  return h*60+mm;
}

// seasonal logic: turf ON from 2nd Monday in Nov → 3rd Monday in Mar
function nthWeekdayOfMonth(y, m, weekday, n){
  const d=new Date(y,m,1);
  const off=(7+weekday-d.getDay())%7;
  return new Date(y,m,1+off+(n-1)*7);
}
function isTurfSeason(d){
  const y=d.getFullYear();
  const secondMonNov=nthWeekdayOfMonth(y,10,1,2);      // Nov
  const thirdMonMar =nthWeekdayOfMonth(y+1,2,1,3);     // next Mar
  if(d>=secondMonNov) return true;
  if(d<thirdMonMar)   return true;
  return false;
}

// wording fixes
function normalizePickleball(reservee, purpose){
  const t=(reservee||'').toLowerCase();
  const p=(purpose||'').toLowerCase();
  if ((t.includes('raec front desk') || t.includes('on hold')) && p.includes('open pickleball')){
    return 'Open Pickleball';
  }
  return null;
}
function cleanName(s){
  if(!s) return '';
  const parts=s.split(',').map(x=>x.trim()).filter(Boolean);
  if(parts.length>=2 && parts[0].toLowerCase()===parts[1].toLowerCase()) return parts[0];
  return s;
}

// facility → courts mapping (UI rooms are "1".."10")
function mapFacilityToRooms(facility, turfSeason){
  const f=(facility||'').toLowerCase();

  // South gym
  if (f.includes('championship court')) return ['1','2']; // equals court 1 & 2
  if (f.includes('full gym 1ab & 2ab')) return ['1','2'];
  if (f.includes('ac gym - court 1-ab')) return ['1'];
  if (f.includes('ac gym - court 2-ab')) return ['2'];
  if (f.includes('ac gym - half court 1a') || f.includes('ac gym - half court 1b')) return ['1'];
  if (f.includes('ac gym - half court 2a') || f.includes('ac gym - half court 2b')) return ['2'];

  // North gym
  if (f.includes('full gym 9 & 10')) return ['9','10'];
  if (f.includes('ac gym - court 9-ab')) return ['9'];
  if (f.includes('ac gym - court 10-ab')) return ['10'];
  if (f.includes('ac gym - half court 9a') || f.includes('ac gym - half court 9b')) return ['9'];
  if (f.includes('ac gym - half court 10a') || f.includes('ac gym - half court 10b')) return ['10'];

  // Fieldhouse
  if (!turfSeason){
    // basketball floor down → ignore any turf descriptors
    if (f.includes('turf')) return [];
    if (f.includes('fieldhouse court 3-8')) return ['3','4','5','6','7','8'];
    const m=f.match(/fieldhouse\s*-\s*court\s*(\d+)/i);
    if(m){
      const n=+m[1];
      if(n>=3 && n<=8) return [String(n)];
    }
  } else {
    // turf season
    if (f.includes('fieldhouse - full turf')) return ['3','4','5','6','7','8'];
    if (f.includes('half turf north')) return ['6','7','8'];
    if (f.includes('half turf south')) return ['3','4','5'];
    if (f.includes('quarter turf')){
      if (f.includes('na')) return ['6'];
      if (f.includes('nb')) return ['7'];
      if (f.includes('sa')) return ['4'];
      if (f.includes('sb')) return ['5'];
      return [];
    }
    const m=f.match(/fieldhouse\s*-\s*court\s*(\d+)/i);
    if(m){
      const n=+m[1];
      if(n>=3 && n<=8) return [String(n)];
    }
  }
  return [];
}

function defaultRooms(){
  return [
    { id:'1',  label:'1',  group:'south' },
    { id:'2',  label:'2',  group:'south' },
    { id:'3',  label:'3',  group:'fieldhouse' },
    { id:'4',  label:'4',  group:'fieldhouse' },
    { id:'5',  label:'5',  group:'fieldhouse' },
    { id:'6',  label:'6',  group:'fieldhouse' },
    { id:'7',  label:'7',  group:'fieldhouse' },
    { id:'8',  label:'8',  group:'fieldhouse' },
    { id:'9',  label:'9',  group:'north' },
    { id:'10', label:'10', group:'north' }
  ];
}

async function writeOut(obj){
  await fs.writeFile(OUT_JSON, JSON.stringify(obj, null, 2), 'utf8');
}

async function main(){
  let csvRaw='';
  try{ csvRaw=await fs.readFile(IN_CSV,'utf8'); }
  catch{ await writeOut({dayStartMin:360,dayEndMin:1380,rooms:defaultRooms(),slots:[]}); return; }

  const rows=parseCSV(csvRaw);
  if(!rows.length){ await writeOut({dayStartMin:360,dayEndMin:1380,rooms:defaultRooms(),slots:[]}); return; }

  const header = rows[0].map(h=>trim(h).toLowerCase());
  const idx = {
    location: header.findIndex(h=>h.startsWith('location')),
    facility: header.findIndex(h=>h.startsWith('facility')),
    time:     header.findIndex(h=>h.startsWith('reserved time')),
    reservee: header.findIndex(h=>h.startsWith('reservee')),
    purpose:  header.findIndex(h=>h.startsWith('reservation purpose')),
  };

  const today = new Date();
  const turfSeason = isTurfSeason(today);

  const raw=[];
  for(let i=1;i<rows.length;i++){
    const r=rows[i]; if(!r||!r.length) continue;

    const loc = trim(r[idx.location] ?? '');
    if (loc && !/^athletic\s*&\s*event\s*center$/i.test(loc)) continue;

    const facility = trim(r[idx.facility] ?? '');
    const reservee = trim(r[idx.reservee] ?? '');
    const purpose  = trim(r[idx.purpose] ?? '');
    const timeStr  = trim(r[idx.time] ?? '');

    // drop admin “Fieldhouse Installed …” rows entirely
    if (purpose.toLowerCase().includes('fieldhouse installed')) continue;

    const tr = parseTimeRange(timeStr);
    if(!tr) continue;
    const [startMin, endMin] = tr;

    // map to rooms (respect season)
    const rooms = mapFacilityToRooms(facility, turfSeason);
    if(!rooms.length) continue;

    let title = cleanName(reservee);
    const pb = normalizePickleball(reservee, purpose);
    if (pb) title = pb;

    raw.push({ rooms, startMin, endMin, title, purpose, facility });
  }

  // Disambiguate fieldhouse 3–8 during court season
  let processed=[];
  if(!turfSeason){
    const keyOf = ev => `${ev.title}|${ev.startMin}|${ev.endMin}`;
    const explicitByKey=new Map(); // title+time -> Set(courts)
    const winMap=new Map();        // "start|end" -> Map(title -> Set(courts))

    for(const ev of raw){
      const exact = ev.rooms.length===1 && ['3','4','5','6','7','8'].includes(ev.rooms[0]);
      if(exact){
        const k=keyOf(ev);
        if(!explicitByKey.has(k)) explicitByKey.set(k,new Set());
        explicitByKey.get(k).add(ev.rooms[0]);
        const w=`${ev.startMin}|${ev.endMin}`;
        if(!winMap.has(w)) winMap.set(w,new Map());
        const m=winMap.get(w);
        if(!m.has(ev.title)) m.set(ev.title,new Set());
        m.get(ev.title).add(ev.rooms[0]);
      }
    }

    for(const ev of raw){
      const isRange = ev.rooms.length===6 && ev.rooms.every(x => ['3','4','5','6','7','8'].includes(x));
      if(!isRange){ processed.push(ev); continue; }

      const k=keyOf(ev);
      const exp=explicitByKey.get(k);
      if(exp && exp.size){ processed.push({...ev, rooms:[...exp].sort()}); continue; }

      const w=`${ev.startMin}|${ev.endMin}`;
      const m=winMap.get(w);
      if(m && m.size){
        const taken=new Set(); for(const set of m.values()) for(const c of set) taken.add(c);
        const remaining=['3','4','5','6','7','8'].filter(c=>!taken.has(c));
        const rangeCount = raw.filter(x => x.rooms.length===6 && x.startMin===ev.startMin && x.endMin===ev.endMin).length;
        if(rangeCount===1 && remaining.length){ processed.push({...ev, rooms:remaining}); continue; }
      }
      processed.push(ev);
    }
  } else {
    processed=raw;
  }

  // Expand per-room and dedupe
  const seen=new Set();
  const slots=[];
  for(const ev of processed){
    for(const room of ev.rooms){
      const key = `${room}|${ev.startMin}|${ev.endMin}|${ev.title}|${ev.purpose||''}`;
      if(seen.has(key)) continue;
      seen.add(key);
      slots.push({ roomId: room, startMin: ev.startMin, endMin: ev.endMin, title: ev.title, subtitle: ev.purpose || '' });
    }
  }
  slots.sort((a,b)=> (Number(a.roomId)-Number(b.roomId)) || (a.startMin-b.startMin));

  const out = { dayStartMin:360, dayEndMin:1380, rooms:defaultRooms(), slots };
  await writeOut(out);
  console.log(`Wrote events.json • rooms=${out.rooms.length} • slots=${out.slots.length}`);
}

main().catch(e=>{ console.error('transform failed:', e); process.exit(1); });
