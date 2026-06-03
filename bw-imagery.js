// SATELLITE IMAGERY GALLERY (in-app) — granular per-sensor SST scans
// Opens via the 🛰 toolbar button; selecting a scan overlays it on the live map.
// Self-contained palette; uses globals: map, L
// ═══════════════════════════════════════════
(function(){
  function getMap(){
    try{ if(window.map && window.map.addLayer) return window.map; }catch(e){}
    try{ if(typeof map!=='undefined' && map && map.addLayer){ window.map=map; return map; } }catch(e){}
    return null;
  }
  // Full-resolution box from the CURRENT map view (auto-coarsens only when zoomed far out)
  function viewBoxStride(m){
    const b=m.getBounds();
    const minLat=Math.max(-89,b.getSouth()), maxLat=Math.min(89,b.getNorth());
    const minLon=Math.max(-179,b.getWest()),  maxLon=Math.min(179,b.getEast());
    const cols=Math.abs(maxLon-minLon)/0.02;
    let stride=Math.max(1,Math.ceil(cols/420)); if(stride>16) stride=16; // 1 = native ~2km
    return {minLat:+minLat.toFixed(3),maxLat:+maxLat.toFixed(3),minLon:+minLon.toFixed(3),maxLon:+maxLon.toFixed(3),stride};
  }
  const FN='/.netlify/functions/sat-pass';
  const REGIONS={
    full:{name:'Full East Coast',S:24,N:45,W:-82,E:-65},
    se:{name:'Southeast (FL→NC)',S:27,N:36,W:-82,E:-72},
    car:{name:'Carolinas + Gulf Stream',S:31,N:37,W:-79,E:-71},
    mid:{name:'Mid-Atlantic',S:35,N:41,W:-77,E:-69},
    ne:{name:'Northeast',S:39,N:45,W:-74,E:-65}
  };
  let product='sst', regionKey='full', spanHours=96, sensorFilter='all';
  const tileCache={}, baseCache={}, cards={};
  let passes=[], galleryOverlay=null, selectedGranule=null;

  const SST_STOPS=[[50,[0,26,160]],[58,[0,80,220]],[64,[0,180,200]],[70,[0,220,80]],[76,[200,230,0]],[82,[255,160,0]],[88,[255,20,20]]];
  function sstColorF(f){
    if(f<=SST_STOPS[0][0])return SST_STOPS[0][1];
    for(let i=0;i<SST_STOPS.length-1;i++){const a=SST_STOPS[i],b=SST_STOPS[i+1];
      if(f<=b[0]){const t=(f-a[0])/(b[0]-a[0]);return [0,1,2].map(j=>Math.round(a[1][j]+(b[1][j]-a[1][j])*t));}}
    return SST_STOPS[SST_STOPS.length-1][1];
  }
  const cToF=c=>c*9/5+32;
  function dataCanvas(grid,nLat,nLon){
    const cv=document.createElement('canvas');cv.width=nLon;cv.height=nLat;
    const ctx=cv.getContext('2d');const id=ctx.createImageData(nLon,nLat);const d=id.data;
    for(let k=0;k<grid.length;k++){const c=grid[k];const o=k*4;
      if(c==null){d[o+3]=0;continue;}const col=sstColorF(cToF(c));d[o]=col[0];d[o+1]=col[1];d[o+2]=col[2];d[o+3]=255;}
    ctx.putImageData(id,0,0);return cv;
  }
  function thumb(tile,baseImg){
    const W=baseImg?baseImg.naturalWidth:tile.nLon,H=baseImg?baseImg.naturalHeight:tile.nLat;
    const cv=document.createElement('canvas');cv.width=W;cv.height=H;const ctx=cv.getContext('2d');
    if(baseImg){try{ctx.drawImage(baseImg,0,0,W,H);}catch(e){ctx.fillStyle='#0a1622';ctx.fillRect(0,0,W,H);}}
    else{ctx.fillStyle='#0a1622';ctx.fillRect(0,0,W,H);}
    ctx.globalAlpha=.9;ctx.imageSmoothingEnabled=true;ctx.drawImage(dataCanvas(tile.grid,tile.nLat,tile.nLon),0,0,W,H);ctx.globalAlpha=1;
    return cv;
  }
  function rb(){return REGIONS[regionKey];}
  function boxQuery(){const r=rb();return {minLat:r.S,maxLat:r.N,minLon:r.W,maxLon:r.E};}
  function strideFor(t){const r=rb();const cols=Math.abs(r.E-r.W)/0.02;let s=Math.max(1,Math.ceil(cols/(t||120)));return s>16?16:s;}
  const qs=o=>Object.keys(o).map(k=>k+'='+encodeURIComponent(o[k])).join('&');
  function fmtTime(iso){return new Date(iso).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}
  function isDay(iso,lon){const d=new Date(iso);const s=d.getUTCHours()+d.getUTCMinutes()/60+lon/15;let h=((s%24)+24)%24;return h>=6&&h<18;}
  function esriUrl(){const r=rb();const H=300,W=Math.max(80,Math.round(H*(r.E-r.W)/(r.N-r.S)));
    return `https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/export?bbox=${r.W},${r.S},${r.E},${r.N}&bboxSR=4326&imageSR=4326&size=${W},${H}&format=png24&transparent=false&f=image`;}
  function loadBase(){
    if(baseCache[regionKey]!==undefined)return Promise.resolve(baseCache[regionKey]);
    return new Promise(res=>{const img=new Image();img.onload=()=>{baseCache[regionKey]=img;res(img);};img.onerror=()=>{baseCache[regionKey]=null;res(null);};img.src=esriUrl();});
  }

  let modal,gridEl,statusEl,ctrl;
  function buildUI(){
    const style=document.createElement('style');
    style.textContent=`
      #bwg-modal{position:fixed;inset:16px;z-index:3000;background:rgba(6,18,32,.985);backdrop-filter:blur(8px);
        border:1px solid rgba(22,214,195,.3);border-radius:14px;display:none;flex-direction:column;color:#e6f2f5;
        font-family:system-ui,sans-serif;box-shadow:0 18px 60px rgba(0,0,0,.6);overflow:hidden}
      #bwg-modal.open{display:flex}
      .bwg-top{display:flex;align-items:center;gap:13px;padding:12px 16px;border-bottom:1px solid rgba(22,214,195,.22);flex-wrap:wrap}
      .bwg-top h2{margin:0;font:800 15px system-ui;color:#16d6c3}
      .bwg-lab{font:700 10px system-ui;color:#7fa6af;letter-spacing:.4px}
      .bwg-seg{display:flex;gap:5px}
      .bwg-pill{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);color:#bcd;border-radius:999px;padding:6px 12px;font:700 12px system-ui;cursor:pointer}
      .bwg-pill:hover{border-color:rgba(22,214,195,.55);color:#dff}
      .bwg-pill.active{background:#16d6c3;border-color:#16d6c3;color:#03222b}
      #bwg-modal select{background:#0a2030;color:#dff;border:1px solid rgba(22,214,195,.3);border-radius:8px;padding:6px 9px;font:600 12px system-ui}
      .bwg-x{margin-left:auto;background:transparent;border:1px solid rgba(255,255,255,.25);color:#cfe;border-radius:8px;width:34px;height:34px;font-size:16px;cursor:pointer}
      .bwg-x:hover{border-color:#ff8;color:#ff8}
      .bwg-sub{display:flex;align-items:center;gap:10px;padding:8px 16px;border-bottom:1px solid rgba(255,255,255,.07);font:500 12px system-ui;color:#9fc7cf;flex-wrap:wrap}
      .bwg-sub button{background:transparent;border:1px solid rgba(255,255,255,.22);color:#cfe;border-radius:7px;padding:5px 10px;font:600 11px system-ui;cursor:pointer}
      .bwg-sub button:hover{border-color:#16d6c3;color:#16d6c3}
      #bwg-legend{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:11px;color:#9fc7cf}
      #bwg-legend .ramp{width:120px;height:9px;border-radius:5px;background:linear-gradient(90deg,#001aa0,#0050dc,#00b4c8,#00dc50,#c8e600,#ffa000,#ff1414)}
      #bwg-grid{flex:1;overflow-y:auto;padding:15px;display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));align-content:start}
      .bwg-card{border:1px solid rgba(255,255,255,.1);border-radius:11px;overflow:hidden;cursor:pointer;background:rgba(255,255,255,.025);transition:border-color .15s,transform .12s}
      .bwg-card:hover{border-color:rgba(22,214,195,.6);transform:translateY(-2px)}
      .bwg-card.sel{border-color:#16d6c3;box-shadow:0 0 0 1px #16d6c3 inset}
      .bwg-tw{position:relative;width:100%;background:#0a1622;display:flex;align-items:center;justify-content:center;min-height:130px}
      .bwg-tw canvas{width:100%;height:auto;display:block}
      .bwg-spin{position:absolute;font:600 11px system-ui;color:#5cc}
      .bwg-badge{position:absolute;top:7px;left:7px;font:800 9px system-ui;padding:3px 6px;border-radius:5px;letter-spacing:.5px;z-index:2}
      .bwg-badge.N20{background:#16d6c3;color:#03222b}.bwg-badge.NPP{background:#5b8def;color:#06122a}.bwg-badge.N21{background:#c98bff;color:#1c0830}
      .bwg-dn{position:absolute;top:6px;right:8px;font-size:13px;filter:drop-shadow(0 1px 2px #000);z-index:2}
      .bwg-clar{position:absolute;bottom:0;left:0;right:0;height:4px;background:rgba(0,0,0,.45);z-index:2}
      .bwg-clar>i{display:block;height:100%;background:linear-gradient(90deg,#16d6c3,#9CFFC0)}
      .bwg-info{padding:8px 10px;display:flex;flex-direction:column;gap:2px}
      .bwg-info .t{font:700 12px system-ui}
      .bwg-info .m{font:500 11px system-ui;color:#8fb6bf;display:flex;justify-content:space-between}
      .bwg-empty{grid-column:1/-1;text-align:center;padding:60px 24px;color:#7f9aa3}
      .bwg-empty h3{color:#bcd;font-size:15px;margin:0 0 8px}.bwg-empty p{max-width:500px;margin:0 auto;line-height:1.5;font-size:13px}
      .bwg-tag{display:inline-block;font:700 11px system-ui;color:#16d6c3;border:1px solid rgba(22,214,195,.4);padding:4px 10px;border-radius:999px;margin-bottom:10px}
      /* floating control for the loaded scan */
      #bwg-scanctrl{position:absolute;left:50%;transform:translateX(-50%);bottom:14px;z-index:760;display:none;align-items:center;gap:10px;
        background:rgba(8,22,40,.94);border:1px solid rgba(22,214,195,.4);border-radius:10px;padding:7px 12px;color:#dff;font:600 11px system-ui;box-shadow:0 4px 16px rgba(0,0,0,.4)}
      #bwg-scanctrl.show{display:flex}
      #bwg-scanctrl input[type=range]{width:90px}
      #bwg-scanctrl button{background:transparent;border:1px solid rgba(255,120,120,.5);color:#ffb3b3;border-radius:6px;padding:3px 8px;cursor:pointer;font:600 11px system-ui}
    `;
    document.head.appendChild(style);

    modal=document.createElement('div');modal.id='bwg-modal';
    modal.innerHTML=
      '<div class="bwg-top"><h2>🛰 Satellite Imagery</h2>'+
        '<span class="bwg-lab">PRODUCT</span><div class="bwg-seg">'+
          '<button class="bwg-pill active" data-prod="sst">SST</button>'+
          '<button class="bwg-pill" data-prod="chl">Chlorophyll</button></div>'+
        '<span class="bwg-lab">REGION</span><select id="bwg-region">'+
          Object.keys(REGIONS).map(k=>`<option value="${k}">${REGIONS[k].name}</option>`).join('')+'</select>'+
        '<span class="bwg-lab">TIME</span><select id="bwg-span"><option value="48">48 h</option><option value="96" selected>96 h</option><option value="168">7 days</option></select>'+
        '<div class="bwg-seg" id="bwg-sensors">'+
          '<button class="bwg-pill active" data-sen="all">All</button>'+
          '<button class="bwg-pill" data-sen="N20">N20</button>'+
          '<button class="bwg-pill" data-sen="NPP">NPP</button>'+
          '<button class="bwg-pill" data-sen="N21">N21</button></div>'+
        '<button class="bwg-x" id="bwg-close">✕</button></div>'+
      '<div class="bwg-sub"><button id="bwg-refresh">↻ Refresh</button>'+
        '<span id="bwg-status">—</span>'+
        '<span id="bwg-legend"><span>cool</span><span class="ramp"></span><span>warm</span></span></div>'+
      '<div id="bwg-grid"></div>';
    document.body.appendChild(modal);

    ctrl=document.createElement('div');ctrl.id='bwg-scanctrl';
    ctrl.innerHTML='<span id="bwg-scanlabel"></span><span>opacity</span><input type="range" min="0.2" max="1" step="0.05" value="0.85" id="bwg-op"><button id="bwg-scanclear">✕ Clear scan</button>';
    document.body.appendChild(ctrl);

    gridEl=modal.querySelector('#bwg-grid');statusEl=modal.querySelector('#bwg-status');
    modal.querySelector('#bwg-close').onclick=()=>modal.classList.remove('open');
    modal.querySelector('#bwg-refresh').onclick=()=>load();
    modal.querySelector('#bwg-region').onchange=e=>{regionKey=e.target.value;load();};
    modal.querySelector('#bwg-span').onchange=e=>{spanHours=parseInt(e.target.value,10)||96;load();};
    modal.querySelectorAll('[data-prod]').forEach(b=>b.onclick=()=>{modal.querySelectorAll('[data-prod]').forEach(x=>x.classList.remove('active'));b.classList.add('active');product=b.dataset.prod;load();});
    modal.querySelectorAll('[data-sen]').forEach(b=>b.onclick=()=>{modal.querySelectorAll('[data-sen]').forEach(x=>x.classList.remove('active'));b.classList.add('active');sensorFilter=b.dataset.sen;renderCards();kickThumbs();});
    ctrl.querySelector('#bwg-op').oninput=e=>{ if(galleryOverlay) galleryOverlay.setOpacity(parseFloat(e.target.value)); };
    ctrl.querySelector('#bwg-scanclear').onclick=clearScan;
  }

  function load(){
    if(product!=='sst'){
      document.getElementById('bwg-legend').style.display='none';
      statusEl.textContent='Chlorophyll — next';
      gridEl.innerHTML='<div class="bwg-empty"><span class="bwg-tag">CHLOROPHYLL · per-sensor scans</span><h3>Chlorophyll passes — wiring next</h3><p>Granular per-sensor chlorophyll (NOAA-20, SNPP) comes from NASA OB.DAAC on the same OPeNDAP backend as SST. Wiring + verifying that next, like we did for SST. Flip back to SST to browse scans now.</p></div>';
      return;
    }
    document.getElementById('bwg-legend').style.display='flex';
    statusEl.textContent='Finding passes…';
    gridEl.innerHTML='<div class="bwg-empty"><h3>Loading passes…</h3><p>NOAA-20 &amp; NPP overpasses over '+rb().name+', last '+spanHours+' h.</p></div>';
    loadBase();
    const url=`${FN}?mode=list&hours=${spanHours}&${qs(boxQuery())}&cb=${Date.now()}`;
    fetch(url).then(r=>r.json()).then(j=>{
      if(j.error){statusEl.textContent='Error: '+(j.note||j.error);gridEl.innerHTML='<div class="bwg-empty"><h3>Backend error</h3><p>'+(j.note||j.error)+'</p></div>';return;}
      passes=j.passes||[];const c=j.counts||{};
      statusEl.textContent=`${passes.length} passes · N20 ${c.N20||0} · NPP ${c.NPP||0} · N21 ${c.N21||0} · ${rb().name}`;
      renderCards();kickThumbs();
    }).catch(()=>{statusEl.textContent='Failed to load';gridEl.innerHTML='<div class="bwg-empty"><h3>Network error</h3><p>Could not reach the satellite backend.</p></div>';});
  }

  const vis=()=>passes.filter(p=>sensorFilter==='all'||p.sensor===sensorFilter);
  function renderCards(){
    const list=vis();
    if(!list.length){gridEl.innerHTML='<div class="bwg-empty"><h3>No passes</h3><p>No '+(sensorFilter==='all'?'':sensorFilter+' ')+'SST overpasses over '+rb().name+' in the last '+spanHours+' h.</p></div>';return;}
    gridEl.innerHTML='';
    const r=rb();const lonC=(r.W+r.E)/2;const aspect=(r.E-r.W)/(r.N-r.S);
    for(const p of list){
      const card=document.createElement('div');card.className='bwg-card'+(p.granule===selectedGranule?' sel':'');
      const day=isDay(p.time_start,lonC);
      card.innerHTML='<div class="bwg-tw" style="aspect-ratio:'+aspect.toFixed(3)+'"><span class="bwg-spin">loading…</span>'+
        '<span class="bwg-badge '+p.sensor+'">'+p.sensor+'</span><span class="bwg-dn">'+(day?'☀️':'🌙')+'</span>'+
        '<span class="bwg-clar"><i style="width:0%"></i></span></div>'+
        '<div class="bwg-info"><span class="t">'+fmtTime(p.time_start)+'</span><span class="m"><span>'+p.sensor+' VIIRS SST</span><span class="temp">—</span></span></div>';
      card.onclick=()=>selectPass(p);
      gridEl.appendChild(card);
      cards[p.granule]={root:card,wrap:card.querySelector('.bwg-tw'),bar:card.querySelector('.bwg-clar>i'),temp:card.querySelector('.temp'),spin:card.querySelector('.bwg-spin')};
      if(tileCache[p.granule])applyTile(p,tileCache[p.granule]);
    }
  }
  function applyTile(p,tile){
    const el=cards[p.granule];if(!el||!tile||!tile.grid)return;
    const cv=thumb(tile,baseCache[regionKey]||null);
    if(el.spin)el.spin.remove();const old=el.wrap.querySelector('canvas');if(old)old.remove();
    el.wrap.insertBefore(cv,el.wrap.firstChild);
    el.bar.style.width=(tile.clarity_pct||0)+'%';
    if(tile.sst&&el.temp)el.temp.textContent=Math.round(cToF(tile.sst.min_c))+'–'+Math.round(cToF(tile.sst.max_c))+'°F';
  }
  async function kickThumbs(){
    await loadBase();
    vis().forEach(p=>{if(tileCache[p.granule])applyTile(p,tileCache[p.granule]);});
    const list=vis().filter(p=>!tileCache[p.granule]);let i=0;const N=4;
    async function worker(){while(i<list.length){const p=list[i++];
      try{const url=`${FN}?mode=tile&stride=${strideFor(120)}&g=${encodeURIComponent(p.opendap)}&${qs(boxQuery())}`;
        const r=await fetch(url);const j=await r.json();
        if(!j.error&&j.grid){tileCache[p.granule]=j;applyTile(p,j);}else{const el=cards[p.granule];if(el&&el.spin)el.spin.textContent='no data';}
      }catch(e){const el=cards[p.granule];if(el&&el.spin)el.spin.textContent='err';}}}
    await Promise.all(Array.from({length:N},()=>worker()));
  }

  // Selecting a scan overlays it on the LIVE map (data-only -> not tainted -> toDataURL OK)
  async function selectPass(p){
    selectedGranule=p.granule;
    Object.values(cards).forEach(e=>e.root.classList.remove('sel'));
    if(cards[p.granule])cards[p.granule].root.classList.add('sel');
    const m=getMap();
    if(!m){ statusEl.textContent='Map not ready — open the map first, then pick a scan'; return; }
    const vb=viewBoxStride(m); // FULL-RES over the current map view
    statusEl.textContent='Loading '+p.sensor+' '+fmtTime(p.time_start)+' at full resolution…';
    try{
      const url=`${FN}?mode=tile&stride=${vb.stride}&g=${encodeURIComponent(p.opendap)}&${qs({minLat:vb.minLat,maxLat:vb.maxLat,minLon:vb.minLon,maxLon:vb.maxLon})}`;
      const r=await fetch(url);const j=await r.json();
      if(j.error||!j.grid){statusEl.textContent='No data for that pass in this view — pan to where the scan has coverage';return;}
      const dataUrl=dataCanvas(j.grid,j.nLat,j.nLon).toDataURL('image/png');
      const b=j.bounds;const bounds=[[b.south,b.west],[b.north,b.east]];
      const op=parseFloat((document.getElementById('bwg-op')||{}).value||0.85);
      if(galleryOverlay){galleryOverlay.setUrl(dataUrl);galleryOverlay.setBounds(bounds);galleryOverlay.setOpacity(op);}
      else { galleryOverlay=L.imageOverlay(dataUrl,bounds,{opacity:op,pane:'satPane',interactive:false}).addTo(m); }
      // keep the user's current view (do NOT fitBounds) so it loads sharp where they're looking
      const tp=j.sst?(' · '+Math.round(cToF(j.sst.min_c))+'–'+Math.round(cToF(j.sst.max_c))+'°F'):'';
      const resTxt=vb.stride===1?' · full res':' · '+(vb.stride*2)+'km';
      document.getElementById('bwg-scanlabel').textContent=p.sensor+' SST · '+fmtTime(p.time_start)+(j.clarity_pct!=null?' · '+j.clarity_pct+'% clr':'')+tp+resTxt;
      ctrl.classList.add('show');
      modal.classList.remove('open'); // reveal the live map with the sharp scan on it
    }catch(e){statusEl.textContent='Failed to load pass';}
  }
  function clearScan(){
    const m=getMap();
    if(galleryOverlay&&m)m.removeLayer(galleryOverlay);
    galleryOverlay=null;selectedGranule=null;ctrl.classList.remove('show');
    Object.values(cards).forEach(e=>e.root.classList.remove('sel'));
  }

  let _built=false;
  function ensureBuilt(){ if(_built) return; buildUI(); _built=true; }
  // Register the opener SYNCHRONOUSLY so the 🛰 button always finds it (no DOMContentLoaded race)
  window.__bwOpenImagery=function(){ ensureBuilt(); modal.classList.add('open'); load(); };
  try{ console.log('%c[imagery] in-app gallery READY (build g8 · view-res)','color:#16d6c3'); }catch(e){}
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', ensureBuilt); else ensureBuilt();
})();
