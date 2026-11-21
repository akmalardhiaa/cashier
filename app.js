"use strict";
/* ================== Konfigurasi ================== */
const TAX_RATE = 0.10, SERVICE_RATE = 0.05;
const MAX_QTY = 20;
const CATS = ["Kopi", "Non-Kopi", "Makanan", "Camilan"];
const BEST = new Set(["m03","m07","m10"]);

/* ================== State ================== */
const S = {
  mode:"", loading:true, error:"", net:true, brand:"Kedai Rindang", demoPay:true,
  table:null, menu:[], orders:[], calls:[], tables:[], staff:false, staffChecked:false
};
const UI = {
  view:"kasir", token:null, cat:"Kopi", cart:{}, sheet:false, custName:"", note:"", pay:"qris",
  filter:"aktif", open:{}, activeOrderId:null, lastCall:0, confirm:null, modal:null, busy:false, idem:null, brandDraft:null
};

/* ================== Util ================== */
function rid(n){ const a="ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; const b=new Uint8Array(n); crypto.getRandomValues(b); let s=""; for(const x of b) s+=a[x%a.length]; return s; }
let SID=null;
try { SID=localStorage.getItem("kr_sid"); } catch(e) {}
if (!SID || !/^[A-Za-z0-9_-]{16,64}$/.test(SID)) { SID=rid(24); try { localStorage.setItem("kr_sid", SID); } catch(e) {} }
function esc(v){ return String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function rp(n){ return "Rp" + Math.round(Number(n)||0).toLocaleString("id-ID"); }
function ago(ts){ if(!ts) return ""; const m=Math.floor((Date.now()-ts)/60000); if(m<1) return "baru saja"; if(m<60) return m+" mnt lalu"; return Math.floor(m/60)+" jam lalu"; }
function mins(ts){ return ts ? Math.max(0,Math.floor((Date.now()-ts)/60000)) : 0; }
function clock(ts){ return ts ? new Date(ts).toLocaleTimeString("id-ID",{hour:"2-digit",minute:"2-digit"}) : ""; }
function startOfDay(){ const d=new Date(); d.setHours(0,0,0,0); return d.getTime(); }
function menuById(id){ return S.menu.find(m=>m.id===id); }
function calc(items){
  const subtotal=items.reduce((s,i)=>s+i.price*i.qty,0);
  const service=Math.round(subtotal*SERVICE_RATE);
  const tax=Math.round((subtotal+service)*TAX_RATE);
  return {subtotal, service, tax, total:subtotal+service+tax};
}
function qrText(t){ return location.origin + "/m/" + t.token; }
function isExpired(o){ return o.status==="menunggu_bayar" && o.payMethod==="qris" && o.expiresAt && Date.now()>o.expiresAt; }
function stateOf(o){
  if (isExpired(o)) return {label:"QR kedaluwarsa", tone:"crit"};
  return ({
    menunggu_bayar:{label:o.payMethod==="tunai"?"Menunggu bayar di kasir":"Menunggu bayar QRIS", tone:"warn"},
    antri:{label:"Antri di dapur", tone:"info"}, diproses:{label:"Sedang dibuat", tone:"info"},
    siap:{label:"Siap diantar", tone:"ok"}, selesai:{label:"Selesai", tone:"muted"},
    batal:{label:o.cancelledBy==="sistem"?"Batal otomatis":"Dibatalkan", tone:"crit"}
  })[o.status] || {label:o.status, tone:"muted"};
}
function toast(msg, tone){
  const el=document.createElement("div"); el.className="toast"+(tone?" "+tone:""); el.textContent=msg;
  document.getElementById("toast").appendChild(el); setTimeout(()=>el.remove(), 4000);
}
function slug(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,""); }
function saveBlob(name, blob){
  const u=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=u; a.download=name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(u), 5000);
}

/* ================== API ================== */
async function api(op, data){
  let r;
  try {
    r = await fetch("/api", {method:"POST", headers:{"Content-Type":"application/json"}, credentials:"same-origin", body:JSON.stringify({op, ...(data||{})})});
  } catch(e) {
    if (S.net) { S.net=false; render(); }
    throw Object.assign(new Error("Koneksi terputus. Periksa internet lalu coba lagi."), {net:true});
  }
  if (!S.net) { S.net=true; render(); }
  let j={}; try { j=await r.json(); } catch(e) {}
  if (!r.ok) {
    const err=new Error(j.error || ("Gagal ("+r.status+")")); err.status=r.status; err.data=j;
    if (j.code==="auth" && S.mode==="staff") { S.staff=false; stopPoll(); render(); }
    throw err;
  }
  return j;
}
async function attempt(p, okMsg){ try { const v=await p; if(okMsg) toast(okMsg); return v; } catch(e) { toast(e.message,"crit"); return null; } }

/* ================== Loaders & polling ================== */
async function loadTable(){
  try { const j=await api("table",{token:UI.token}); S.table=j.table; S.menu=j.menu; S.brand=j.brand; S.demoPay=j.demoPay; S.error=""; if(!S.demoPay) UI.pay="tunai"; }
  catch(e) { if(e.status===404) S.error="notfound"; else if(!S.table) S.error=e.message; }
  S.loading=false; render();
}
async function loadMine(){ if(!S.table) return; try { const j=await api("mine",{token:UI.token, session:SID}); S.orders=j.orders; render(); } catch(e) {} }
async function loadBoard(){ try { const j=await api("board"); S.orders=j.orders; S.calls=j.calls; S.brand=j.brand; S.demoPay=j.demoPay; S.loading=false; render(); } catch(e) {} }
async function loadMenuAll(){ try { const j=await api("menuAll"); S.menu=j.menu; render(); } catch(e) {} }
async function loadTables(){ try { const j=await api("tables"); S.tables=j.tables; render(); } catch(e) {} }

let pollT=null, menuT=0;
function stopPoll(){ clearTimeout(pollT); pollT=null; }
function schedule(){
  stopPoll();
  if (S.mode==="customer" && S.table) pollT=setTimeout(async()=>{ if(document.visibilityState==="visible"){ await loadMine(); if(Date.now()-menuT>60000){ menuT=Date.now(); await loadTable(); } } schedule(); }, 4000);
  if (S.mode==="staff" && S.staff) pollT=setTimeout(async()=>{ if(document.visibilityState==="visible") await loadBoard(); schedule(); }, 3000);
}
document.addEventListener("visibilitychange", ()=>{
  if (document.visibilityState!=="visible") return;
  if (S.mode==="customer" && S.table) loadMine();
  if (S.mode==="staff" && S.staff) loadBoard();
});
async function enterStaff(){
  await loadBoard();
  await Promise.all([loadMenuAll(), loadTables()]);
  menuT=Date.now(); schedule();
}

/* ================== QR ================== */
const qrCache = new Map();
function qrCanvas(text, size){
  if (typeof QRCode==="undefined") return null;
  const div=document.createElement("div");
  new QRCode(div,{text, width:size, height:size, colorDark:"#000000", colorLight:"#ffffff", correctLevel:QRCode.CorrectLevel.M});
  return div.querySelector("canvas");
}
function qrUrl(text, size){
  const k=size+"|"+text; if(qrCache.has(k)) return qrCache.get(k);
  const c=qrCanvas(text,size); const u=c?c.toDataURL("image/png"):"";
  qrCache.set(k,u); return u;
}
function qrImg(text,size,alt){
  const u=qrUrl(text,size);
  return u ? `<img src="${u}" alt="${esc(alt)}" width="${size}" height="${size}">` : `<div class="small muted" style="width:150px;height:150px;display:grid;place-items:center;line-height:1.3">Pustaka QR gagal dimuat</div>`;
}

