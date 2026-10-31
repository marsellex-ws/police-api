// Police Department portal / staff administration. All mutations require an authenticated admin/developer.
import { randomBytes } from 'node:crypto';

const LOGIN = /^[a-z0-9_.-]{3,32}$/i;
const DEPTS = new Set(['LSPD','SFPD','LVPD']);
const SLOTS = new Set(['responsible','curator_lspd','curator_sfpd','curator_lvpd','minister','leader_lspd','leader_sfpd','leader_lvpd','swat_deputy','swat_commander','swat_deputy_2']);
const avatarBase = 'https://pbwgvyhchpzmgqjyqxzv.supabase.co/storage/v1/object/public/ws-avatars/';
function clean(value,max, HttpError) {
  if (typeof value !== 'string' || value.length>max) throw new HttpError(400,'Неверное значение поля');
  return value.trim();
}
function httpsUrl(value,max,HttpError){
  const url=clean(value,max,HttpError);
  if(!url)return '';
  let u;try{u=new URL(url)}catch{throw new HttpError(400,'Укажите корректную HTTPS-ссылку')}
  if(u.protocol!=='https:'||u.username||u.password||!u.hostname)throw new HttpError(400,'Укажите корректную HTTPS-ссылку');
  return u.href;
}
function vkUrl(v,HttpError){
  const s=httpsUrl(v,250,HttpError);if(!s)return '';
  const u=new URL(s);
  if(!['vk.com','m.vk.com','vk.ru'].includes(u.hostname)) throw new HttpError(400,'Укажите ссылку на профиль VK');
  return s;
}
const sorted = arr=>arr.sort((a,b)=>String(a.nickname||'').localeCompare(String(b.nickname||''),'ru'));
// Calendar boundaries are Moscow-local; dates are represented as ISO UTC calendar days.
const isoDate=d=>d.toISOString().slice(0,10);
const addDays=(s,n)=>{const d=new Date(s+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return isoDate(d)};
function activityCalendar(){
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const day=new Date(today+'T12:00:00Z');
  const monday=addDays(today,-((day.getUTCDay()+6)%7));
  const starts=Array.from({length:8},(_,i)=>addDays(monday,(i-7)*7));
  const weeks=starts.map(start=>({start,end:addDays(start,6)}));
  return {today,monday,weeks,start:starts[0]};
}
function sumAo(rows,from,to){
  const records=rows.filter(x=>x.activity_date>=from&&x.activity_date<=to);
  return records.length?records.reduce((sum,x)=>sum+Number(x.ao||0),0):null;
}

export async function handlePortalRequest({ req,res,url,supabase,identity,rpc,bodyJson,send,HttpError,storageUpload }){
  const path=url.pathname;
  if(!path.startsWith('/api/portal/'))return false;
  const admin = async () => {
    const u=await identity(req);
    if(!['admin','developer'].includes(u.role))throw new HttpError(403,'Недостаточно прав');
    return u;
  };
  const prefixes='/api/portal/admin/';
  if(req.method==='GET'&&path==='/api/portal/leadership'){
    const items=await supabase('GET','pd_portal_leadership?select=slot,nickname,avatar_url,vk_url,forum_url,gender');
    send(res,200,{ok:true,items});return true;
  }
  if(req.method==='GET'&&path==='/api/portal/chiefs'){
    const cal=activityCalendar();
    const [chiefs,allAo]=await Promise.all([
      supabase('GET','pd_portal_chiefs?select=department,nickname,account_number,avatar_url'),
      supabase('GET',`pd_chief_ao_daily?${new URLSearchParams({select:'department,chief_account,activity_date,ao',activity_date:`gte.${cal.start}`,order:'activity_date.asc',limit:'300'})}`)
    ]);
    const items=chiefs.map(chief=>{
      // A new chief must not inherit the previous chief's AO history.
      const rows=allAo.filter(row=>row.department===chief.department&&row.chief_account===String(chief.account_number||''));
      return {...chief,ao_day:sumAo(rows,cal.today,cal.today),ao_week:sumAo(rows,cal.monday,cal.today)};
    });
    const weeks=cal.weeks.map(w=>({
      start:w.start,end:w.end,
      totals:Object.fromEntries(['LSPD','SFPD','LVPD'].map(dept=>{
        const chief=chiefs.find(c=>c.department===dept);
        const rows=allAo.filter(r=>r.department===dept&&r.chief_account===String(chief?.account_number||''));
        return [dept,sumAo(rows,w.start,w.end)];
      }))
    }));
    res.setHeader('Cache-Control','no-store');
    send(res,200,{ok:true,items,activity:{today:cal.today,week_start:cal.monday,weeks}});return true;
  }
  // Public demo configuration; only a privileged account can modify the catalog.
  const RANGE_COLUMNS='id,name,tier,hp,armor,image_url,icon,is_enabled,sort_order';
  if(req.method==='GET'&&path==='/api/portal/range'){
    const [prizes,settings]=await Promise.all([
      supabase('GET',`pd_range_prizes?select=${RANGE_COLUMNS}&is_enabled=eq.true&order=sort_order.asc&limit=100`),
      supabase('GET','pd_range_settings?select=id,round_seconds,speed_multiplier,bonus_a,bonus_b,bonus_interval,max_extra_seconds&id=eq.1&limit=1')
    ]);
    res.setHeader('Cache-Control','no-store');
    send(res,200,{ok:true,prizes,settings:settings?.[0]||null});return true;
  }
  if(!path.startsWith(prefixes))throw new HttpError(404,'Раздел не найден');
  const user=await admin();
  // Admin-only range catalog + settings. No database credentials are ever sent to clients.
  const rangeRoot='/api/portal/admin/range';
  const rangeFields=['name','tier','hp','armor','icon','image_url','is_enabled','sort_order'];
  const parseRangePrize=(body)=>{
    const name=clean(body.name,80,HttpError);
    if(!name)throw new HttpError(400,'Введите название приза');
    const tier=String(body.tier||'');if(!['easy','medium','hard'].includes(tier))throw new HttpError(400,'Неизвестная категория');
    const hp=Number(body.hp),armor=Number(body.armor),sort_order=Number(body.sort_order??100);
    if(!Number.isSafeInteger(hp)||hp<1||hp>200)throw new HttpError(400,'HP должно быть от 1 до 200');
    if(!Number.isSafeInteger(armor)||armor<0||armor>200)throw new HttpError(400,'Броня должна быть от 0 до 200');
    if(!Number.isSafeInteger(sort_order)||sort_order<0||sort_order>99999)throw new HttpError(400,'Некорректный порядок');
    const image_url=httpsUrl(String(body.image_url||''),700,HttpError);
    // Do not accept arbitrary images from other hosts. Use an uploaded, public Supabase Storage image.
    const storagePrefix='https://pbwgvyhchpzmgqjyqxzv.supabase.co/storage/v1/object/public/ws-avatars/range-prizes/';
    if(image_url&&!image_url.startsWith(storagePrefix))throw new HttpError(400,'Загрузите изображение через форму администратора');
    const icon=clean(String(body.icon||'🎁'),20,HttpError)||'🎁';
    return {name,tier,hp,armor,image_url,icon,is_enabled:body.is_enabled===true,sort_order,updated_by:user.login,updated_at:new Date().toISOString()};
  };
  if(req.method==='GET'&&path===rangeRoot){
    const [prizes,settings]=await Promise.all([
      supabase('GET',`pd_range_prizes?select=${RANGE_COLUMNS}&order=sort_order.asc&limit=200`),
      supabase('GET','pd_range_settings?select=id,round_seconds,speed_multiplier,bonus_a,bonus_b,bonus_interval,max_extra_seconds&id=eq.1&limit=1')
    ]);
    send(res,200,{ok:true,prizes,settings:settings?.[0]||null});return true;
  }
  if(req.method==='PUT'&&path===rangeRoot+'/settings'){
    const body=await bodyJson(req,2048);
    const constraints={round_seconds:[10,120],speed_multiplier:[0.5,5],bonus_a:[1,60],bonus_b:[1,60],bonus_interval:[3,40],max_extra_seconds:[0,180]};
    const values={id:1,updated_by:user.login,updated_at:new Date().toISOString()};
    for(const [key,[min,max]] of Object.entries(constraints)){
      const num=Number(body[key]);
      if(!Number.isFinite(num)||num<min||num>max||(key!=='speed_multiplier'&&!Number.isSafeInteger(num)))
        throw new HttpError(400,`Недопустимое значение ${key}`);
      values[key]=num;
    }
    const saved=await supabase('POST','pd_range_settings?on_conflict=id&select=id,round_seconds,speed_multiplier,bonus_a,bonus_b,bonus_interval,max_extra_seconds',values,{prefer:'resolution=merge-duplicates,return=representation'});
    send(res,200,{ok:true,settings:saved?.[0]||values});return true;
  }
  if(req.method==='POST'&&path===rangeRoot+'/upload'){
    const body=await bodyJson(req,430000);
    const mime=String(body.mime||''),encoded=String(body.base64||'');
    if(!['image/png','image/jpeg'].includes(mime)||!encoded||encoded.length>410000||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
      throw new HttpError(400,'Разрешён PNG или JPG размером не более 300 КБ');
    const bytes=Buffer.from(encoded,'base64');
    if(!bytes.length||bytes.length>300*1024)throw new HttpError(413,'Размер изображения до 300 КБ');
    const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
    if((mime==='image/png'&&!png)||(mime==='image/jpeg'&&!jpg))throw new HttpError(400,'Неверный формат изображения');
    const path='range-prizes/'+randomBytes(16).toString('hex')+(png?'.png':'.jpg');
    const image_url=await storageUpload(path,bytes,mime);
    send(res,200,{ok:true,image_url});return true;
  }
  if(req.method==='POST'&&path===rangeRoot+'/prizes'){
    const body=await bodyJson(req,3200);
    const record=parseRangePrize(body);
    const saved=await supabase('POST',`pd_range_prizes?select=${RANGE_COLUMNS}`,[record],{prefer:'return=representation'});
    send(res,201,{ok:true,item:saved[0]});return true;
  }
  const prizeMatch=/^\/api\/portal\/admin\/range\/prizes\/([0-9a-f-]{36})$/.exec(path);
  if(prizeMatch&&req.method==='PUT'){
    const body=await bodyJson(req,3200);
    const record=parseRangePrize(body);
    const rows=await supabase('PATCH',`pd_range_prizes?${new URLSearchParams({id:`eq.${prizeMatch[1]}`,select:RANGE_COLUMNS})}`,record,{prefer:'return=representation'});
    if(!rows?.length)throw new HttpError(404,'Приз не найден');
    send(res,200,{ok:true,item:rows[0]});return true;
  }
  if(prizeMatch&&req.method==='DELETE'){
    const rows=await supabase('DELETE',`pd_range_prizes?${new URLSearchParams({id:`eq.${prizeMatch[1]}`,select:'id'})}`,null,{prefer:'return=representation'});
    if(!rows?.length)throw new HttpError(404,'Приз не найден');
    send(res,200,{ok:true});return true;
  }
  if(req.method==='GET'&&path==='/api/portal/admin/users'){
    const [users,roles,links]=await Promise.all([
      supabase('GET','ws_profiles?select=login,nickname,department,avatar_url,avatar_path&order=nickname.asc&limit=500'),
      supabase('GET','pd_ws_roles?select=login,role&limit=500'),
      supabase('GET','pd_portal_user_links?select=login,vk_url&limit=500')
    ]);
    const roleMap=new Map(roles.map(p=>[String(p.login).toLowerCase(),p.role]));
    const linkMap=new Map(links.map(p=>[String(p.login).toLowerCase(),p.vk_url]));
    const items=sorted(users.filter(p=>p.login).map(p=>({login:p.login,nickname:p.nickname,department:p.department,
      avatar_url:p.avatar_url|| (p.avatar_path ? avatarBase+p.avatar_path.split('/').map(encodeURIComponent).join('/') : ''),
      role:roleMap.get(p.login.toLowerCase())||null,vk_url:linkMap.get(p.login.toLowerCase())||''})));
    send(res,200,{ok:true,items});return true;
  }
  if(req.method==='POST'&&path==='/api/portal/admin/leadership/avatar'){
    const body=await bodyJson(req,430000);
    const slot=String(body.slot||'');if(!SLOTS.has(slot))throw new HttpError(400,'Неизвестная должность');
    const mime=String(body.mime||'');if(!['image/png','image/jpeg'].includes(mime))throw new HttpError(400,'Разрешены PNG и JPG');
    const encoded=String(body.base64||'');if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw new HttpError(400,'Повреждённый файл');
    const bytes=Buffer.from(encoded,'base64');
    if(!bytes.length||bytes.length>300*1024)throw new HttpError(413,'Изображение должно быть не более 300 КБ');
    const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
    if((mime==='image/png'&&!png)||(mime==='image/jpeg'&&!jpg))throw new HttpError(400,'Формат файла не совпадает с содержимым');
    const ext=png?'png':'jpg';const filename=`leadership/${slot}-${randomBytes(12).toString('hex')}.${ext}`;
    const avatar_url=await storageUpload(filename,bytes,mime);
    send(res,200,{ok:true,avatar_url});return true;
  }
  const passwordMatch=/^\/api\/portal\/admin\/users\/([a-z0-9_.-]{3,32})\/password$/i.exec(path);
  if(req.method==='POST'&&passwordMatch){
    const target=passwordMatch[1].toLowerCase();
    const body=await bodyJson(req,512);
    if(body.confirm!==true)throw new HttpError(400,'Подтверди сброс пароля');
    const newPassword=randomBytes(24).toString('base64url');
    const ok=await rpc('pd_portal_admin_reset_password',{p_actor:user.login,p_target:target,p_new_password:newPassword});
    if(ok!==true)throw new HttpError(403,'Смена пароля недоступна для этого пользователя');
    res.setHeader('Cache-Control','no-store, private');
    send(res,200,{ok:true,login:target,temporary_password:newPassword});return true;
  }
  const vkMatch=/^\/api\/portal\/admin\/users\/([a-z0-9_.-]{3,32})\/vk$/i.exec(path);
  if(req.method==='PUT'&&vkMatch){
    const target=vkMatch[1].toLowerCase();const body=await bodyJson(req,1024);
    const vk_url=vkUrl(body.vk_url,HttpError);
    const users=await supabase('GET',`ws_profiles?${new URLSearchParams({select:'login',login:`eq.${target}`,limit:'1'})}`);
    if(!users.length)throw new HttpError(404,'Пользователь не найден');
    await supabase('POST','pd_portal_user_links?on_conflict=login',{login:target,vk_url,updated_by:user.login,updated_at:new Date().toISOString()},{prefer:'resolution=merge-duplicates,return=representation'});
    await supabase('POST','pd_portal_admin_events',{actor:user.login,target,action:'set_vk'});
    send(res,200,{ok:true,vk_url});return true;
  }
  const leadershipMatch=/^\/api\/portal\/admin\/leadership\/([a-z_]+)$/.exec(path);
  if(req.method==='PUT'&&leadershipMatch){
    const slot=leadershipMatch[1];if(!SLOTS.has(slot))throw new HttpError(404,'Должность не найдена');
    const body=await bodyJson(req,3000);
    const nickname=clean(body.nickname,64,HttpError),avatar_url=httpsUrl(body.avatar_url,700,HttpError);
    const vk_url=vkUrl(body.vk_url,HttpError),forum_url=httpsUrl(body.forum_url||'',700,HttpError);
    const gender=body.gender;if(!['male','female'].includes(gender))throw new HttpError(400,'Неверное обращение');
    const record={nickname,avatar_url,vk_url,forum_url,gender,updated_by:user.login,updated_at:new Date().toISOString()};
    const items=await supabase('PATCH',`pd_portal_leadership?${new URLSearchParams({slot:`eq.${slot}`,select:'slot,nickname,avatar_url,vk_url,forum_url,gender'})}`,record,{prefer:'return=representation'});
    if(!items?.[0])throw new HttpError(404,'Должность не найдена');
    await supabase('POST','pd_portal_admin_events',{actor:user.login,target:slot,action:'set_leadership'});
    send(res,200,{ok:true,item:items[0]});return true;
  }
  // Manual AO entry is available only to portal admins and developers.
  const aoMatch=/^\/api\/portal\/admin\/chiefs\/(LSPD|SFPD|LVPD)\/activity$/.exec(path);
  if(req.method==='PUT'&&aoMatch){
    const department=aoMatch[1];
    const body=await bodyJson(req,2048);
    const date=String(body.date||''),ao=body.ao;
    const cal=activityCalendar();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T12:00:00Z'))||isoDate(new Date(date+'T12:00:00Z'))!==date)
      throw new HttpError(400,'Некорректная дата');
    if(date>cal.today||date<addDays(cal.today,-365)) throw new HttpError(400,'Дата должна быть за прошедший год, не позднее сегодня (МСК)');
    if(!Number.isSafeInteger(ao)||ao<0||ao>100000)throw new HttpError(400,'АО должно быть целым числом от 0 до 100000');
    const chiefs=await supabase('GET',`pd_portal_chiefs?${new URLSearchParams({select:'account_number',department:`eq.${department}`,limit:'1'})}`);
    const account=String(chiefs[0]?.account_number||'');
    if(!/^\d{1,20}$/.test(account))throw new HttpError(400,'Сначала укажите номер аккаунта шефа в админке');
    const rows=await supabase('POST','pd_chief_ao_daily?on_conflict=department,chief_account,activity_date',
      {department,chief_account:account,activity_date:date,ao,updated_by:user.login,updated_at:new Date().toISOString()},
      {prefer:'resolution=merge-duplicates,return=representation'});
    res.setHeader('Cache-Control','no-store, private');
    send(res,200,{ok:true,item:rows?.[0]||{department,chief_account:account,activity_date:date,ao}});return true;
  }
  const chiefMatch=/^\/api\/portal\/admin\/chiefs\/([A-Z]+)$/.exec(path);
  if(req.method==='PUT'&&chiefMatch){
    const dept=chiefMatch[1];if(!DEPTS.has(dept))throw new HttpError(404,'Департамент не найден');
    const body=await bodyJson(req,3000);
    const nickname=clean(body.nickname,64,HttpError),account_number=clean(body.account_number,32,HttpError),avatar_url=httpsUrl(body.avatar_url,700,HttpError);
    if(account_number && !/^\d{1,20}$/.test(account_number))throw new HttpError(400,'Номер аккаунта должен содержать цифры');
    const items=await supabase('PATCH',`pd_portal_chiefs?${new URLSearchParams({department:`eq.${dept}`,select:'department,nickname,account_number,avatar_url'})}`,
      {nickname,account_number,avatar_url,updated_by:user.login,updated_at:new Date().toISOString()},{prefer:'return=representation'});
    if(!items?.[0])throw new HttpError(404,'Департамент не найден');
    await supabase('POST','pd_portal_admin_events',{actor:user.login,target:dept,action:'set_chief'});
    send(res,200,{ok:true,item:items[0]});return true;
  }
  throw new HttpError(404,'Маршрут не найден');
}
