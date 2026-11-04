/* Frozen leader balances. Database RPCs lock and transfer points atomically. */
const DEPARTMENTS=new Set(['LSPD','SFPD','LVPD']);
const columns='id,source_history_id,department,nickname,amount,status,created_at,imported_by,thawed_at,thawed_by,target_login,balance_before,balance_after';
const isThawed=row=>['true','да','1'].includes(String(row.source_data?.values?.[7]??'').toLowerCase());
export async function handleFrozenPoints({req,url,supabase,identity,rpc,bodyJson,send,res,HttpError}){
 if(!/^\/api\/portal\/quests\/frozen(?:\/|$)/.test(url.pathname))return false;
 const user=await identity(req);
 const manager=['admin','developer'].includes(user.role);
 if(!user.login||!['admin','developer','minister','leader'].includes(user.role))throw new HttpError(403,'Раздел доступен шефам и администрации');
 const reply=(result)=>{
  if(result?.ok!==true)throw new HttpError([400,403,404,409].includes(result?.status)?result.status:502,result?.error||'Операция не выполнена');
  send(res,200,result);return true;
 };
 if(req.method==='GET'&&url.pathname==='/api/portal/quests/frozen'){
  if(user.role==='leader'&&!DEPARTMENTS.has(user.department))throw new HttpError(403,'Не назначен департамент');
  const query=new URLSearchParams({select:columns,order:'created_at.desc',limit:'1000'});
  if(user.role==='leader')query.set('department','eq.'+user.department);
  let items;
  try{items=await supabase('GET','pd_quest_leader_frozen?'+query);}
  catch{throw new HttpError(503,'Учёт заморозок пока недоступен. Администратору необходимо применить миграцию базы данных.');}
  let legacy=[];
  if(manager){
   const rows=await supabase('GET','pd_quest_legacy_history?'+new URLSearchParams({select:'id,department,nickname,description,amount,before_points,after_points,event_date,date_text,needs_review,source_data',track:'eq.leader',description:'ilike.*замороз*',order:'id.desc',limit:'1000'}));
   const registered=new Set(items.map(x=>String(x.source_history_id)));
   legacy=rows.filter(x=>DEPARTMENTS.has(x.department)&&!registered.has(String(x.id))&&!isThawed(x)&&!/размороз/i.test(x.description||'')).map(({source_data,...row})=>row);
  }
  send(res,200,{ok:true,items,legacy,can_manage:manager,department:user.department||null});return true;
 }
 // Role checks precede body parsing and every RPC. Minister and leader are read-only.
 if(!manager)throw new HttpError(403,'Размораживать и подтверждать заморозки могут только администратор и разработчик');
 if(req.method==='POST'&&url.pathname==='/api/portal/quests/frozen/import'){
  const input=await bodyJson(req,1000),id=String(input.history_id??'');
  const amount=Number(input.amount);
  if(!/^[a-zA-Z0-9-]{1,80}$/.test(id)||!Number.isFinite(amount)||amount<=0||amount>400||Math.abs(Math.round(amount*100)-amount*100)>1e-7)throw new HttpError(400,'Укажите архивную строку и сумму до 400 баллов, максимум два знака после запятой');
  return reply(await rpc('pd_quest_import_leader_freeze',{p_history_id:id,p_amount:amount,p_actor:user.login}));
 }
 const match=/^\/api\/portal\/quests\/frozen\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/thaw$/i.exec(url.pathname);
 if(req.method==='POST'&&match){
  const input=await bodyJson(req,500),target=String(input.target_login||'').trim().toLowerCase();
  if(!/^[a-z0-9_.-]{2,32}$/.test(target))throw new HttpError(400,'Укажите логин аккаунта действующего шефа');
  return reply(await rpc('pd_quest_thaw_leader_points',{p_id:match[1],p_target_login:target,p_actor:user.login}));
 }
 throw new HttpError(404,'Не найдено');
}
