import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createApp} from './server.js';
import adapter from './api/index.js';
async function run(handler,fn){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));try{await fn(`http://127.0.0.1:${s.address().port}`);}finally{await new Promise(r=>s.close(r));}}
test('production CORS survives legacy environment settings and rejects unrelated origins',async()=>{
 await run(createApp({env:{ALLOWED_ORIGINS:'https://marsellex.ru'}}),async base=>{
  for(const origin of ['https://police-department.ru','https://www.police-department.ru']){
   const r=await fetch(base+'/api/auth/me',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'Authorization, Content-Type'}});
   assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),origin);assert.match(r.headers.get('access-control-allow-headers'),/Authorization, Content-Type/);assert.equal(r.headers.get('vary'),'Origin');
   const health=await fetch(base+'/health',{headers:{Origin:origin}});assert.equal(health.status,200);assert.equal(health.headers.get('access-control-allow-origin'),origin);
  }
  const denied=await fetch(base+'/health',{headers:{Origin:'https://untrusted.example'}});assert.equal(denied.status,403);assert.equal(denied.headers.get('access-control-allow-origin'),null);
 });
});
test('Vercel rewrites reach health and nested API handlers while preserving query parameters',async()=>{
 const config=JSON.parse(await readFile(new URL('./vercel.json',import.meta.url),'utf8'));
 assert.deepEqual(config.rewrites,[{source:'/health',destination:'/api/index?__police_path=health'},{source:'/api/:path*',destination:'/api/index?__police_path=api/:path*'}]);
 await run(adapter,async base=>{
  const health=await fetch(base+'/api/index?__police_path=health&probe=1');assert.equal(health.status,200);assert.equal((await health.json()).service,'police-api');
  const auth=await fetch(base+'/api/index?__police_path=api/auth/me&probe=1');assert.equal(auth.status,401);assert.equal((await auth.json()).error,'Sign in required');
 });
});
