/* Police Department — quests, approvals and point exchange.
   All read/write access flows through the WS session identity.
   Direct browser access to Supabase tables is revoked. */
const DEPTS = new Set(['LSPD','SFPD','LVPD']);
const TRACKS = new Set(['senior','leader','blacklist']);
const UUID = /^[0-9a-f-]{36}$/i;
const CODE = /^[a-z0-9_\-]{2,80}$/i;
const COLS = 'id,department,nickname,account_number,track,balance,warnings,proof,note,updated_at';
const ITEM = 'id,title,audience,points_min,points_max,calc_type,requirements,daily_limit,weekly_limit,active,sort_order';
const REWARD = 'id,title,audience,cost,conditions,requires_approval,active,sort_order';
const REQ = 'id,kind,department,track,nickname,requested_by,item_id,item_title,quantity,points,evidence_url,note,status,reviewed_by,review_note,created_at,reviewed_at';
const DEPT_OK = d => DEPTS.has(d);
const scope = u => ['developer','admin','minister'].includes(u.role) ? 'all' : u.role === 'leader' && DEPT_OK(u.department) ? 'leader' : 'self';
const textField = (v,max=500) => String(v??'').trim().slice(0,max);
const escaped = v => encodeURIComponent(String(v));
const qstr = o => new URLSearchParams(o).toString();
const num = (v,min,max) => { const n=Number(v); return Number.isFinite(n)&&n>=min&&n<=max ? n : null; };
const needsLogin = (u,HttpError) => {if(!u?.login)throw new HttpError(401,'Требуется авторизация');};
const rankTrack = u => u.role==='leader'?'leader':'senior';
const safeUrl = s => {try{const u=new URL(s);return u.protocol==='https:' && !u.username && !u.password && s.length<=850;}catch{return false}};

