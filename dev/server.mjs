import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const ROOT=new URL('..', import.meta.url).pathname.replace(/\/$/,'');
const { default: handler } = await import(ROOT + '/api/index.js');
http.createServer(async (req,res)=>{
  const u=new URL(req.url,'http://localhost');
  res.status=(c)=>{res.statusCode=c; return res}; res.json=(o)=>{ res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(o)); return res; };
  if (u.pathname==='/api'){
    let body=''; for await (const c of req) body+=c;
    try { req.body = body ? JSON.parse(body) : {}; } catch { req.body = {}; }
    req.query=Object.fromEntries(u.searchParams);
    return handler(req,res);
  }
  const f=(u.pathname==='/'||u.pathname==='/staf'||u.pathname.startsWith('/m/'))?'index.html':u.pathname.slice(1);
  const p=path.join(ROOT,f); if(!p.startsWith(ROOT)||!fs.existsSync(p)){res.statusCode=404; return res.end('404');}
  res.setHeader('Content-Type', p.endsWith('.html')?'text/html; charset=utf-8':p.endsWith('.css')?'text/css':p.endsWith('.js')?'text/javascript':'application/octet-stream'); fs.createReadStream(p).pipe(res);
}).listen(3000, ()=>console.log('DEV READY'));