/* ================== Ilustrasi menu (digambar di canvas) ================== */
const AW=480, AH=360;
function rng(seed){ let s=(seed>>>0)||1; return ()=>((s=(Math.imul(s,1664525)+1013904223)>>>0)/4294967296); }
function grad(x,x0,y0,x1,y1,st){ const g=x.createLinearGradient(x0,y0,x1,y1); for(const [o,c] of st) g.addColorStop(o,c); return g; }
function rgrad(x,cx,cy,r0,r1,st){ const g=x.createRadialGradient(cx,cy,r0,cx,cy,r1); for(const [o,c] of st) g.addColorStop(o,c); return g; }
function paint(x,fill,stroke,lw){ if(fill){ x.fillStyle=fill; x.fill(); } if(stroke){ x.strokeStyle=stroke; x.lineWidth=lw||2; x.stroke(); } }
function E(x,cx,cy,rx,ry,fill,stroke,lw,rot){ x.beginPath(); x.ellipse(cx,cy,rx,ry,rot||0,0,Math.PI*2); paint(x,fill,stroke,lw); }
function R(x,X,Y,w,h,r,fill,stroke,lw){ x.beginPath(); if(x.roundRect) x.roundRect(X,Y,w,h,r); else x.rect(X,Y,w,h); paint(x,fill,stroke,lw); }
function P(x,pts,fill,stroke,lw){ x.beginPath(); pts.forEach(([a,b],i)=>i?x.lineTo(a,b):x.moveTo(a,b)); x.closePath(); paint(x,fill,stroke,lw); }
function shade(x,cx,cy,rx,ry){ E(x,cx,cy,rx,ry,"rgba(70,45,20,.16)"); }
function steam(x,xs,y0){ x.save(); x.strokeStyle="rgba(255,255,255,.8)"; x.lineWidth=6; x.lineCap="round"; for(const sx of xs){ x.beginPath(); x.moveTo(sx,y0); x.bezierCurveTo(sx-16,y0-24,sx+16,y0-44,sx,y0-70); x.stroke(); } x.restore(); }
function iceCube(x,cx,cy,s,a){ x.save(); x.translate(cx,cy); x.rotate(a); R(x,-s/2,-s/2,s,s,7,"rgba(255,255,255,.34)","rgba(255,255,255,.75)",2); E(x,-s/5,-s/5,s/6,s/10,"rgba(255,255,255,.5)"); x.restore(); }
function heart(x,cx,cy,s,fill){ x.beginPath(); x.moveTo(cx,cy+s*.95); x.bezierCurveTo(cx-s*1.5,cy+s*.05,cx-s*.85,cy-s*1.05,cx,cy-s*.35); x.bezierCurveTo(cx+s*.85,cy-s*1.05,cx+s*1.5,cy+s*.05,cx,cy+s*.95); x.closePath(); paint(x,fill); }
function glassPath(x,cx,y0,y1,wt,wb){ x.beginPath(); x.moveTo(cx-wt/2,y0); x.lineTo(cx-wb/2,y1-14); x.quadraticCurveTo(cx-wb/2,y1,cx-wb/2+14,y1); x.lineTo(cx+wb/2-14,y1); x.quadraticCurveTo(cx+wb/2,y1,cx+wb/2,y1-14); x.lineTo(cx+wt/2,y0); x.closePath(); }
function drink(x,o){
  const {cx=240,y0=74,y1=300,wt=150,wb=118,layers=[],ice=0,seed=3,straw=null,extra=null}=o;
  shade(x,cx,y1+6,wb/2+34,14);
  if(straw){ x.save(); x.strokeStyle=straw; x.lineWidth=13; x.lineCap="round"; x.beginPath(); x.moveTo(cx+40,y0-56); x.lineTo(cx+12,y1-40); x.stroke(); x.restore(); }
  x.save(); glassPath(x,cx,y0,y1,wt,wb); x.clip();
  x.fillStyle="rgba(255,255,255,.22)"; x.fillRect(0,0,AW,AH);
  for(const [ly,fill] of layers){ x.fillStyle=fill; x.fillRect(0,ly,AW,AH-ly); }
  if(extra) extra(x);
  const r=rng(seed), top=layers.length?layers[0][0]:y0;
  for(let i=0;i<ice;i++) iceCube(x,cx-wt/2+34+r()*(wt-68),top+14+r()*56,34+r()*10,r()*1.2-.6);
  x.fillStyle="rgba(255,255,255,.28)"; x.fillRect(cx-wt/2+12,y0,14,y1-y0);
  x.restore();
  glassPath(x,cx,y0,y1,wt,wb); paint(x,null,"rgba(255,255,255,.9)",4);
  E(x,cx,y0,wt/2,9,null,"rgba(255,255,255,.95)",3);
}
function plate(x){ shade(x,244,258,190,66); E(x,240,232,186,98,grad(x,0,134,0,330,[[0,"#ffffff"],[1,"#e9e4dc"]])); E(x,240,228,152,76,"#f6f3ee"); }
const DRAW = {
  espresso(x){
    shade(x,240,298,150,20);
    E(x,240,288,136,30,grad(x,0,258,0,318,[[0,"#ffffff"],[1,"#e4ded5"]]),"rgba(0,0,0,.05)",2); E(x,240,282,82,14,"rgba(0,0,0,.07)");
    x.save(); x.strokeStyle="#ece7df"; x.lineWidth=15; x.lineCap="round"; x.beginPath(); x.arc(320,214,26,-1.2,1.3); x.stroke(); x.restore();
    x.beginPath(); x.moveTo(160,170); x.bezierCurveTo(164,252,192,284,240,284); x.bezierCurveTo(288,284,316,252,320,170); x.closePath();
    paint(x,grad(x,160,0,320,0,[[0,"#ffffff"],[.65,"#f3efe9"],[1,"#d6cec2"]]));
    E(x,240,170,80,18,"#f8f5f0","rgba(0,0,0,.05)",2); E(x,240,172,70,13,rgrad(x,236,170,4,70,[[0,"#d39a5e"],[.55,"#93582a"],[1,"#3d2210"]]));
    steam(x,[218,256],140);
  },
  americano(x){ drink(x,{ice:4,seed:7,layers:[[118,grad(x,0,118,0,300,[[0,"#6a4026"],[1,"#21130b"]])]]}); },
  kopisusu(x){ drink(x,{y0:66,wt:164,wb:126,straw:"#1c6a50",ice:3,seed:11,layers:[
    [100,grad(x,0,100,0,160,[[0,"#a86f40"],[1,"#c99a6c"]])],[150,grad(x,0,150,0,250,[[0,"#d8b58b"],[1,"#ecd8bb"]])],[248,grad(x,0,248,0,300,[[0,"#8a4a1a"],[1,"#5c2d0c"]])]]}); },
  cappuccino(x){
    E(x,250,206,138,124,"rgba(70,45,20,.14)");
    E(x,240,190,134,122,rgrad(x,220,170,20,140,[[0,"#ffffff"],[1,"#e8e2d9"]])); E(x,240,190,112,102,null,"rgba(0,0,0,.05)",2);
    R(x,326,172,64,34,17,"#efe9e1");
    E(x,240,190,98,92,"#fbfaf8","rgba(0,0,0,.05)",2); E(x,240,190,86,80,"#ece5db");
    E(x,240,190,78,72,rgrad(x,240,190,10,78,[[0,"#c38a54"],[1,"#7d4720"]])); E(x,240,190,74,68,null,"#e7cfae",5);
    heart(x,240,198,40,"#f7ebd9"); heart(x,240,196,24,"#c38a54"); heart(x,240,194,12,"#f7ebd9");
    x.save(); x.translate(150,282); x.rotate(-.6); E(x,0,0,16,11,"#d3d7da"); R(x,12,-3,70,6,3,"#c6cbcf"); x.restore();
  },
  latte(x){
    drink(x,{y0:100,wt:140,wb:136,seed:2,layers:[[120,"#fbf6ee"],[146,grad(x,0,146,0,300,[[0,"#c08c5a"],[.5,"#d9b48c"],[1,"#efe2cf"]])]]});
    x.save(); x.strokeStyle="rgba(255,255,255,.9)"; x.lineWidth=11; x.beginPath(); x.arc(312,205,40,-1.25,1.25); x.stroke(); x.restore();
  },
  v60(x){
    shade(x,240,306,120,16);
    const sp=()=>{ x.beginPath(); x.moveTo(180,206); x.bezierCurveTo(160,252,172,302,240,304); x.bezierCurveTo(308,302,320,252,300,206); x.closePath(); };
    x.save(); sp(); x.clip(); x.fillStyle="rgba(255,255,255,.25)"; x.fillRect(0,0,AW,AH);
    x.fillStyle=grad(x,0,246,0,304,[[0,"#7b4521"],[1,"#3b1f0d"]]); x.fillRect(0,246,AW,80);
    x.fillStyle="rgba(255,255,255,.3)"; x.fillRect(190,206,10,100); x.restore();
    sp(); paint(x,null,"rgba(255,255,255,.9)",4);
    R(x,196,192,88,16,6,"#e7e1d8");
    P(x,[[156,96],[324,96],[270,194],[210,194]],grad(x,156,0,324,0,[[0,"#fbf9f6"],[1,"#d9d1c6"]]));
    x.save(); x.strokeStyle="rgba(0,0,0,.07)"; x.lineWidth=3; for(let i=0;i<5;i++){ x.beginPath(); x.moveTo(186+i*27,104); x.lineTo(222+i*9,188); x.stroke(); } x.restore();
    P(x,[[172,96],[308,96],[300,74],[180,74]],"#fbf5ea","rgba(0,0,0,.05)",2);
    R(x,148,90,184,14,7,"#ffffff","rgba(0,0,0,.05)",2);
    E(x,240,216,4,7,"#5a3218"); steam(x,[226,256],70);
  },
  matcha(x){ drink(x,{straw:"#2d6a4f",ice:4,seed:5,layers:[[112,grad(x,0,112,0,200,[[0,"#7fae55"],[1,"#a6c97f"]])],[196,grad(x,0,196,0,300,[[0,"#e9efd8"],[1,"#f7f5ec"]])]]}); },
  cokelat(x){
    shade(x,236,302,120,16);
    x.save(); x.strokeStyle="#2c5a4b"; x.lineWidth=18; x.beginPath(); x.arc(312,220,38,-1.15,1.15); x.stroke(); x.restore();
    R(x,158,146,156,156,24,grad(x,158,0,314,0,[[0,"#4b8a74"],[1,"#2c5a4b"]]));
    E(x,236,148,78,14,"#285043"); E(x,236,150,68,10,"#6b3a1f");
    for(const [a,b,r] of [[204,136,28],[236,124,32],[268,136,28],[220,110,22],[252,106,22],[236,90,18]]) E(x,a,b,r,r*.85,rgrad(x,a-r/3,b-r/3,2,r,[[0,"#ffffff"],[1,"#f1e6d8"]]));
    x.save(); x.strokeStyle="#5a2e14"; x.lineWidth=5; x.lineCap="round"; x.beginPath(); x.moveTo(196,118); x.bezierCurveTo(215,96,230,140,248,108); x.bezierCurveTo(262,86,272,128,282,116); x.stroke(); x.restore();
    const r=rng(8); for(let i=0;i<22;i++) E(x,204+r()*66,92+r()*50,2.2,2.2,"#7a4022");
  },
  teh(x){
    drink(x,{ice:3,seed:9,layers:[[116,grad(x,0,116,0,300,[[0,"#f3b862"],[1,"#d0701f"]])]],extra:(x)=>{
      for(const [a,b] of [[205,268],[250,280],[282,262],[228,240]]) E(x,a,b,17,16,rgrad(x,a-5,b-5,2,18,[[0,"#ffffff"],[1,"#f1d9dc"]]),"rgba(255,255,255,.7)",2);
    }});
    E(x,312,76,22,20,rgrad(x,306,70,3,24,[[0,"#e2556a"],[1,"#9e2236"]]));
    const r=rng(4); for(let i=0;i<14;i++) E(x,300+r()*24,66+r()*20,2,2,"rgba(255,255,255,.35)");
    E(x,178,70,22,9,"#4f9a5a",null,0,-.5);
  },
  nasgor(x){
    plate(x); const r=rng(21);
    for(let i=0;i<260;i++){ const a=r()*Math.PI*2, d=Math.sqrt(r()); E(x,228+Math.cos(a)*d*108,222+Math.sin(a)*d*58,8+r()*4,6+r()*3,["#c98a43","#d89a52","#b97a38","#e3ad66"][i%4],null,0,r()*3); }
    for(let i=0;i<40;i++){ const a=r()*Math.PI*2, d=Math.sqrt(r()); E(x,228+Math.cos(a)*d*100,222+Math.sin(a)*d*52,3,3,i%2?"#5d9a3a":"#d24b2e"); }
    for(const [a,b,q] of [[200,170,34],[226,162,26],[184,186,24],[214,190,26]]) E(x,a,b,q,q*.8,"#fffdf6");
    E(x,204,172,17,15,rgrad(x,199,167,2,18,[[0,"#ffd75a"],[1,"#f0a01a"]])); E(x,198,166,5,3,"rgba(255,255,255,.7)");
    for(const [a,b,rot] of [[338,246,.3],[356,212,-.2]]){ x.save(); x.translate(a,b); x.rotate(rot); x.beginPath(); for(let k=0;k<=24;k++){ const t=k/24*Math.PI*2, q=40+(k%2?4:-2); x.lineTo(Math.cos(t)*q,Math.sin(t)*q*.62); } x.closePath(); paint(x,"#f8eed9","#e8d4ad",2); x.restore(); }
    for(let i=0;i<10;i++) R(x,120+r()*50,244+r()*30,10,10,2,["#f2d04a","#f08a2a","#9cc56a"][i%3]);
  },
  mie(x){
    plate(x); const r=rng(33); x.save(); x.lineCap="round";
    for(let i=0;i<80;i++){ const a=r()*Math.PI*2, d=Math.sqrt(r())*.85, sx=236+Math.cos(a)*d*112, sy=222+Math.sin(a)*d*58; x.strokeStyle=["#c98a3a","#b8772c","#dba15a"][i%3]; x.lineWidth=6; x.beginPath(); x.moveTo(sx,sy); x.bezierCurveTo(sx+(r()-.5)*70,sy+(r()-.5)*40,sx+(r()-.5)*70,sy+(r()-.5)*40,sx+(r()-.5)*60,sy+(r()-.5)*30); x.stroke(); }
    x.restore();
    for(let i=0;i<18;i++){ const a=r()*Math.PI*2, d=Math.sqrt(r())*.7; E(x,236+Math.cos(a)*d*110,220+Math.sin(a)*d*55,12,5,"#ecc895",null,0,r()*3); }
    for(let i=0;i<14;i++){ const a=r()*Math.PI*2, d=Math.sqrt(r())*.75; E(x,236+Math.cos(a)*d*110,220+Math.sin(a)*d*55,11,6,i%2?"#4f8f37":"#6fb04d",null,0,r()*3); }
    for(let i=0;i<30;i++) E(x,170+r()*140,190+r()*60,3,2.5,"#8a4a1c");
    for(let i=0;i<5;i++) E(x,190+r()*110,200+r()*40,5,5,"#d8402b");
  },
  roti(x){
    shade(x,244,300,170,22);
    R(x,96,214,290,92,16,grad(x,0,214,0,306,[[0,"#c38f5b"],[1,"#9b6a3e"]]));
    x.save(); x.strokeStyle="rgba(0,0,0,.08)"; x.lineWidth=2; for(let i=0;i<4;i++){ x.beginPath(); x.moveTo(110,236+i*18); x.lineTo(372,232+i*18); x.stroke(); } x.restore();
    R(x,140,178,200,76,24,"#e8b56e","#b8742f",8);
    R(x,142,160,196,24,12,"#8fb34e"); for(const a of [170,214,262,300]) E(x,a,186,9,12,"#8fb34e");
    R(x,140,92,200,76,24,"#f0c47f","#c07d36",8);
    x.save(); x.strokeStyle="rgba(150,85,30,.45)"; x.lineWidth=6; x.lineCap="round"; for(let i=0;i<4;i++){ x.beginPath(); x.moveTo(176+i*40,108); x.lineTo(156+i*40,152); x.stroke(); } x.restore();
    R(x,212,74,58,28,6,"#fff2bd","rgba(0,0,0,.05)",2); E(x,226,82,10,4,"rgba(255,255,255,.7)");
  },
  pisang(x){
    plate(x); const r=rng(17);
    for(const [a,b,rot] of [[176,214,-.45],[248,198,.15],[312,224,-.25],[204,256,.3],[286,264,-.1]]){ x.save(); x.translate(a,b); x.rotate(rot); E(x,0,0,54,23,grad(x,0,-23,0,23,[[0,"#f2bd5c"],[1,"#c97f22"]]),"#a8611a",3); for(let k=0;k<12;k++) E(x,(r()-.5)*84,(r()-.5)*30,3,2,"rgba(140,80,20,.5)"); x.restore(); }
    x.save(); x.lineCap="round"; x.strokeStyle="#fffaf0"; x.lineWidth=5; x.beginPath(); x.moveTo(140,200); x.bezierCurveTo(200,170,220,280,280,230); x.bezierCurveTo(320,200,330,270,350,250); x.stroke();
    x.lineWidth=4; for(let i=0;i<70;i++){ const px=150+r()*190, py=190+r()*90, a=r()*Math.PI; x.strokeStyle=i%3?"#f7dc6f":"#f2c94c"; x.beginPath(); x.moveTo(px,py); x.lineTo(px+Math.cos(a)*12,py+Math.sin(a)*12); x.stroke(); }
    x.restore();
  },
  kentang(x){
    shade(x,240,304,170,18);
    E(x,112,286,40,16,"#ffffff","rgba(0,0,0,.06)",2); E(x,112,282,32,10,"#d8352a");
    E(x,368,288,40,16,"#ffffff","rgba(0,0,0,.06)",2); E(x,368,284,32,10,"#fff3cf");
    const r=rng(5); for(let i=0;i<20;i++){ const fx=180+r()*120, h=110+r()*50, a=(r()-.5)*.5; x.save(); x.translate(fx,212); x.rotate(a); R(x,-9,-h,18,h+20,3,grad(x,-9,0,9,0,[[0,"#f8d468"],[1,"#e5a63a"]]),"#d18e2a",1.5); x.restore(); }
    const box=[[166,190],[314,190],[292,302],[188,302]];
    P(x,box,"#c8402e"); x.save(); P(x,box); x.clip(); x.fillStyle="#f6efe4"; for(const sx of [200,240,280]){ P(x,[[sx-8,190],[sx+8,190],[sx+5,302],[sx-5,302]]); x.fill(); } x.restore();
    R(x,160,182,160,16,5,"#b23526");
  },
  croissant(x){
    x.save(); x.translate(240,214); x.rotate(.12); R(x,-150,-108,300,216,8,"#f4ede1","#e3d6c1",2); x.restore();
    shade(x,240,262,140,22);
    const segs=[-3,3,-2,2,-1,1,0];
    for(const i of segs){ const t=i*.36, cx=240+Math.sin(t)*104, cy=292-Math.cos(t)*104, rx=48-Math.abs(i)*7, ry=36-Math.abs(i)*5;
      E(x,cx,cy,rx,ry,grad(x,0,cy-ry,0,cy+ry,[[0,"#f4bf68"],[1,"#c4762b"]]),"#a85f1f",2.5,t);
      x.save(); x.strokeStyle="rgba(255,225,160,.75)"; x.lineWidth=3; x.beginPath(); x.ellipse(cx,cy-4,rx*.6,ry*.45,t,Math.PI*1.1,Math.PI*1.9); x.stroke(); x.restore(); }
  }
};
const ART_BG = {espresso:["#f3e6d6","#dcc3a2"],americano:["#e2ecef","#b7cfd6"],kopisusu:["#f3e2cd","#ddb98c"],cappuccino:["#efe5d8","#d6bea2"],latte:["#ebe4da","#cdbfa9"],v60:["#e6ede4","#c2d1bd"],matcha:["#e7f0de","#bdd6a5"],cokelat:["#f2e1d8","#d8b5a1"],teh:["#f7e8d6","#ebc394"],nasgor:["#f5e4cd","#e4c08a"],mie:["#f4e7d2","#dfc293"],roti:["#eef0de","#d2d9ad"],pisang:["#f7ebd2","#e9cc8e"],kentang:["#f9e6d8","#ecbd9b"],croissant:["#f5e8d8","#e2c49b"]};
const KIND_RULES = [[/espresso/,"espresso"],[/americano|long black/,"americano"],[/aren|kopi susu/,"kopisusu"],[/cappuccino|flat white/,"cappuccino"],[/matcha|green tea/,"matcha"],[/latte/,"latte"],[/v60|single origin|manual|tubruk/,"v60"],[/cokelat|coklat|chocolate/,"cokelat"],[/teh|tea|leci/,"teh"],[/nasi/,"nasgor"],[/mie|bakmi|kwetiau|pasta/,"mie"],[/roti|toast|sandwich/,"roti"],[/pisang/,"pisang"],[/kentang|fries/,"kentang"],[/croissant|pastry|donat|kue/,"croissant"]];
function kindOf(m){ const n=String(m.name||"").toLowerCase(); for(const [re,k] of KIND_RULES) if(re.test(n)) return k; return ({"Kopi":"latte","Non-Kopi":"teh","Makanan":"nasgor","Camilan":"kentang"})[m.cat]||"latte"; }
function d2b(d){
  try{ const i=d.indexOf(","); const mime=(d.slice(0,i).match(/^data:(image\/(?:jpeg|png|webp));base64$/)||[])[1]; if(!mime) return null;
    const bin=atob(d.slice(i+1)); const u=new Uint8Array(bin.length); for(let k=0;k<bin.length;k++) u[k]=bin.charCodeAt(k);
    return URL.createObjectURL(new Blob([u],{type:mime})); } catch(e){ return null; }
}
const artCache=new Map();
function artUrl(k){
  if (artCache.has(k)) return artCache.get(k);
  const c=document.createElement("canvas"); c.width=AW; c.height=AH; const x=c.getContext("2d");
  const [a,b]=ART_BG[k]||["#eeeeee","#cccccc"]; x.fillStyle=rgrad(x,240,140,20,340,[[0,a],[1,b]]); x.fillRect(0,0,AW,AH);
  try{ DRAW[k](x); }catch(e){ console.warn(k,e); }
  const u=d2b(c.toDataURL("image/jpeg",.9))||""; artCache.set(k,u); return u;
}
let heroCache=null;
function drawHero(x){
  x.fillStyle=grad(x,0,0,960,400,[[0,"#1f7357"],[1,"#0d3527"]]); x.fillRect(0,0,960,400);
  for(const [a,b,q] of [[120,60,140],[880,40,120],[520,380,200]]) E(x,a,b,q,q,"rgba(255,255,255,.05)");
  x.strokeStyle="rgba(255,255,255,.35)"; x.lineWidth=2; x.beginPath(); x.moveTo(0,30); x.quadraticCurveTo(480,110,960,30); x.stroke();
  for(let i=1;i<16;i++){ const t=i/16, px=960*t, py=(1-t)*(1-t)*30+2*(1-t)*t*110+t*t*30; x.save(); x.shadowColor="rgba(255,210,120,.9)"; x.shadowBlur=18; E(x,px,py+8,6,7,"#ffd88a"); x.restore(); }
  x.fillStyle=grad(x,0,326,0,400,[[0,"#a06e40"],[1,"#6f4729"]]); x.fillRect(0,330,960,70); x.fillStyle="#c08a55"; x.fillRect(0,326,960,8);
  const put=(k,cx,s)=>{ x.save(); x.translate(cx-240*s,330-300*s); x.scale(s,s); try{ DRAW[k](x); }catch(e){} x.restore(); };
  put("kopisusu",560,.92); put("latte",715,.84); put("croissant",866,.62);
}
function heroUrl(){
  if (heroCache) return heroCache;
  const c=document.createElement("canvas"); c.width=960; c.height=400; drawHero(c.getContext("2d"));
  heroCache=d2b(c.toDataURL("image/jpeg",.88))||""; return heroCache;
}
async function shrinkPhoto(file){
  if (!file || !/^image\//.test(file.type)) throw new Error("Pilih file gambar (JPG atau PNG).");
  if (file.size>15*1024*1024) throw new Error("Foto terlalu besar, maksimal 15 MB.");
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>rej(new Error("Format foto tidak bisa dibaca di browser ini. Coba JPG atau PNG.")); i.src=url; });
    const c=document.createElement("canvas"); c.width=AW; c.height=AH; const x=c.getContext("2d");
    const s=Math.max(AW/img.naturalWidth, AH/img.naturalHeight), w=img.naturalWidth*s, h=img.naturalHeight*s;
    x.drawImage(img,(AW-w)/2,(AH-h)/2,w,h);
    let q=.8, d=c.toDataURL("image/jpeg",q); while(d.length>180000 && q>.4){ q-=.1; d=c.toDataURL("image/jpeg",q); }
    return d;
  } finally { URL.revokeObjectURL(url); }
}