export async function handleQuestsRequest({req,res,url,supabase,identity,rpc,bodyJson,send,HttpError}) {
 const path=url.pathname;
 if(!path.startsWith('/api/portal/quests'))return false;
 const u=await identity(req);needsLogin(u,HttpError);
 const level=scope(u),manage=level==='all',dept=DEPT_OK(u.department)?u.department:null;
 const requireManager=()=>{if(!manage)throw new HttpError(403,'Недостаточно прав');};
 const canEdit=(d,t)=>manage || (level==='leader'&&d===dept&&t==='senior');
 const maySee=(d,t,n)=>canEdit(d,t) || (d===dept && t===rankTrack(u) && n.toLowerCase()===String(u.nickname).toLowerCase());
 const returnJSON=(code,value)=>{send(res,code,{ok:true,...value});return true;};
 const getMember=async (d,t,n)=>{
   const rows=await supabase('GET',`pd_quest_members?${qstr({select:COLS,department:`eq.${d}`,track:`eq.${t}`,limit:'300'})}`);
   return rows?.find(x=>String(x.nickname).toLowerCase()===String(n).toLowerCase())||null;
 };
 const canWork=()=>!!dept && (u.role==='senior'||u.role==='leader');
 if(req.method==='GET'&&path==='/api/portal/quests/bootstrap'){
   const [jobs,rewards,member]=await Promise.all([
    supabase('GET',`pd_quest_catalog?select=${ITEM}&active=eq.true&order=sort_order.asc`),
    supabase('GET',`pd_quest_rewards?select=${REWARD}&active=eq.true&order=sort_order.asc`),
    canWork()?getMember(dept,rankTrack(u),u.nickname):Promise.resolve(null)
   ]);
   return returnJSON(200,{me:{nickname:u.nickname,login:u.login,role:u.role,department:dept,permissions:level,track:rankTrack(u)},member,jobs,rewards});
 }
 // Compact public roster for authenticated portal members. No account numbers, punishments or notes.
 if(req.method==='GET'&&path==='/api/portal/quests/roster-public'){
   const rows=await supabase('GET',`pd_quest_members?${qstr({select:'department,nickname,track,balance',track:'in.(senior,leader)',order:'department.asc,track.asc,nickname.asc',limit:'300'})}`);
   const names=[...new Set((rows||[]).map(x=>String(x.nickname||'').trim()).filter(Boolean))];
   let avatars=[];
   if(names.length){
     const inValues=names.map(name=>'"'+name.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"').join(',');
     try {avatars=await supabase('GET',`ws_profiles?${qstr({select:'nickname,avatar_url',nickname:`in.(${inValues})`,limit:'300'})}`)}
     catch {avatars=[]}
   }
   const normalizeName=n=>String(n||'').toLocaleLowerCase('ru').replace(/[\s_]+/g,'');
   const avatarMap=new Map((avatars||[]).filter(x=>typeof x.avatar_url==='string'&&x.avatar_url.startsWith('https://')).map(x=>[normalizeName(x.nickname),x.avatar_url]));
   const items=(rows||[]).map(x=>({department:x.department,nickname:x.nickname,track:x.track,balance:x.balance,avatar_url:avatarMap.get(normalizeName(x.nickname))||''}));
   return returnJSON(200,{items});
 }
 if(req.method==='GET'&&path==='/api/portal/quests/roster'){
   if(level==='self')throw new HttpError(403,'Недостаточно прав');
   const d=level==='leader'?dept:(DEPT_OK(url.searchParams.get('department'))?url.searchParams.get('department'):null);
   const filters={select:COLS,order:'department.asc,track.asc,nickname.asc',limit:'300'};
   if(d)filters.department=`eq.${d}`;
   if(level==='leader')filters.track='eq.senior';
   return returnJSON(200,{items:await supabase('GET',`pd_quest_members?${qstr(filters)}`)});
 }
 if(req.method==='GET'&&path==='/api/portal/quests/requests'){
   const filters={select:REQ,order:'created_at.desc',limit:'120'};
   if(level==='leader'){filters.department=`eq.${dept}`;filters.or=`(track.eq.senior,requested_by.eq.${u.login})`}
   if(level==='self')filters.requested_by=`eq.${u.login}`;
   if(manage&&DEPT_OK(url.searchParams.get('department')))filters.department=`eq.${url.searchParams.get('department')}`;
   return returnJSON(200,{items:await supabase('GET',`pd_quest_requests?${qstr(filters)}`)});
 }
 if(req.method==='GET'&&path==='/api/portal/quests/history'){
   const filters={select:'id,source_sheet,source_row,track,department,nickname,event_type,before_points,amount,after_points,description,event_date,date_text,needs_review,source_data',order:'id.desc',limit:'1000'};
   if(level==='leader'){filters.department=`eq.${dept}`;filters.track='eq.senior'}
   if(level==='self'){if(!dept)throw new HttpError(403,'Нет департамента');filters.department=`eq.${dept}`;filters.track=`eq.${rankTrack(u)}`;filters.nickname=`eq.${u.nickname}`}
   if(manage&&DEPT_OK(url.searchParams.get('department')))filters.department=`eq.${url.searchParams.get('department')}`;
   const hist=await supabase('GET',`pd_quest_legacy_history?${qstr(filters)}`);
   return returnJSON(200,{items:level==='self'?hist.filter(x=>String(x.nickname).toLowerCase()===String(u.nickname).toLowerCase()):hist});
 }
 if(req.method==='GET'&&path==='/api/portal/quests/ledger'){
   const filters={select:'id,department,track,nickname,amount,description,performed_by,created_at',order:'created_at.desc',limit:'300'};
   if(level==='leader'){filters.department=`eq.${dept}`;filters.track='eq.senior'}
   if(level==='self'){if(!dept)throw new HttpError(403,'Нет департамента');filters.department=`eq.${dept}`;filters.track=`eq.${rankTrack(u)}`;filters.nickname=`eq.${u.nickname}`}
   const ledger=await supabase('GET',`pd_quest_ledger?${qstr(filters)}`);
   return returnJSON(200,{items:level==='self'?ledger.filter(x=>String(x.nickname).toLowerCase()===String(u.nickname).toLowerCase()):ledger});
 }
 if(req.method==='POST'&&path==='/api/portal/quests/requests'){
   if(!canWork())throw new HttpError(403,'Нет роли старшего состава или лидера');
   const b=await bodyJson(req,3000),kind=textField(b.kind,16),item_id=textField(b.item_id,80),track=rankTrack(u);
   if(!['quest','reward'].includes(kind)||!CODE.test(item_id))throw new HttpError(400,'Выберите работу или награду');
   const table=kind==='quest'?'pd_quest_catalog':'pd_quest_rewards';
   const rows=await supabase('GET',`${table}?${qstr({select:kind==='quest'?ITEM:REWARD,id:`eq.${item_id}`,active:'eq.true',limit:'1'})}`);
   const x=rows?.[0];if(!x)throw new HttpError(404,'Пункт не найден');
   if(x.audience!=='all'&&x.audience!==track)throw new HttpError(403,'Недоступно для вашего ранга');
   const member=await getMember(dept,track,u.nickname);
   if(!member){
      const added=await supabase('POST','pd_quest_members?on_conflict=department,nickname,track&select=id', [{department:dept,nickname:u.nickname,track,balance:0}], {prefer:'resolution=ignore-duplicates,return=representation'});
   }
   const qty=num(b.quantity??1,1,1000000);if(qty===null)throw new HttpError(400,'Неверное количество');
   let points=0;
   if(kind==='reward'){
     if(x.cost===null||x.cost===undefined)throw new HttpError(400,'Стоимость варианта уточняется у администрации');
     points=Number(x.cost);
     if(points===0 && !x.requires_approval)throw new HttpError(400,'Нужно согласование');
   }else{
     const min=Number(x.points_min),max=Number(x.points_max),mode=x.calc_type;
     if(mode==='online')points=Math.round(qty*.20*100)/100;
     else if(mode==='premium')points=Math.floor(qty/50000)*4;
     else if(mode==='per_unit'){if(!Number.isInteger(qty)||qty>20)throw new HttpError(400,'Количество от 1 до 20');points=min*qty}
     else if(mode==='range')points=num(b.points,min,max);
     else points=min;
     if(points===null||points<0||points>500)throw new HttpError(400,'Неверное количество баллов');
     if(mode==='premium'&&(qty%50000!==0||qty>500000))throw new HttpError(400,'Премия: шаг 50 000$, до 500 000$');
   }
   if(kind==='quest'&&(x.daily_limit||x.weekly_limit)){
      const now=new Date(),msk=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
      const dayStart=new Date(msk+'T00:00:00+03:00');const weekday=(dayStart.getUTCDay()+6)%7;
      const wStart=new Date(dayStart.getTime()-weekday*86400000);const from=new Date(Math.min(x.daily_limit?dayStart.getTime():Infinity,x.weekly_limit?wStart.getTime():Infinity)).toISOString();
      const prior=await supabase('GET',`pd_quest_requests?${qstr({select:'item_id,quantity,created_at,status',requested_by:`eq.${u.login}`,item_id:`eq.${item_id}`,kind:'eq.quest',created_at:`gte.${from}`,status:'in.(pending,approved)',limit:'200'})}`);
      const count=(p)=>prior.filter(v=>new Date(v.created_at)>=p).reduce((a,v)=>a+Number(v.quantity||1),0);
      if(x.daily_limit&&count(dayStart)+qty>Number(x.daily_limit))throw new HttpError(400,'Превышен дневной лимит');
      if(x.weekly_limit&&count(wStart)+qty>Number(x.weekly_limit))throw new HttpError(400,'Превышен недельный лимит');
   }
   const evidence=textField(b.evidence_url,850);
   if(kind==='quest'&&!safeUrl(evidence))throw new HttpError(400,'Добавьте HTTPS-ссылку на доказательства');
   const record={kind,department:dept,track,nickname:u.nickname,requested_by:u.login,item_id,item_title:x.title,quantity:qty,points,evidence_url:evidence,note:textField(b.note,800),status:'pending'};
   const rowsAdded=await supabase('POST','pd_quest_requests?select=id,status,created_at',[record],{prefer:'return=representation'});
   return returnJSON(201,{item:rowsAdded?.[0]});
 }
 const reviewMatch=/^\/api\/portal\/quests\/requests\/([0-9a-f-]{36})\/review$/i.exec(path);
 if(req.method==='PUT'&&reviewMatch){
   const id=reviewMatch[1], rows=await supabase('GET',`pd_quest_requests?${qstr({select:REQ,id:`eq.${id}`,limit:'1'})}`),r=rows?.[0];
   if(!r)throw new HttpError(404,'Заявка не найдена');
   if(!canEdit(r.department,r.track))throw new HttpError(403,'Нельзя проверять заявки этого департамента');
   const b=await bodyJson(req,1000),action=textField(b.action,12);
   if(!['approved','rejected'].includes(action))throw new HttpError(400,'Выберите решение');
   const result=await rpc('pd_quest_review_request',{p_id:id,p_action:action,p_reviewer:u.login,p_note:textField(b.note,500)});
   return returnJSON(200,{item:result});
 }
 if(req.method==='POST'&&path==='/api/portal/quests/members'){
   const b=await bodyJson(req,1800),d=manage?textField(b.department,8):dept,t=manage?textField(b.track,10):'senior';
   if(!DEPT_OK(d)||!TRACKS.has(t)||!canEdit(d,t))throw new HttpError(403,'Недоступно для этого департамента');
   const nickname=textField(b.nickname,80);if(!/^[\p{L}\p{N}_.\- ]{3,80}$/u.test(nickname))throw new HttpError(400,'Неверный ник');
   const record={department:d,track:t,nickname,account_number:textField(b.account_number,30),warnings:textField(b.warnings,180),note:textField(b.note,500)};
   const created=await supabase('POST',`pd_quest_members?select=${COLS}`,[record],{prefer:'return=representation'});
   return returnJSON(201,{item:created?.[0]});
 }
 const memberMatch=/^\/api\/portal\/quests\/members\/([0-9a-f-]{36})$/i.exec(path);
 if(req.method==='PUT'&&memberMatch){
   const id=memberMatch[1],rows=await supabase('GET',`pd_quest_members?${qstr({select:COLS,id:`eq.${id}`,limit:'1'})}`),member=rows?.[0];
   if(!member)throw new HttpError(404,'Сотрудник не найден');
   if(!canEdit(member.department,member.track))throw new HttpError(403,'Нельзя менять данные чужого департамента');
   const b=await bodyJson(req,2000),record={account_number:textField(b.account_number,30),warnings:textField(b.warnings,180),note:textField(b.note,500),proof:textField(b.proof,300),updated_at:new Date().toISOString()};
   const updated=await supabase('PATCH',`pd_quest_members?${qstr({id:`eq.${id}`,select:COLS})}`,record,{prefer:'return=representation'});
   return returnJSON(200,{item:updated?.[0]});
 }
 if(req.method==='POST'&&path==='/api/portal/quests/adjust'){
   const b=await bodyJson(req,1100),d=textField(b.department,8),t=textField(b.track,10),nick=textField(b.nickname,80),delta=num(b.amount,-100000,100000);
   if(!DEPT_OK(d)||!TRACKS.has(t)||t==='blacklist'||!canEdit(d,t))throw new HttpError(403,'Нельзя менять баланс');
   if(delta===null||delta===0||!nick||!textField(b.reason,500))throw new HttpError(400,'Укажите изменение и причину');
   const result=await rpc('pd_quest_adjust_balance',{p_department:d,p_track:t,p_nickname:nick,p_amount:delta,p_reviewer:u.login,p_reason:textField(b.reason,500)});
   return returnJSON(200,{item:result});
 }
 const tableMatch=/^\/api\/portal\/quests\/(catalog|rewards)\/([a-z0-9_-]{2,80})$/i.exec(path);
 if(req.method==='PUT'&&tableMatch){
   requireManager();const kind=tableMatch[1],id=tableMatch[2],b=await bodyJson(req,2400);
   const fields=kind==='catalog'?['title','audience','points_min','points_max','requirements','daily_limit','weekly_limit','active']:['title','audience','cost','conditions','requires_approval','active'];
   const record={};for(const f of fields)if(Object.hasOwn(b,f))record[f]=b[f];
   if(Object.hasOwn(record,'title'))record.title=textField(record.title,160);
   if(Object.hasOwn(record,'requirements'))record.requirements=textField(record.requirements,1400);
   if(Object.hasOwn(record,'conditions'))record.conditions=textField(record.conditions,1400);
   const table=kind==='catalog'?'pd_quest_catalog':'pd_quest_rewards',columns=kind==='catalog'?ITEM:REWARD;
   const results=await supabase('PATCH',`${table}?${qstr({id:`eq.${id}`,select:columns})}`,record,{prefer:'return=representation'});
   if(!results?.length)throw new HttpError(404,'Не найдено');return returnJSON(200,{item:results[0]});
 }
 return false;
}
