/* Run with: node --use-env-proxy scripts/database.mjs [--apply migration.sql]
   SUPABASE_ACCESS_TOKEN is provided only through secure environment settings. */
import {readFile} from 'node:fs/promises';
const ref=process.env.SUPABASE_PROJECT_REF,token=process.env.SUPABASE_ACCESS_TOKEN;
if(!/^[a-z]{20}$/.test(ref||'')||!token){console.error('Configure SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN in environment settings.');process.exit(1);}
const apply=process.argv[2]==='--apply';
if((process.argv.length>2&&!apply)||(apply&&process.argv.length!==4)){console.error('Usage: node --use-env-proxy scripts/database.mjs [--apply migration.sql]');process.exit(1);}
const query=apply?await readFile(process.argv[3],'utf8'):`select jsonb_build_object(
 'columns',(select jsonb_agg(c) from (select table_name,column_name,data_type from information_schema.columns where table_schema='public' and table_name in ('pd_quest_members','pd_quest_ledger','pd_quest_legacy_history','pd_quest_leader_frozen','pd_ws_roles','ws_profiles') order by table_name,ordinal_position)c),
 'balance_function',(select jsonb_agg(f) from (select p.proname,pg_get_function_identity_arguments(p.oid) arguments,pg_get_function_result(p.oid) result from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='pd_quest_adjust_balance')f),
 'member_constraints',(select jsonb_agg(pg_get_constraintdef(oid)) from pg_constraint where conrelid=to_regclass('public.pd_quest_members'))
) schema_check`;
try{
 const response=await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(60000)});
 if(!response.ok){console.error('Supabase SQL API returned HTTP '+response.status+'. Check project access and the environment network configuration.');process.exit(1);}
 const data=await response.json();if(apply)console.log('Migration request completed. Run the schema check to verify.');else console.log(JSON.stringify(data,null,2));
}catch(error){console.error('Database request failed: '+(error.name==='TimeoutError'?'timeout':error.code||error.cause?.code||'network error'));process.exit(1);}
