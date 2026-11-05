import {load} from 'cheerio';
import sharp from 'sharp';
const ORIGIN='https://forum.gta-samp.ru';
export class ForumAvatarError extends Error{constructor(status,message){super(message);this.status=status;}}
function forumUrl(value){let u;try{u=new URL(value)}catch{throw new ForumAvatarError(400,'Укажите ссылку на профиль forum.gta-samp.ru');}if(u.origin!==ORIGIN||u.protocol!=='https:'||u.username||u.password)throw new ForumAvatarError(400,'Разрешён только форум forum.gta-samp.ru');return u;}
export function forumProfile(value){
 const u=forumUrl(value);let path;
 try{path=decodeURIComponent(u.pathname==='/index.php'?u.search.slice(1).split('&')[0]:u.pathname)}catch{throw new ForumAvatarError(400,'Некорректная ссылка на профиль');}
 const match=/^\/profile\/([1-9]\d{0,9})(?:-([^/?#]*))?\/?$/.exec(path);
 if(!match)throw new ForumAvatarError(400,'Нужна ссылка на профиль пользователя форума');
 const result=new URL('/index.php',ORIGIN);result.search='?/profile/'+match[1]+'-'+encodeURIComponent(match[2]||'profile')+'/';
 return {id:match[1],url:result.href};
}
function imageUrl(value,base){let u;try{u=forumUrl(new URL(value,base).href)}catch{return null;}if(!u.pathname.startsWith('/uploads/')||u.search||u.hash)return null;return u.href;}
export function extractForumAvatar(html,profile){
 const $=load(html);const owner=$('#elProfilePhoto');
 const identities=[$('link[rel="canonical"]').attr('href'),$('#elProfileHeader').attr('data-url')].filter(Boolean);
 const matches=identities.some(value=>{try{return forumProfile(value.replace(/&csrfKey=.*$/,'' )).id===profile.id}catch{return false}});
 if(!matches||!owner.length)throw new ForumAvatarError(502,'Форум не вернул запрошенный профиль. Попробуйте позже или загрузите файл вручную.');
 const candidates=[owner.find('a[data-ipslightbox]').first().attr('href'),owner.find('img').first().attr('data-src'),owner.find('img').first().attr('src')];
 const urls=[...new Set(candidates.filter(Boolean).map(v=>imageUrl(v,profile.url)).filter(Boolean))];
 if(!urls.length)throw new ForumAvatarError(404,'В профиле нет загруженного аватара. Можно выбрать файл вручную.');
 return urls.slice(0,2);
}
async function boundedBody(response,limit){
 if(Number(response.headers.get('content-length'))>limit)throw new ForumAvatarError(413,'Файл на форуме слишком большой');
 const reader=response.body?.getReader();if(!reader)throw new ForumAvatarError(502,'Пустой ответ форума');
 const chunks=[];let length=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit)throw new ForumAvatarError(413,'Файл на форуме слишком большой');chunks.push(value)}}catch(error){await reader.cancel().catch(()=>{});throw error}
 return Buffer.concat(chunks);
}
export async function normalizeForumAvatar(bytes){
 const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 const gif=/^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii'));
 const webp=bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
 const avif=bytes.subarray(4,8).toString()==='ftyp'&&/avif|avis/.test(bytes.subarray(8,32).toString());
 if(!png&&!jpeg&&!gif&&!webp&&!avif)throw new ForumAvatarError(415,'Форум вернул неподдерживаемый формат изображения');
 try{
  const base=sharp(bytes,{animated:false,limitInputPixels:16777216}).rotate().resize(512,512,{fit:'cover',position:'attention',withoutEnlargement:true}).flatten({background:'#081727'});
  for(const quality of [88,75,60,45]){
   const output=await base.clone().jpeg({quality,mozjpeg:true}).toBuffer({resolveWithObject:true});
   if(output.data.length<=300*1024)return {bytes:output.data,mime:'image/jpeg',width:output.info.width,height:output.info.height};
  }
  throw new ForumAvatarError(413,'Не удалось уменьшить изображение до 300 КБ');
 }catch(error){if(error instanceof ForumAvatarError)throw error;throw new ForumAvatarError(415,'Не удалось обработать изображение форума');}
}
export async function fetchForumAvatar(value,{fetchImpl=fetch}={}){
 const profile=forumProfile(value),signal=AbortSignal.timeout(20000),cookies=new Map();
 async function get(url,kind){
  let current=forumUrl(url).href;
  for(let hop=0;hop<5;hop++){
   const r=await fetchImpl(current,{method:'GET',redirect:'manual',signal,headers:{Accept:kind==='page'?'text/html':'image/*','User-Agent':'PoliceDepartment/1.0 (+https://police-department.ru)','Cache-Control':'no-cache',Pragma:'no-cache',...(cookies.size?{Cookie:[...cookies.values()].join('; ')}:{})}});
   // Ordinary anonymous visitor session; no user forum credentials are accepted or stored.
   for(const raw of r.headers.getSetCookie?.()||[]){const pair=raw.split(';')[0];if(/^[A-Za-z0-9_-]+=[^\r\n]*$/.test(pair))cookies.set(pair.split('=')[0],pair);}
   if([301,302,303,307,308].includes(r.status)){
    const target=new URL(r.headers.get('location')||'',current);forumUrl(target.href);
    if(kind==='image'&&!imageUrl(target.href,current))throw new ForumAvatarError(502,'Недопустимый адрес изображения форума');
    if(kind==='page'&&forumProfile(target.href).id!==profile.id)throw new ForumAvatarError(502,'Форум перенаправил на другой профиль');
    await r.body?.cancel();current=target.href;continue;
   }
   if(!r.ok)throw new ForumAvatarError(r.status===404?404:502,'Форум временно не отдаёт аватар. Попробуйте позже или выберите файл.');
   const body=await boundedBody(r,kind==='page'?2*1024*1024:8*1024*1024);
   if(!body.length&&/^0\s*;?$/.test(r.headers.get('refresh')||''))continue;
   if(!body.length)throw new ForumAvatarError(502,'Форум вернул пустой ответ. Попробуйте позже.');
   return body;
  }
  throw new ForumAvatarError(502,'Не удалось открыть профиль форума. Попробуйте позже.');
 }
 try{
  const html=(await get(profile.url,'page')).toString('utf8');
  const candidates=extractForumAvatar(html,profile);let last;
  for(const url of candidates){try{return {...await normalizeForumAvatar(await get(url,'image')),profile_id:profile.id};}catch(error){last=error;}}
  throw last;
 }catch(error){if(error instanceof ForumAvatarError)throw error;if(signal.aborted)throw new ForumAvatarError(504,'Форум не ответил вовремя. Попробуйте ещё раз.');throw new ForumAvatarError(502,'Не удалось связаться с форумом. Попробуйте позже.');}
}