/* ================== Actions ================== */
function myOrders(){ return S.orders.slice().sort((a,b)=>b.createdAt-a.createdAt); }
function cartItems(){
  return Object.entries(UI.cart).filter(([,q])=>q>0).map(([id,qty])=>{ const m=menuById(id); return m?{menuId:id,name:m.name,price:m.price,qty}:null; }).filter(Boolean);
}
const A = {
  nav(d){ go(d.v); },
  cat(d){ UI.cat=d.v; render(); },
  inc(d){ const m=menuById(d.id); if(!m||m.available===false) return; UI.cart[d.id]=Math.min(MAX_QTY,(UI.cart[d.id]||0)+1); render(); },
  dec(d){ UI.cart[d.id]=Math.max(0,(UI.cart[d.id]||0)-1); render(); },
  sheet(){ UI.sheet=true; UI.sheetAnim=true; render(); UI.sheetAnim=false; },
  closeSheet(){ UI.sheet=false; render(); },
  pay(d){ UI.pay=d.v; render(); },
  async place(){
    const items=cartItems(); if(!items.length) return toast("Keranjang masih kosong.");
    UI.busy=true; render();
    UI.idem = UI.idem || rid(20);
    try {
      const j=await api("order",{token:UI.token, session:SID, idem:UI.idem, pay:UI.pay, name:UI.custName, note:UI.note, items:items.map(i=>({menuId:i.menuId, qty:i.qty}))});
      UI.idem=null; UI.cart={}; UI.note=""; UI.sheet=false;
      S.orders=[j.order, ...S.orders.filter(o=>o.id!==j.order.id)]; UI.activeOrderId=j.order.id;
    } catch(e) {
      if (!e.net) UI.idem=null;
      if (e.data && e.data.orderId){ UI.sheet=false; UI.activeOrderId=e.data.orderId; await loadMine(); }
      if (e.data && e.data.refresh) await loadTable();
      toast(e.message,"crit");
    } finally { UI.busy=false; render(); }
  },
  async simPaid(d){ if(await attempt(api("simpay",{session:SID,id:d.id}),"Pembayaran diterima. Pesanan masuk ke dapur.")) await loadMine(); },
  async renewQr(d){ if(await attempt(api("renew",{session:SID,id:d.id}))) await loadMine(); },
  async custCancel(d){ if(await attempt(api("cancel",{session:SID,id:d.id}),"Pesanan dibatalkan.")){ await loadMine(); } },
  viewOrder(d){ UI.activeOrderId=d.id; render(); window.scrollTo(0,0); },
  backMenu(){ UI.activeOrderId=null; render(); },
  async callWaiter(){
    if (Date.now()-UI.lastCall<60000) return toast("Pelayan sudah dipanggil. Tunggu sebentar ya.");
    if (await attempt(api("call",{token:UI.token, session:SID}))) { UI.lastCall=Date.now(); toast("Pelayan sedang menuju "+(S.table?S.table.name:"mejamu")+"."); }
  },
  // staf
  async logout(){ await attempt(api("logout")); S.staff=false; stopPoll(); render(); },
  async doneCall(d){ if(await attempt(api("resolveCall",{id:d.id}))) loadBoard(); },
  filter(d){ UI.filter=d.v; render(); },
  toggleOpen(d){ UI.open[d.id]=!UI.open[d.id]; render(); },
  async cashPaid(d){ if(await attempt(api("cashpaid",{id:d.id}),"Pembayaran tunai dicatat. Pesanan masuk ke dapur.")) loadBoard(); },
  async status(d){ await attempt(api("status",{id:d.id,to:d.v})); loadBoard(); },
  askCancel(d){ UI.confirm={kind:"cancel", id:d.id}; render(); },
  askRotate(d){ UI.confirm={kind:"rotate", id:d.id}; render(); },
  noConfirm(){ UI.confirm=null; render(); },
  async yesConfirm(){
    const c=UI.confirm; UI.confirm=null; render();
    if (c.kind==="cancel"){ await attempt(api("status",{id:c.id,to:"batal"}),"Pesanan dibatalkan."); loadBoard(); }
    if (c.kind==="rotate"){ if(await attempt(api("tableRotate",{id:c.id}),"Kode QR diganti. Cetak ulang kartu meja ini; QR lama sudah tidak berlaku.")) { qrCache.clear(); loadTables(); } }
  },
  async toggleMenu(d){ const m=menuById(d.id); if(!m) return; if(await attempt(api("menuUpdate",{id:d.id, available:m.available===false}))) loadMenuAll(); },
  async resetPhoto(d){ if(await attempt(api("menuResetPhoto",{id:d.id}),"Kembali memakai ilustrasi.")) loadMenuAll(); },
  async addTable(){ if(await attempt(api("tableAdd",{}),"Meja ditambahkan.")) loadTables(); },
  async saveBrand(){ const v=(UI.brandDraft??S.brand).trim(); if(await attempt(api("settingsSave",{brand:v}),"Nama kedai disimpan.")){ UI.brandDraft=null; loadBoard(); } },
  async copy(d){ try { await navigator.clipboard.writeText(d.v); toast("Tautan disalin."); } catch(e) { toast("Tidak bisa menyalin. Salin manual dari teks di bawah QR."); } },
  openLink(d){ window.open(d.v, "_blank", "noopener"); },
  async preview(d){
    const t=S.tables.find(x=>x.id===d.id); if(!t) return;
    const blob=await cardBlob(t); UI.modal={t, url:URL.createObjectURL(blob), blob}; renderModal();
  },
  closeModal(){ if(UI.modal) URL.revokeObjectURL(UI.modal.url); UI.modal=null; renderModal(); },
  dlCard(){ const m=UI.modal; if(m) saveBlob("kartu-"+slug(m.t.name)+".png", m.blob); },
  async dlAll(){
    if (typeof JSZip==="undefined") return toast("Pustaka ZIP gagal dimuat.","crit");
    UI.busy=true; render();
    try { const zip=new JSZip(); for (const t of S.tables) zip.file("kartu-"+slug(t.name)+".png", await cardBlob(t)); saveBlob("kartu-qr-semua-meja.zip", await zip.generateAsync({type:"blob"})); }
    finally { UI.busy=false; render(); }
  }
};

