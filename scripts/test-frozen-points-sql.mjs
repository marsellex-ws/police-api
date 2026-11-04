// Optional local test dependency; see migrations/README.md.
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const db=new PGlite();
await db.exec(`
create role anon;create role authenticated;create role service_role;
create table pd_ws_roles(login text primary key,role text,department text);
create table ws_profiles(login text primary key,nickname text);
create table pd_quest_members(id uuid primary key default gen_random_uuid(),department text,track text,nickname text,balance numeric not null default 0,unique(department,nickname,track));
create table pd_quest_legacy_history(id bigint primary key,track text,department text,nickname text,description text,amount text,before_points text,after_points text,event_date date,date_text text,needs_review boolean,source_data jsonb);
create table pd_quest_ledger(id uuid default gen_random_uuid(),department text,nickname text,amount numeric);
create function pd_quest_adjust_balance(p_department text,p_track text,p_nickname text,p_amount numeric,p_reviewer text,p_reason text) returns jsonb language plpgsql as $$begin
update pd_quest_members set balance=balance+p_amount where department=p_department and track=p_track and nickname=p_nickname;
insert into pd_quest_ledger(department,nickname,amount)values(p_department,p_nickname,p_amount);return jsonb_build_object('ok',true);end$$;
insert into pd_ws_roles values ('admin','admin','ALL'),('dev','developer','ALL'),('minister','minister','ALL'),('chief','leader','LSPD'),('wrongdept','leader','SFPD'),('senior','senior','LSPD'),('impostor','leader','LSPD');
insert into ws_profiles values('chief','Chief_Name'),('wrongdept','Chief_Name'),('senior','Chief_Name'),('impostor','Other_Name');
insert into pd_quest_members(department,track,nickname,balance) values('LSPD','leader','Chief_Name',30);
insert into pd_quest_legacy_history(id,track,department,nickname,description,source_data) select n,'leader','LSPD','Chief_Name','Заморозка баллов','{"values":[null,null,null,null,null,null,null,false]}' from generate_series(1,10)n;
update pd_quest_legacy_history set source_data='{"values":[null,null,null,null,null,null,null,true]}'where id=8;
`);
const migration=await readFile(new URL('../migrations/20261104_leader_frozen_points.sql',import.meta.url),'utf8');await db.exec(migration);await db.exec(migration);
let checks=0;
const call=async(sql,args)=> (await db.query(sql,args)).rows[0].result;
const imp=(id,amount,actor='admin')=>call('select pd_quest_import_leader_freeze($1,$2,$3) result',[String(id),amount,actor]);
const thaw=(id,target='chief',actor='admin')=>call('select pd_quest_thaw_leader_points($1,$2,$3) result',[id,target,actor]);
for(const actor of ['chief','minister','senior']){assert.equal((await imp(1,300,actor)).status,403);checks++;}
for(const amount of [0,401,1.001]){assert.equal((await imp(1,amount)).status,400);checks++;}
assert.equal((await imp(8,300)).status,409);checks++;
const frozen=(await imp(1,300)).item;assert(frozen);assert.equal((await imp(1,300)).status,409);checks++;
for(const actor of ['chief','minister','senior']){assert.equal((await thaw(frozen.id,'chief',actor)).status,403);checks++;}
for(const target of ['wrongdept','senior','impostor','missing']){assert.equal((await thaw(frozen.id,target)).status,409);checks++;}
const result=await thaw(frozen.id);assert.equal(result.balance,330);assert.equal(result.item.status,'thawed');assert.equal(result.item.balance_before,30);checks++;
assert.equal((await thaw(frozen.id)).status,409);assert.equal((await db.query('select count(*)::int n from pd_quest_ledger')).rows[0].n,1);checks++;
assert.equal((await db.query("select source_data->'values'->7 as value from pd_quest_legacy_history where id=1")).rows[0].value,true);checks++;
const concurrent=(await imp(2,50)).item;const responses=await Promise.all([thaw(concurrent.id),thaw(concurrent.id)]);assert.equal(responses.filter(x=>x.ok).length,1);assert.equal(Number((await db.query('select balance from pd_quest_members')).rows[0].balance),380);checks++;
const rollback=(await imp(3,25)).item;await db.exec(`create function reject_ledger()returns trigger language plpgsql as $$begin raise exception 'test ledger failure';end$$;create trigger ledger_failure before insert on pd_quest_ledger for each row execute function reject_ledger();`);
await assert.rejects(thaw(rollback.id),/test ledger failure/);assert.equal(Number((await db.query('select balance from pd_quest_members')).rows[0].balance),380);assert.equal((await db.query('select status from pd_quest_leader_frozen where id=$1',[rollback.id])).rows[0].status,'frozen');checks++;
await db.exec('drop trigger ledger_failure on pd_quest_ledger;');
const flag=(await imp(4,30)).item;await db.exec(`update pd_quest_legacy_history set source_data='{"values":[null,null,null,null,null,null,null,true]}' where id=4;`);assert.equal((await thaw(flag.id)).status,409);checks++;
const dev=(await imp(5,5,'dev')).item;assert.equal((await thaw(dev.id,'chief','dev')).ok,true);checks++;
for(const role of ['anon','authenticated']){assert.equal((await db.query("select has_function_privilege($1,'pd_quest_thaw_leader_points(uuid,text,text)','execute') x",[role])).rows[0].x,false);checks++;}
console.log('PostgreSQL checks passed:',checks);await db.close();
