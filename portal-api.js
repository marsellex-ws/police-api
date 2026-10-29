// Police Department portal / staff administration. All mutations require an authenticated admin/developer.
import { randomBytes } from 'node:crypto';

const LOGIN = /^[a-z0-9_.-]{3,32}$/i;
const DEPTS = new Set(['LSPD','SFPD','LVPD']);
const SLOTS = new Set(['responsible','curator_lspd','curator_sfpd','curator_lvpd','minister','leader_lspd','leader_sfpd','leader_lvpd']);
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
export async function handlePortalRequest({ req,res,url,supabase,identity,rpc,bodyJson,send,HttpError }){
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
    const items=await supabase('GET','pd_portal_chiefs?select=department,nickname,account_number,avatar_url');
    send(res,200,{ok:true,items});return true;
  }
  if(!path.startsWith(prefixes))throw new HttpError(404,'Раздел не найден');
  const user=await admin();
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