/* Kartu meja siap cetak (A6, 300 dpi) */
async function cardBlob(t){
  try { await document.fonts.ready; } catch(e) {}
  const W=1240,H=1748, c=document.createElement("canvas"); c.width=W; c.height=H; const x=c.getContext("2d");
  x.fillStyle="#ffffff"; x.fillRect(0,0,W,H);
  const hero=document.createElement("canvas"); hero.width=960; hero.height=400; drawHero(hero.getContext("2d"));
  x.drawImage(hero,0,0,W,W*400/960);
  x.fillStyle="rgba(0,0,0,.28)"; x.fillRect(0,0,W*0.48,W*400/960);
  x.textAlign="left"; x.fillStyle="#ffffff";
  x.font='700 64px "Bricolage Grotesque", sans-serif'; x.fillText(S.brand||"Kedai", 56, 300);
  x.font='500 32px "Plus Jakarta Sans", sans-serif'; x.fillText("Pesan & bayar dari meja", 56, 350);
  x.textAlign="center";
  x.fillStyle="#16201a"; x.font='800 140px "Bricolage Grotesque", sans-serif'; x.fillText(t.name, W/2, 690);
  x.fillStyle="#5b6a61"; x.font='500 40px "Plus Jakarta Sans", sans-serif'; x.fillText("Scan dengan kamera HP", W/2, 760);
  const q=qrCanvas(qrText(t), 640);
  x.fillStyle="#ffffff"; x.strokeStyle="#d9e1da"; x.lineWidth=6;
  x.beginPath(); if(x.roundRect) x.roundRect(W/2-360, 800, 720, 720, 36); else x.rect(W/2-360,800,720,720); x.fill(); x.stroke();
  if (q) x.drawImage(q, W/2-320, 840, 640, 640);
  x.fillStyle="#16201a"; x.font='700 42px "Plus Jakarta Sans", sans-serif'; x.fillText("1  Scan     2  Pilih menu     3  Bayar", W/2, 1600);
  x.fillStyle="#5b6a61"; x.font='500 30px "Plus Jakarta Sans", sans-serif'; x.fillText(location.host+"/m/"+t.token.slice(0,4)+"••••", W/2, 1680);
  return new Promise(r=>c.toBlob(r,"image/png"));
}

