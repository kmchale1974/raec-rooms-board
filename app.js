(async function(){
  const grid=document.getElementById('grid'), sub=document.getElementById('sub'), stamp=document.getElementById('stamp');
  const wrap=document.getElementById('grid-wrap'), nowline=document.getElementById('nowline');
  let windowStart=null, windowEnd=null, cols=0;

  async function load(){ const r=await fetch('events.json?ts='+Date.now()); const d=await r.json(); render(d); positionNowLine(); }
  function render(data){
    const rooms=data.rooms||[]; if(!rooms.length){ grid.textContent='No rooms found.'; return; }
    windowStart=new Date(data.windowStart); windowEnd=new Date(data.windowEnd);
    const slots=rooms[0].slots||[]; cols=slots.length; grid.style.setProperty('--cols', cols);
    grid.innerHTML='';

    const corner=document.createElement('div'); corner.className='cell header'; corner.textContent='Room'; grid.appendChild(corner);

    const N=Math.max(1, Math.floor(cols/14));
    slots.forEach((s,i)=>{ const th=document.createElement('div'); th.className='timehead';
      th.textContent=(i%N===0)? new Date(s.start).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}):''; grid.appendChild(th); });

    rooms.forEach(r=>{ const rn=document.createElement('div'); rn.className='roomname'; rn.textContent=r.room; grid.appendChild(rn);
      r.slots.forEach(s=>{ const cell=document.createElement('div'); cell.className='cell';
        const block=document.createElement('div'); block.className='slot '+(s.booked?'booked':'free');
        block.title=`${r.room} • ${new Date(s.start).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})}–${new Date(s.end).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})} • ${s.booked?'Booked':'Available'}`;
        cell.appendChild(block); grid.appendChild(cell); }); });

    sub.textContent=`${data.date} • ${data.slotMinutes}-min slots`;
    const d=new Date(data.generatedAt||Date.now()); stamp.textContent=`Updated ${d.toLocaleString()}`;
  }
  function positionNowLine(){
    if(!windowStart||!windowEnd){nowline.hidden=true;return;}
    const now=new Date(); const total=windowEnd-windowStart; const offset=now-windowStart;
    if(offset<0||offset>total){ nowline.hidden=true; return; }
    const sticky=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sticky'));
    const gridWidth=wrap.clientWidth - sticky;
    const left=sticky + Math.max(0, Math.min(1, offset/total))*gridWidth;
    nowline.style.left=`${left}px`; nowline.hidden=false;
  }
  await load();
  setInterval(load, 30*60*1000);
  setInterval(positionNowLine, 60*1000);
  window.addEventListener('resize', positionNowLine);
})();
