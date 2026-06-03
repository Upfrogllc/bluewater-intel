// bw-chl.js — NASA GIBS chlorophyll map layer (PACE OCI / VIIRS SNPP)
// Pre-rendered Web-Mercator tiles, drop-in for Leaflet. No token needed.
// Self-contained: registers window.__bwChl and injects a small control.
// Uses globals: map, L
// ═══════════════════════════════════════════
(function(){
  function getMap(){
    try{ if(window.map && window.map.addLayer) return window.map; }catch(e){}
    try{ if(typeof map!=='undefined' && map && map.addLayer){ window.map=map; return map; } }catch(e){}
    return null;
  }

  // GIBS layers confirmed available (GoogleMapsCompatible, max native zoom 7).
  const SOURCES = {
    pace: { id:'OCI_PACE_Chlorophyll_a',      matrix:'GoogleMapsCompatible_Level7', maxNZ:7, label:'PACE OCI' },
    snpp: { id:'VIIRS_SNPP_L2_Chlorophyll_A', matrix:'GoogleMapsCompatible_Level7', maxNZ:7, label:'VIIRS SNPP' },
  };
  function yesterdayUTC(){ const d=new Date(Date.now()-24*3600*1000); return d.toISOString().slice(0,10); }

  let srcKey='pace', dateStr=yesterdayUTC(), opacity=0.8, layer=null, on=false, ctrl=null, paneReady=false;

  function ensurePane(m){
    if(paneReady) return;
    if(!m.getPane('bwChlPane')){ m.createPane('bwChlPane'); m.getPane('bwChlPane').style.zIndex=410; }
    paneReady=true;
  }
  function tileUrl(s){
    return `https://gibs-{s}.earthdata.nasa.gov/wmts/epsg3857/best/${s.id}/default/${dateStr}/${s.matrix}/{z}/{y}/{x}.png`;
  }
  function rebuild(){
    const m=getMap(); if(!m) return;
    ensurePane(m);
    if(layer){ m.removeLayer(layer); layer=null; }
    if(!on) return;
    const s=SOURCES[srcKey];
    layer=L.tileLayer(tileUrl(s), {
      subdomains:['a','b','c'], tileSize:256, maxNativeZoom:s.maxNZ, maxZoom:18,
      opacity:opacity, pane:'bwChlPane', bounds:[[-85,-180],[85,180]],
      attribution:'Chlorophyll: NASA GIBS', errorTileUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    }).addTo(m);
  }

  function buildCtrl(){
    if(ctrl || typeof document==='undefined') return;
    ctrl=document.createElement('div'); ctrl.id='bw-chl-ctrl';
    ctrl.innerHTML=`
      <style>
        #bw-chl-ctrl{position:absolute;left:12px;top:84px;z-index:620;width:210px;
          background:rgba(8,18,28,.86);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
          border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:10px 11px;color:#eaf2f5;
          font-family:'Inter',system-ui,sans-serif;box-shadow:0 6px 22px rgba(0,0,0,.4);user-select:none}
        #bw-chl-ctrl .t{font-size:11px;letter-spacing:.4px;text-transform:uppercase;color:#5dffaa;font-weight:700;
          display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
        #bw-chl-ctrl .sw{position:relative;width:34px;height:18px;border-radius:10px;background:#33495a;cursor:pointer;transition:background .15s}
        #bw-chl-ctrl .sw.on{background:#16a06f}
        #bw-chl-ctrl .sw i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .15s}
        #bw-chl-ctrl .sw.on i{left:18px}
        #bw-chl-ctrl .row{display:flex;align-items:center;gap:7px;margin-top:8px;font-size:10px;color:#cfe0e6}
        #bw-chl-ctrl .row b{width:42px;color:#9fb3bd;font-weight:600}
        #bw-chl-ctrl select,#bw-chl-ctrl input[type=date]{flex:1;background:#0a2030;color:#dff;border:1px solid rgba(255,255,255,.18);
          border-radius:6px;padding:4px 6px;font:600 11px system-ui}
        #bw-chl-ctrl input[type=range]{flex:1;height:3px;accent-color:#5dffaa;cursor:pointer}
        #bw-chl-ctrl .hint{font-size:9px;color:#7f97a2;margin-top:7px;line-height:1.35}
      </style>
      <div class="t"><span>Chlorophyll · GIBS</span><div class="sw" id="bw-chl-sw"><i></i></div></div>
      <div class="row"><b>source</b><select id="bw-chl-src">
        <option value="pace">PACE OCI</option><option value="snpp">VIIRS SNPP</option></select></div>
      <div class="row"><b>date</b><input type="date" id="bw-chl-date" value="${dateStr}" max="${dateStr}"></div>
      <div class="row"><b>opacity</b><input type="range" id="bw-chl-op" min="0.2" max="1" step="0.05" value="${opacity}"></div>
      <div class="hint">Green = high chlorophyll (bait). Edges between green and blue are the breaks. Clouds show as gaps.</div>
    `;
    const host=document.getElementById('mapwrap')||document.body;
    try{ if(getComputedStyle(host).position==='static') host.style.position='relative'; }catch(e){}
    host.appendChild(ctrl);

    const sw=ctrl.querySelector('#bw-chl-sw');
    sw.onclick=()=>{ on=!on; sw.classList.toggle('on',on); rebuild(); };
    ctrl.querySelector('#bw-chl-src').onchange=e=>{ srcKey=e.target.value; rebuild(); };
    ctrl.querySelector('#bw-chl-date').onchange=e=>{ dateStr=e.target.value||dateStr; rebuild(); };
    ctrl.querySelector('#bw-chl-op').oninput=e=>{ opacity=parseFloat(e.target.value); if(layer) layer.setOpacity(opacity); };
  }

  // Public API (for future eddy-finder wiring)
  window.__bwChl = {
    show(){ on=true; if(ctrl){ctrl.querySelector('#bw-chl-sw').classList.add('on');} rebuild(); },
    hide(){ on=false; if(ctrl){ctrl.querySelector('#bw-chl-sw').classList.remove('on');} rebuild(); },
    toggle(){ on?this.hide():this.show(); },
    state(){ return { on, source:srcKey, date:dateStr, layerId:SOURCES[srcKey].id }; }
  };

  function init(){ const m=getMap(); if(!m){ setTimeout(init,150); return; } buildCtrl(); }
  try{ console.log('%c[chl] GIBS chlorophyll layer READY (build chl-tiles-v1)','color:#5dffaa'); }catch(e){}
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