/* ================== Routing ================== */
function go(h){ applyHash(h); try { if(location.hash.slice(1)!==h) history.replaceState(null,"","#"+h); } catch(e) {} }
function applyHash(h){ UI.view=["kasir","dapur","meja","menu"].includes(h)?h:"kasir"; window.scrollTo(0,0); render(); }
window.addEventListener("hashchange", ()=>{ if(S.mode==="staff") applyHash(location.hash.slice(1)); });

/* ================== Render: staff ================== */
function netPill(){
  if (!S.net) return `<span class="pill t-crit">Offline</span>`;
  return `<span class="pill t-ok">Tersambung</span>`;
}
function staffTop(){
  const unpaid=S.orders.filter(o=>o.status==="menunggu_bayar"&&!isExpired(o)).length;
  const kitchen=S.orders.filter(o=>o.status==="antri"||o.status==="diproses").length;
  const tab=(v,l,b,cls)=>`<button class="tab" data-act="nav" data-v="${v}" ${UI.view===v?'aria-current="page"':""}>${l}${b?`<span class="badge ${cls||""}">${b}</span>`:""}</button>`;
  return `<header class="top"><div class="top-in">
    <div class="brand"><b>${esc(S.brand)}</b><span>Dashboard staf</span></div>
    <nav class="tabs" aria-label="Halaman staf">${tab("kasir","Kasir",unpaid+S.calls.length)}${tab("dapur","Dapur",kitchen,"info")}${tab("meja","QR Meja")}${tab("menu","Menu & stok")}</nav>
    <div class="grow"></div>${netPill()}<button class="btn" data-act="logout">Keluar</button>
  </div></header>`;
}
function confirmBar(id, kind){
  if (!UI.confirm || UI.confirm.id!==id || UI.confirm.kind!==kind) return "";
  const msg = kind==="cancel" ? "Batalkan pesanan ini?" : "Ganti kode QR? Kartu lama di meja langsung tidak berlaku.";
  return `<div class="banner t-crit"><span class="grow">${msg}</span><button class="btn" data-act="noConfirm">Tidak</button><button class="btn primary" style="background:var(--crit);border-color:var(--crit)" data-act="yesConfirm">Ya, lanjutkan</button></div>`;
}
function renderKasir(){
  const sod=startOfDay();
  const today=S.orders.filter(o=>o.createdAt>=sod && o.status!=="batal");
  const paid=today.filter(o=>o.payStatus==="paid");
  const omzet=paid.reduce((s,o)=>s+(o.total||0),0);
  const qris=paid.filter(o=>o.payMethod==="qris").reduce((s,o)=>s+(o.total||0),0);
  const unpaid=S.orders.filter(o=>o.status==="menunggu_bayar"&&!isExpired(o));
  const inK=S.orders.filter(o=>["antri","diproses","siap"].includes(o.status));
  const F={aktif:o=>!["selesai","batal"].includes(o.status), bayar:o=>o.status==="menunggu_bayar", dapur:o=>["antri","diproses","siap"].includes(o.status), selesai:o=>o.status==="selesai", batal:o=>o.status==="batal", semua:()=>true};
  const list=S.orders.filter(F[UI.filter]||F.aktif).sort((a,b)=>b.createdAt-a.createdAt);
  const chip=(v,l)=>`<button class="chip" data-act="filter" data-v="${v}" aria-pressed="${UI.filter===v}">${l}</button>`;
  return `
  <section class="tiles" aria-label="Ringkasan hari ini">
    <div class="card tile"><span class="k">Omzet dibayar hari ini</span><span class="v num">${rp(omzet)}</span><span class="s num">QRIS ${rp(qris)} · Tunai ${rp(omzet-qris)}</span></div>
    <div class="card tile"><span class="k">Pesanan hari ini</span><span class="v num">${today.length}</span><span class="s num">Rata-rata ${rp(paid.length?omzet/paid.length:0)} per nota</span></div>
    <div class="card tile"><span class="k">Menunggu bayar</span><span class="v num" style="color:${unpaid.length?"var(--warn)":"inherit"}">${unpaid.length}</span><span class="s">Belum masuk dapur</span></div>
    <div class="card tile"><span class="k">Di dapur / siap antar</span><span class="v num">${inK.length}</span><span class="s">${inK.filter(o=>o.status==="siap").length} siap diantar</span></div>
  </section>
  ${S.calls.length?`<section class="calls" aria-label="Panggilan pelayan">${S.calls.map(c=>`<div class="card call"><b>${esc(c.tableName)}</b><span class="grow">memanggil pelayan · ${ago(c.at)}</span><button class="btn" data-act="doneCall" data-id="${esc(c.tableId)}">Sudah didatangi</button></div>`).join("")}</section>`:""}
  <section style="display:grid;gap:12px">
    <div class="row"><h2 class="grow">Pesanan</h2><div class="chips">${chip("aktif","Aktif")}${chip("bayar","Menunggu bayar")}${chip("dapur","Di dapur")}${chip("selesai","Selesai")}${chip("batal","Batal")}${chip("semua","Semua")}</div></div>
    <div class="orders">${list.length?list.map(orderRow).join(""):`<div class="empty">${S.loading?"Memuat pesanan…":"Belum ada pesanan di filter ini. Scan salah satu QR meja dengan HP untuk mencoba."}</div>`}</div>
  </section>`;
}
function orderRow(o){
  const st=stateOf(o); const open=UI.open[o.id];
  const n=(o.items||[]).reduce((s,i)=>s+i.qty,0);
  let acts="";
  if (o.status==="menunggu_bayar"){
    if (o.payMethod==="tunai") acts+=`<button class="btn primary" data-act="cashPaid" data-id="${esc(o.id)}">Terima tunai ${rp(o.total)}</button>`;
    acts+=`<button class="btn danger" data-act="askCancel" data-id="${esc(o.id)}">Batalkan</button>`;
  }
  if (o.status==="siap") acts+=`<button class="btn primary" data-act="status" data-v="selesai" data-id="${esc(o.id)}">Sudah diantar</button>`;
  return `<article class="card order"><div class="stripe ${st.tone}"></div><div class="body">
    <div class="head">
      <div><div class="code">${esc(o.code)}</div><div class="small muted">${esc(o.tableName)} · ${clock(o.createdAt)}</div></div>
      <button class="btn ghost" style="justify-content:flex-start;text-align:left;padding:4px 0" data-act="toggleOpen" data-id="${esc(o.id)}" aria-expanded="${!!open}">
        <span>${esc(o.customerName||"Tanpa nama")} · ${n} item<br><span class="small muted">${open?"Sembunyikan rincian":"Lihat rincian"}</span></span></button>
      <div style="text-align:right"><div class="num" style="font-weight:700">${rp(o.total)}</div><div class="small muted">${o.payMethod==="qris"?"QRIS":"Tunai"}</div></div>
      <span class="pill t-${st.tone}">${st.label}</span>
    </div>
    ${open?`<div class="items">${(o.items||[]).map(i=>`<div><span>${i.qty}× ${esc(i.name)}</span><span class="num">${rp(i.price*i.qty)}</span></div>`).join("")}
      <div class="small muted"><span>Subtotal ${rp(o.subtotal)} · Layanan ${rp(o.service)} · PB1 ${rp(o.tax)}</span><span class="mono">${esc(o.payRef||"")}</span></div></div>`:""}
    ${o.note?`<div class="note"><b>Catatan:</b> ${esc(o.note)}</div>`:""}
    ${acts?`<div class="row">${acts}</div>`:""}
    ${confirmBar(o.id,"cancel")}
  </div></article>`;
}
function renderDapur(){
  const col=(st,title,next,label)=>{
    const rows=S.orders.filter(o=>o.status===st).sort((a,b)=>(a.paidAt||a.createdAt)-(b.paidAt||b.createdAt));
    return `<section class="col" aria-label="${title}"><div class="col-h"><h2>${title}</h2><span class="pill t-muted num">${rows.length}</span></div>
      ${rows.length?rows.map(o=>{ const m=mins(o.paidAt||o.createdAt); const tone=m>=15?"crit":m>=8?"warn":"";
        return `<article class="card kcard"><div class="kh ${tone}"><div><div class="code">${esc(o.tableName)}</div><div class="small muted">${esc(o.code)} · ${esc(o.customerName||"Tanpa nama")}</div></div>
          <span class="pill ${tone?"t-"+tone:"t-ok"} num">${m} mnt</span></div>
          <div class="kb">${(o.items||[]).map(i=>`<div><span class="qty num">${i.qty}×</span> ${esc(i.name)}</div>`).join("")}${o.note?`<div class="note">${esc(o.note)}</div>`:""}</div>
          <div class="kf"><button class="btn primary block" data-act="status" data-v="${next}" data-id="${esc(o.id)}">${label}</button></div></article>`;}).join("")
      :`<div class="empty">Kosong</div>`}</section>`;
  };
  return `<div class="row"><h1 class="grow">Layar dapur & bar</h1><span class="small muted">Hanya pesanan lunas yang muncul. Kartu kuning setelah 8 menit, merah setelah 15 menit.</span></div>
  <div class="kds">${col("antri","Antrian","diproses","Mulai buat")}${col("diproses","Sedang dibuat","siap","Tandai siap")}${col("siap","Siap diantar","selesai","Sudah diantar")}</div>`;
}
function renderMeja(){
  return `<div class="split">
    <section style="display:grid;gap:12px">
      <div class="row"><h1 class="grow">QR per meja</h1>
        <button class="btn" data-act="addTable">Tambah meja</button>
        <button class="btn primary" data-act="dlAll" ${UI.busy?"disabled":""}>Unduh semua kartu (ZIP)</button>
      </div>
      <div class="qrgrid">${S.tables.map(t=>`<article class="card qcard">
        <div class="row" style="width:100%;justify-content:space-between"><h3>${esc(t.name)}</h3><span class="pill t-muted">${esc(t.area||"")}</span></div>
        <div class="qbox">${qrImg(qrText(t),300,"QR "+t.name)}</div>
        <div class="mono muted" style="word-break:break-all">/m/${esc(t.token)}</div>
        <div class="actions">
          <button class="btn" data-act="openLink" data-v="${esc(qrText(t))}">Buka menu</button>
          <button class="btn" data-act="preview" data-id="${esc(t.id)}">Kartu cetak</button>
          <button class="btn" data-act="copy" data-v="${esc(qrText(t))}">Salin tautan</button>
          <button class="btn danger" data-act="askRotate" data-id="${esc(t.id)}">Ganti kode</button>
        </div>
        ${confirmBar(t.id,"rotate")}
      </article>`).join("") || `<div class="empty">Memuat meja…</div>`}</div>
    </section>
    <aside class="card panel">
      <h2>Pengaturan kedai</h2>
      <label class="f" for="brandIn">Nama kedai<input type="text" id="brandIn" maxlength="40" data-bind="brandDraft" value="${esc(UI.brandDraft??S.brand)}"></label>
      <button class="btn primary" data-act="saveBrand">Simpan nama</button>
      <hr style="border:0;border-top:1px solid var(--line);width:100%">
      <p class="small muted">Setiap QR berisi alamat <b>${esc(location.host)}/m/</b> + kode acak meja. Kode acak mencegah orang menebak meja lain, dan bisa diganti kapan saja kalau stiker difoto atau dipalsukan.</p>
      <h3>Tips pemasangan</h3>
      <ul class="small" style="margin:0;padding-left:18px;display:grid;gap:4px">
        <li>Cetak di stiker doff atau akrilik, minimal 4×4 cm untuk QR.</li>
        <li>Tempel di tengah meja, jauh dari lampu yang memantul.</li>
        <li>Cek tiap pagi: stiker QR palsu yang ditempel di atasnya adalah modus penipuan yang umum.</li>
      </ul>
    </aside>
  </div>`;
}
function renderMenu(){
  return `<div class="row"><h1 class="grow">Menu & stok</h1><span class="small muted">Tandai “Habis” agar menu langsung tidak bisa dipesan di HP pelanggan.</span></div>
  <p class="small muted">Gambar bawaan adalah ilustrasi. Ganti dengan foto asli; foto otomatis dipotong 4:3 dan dikecilkan.</p>
  <div class="card scroll-x"><table class="mtable"><thead><tr><th>Foto</th><th>Menu</th><th>Kategori</th><th>Harga</th><th>Status</th></tr></thead><tbody>
  ${S.menu.map(m=>`<tr>
    <td style="min-width:120px"><img class="athumb" src="${imgOf(m)}" alt="${esc(m.name)}">
      <div class="row small" style="margin-top:6px;gap:10px"><label class="btn" style="min-height:30px;padding:2px 10px;font-size:12.5px" for="up-${esc(m.id)}">Ganti foto</label><input class="sr" type="file" accept="image/*" id="up-${esc(m.id)}" data-change="photo" data-id="${esc(m.id)}">
      ${m.photoUrl?`<button class="btn ghost" style="min-height:30px;padding:2px 4px;font-size:12.5px" data-act="resetPhoto" data-id="${esc(m.id)}">Pakai ilustrasi</button>`:""}</div></td>
    <td><b>${esc(m.name)}</b><div class="small muted">${esc(m.desc||"")}</div></td>
    <td>${esc(m.cat)}</td>
    <td><input type="number" id="price-${esc(m.id)}" min="1000" max="1000000" step="500" value="${Number(m.price)||0}" data-change="price" data-id="${esc(m.id)}" aria-label="Harga ${esc(m.name)}"></td>
    <td><button class="toggle ${m.available===false?"off":"on"}" data-act="toggleMenu" data-id="${esc(m.id)}">${m.available===false?"Habis":"Tersedia"}</button></td>
  </tr>`).join("")}
  </tbody></table></div>`;
}
function renderLogin(){
  return `<main class="login-wrap"><form class="card panel login" id="loginForm">
    <div class="brand"><b>${esc(S.brand)}</b><span>Dashboard staf</span></div>
    <h1>Masuk</h1>
    <label class="f" for="pw">Password staf<input type="password" id="pw" autocomplete="current-password" required minlength="8"></label>
    <button class="btn primary block lg" type="submit" ${UI.busy?"disabled":""}>${UI.busy?"Memeriksa…":"Masuk"}</button>
    <p class="small muted">Password diatur pemilik di Vercel (STAFF_PASSWORD). Sesi berlaku 12 jam di perangkat ini.</p>
  </form></main>`;
}

