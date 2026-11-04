import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createApp} from './server.js';

const token='a'.repeat(64), id='31bf20da-3c21-401f-a229-12d6cf7a9d33';
async function withApp(role,run){
 const calls=[];
 const fetchImpl=async(input,options)=>{
  const url=new URL(input),path=url.pathname.replace('/rest/v1/','');
  calls.push({path,query:url.searchParams,body:options.body?JSON.parse(options.body):null});
  let body;
  if(path==='ws_sessions')body=[{created_at:new Date().toISOString()}];
  else if(path==='rpc/ws_admin_access_state')body={ok:1,login:'trusted',nickname:'Chief_Name'};
  else if(path==='pd_ws_roles')body=[{role,department:'LSPD'}];
  else if(path==='pd_quest_leader_frozen'||path==='pd_quest_legacy_history')body=[];
  else if(path==='rpc/pd_quest_thaw_leader_points')body={ok:true,item:{id,status:'thawed'},balance:330};
  else throw Error('Unexpected database request: '+path);
  return {ok:true,status:200,text:async()=>JSON.stringify(body)};
 };
 const server=http.createServer(createApp({env:{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_local_test_only_key'},fetchImpl}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}/api/portal/quests/frozen`;
 const request=async(path='',body,authenticated=true)=>{
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:'https://marsellex.ru',...(authenticated?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json()};
 };
 try{await run(request,calls);}finally{await new Promise(resolve=>server.close(resolve));}
}

test('HTTP frozen routes require a fresh WS session before accessing the registry',()=>withApp('admin',async(request,calls)=>{
 assert.equal((await request('',undefined,false)).status,401);
 assert.equal(calls.length,0);
}));
test('HTTP chief reads only their department and minister can read all departments',async()=>{
 for(const role of ['leader','minister'])await withApp(role,async(request,calls)=>{
  const response=await request();assert.equal(response.status,200);assert.equal(response.body.can_manage,false);
  assert.equal(calls.find(x=>x.path==='pd_quest_leader_frozen').query.get('department'),role==='leader'?'eq.LSPD':null);
  assert(!calls.some(x=>x.path==='pd_quest_legacy_history'));
 });
});
test('HTTP thaw rejects chiefs, ministers and ordinary members before a mutation',async()=>{
 for(const role of ['leader','minister','senior'])await withApp(role,async(request,calls)=>{
  assert.equal((await request('/'+id+'/thaw',{target_login:'chief',actor:'admin',amount:999})).status,403);
  assert(!calls.some(x=>x.path.startsWith('rpc/pd_quest_')));
 });
});
test('HTTP admin and developer thaw use the authenticated actor and database amount',async()=>{
 for(const role of ['admin','developer'])await withApp(role,async(request,calls)=>{
  const response=await request('/'+id+'/thaw',{target_login:'CHIEF',actor:'forged',amount:999});
  assert.equal(response.status,200);assert.equal(response.body.balance,330);
  assert.deepEqual(calls.find(x=>x.path==='rpc/pd_quest_thaw_leader_points').body,{p_id:id,p_target_login:'chief',p_actor:'trusted'});
 });
});
