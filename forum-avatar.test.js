import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {randomBytes} from 'node:crypto';import sharp from 'sharp';
import {createApp} from './server.js';import {forumProfile,extractForumAvatar,normalizeForumAvatar,fetchForumAvatar} from './forum-avatar.js';
const profile='https://forum.gta-samp.ru/index.php?/profile/233224-example/';
const full='https://forum.gta-samp.ru/uploads/avatar.png',thumb='https://forum.gta-samp.ru/uploads/avatar.thumb.png';
const html=`<link rel="canonical" href="${profile}"><div class="ipsUserPhoto"><img src="https://evil.example/visitor.png"></div><div id="elProfilePhoto"><a data-ipslightbox href="${full}"><img src="${thumb}"></a></div>`;
const png=await sharp({create:{width:200,height:200,channels:4,background:'#4e91ff'}}).png().toBuffer();
test('validates forum profile host and path; never accepts arbitrary fetch URLs',()=>{
 assert.equal(forumProfile(profile).id,'233224');
 for(const url of ['http://forum.gta-samp.ru/index.php?/profile/1-a/','https://evil.example/index.php?/profile/1-a/','https://forum.gta-samp.ru.evil.example/index.php?/profile/1-a/','https://admin:password@forum.gta-samp.ru/index.php?/profile/1-a/','https://forum.gta-samp.ru/index.php?/topic/1-a/','https://127.0.0.1/'])assert.throws(()=>forumProfile(url));
});
test('extracts only the requested profile owner avatar, preferring its original photo',()=>{
 assert.deepEqual(extractForumAvatar(html,forumProfile(profile)),[full,thumb]);
 assert.throws(()=>extractForumAvatar(html.replace('233224-example','123-other'),forumProfile(profile)));
 assert.throws(()=>extractForumAvatar(`<link rel="canonical" href="${profile}"><div id="elProfilePhoto"><img src="data:image/svg+xml,default"></div>`,forumProfile(profile)),{status:404});
});
test('supports ordinary anonymous Refresh cookies without credentials or external redirects',async()=>{
 const seen=[];
 const result=await fetchForumAvatar(profile,{fetchImpl:async(url,options)=>{seen.push({url,headers:options.headers});if(seen.length===1)return new Response('',{headers:{Refresh:'0','Set-Cookie':'visitor=test; Path=/; Secure'}});if(seen.length===2){assert.equal(options.headers.Cookie,'visitor=test');return new Response(html);}assert.equal(url,full);return new Response(png);}});
 assert.equal(seen.length,3);assert.equal(result.mime,'image/jpeg');assert(result.bytes.length<=300*1024);assert.equal(result.width,200);
 let calls=0;await assert.rejects(fetchForumAvatar(profile,{fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{Location:'https://127.0.0.1/private'}});}}));assert.equal(calls,1);
});
test('resizes, converts and compresses large raster input, rejecting SVG and corrupt images',async()=>{
 const input=await sharp(randomBytes(1024*800*3),{raw:{width:1024,height:800,channels:3}}).png().toBuffer();
 const output=await normalizeForumAvatar(input);assert(output.bytes.length<=300*1024);const metadata=await sharp(output.bytes).metadata();assert.equal(metadata.format,'jpeg');assert.equal(metadata.width,512);assert.equal(metadata.height,512);
 await assert.rejects(normalizeForumAvatar(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),{status:415});
 await assert.rejects(normalizeForumAvatar(Buffer.from([255,216,255,0,0])),{status:415});
});
test('bounds source downloads and reports unavailable forum instead of inventing an avatar',async()=>{
 await assert.rejects(fetchForumAvatar(profile,{fetchImpl:async()=>new Response('blocked',{status:403})}),{status:502});
 await assert.rejects(fetchForumAvatar(profile,{fetchImpl:async()=>new Response('large',{headers:{'content-length':String(3*1024*1024)}})}),{status:413});
});
async function withApp(role,run){
 const calls=[];const token='a'.repeat(64);
 const fetchImpl=async(url,options)=>{
  calls.push({url,method:options.method});
  if(url.startsWith('https://forum.gta-samp.ru'))return new Response(url.includes('/uploads/')?png:html);
  if(url.includes('/storage/v1/object/')){assert.equal(options.headers['Content-Type'],'image/jpeg');assert(options.body.length<=300*1024);return new Response('{}');}
  let body;const path=new URL(url).pathname.replace('/rest/v1/','');
  if(path==='ws_sessions')body=[{created_at:new Date().toISOString()}];
  else if(path==='rpc/ws_admin_access_state')body={ok:1,login:'admin_test',nickname:'Admin_Test'};
  else if(path==='pd_ws_roles')body=[{role,department:'LSPD'}];
  else throw Error('Unexpected database mutation or query: '+path);
  return new Response(JSON.stringify(body));
 };
 const server=http.createServer(createApp({env:{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_test_key_very_long'},fetchImpl}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=async(auth=true,data={slot:'minister',forum_url:profile})=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/portal/admin/leadership/forum-avatar`,{method:'POST',headers:{Origin:'https://police-department.ru','Content-Type':'application/json',...(auth?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});return {status:r.status,data:await r.json()};};
 try{await run(request,calls);}finally{await new Promise(r=>server.close(r));}
}
test('only authenticated admin/developer may import, before any forum or storage access',async()=>{
 await withApp('admin',async(request,calls)=>{assert.equal((await request(false)).status,401);assert.equal(calls.length,0);});
 for(const role of ['user','senior','leader','minister'])await withApp(role,async(request,calls)=>{assert.equal((await request()).status,403);assert(!calls.some(x=>x.url.startsWith('https://forum.')||x.url.includes('/storage/')));});
});
test('admin and developer upload one normalized avatar without changing leadership records',async()=>{
 for(const role of ['admin','developer'])await withApp(role,async(request,calls)=>{
  const r=await request();assert.equal(r.status,200);assert.equal(r.data.mime,'image/jpeg');assert.match(r.data.avatar_url,/\/ws-avatars\/leadership\/minister-[a-f0-9]+\.jpg$/);assert(r.data.size<=300*1024);
  assert.equal(calls.filter(x=>x.url.includes('/storage/')).length,1);assert(!calls.some(x=>x.method==='PATCH'||x.url.includes('pd_portal_admin_events')));
 });
});