/* ================== Render: customer ================== */
function imgOf(m){ return (m && m.photoUrl) ? m.photoUrl : artUrl(kindOf(m||{})); }
function renderCustomer(){
  if (S.loading) return phone(`<div class="cpad" style="padding-top:48px;text-align:center"><p class="muted">Memuat menu…</p></div>`);
  if (S.error==="notfound") return phone(`<div class="cpad" style="padding-top:48px;text-align:center"><h1>QR tidak dikenali</h1><p class="muted">Kode QR ini sudah tidak berlaku atau bukan milik kedai ini. Minta bantuan kasir, dan jangan membayar ke QR lain.</p></div>`);
  if (S.error) return phone(`<div class="cpad" style="padding-top:48px;text-align:center"><h1>Menu belum bisa dimuat</h1><p class="muted">${esc(S.error)}</p><button class="btn primary" data-act="reload">Coba lagi</button></div>`);
  const t=S.table;
  const mine=myOrders();
  const ao=UI.activeOrderId && S.orders.find(o=>o.id===UI.activeOrderId);
  if (ao) return phone(head(t)+orderScreen(ao,t));
  const items=cartItems(); const tot=calc(items); const n=items.reduce((s,i)=>s+i.qty,0);
  const activeMine=mine.filter(o=>!["selesai","batal"].includes(o.status));
  const list=S.menu.filter(m=>m.cat===UI.cat);
  const body = `${head(t)}
    ${!S.net?`<div class="banner t-crit" style="margin:12px 14px 0">Koneksi terputus. Pesanan akan dikirim setelah internet kembali.</div>`:""}
    ${activeMine.slice(0,2).map(o=>`<button class="card mystrip" data-act="viewOrder" data-id="${esc(o.id)}"><span><b>Pesanan ${esc(o.code)}</b><br><span class="small">${stateOf(o).label}</span></span><span aria-hidden="true">›</span></button>`).join("")}
    <nav class="cats" aria-label="Kategori">${CATS.map(c=>`<button class="chip" data-act="cat" data-v="${c}" aria-pressed="${UI.cat===c}">${c}</button>`).join("")}</nav>
    <div class="mgrid">${list.length?list.map(m=>{ const q=UI.cart[m.id]||0; const so=m.available===false;
      return `<article class="card mc ${so?"so":""}"><div class="ph"><img src="${imgOf(m)}" alt="${esc(m.name)}" width="480" height="360">${so?`<span class="flag out">Habis</span>`:BEST.has(m.id)?`<span class="flag">Terlaris</span>`:""}</div>
      <div class="mb"><div class="nm">${esc(m.name)}</div><div class="ds">${esc(m.desc||"")}</div>
      <div class="pb"><span class="num" style="font-weight:700">${rp(m.price)}</span>${so?"":q?`<div class="step"><button data-act="dec" data-id="${esc(m.id)}" aria-label="Kurangi ${esc(m.name)}">−</button><span class="num">${q}</span><button data-act="inc" data-id="${esc(m.id)}" aria-label="Tambah ${esc(m.name)}">+</button></div>`:`<button class="plus" data-act="inc" data-id="${esc(m.id)}" aria-label="Tambah ${esc(m.name)}">+</button>`}</div></div></article>`;}).join(""):`<div class="empty" style="grid-column:1/-1">Belum ada menu di kategori ini.</div>`}</div>
    ${n?`<div class="cartbar"><button class="btn primary block lg" data-act="sheet"><span>${n} item</span><span>Lihat pesanan · ${rp(tot.total)}</span></button></div>`:""}`;
  return phone(body) + (UI.sheet?cartSheet(t,items,tot):"");
}
function head(t){
  return `<header class="hero"><img src="${heroUrl()}" alt="" width="960" height="400"><div class="hero-t"><span class="tbl">${esc(t.name)}</span><h1>${esc(S.brand)}</h1></div></header>
    <div class="subhead"><p class="small muted grow">Pesan dari HP, bayar ${S.demoPay?"pakai QRIS atau ":""}di kasir. Pesanan diantar ke ${esc(t.name)}.</p><button class="btn" style="min-height:34px;padding:4px 10px;font-size:13px;flex:none" data-act="callWaiter">Panggil pelayan</button></div>`;
}
function cartSheet(t,items,tot){
  return `<div class="sheet-bg" data-act="closeSheet" data-self="1"><div class="sheet${UI.sheetAnim?" anim":""}" role="dialog" aria-modal="true" aria-labelledby="sheetT">
    <div class="row"><h2 id="sheetT" class="grow">Pesanan ${esc(t.name)}</h2><button class="btn ghost" data-act="closeSheet" aria-label="Tutup">Tutup</button></div>
    <div style="display:grid;gap:10px">${items.map(i=>`<div class="row" style="flex-wrap:nowrap"><img class="cthumb" src="${imgOf(menuById(i.menuId))}" alt=""><div class="grow"><b>${esc(i.name)}</b><div class="small muted num">${rp(i.price)}</div></div>
      <div class="step"><button data-act="dec" data-id="${esc(i.menuId)}" aria-label="Kurangi">−</button><span class="num">${i.qty}</span><button data-act="inc" data-id="${esc(i.menuId)}" aria-label="Tambah">+</button></div>
      <div class="num" style="min-width:84px;text-align:right;font-weight:700">${rp(i.price*i.qty)}</div></div>`).join("")}</div>
    <label class="f" for="custName">Nama (untuk dipanggil)<input type="text" id="custName" maxlength="40" data-bind="custName" value="${esc(UI.custName)}" placeholder="mis. Rina"></label>
    <label class="f" for="note">Catatan untuk dapur<textarea id="note" maxlength="200" data-bind="note" placeholder="mis. kopi susu less sugar, tanpa es">${esc(UI.note)}</textarea></label>
    <div style="display:grid;gap:8px"><b class="small">Cara bayar</b>
      ${S.demoPay?`<label class="radio ${UI.pay==="qris"?"sel":""}" for="payQ"><input type="radio" id="payQ" name="pay" ${UI.pay==="qris"?"checked":""} data-act="pay" data-v="qris"><span><b>QRIS</b><br><span class="small muted">Semua m-banking & e-wallet. Pesanan langsung ke dapur setelah bayar.</span></span></label>`:""}
      <label class="radio ${UI.pay==="tunai"?"sel":""}" for="payT"><input type="radio" id="payT" name="pay" ${UI.pay==="tunai"?"checked":""} data-act="pay" data-v="tunai"><span><b>Bayar di kasir</b><br><span class="small muted">Tunai atau debit. Pesanan diproses setelah kasir menerima pembayaran.</span></span></label>
    </div>
    <div style="display:grid;gap:4px" class="num">
      <div class="line"><span class="muted">Subtotal</span><span>${rp(tot.subtotal)}</span></div>
      <div class="line"><span class="muted">Biaya layanan ${SERVICE_RATE*100}%</span><span>${rp(tot.service)}</span></div>
      <div class="line"><span class="muted">PB1 ${TAX_RATE*100}%</span><span>${rp(tot.tax)}</span></div>
      <div class="line total"><span>Total</span><span>${rp(tot.total)}</span></div>
    </div>
    <button class="btn primary block lg" data-act="place" ${UI.busy?"disabled":""}>${UI.busy?"Mengirim…":UI.pay==="qris"?"Pesan & bayar QRIS":"Pesan, bayar di kasir"}</button>
  </div></div>`;
}
function orderScreen(o,t){
  const st=stateOf(o);
  const back=`<button class="btn ghost" data-act="backMenu" style="justify-self:start;padding-left:0">‹ Kembali ke menu</button>`;
  const summary=`<div class="card cpad" style="gap:8px"><div class="row"><b class="grow">Rincian</b><span class="pill t-${st.tone}">${st.label}</span></div>
    ${(o.items||[]).map(i=>`<div class="line"><span>${i.qty}× ${esc(i.name)}</span><span class="num">${rp(i.price*i.qty)}</span></div>`).join("")}
    <div class="line small muted num"><span>Layanan + PB1</span><span>${rp((o.service||0)+(o.tax||0))}</span></div>
    <div class="line total num"><span>Total</span><span>${rp(o.total)}</span></div>
    ${o.payRef?`<div class="small muted">Ref. pembayaran <span class="mono">${esc(o.payRef)}</span></div>`:""}</div>`;
  if (o.status==="batal") return `<div class="cpad">${back}<div class="card cpad" style="text-align:center"><h2>Pesanan ${esc(o.code)} dibatalkan</h2><p class="muted small">${o.cancelledBy==="sistem"?"Pesanan tunai dibatalkan otomatis karena tidak dibayar dalam 30 menit. ":""}Tidak ada dana yang ditarik untuk pesanan yang belum dibayar.</p></div>${summary}</div>`;
  if (o.status==="menunggu_bayar"){
    if (o.payMethod==="tunai") return `<div class="cpad">${back}<div class="card paybox"><span class="small muted">Tunjukkan kode ini ke kasir</span><div class="amount" style="font-size:44px">${esc(o.code)}</div><div class="amount num" style="font-size:24px">${rp(o.total)}</div><p class="small muted">Pesanan masuk ke dapur setelah kasir menerima pembayaran. Bayar dalam 30 menit.</p></div>${summary}<button class="btn danger" data-act="custCancel" data-id="${esc(o.id)}">Batalkan pesanan</button></div>`;
    if (isExpired(o)) return `<div class="cpad">${back}<div class="card paybox"><h2>QR pembayaran kedaluwarsa</h2><p class="small muted">QRIS dinamis hanya berlaku 10 menit agar tidak bisa dipakai ulang.</p><button class="btn primary block lg" data-act="renewQr" data-id="${esc(o.id)}">Buat QR baru</button></div>${summary}<button class="btn danger" data-act="custCancel" data-id="${esc(o.id)}">Batalkan pesanan</button></div>`;
    const payload=`DEMO-QRIS|${S.brand}|${o.code}|${o.total}|${o.id}`;
    return `<div class="cpad">${back}<div class="card paybox">
      <span class="sim">Simulasi · bukan QRIS sungguhan</span>
      <span class="small muted">Bayar pesanan ${esc(o.code)}</span>
      <div class="amount num">${rp(o.total)}</div>
      <div class="qbox">${qrImg(payload,440,"QR pembayaran")}</div>
      <div class="small">Berlaku <b class="num" id="countdown" data-exp="${o.expiresAt}">--:--</b> lagi</div>
      <p class="small muted">Buka m-banking atau e-wallet, pilih Scan/QRIS, lalu bayar. Halaman ini berubah sendiri setelah pembayaran masuk.</p>
      ${S.demoPay?`<button class="btn primary block lg" data-act="simPaid" data-id="${esc(o.id)}">Simulasikan pembayaran berhasil</button>
      <p class="small muted">Tombol ini hanya untuk masa uji coba. Setelah payment gateway tersambung, status lunas datang otomatis dari server.</p>`:""}
    </div>${summary}<button class="btn danger" data-act="custCancel" data-id="${esc(o.id)}">Batalkan pesanan</button></div>`;
  }
  const step={antri:1,diproses:2,siap:3,selesai:4}[o.status]||0;
  const labels=["Dibayar","Dibuat","Siap","Diantar"];
  return `<div class="cpad">${back}<div class="card paybox"><span class="small muted">Nomor pesanan</span><div class="amount" style="font-size:44px">${esc(o.code)}</div>
    <div class="tracker" style="width:100%">${labels.map((l,i)=>`<div class="${i<step?"done":""}"><i></i>${l}</div>`).join("")}</div>
    <p class="small muted">${o.status==="selesai"?"Selamat menikmati!":o.status==="siap"?"Pesanan sedang diantar ke "+esc(t.name)+".":"Kami kabari di halaman ini saat pesananmu siap."}</p></div>
    ${summary}<button class="btn" data-act="backMenu">Pesan lagi</button></div>`;
}
function phone(inner){ return `<div class="cust-wrap"><div class="phone">${inner}</div></div>`; }
function renderLanding(){
  return `<main class="login-wrap"><div class="card panel login" style="text-align:center">
    <img src="${heroUrl()}" alt="" style="width:100%;border-radius:10px">
    <h1>${esc(S.brand)}</h1>
    <p class="muted">Untuk memesan, scan QR yang ada di mejamu dengan kamera HP.</p>
    <a class="btn" href="/staf">Masuk dashboard staf</a>
  </div></main>`;
}

