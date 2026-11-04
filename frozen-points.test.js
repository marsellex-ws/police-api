import test from 'node:test';
import assert from 'node:assert/strict';
import {handleFrozenPoints} from './frozen-points-api.js';
const ID='31bf20da-3c21-401f-a229-12d6cf7a9d33';
class HttpError extends Error{constructor(status,message){super(message);this.status=status;}}
function fixture(role='admin',body={}){
 const queries=[],calls=[];
 let response;
 const args={req:{method:'GET'},res:{},url:new URL('https://example.test/api/portal/quests/frozen'),identity:async()=>({login:'trusted',role,department:'LSPD'}),bodyJson:async()=>body,HttpError,send:(res,status,data)=>{response={status,data};},supabase:async(method,route)=>{queries.push(route);return route.startsWith('pd_quest_leader_frozen')?[]:[{id:1,department:'LSPD',nickname:'Chief',description:'Заморозка',source_data:{values:[null,null,null,null,null,null,null,false]}},{id:2,department:'LSPD',description:'Заморозка',source_data:{values:[null,null,null,null,null,null,null,true]}}];},rpc:async(name,params)=>{calls.push({name,params});return {ok:true,item:{id:ID}};}};
 return {args,queries,calls,get response(){return response;}};
}
test('chief sees only own department and cannot read raw legacy freeze candidates',async()=>{
 const f=fixture('leader');await handleFrozenPoints(f.args);assert.match(f.queries[0],/department=eq.LSPD/);assert.equal(f.queries.length,1);assert.equal(f.response.data.can_manage,false);assert.deepEqual(f.response.data.legacy,[]);
});
test('ordinary members cannot enumerate leader frozen balances',async()=>{
 const f=fixture('senior');await assert.rejects(handleFrozenPoints(f.args),{status:403});assert.equal(f.queries.length,0);
});
test('chief and minister cannot thaw even with a forged admin field',async()=>{
 for(const role of ['leader','minister']){const f=fixture(role,{target_login:'chief',actor:'admin'});f.args.req.method='POST';f.args.url.pathname+='/'+ID+'/thaw';await assert.rejects(handleFrozenPoints(f.args),{status:403});assert.equal(f.calls.length,0);}
});
test('administrator imports only unthawed legacy candidates',async()=>{
 const f=fixture();await handleFrozenPoints(f.args);assert.equal(f.response.data.can_manage,true);assert.deepEqual(f.response.data.legacy.map(x=>x.id),[1]);assert(!('source_data' in f.response.data.legacy[0]));
});
test('developer transfers via atomic RPC using session actor, never supplied amount',async()=>{
 const f=fixture('developer',{target_login:'CHIEF',actor:'forged',amount:9999});f.args.req.method='POST';f.args.url.pathname+='/'+ID+'/thaw';await handleFrozenPoints(f.args);assert.deepEqual(f.calls,[{name:'pd_quest_thaw_leader_points',params:{p_id:ID,p_target_login:'chief',p_actor:'trusted'}}]);
});
test('database rejection for reused or wrong-department freeze is an HTTP conflict',async()=>{
 const f=fixture('admin',{target_login:'chief'});f.args.req.method='POST';f.args.url.pathname+='/'+ID+'/thaw';f.args.rpc=async()=>({ok:false,status:409,error:'Баллы уже разморожены'});await assert.rejects(handleFrozenPoints(f.args),{status:409});
});
test('import rejects over-cap, zero and sub-cent amounts without writing',async()=>{
 for(const amount of [401,0,1.001]){const f=fixture('admin',{history_id:'1',amount});f.args.req.method='POST';f.args.url.pathname+='/import';await assert.rejects(handleFrozenPoints(f.args),{status:400});assert.equal(f.calls.length,0);}
});
test('missing migration returns actionable service-unavailable status',async()=>{
 const f=fixture();f.args.supabase=async()=>{throw Error('table missing');};await assert.rejects(handleFrozenPoints(f.args),{status:503});
});
