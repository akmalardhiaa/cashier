const B='http://localhost:3000/api'; let cookie='';
async function call(op, data={}, ip='1.1.1.1'){ const r=await fetch(B,{method:'POST',headers:{'content-type':'application/json',cookie,'x-forwarded-for':ip},body:JSON.stringify({op,...data})}); const sc=r.headers.get('set-cookie'); if(sc) cookie=sc.split(';')[0]; return {s:r.status, j:await r.json()}; }
const ok=(c,m)=>console.log((c?'PASS ':'FAIL ')+m);
let r=await call('login',{password:'salah-salah'}); ok(r.s===401,'login salah ditolak');
r=await call('board'); ok(r.s===401,'board tanpa login ditolak');
r=await call('login',{password:'' + (process.env.STAFF_PASSWORD || 'uji-coba-123') + ''}); ok(r.s===200 && cookie.startsWith('kr_staff='),'login benar');
r=await call('tables'); ok(r.j.tables.length===8,'8 meja awal'); const t=r.j.tables[2];
r=await call('table',{token:t.token}); ok(r.s===200 && r.j.menu.length===15 && r.j.table.name==='Meja 03','menu via token meja');
r=await call('table',{token:'tebaktebak'}); ok(r.s===404,'token asal ditolak');
const sid='sess'+Math.random().toString(36).slice(2).padEnd(20,'x');
r=await call('order',{token:t.token,session:sid,idem:'idem00000001',pay:'qris',name:'Rina',note:'<img src=x onerror=alert(1)>',items:[{menuId:'m03',qty:2,price:1},{menuId:'m05',qty:1}]});
ok(r.s===200 && r.j.order.subtotal===78000 && r.j.order.total===78000+3900+8190,'harga dihitung server (abaikan price dari klien): '+r.j.order?.total);
const o1=r.j.order;
r=await call('order',{token:t.token,session:sid,idem:'idem00000001',pay:'qris',items:[{menuId:'m03',qty:2}]}); ok(r.s===200 && r.j.order.id===o1.id,'idempotency: klik ganda = 1 pesanan');
r=await call('order',{token:t.token,session:sid,idem:'idem00000002',pay:'qris',items:[{menuId:'m01',qty:1}]}); ok(r.s===409 && r.j.orderId===o1.id,'pesanan ke-2 diblok sebelum bayar');
r=await call('status',{id:o1.id,to:'diproses'}); ok(r.s===409,'dapur tidak bisa proses pesanan belum lunas');
r=await call('simpay',{session:'lainlainlainlainlain',id:o1.id}); ok(r.s===409,'sesi lain tidak bisa melunasi pesanan orang');
r=await call('simpay',{session:sid,id:o1.id}); ok(r.s===200,'simulasi bayar QRIS');
r=await call('mine',{token:t.token,session:sid}); ok(r.j.orders[0].status==='antri','status antri setelah lunas');
r=await call('cancel',{session:sid,id:o1.id}); ok(r.s===409,'pesanan lunas tidak bisa dibatalkan pelanggan');
r=await call('status',{id:o1.id,to:'batal'}); ok(r.s===409,'kasir tidak bisa batalkan pesanan lunas');
r=await call('status',{id:o1.id,to:'constructor'}); ok(r.s===400,'status aneh ditolak');
for (const to of ['diproses','siap','selesai']){ r=await call('status',{id:o1.id,to}); ok(r.s===200,'transisi '+to); }
// tunai
const sid2='sess2'+Math.random().toString(36).slice(2).padEnd(20,'y');
r=await call('order',{token:t.token,session:sid2,idem:'idem00000003',pay:'tunai',items:[{menuId:'m10',qty:1}]}); const o2=r.j.order; ok(r.s===200 && o2.code.startsWith('I-'),'pesanan tunai '+o2.code);
r=await call('menuUpdate',{id:'m10',available:false}); ok(r.s===200,'tandai habis');
r=await call('order',{token:t.token,session:'sess3xxxxxxxxxxxxxxxxx',idem:'idem00000004',pay:'tunai',items:[{menuId:'m10',qty:1}]}); ok(r.s===409 && /habis/.test(r.j.error),'menu habis tidak bisa dipesan');
await call('menuUpdate',{id:'m10',available:true});
r=await call('cashpaid',{id:o2.id}); ok(r.s===200,'kasir terima tunai');
r=await call('cashpaid',{id:o2.id}); ok(r.s===409,'terima tunai 2x ditolak');
r=await call('menuUpdate',{id:'m01',price:5}); ok(r.s===400,'harga di luar batas ditolak');
r=await call('board'); ok(r.j.orders.length===2,'board berisi 2 pesanan');
r=await call('call',{token:t.token,session:sid}); ok(r.s===200,'panggil pelayan'); r=await call('board'); ok(r.j.calls.length===1,'panggilan muncul di kasir');
// rotate
r=await call('tableRotate',{id:t.id}); r=await call('table',{token:t.token}); ok(r.s===404,'QR lama mati setelah ganti kode');
// photo
const jpg='data:image/jpeg;base64,'+Buffer.from([0xff,0xd8,0xff,0xe0,...Array(200).fill(1)]).toString('base64');
r=await call('menuPhoto',{id:'m01',data:jpg}); ok(r.s===200,'upload foto');
r=await call('menuPhoto',{id:'m01',data:'data:image/svg+xml;base64,PHN2Zz4='}); ok(r.s===400,'foto non-JPEG ditolak');
r=await call('menuAll'); const url=r.j.menu.find(m=>m.id==='m01').photoUrl; const pr=await fetch('http://localhost:3000'+url); ok(pr.status===200 && pr.headers.get('content-type')==='image/jpeg','foto bisa diambil: '+url);
// rate limit order per IP
let blocked=false; for(let i=0;i<9;i++){ const s='rl'+i+'xxxxxxxxxxxxxxxxxxxx'; const tt=(await call('tables')).j.tables[0]; r=await call('order',{token:tt.token,session:s,idem:'rate000000'+i,pay:'tunai',items:[{menuId:'m01',qty:1}]},'9.9.9.9'); if(r.s===429) blocked=true; } ok(blocked,'rate limit 8 pesanan / 10 menit per IP');
// login brute force
cookie=''; let lim=false; for(let i=0;i<7;i++){ r=await call('login',{password:'x'+i+'zzzzzzz'},'7.7.7.7'); if(r.s===429) lim=true; } ok(lim,'login dikunci setelah 5 kali salah');
r=await call('nonexistent'); ok(r.s===404,'operasi asing ditolak');
r=await call('__proto__'); ok(r.s===404,'__proto__ ditolak');