/* ================== Render root ================== */
function render(){
  const ae=document.activeElement; const fid=ae&&ae.id; let ss=null,se=null;
  try { if(fid&&ae.selectionStart!=null){ ss=ae.selectionStart; se=ae.selectionEnd; } } catch(e) {}
  const app=document.getElementById("app");
  if (S.mode==="customer") app.innerHTML=renderCustomer();
  else if (S.mode==="staff") {
    if (!S.staffChecked) app.innerHTML=`<main class="login-wrap"><p class="muted">Memuat…</p></main>`;
    else if (!S.staff) { if(!document.getElementById("loginForm")) app.innerHTML=renderLogin(); return; }
    else { const v={kasir:renderKasir,dapur:renderDapur,meja:renderMeja,menu:renderMenu}[UI.view]||renderKasir; app.innerHTML=staffTop()+`<main class="staff">${v()}</main>`; }
  }
  else app.innerHTML=renderLanding();
  if (fid){ const el=document.getElementById(fid); if(el && el!==document.activeElement){ el.focus({preventScroll:true}); try{ if(ss!=null) el.setSelectionRange(ss,se); }catch(e){} } }
  tick();
}
function renderModal(){
  const box=document.getElementById("modal"); const m=UI.modal;
  if (!m){ box.innerHTML=""; return; }
  box.innerHTML=`<div class="modal-bg" data-act="closeModal" data-self="1"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mT">
    <div class="row"><h2 id="mT" class="grow">Kartu ${esc(m.t.name)}</h2><button class="btn ghost" data-act="closeModal">Tutup</button></div>
    <img src="${m.url}" alt="Pratinjau kartu meja ${esc(m.t.name)}">
    <p class="small muted">Ukuran A6 (10,5 × 14,8 cm) pada 300 dpi.</p>
    <button class="btn primary block" data-act="dlCard">Unduh PNG</button>
  </div></div>`;
}
function tick(){
  const el=document.getElementById("countdown"); if(!el) return;
  const left=Number(el.dataset.exp)-Date.now();
  if (left<=0){ render(); return; }
  const m=Math.floor(left/60000), s=Math.floor(left%60000/1000);
  el.textContent=String(m).padStart(2,"0")+":"+String(s).padStart(2,"0");
}
setInterval(tick,1000);
setInterval(()=>{ if(S.mode==="staff" && S.staff && (UI.view==="dapur"||UI.view==="kasir")) render(); },30000);

/* ================== Events ================== */
A.reload=()=>{ S.loading=true; S.error=""; render(); loadTable().then(()=>{ loadMine(); schedule(); }); };
document.addEventListener("click", e=>{
  const el=e.target.closest("[data-act]"); if(!el) return;
  if (el.dataset.self && e.target!==el) return;
  if (el.tagName==="A") e.preventDefault();
  const f=A[el.dataset.act]; if(f) f(el.dataset, el, e);
});
document.addEventListener("input", e=>{ const b=e.target.dataset&&e.target.dataset.bind; if(b) UI[b]=e.target.value; });
document.addEventListener("submit", async e=>{
  if (e.target.id!=="loginForm") return;
  e.preventDefault();
  const pw=document.getElementById("pw"); const val=pw.value;
  UI.busy=true; e.target.querySelector("button").disabled=true;
  try { await api("login",{password:val}); pw.value=""; S.staff=true; UI.busy=false; render(); enterStaff(); }
  catch(err) { UI.busy=false; e.target.querySelector("button").disabled=false; toast(err.message,"crit"); pw.select(); }
});
document.addEventListener("change", e=>{
  const c=e.target.dataset&&e.target.dataset.change; if(!c) return;
  if (c==="price"){
    const v=Math.round(Number(e.target.value));
    if (!(v>=1000 && v<=1000000)) { toast("Harga harus antara Rp1.000 dan Rp1.000.000.","crit"); render(); return; }
    attempt(api("menuUpdate",{id:e.target.dataset.id, price:v}),"Harga diperbarui.").then(()=>loadMenuAll());
  }
  if (c==="photo"){
    const id=e.target.dataset.id, f=e.target.files&&e.target.files[0]; e.target.value="";
    if (!f) return;
    shrinkPhoto(f).then(d=>attempt(api("menuPhoto",{id, data:d}),"Foto menu diperbarui.")).then(()=>loadMenuAll(), err=>toast(err.message,"crit"));
  }
});
document.addEventListener("keydown", e=>{ if(e.key==="Escape"){ if(UI.modal) A.closeModal(); else if(UI.sheet) A.closeSheet(); } });

/* ================== Start ================== */
(function start(){
  const p=location.pathname.replace(/\/+$/,"");
  const m=p.match(/^\/m\/([A-Za-z0-9_-]{6,40})$/);
  if (m){ S.mode="customer"; UI.token=m[1]; render(); loadTable().then(()=>{ menuT=Date.now(); loadMine(); schedule(); }); return; }
  if (p==="/staf"){ S.mode="staff"; UI.view=["kasir","dapur","meja","menu"].includes(location.hash.slice(1))?location.hash.slice(1):"kasir"; render();
    api("me").then(j=>{ S.staff=!!j.staff; }).catch(()=>{}).finally(()=>{ S.staffChecked=true; render(); if(S.staff) enterStaff(); }); return; }
  S.mode="landing"; render();
})();
