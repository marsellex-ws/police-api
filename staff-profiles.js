const NICK=/^[a-z0-9_]{3,24}$/i;
const LOGIN=/^[a-z0-9_.-]{3,32}$/i;
export const staffNicknameKey=value=>String(value||'').trim().replace(/\s+/g,'_').toLowerCase();
export function publicStaffAvatar(profile,supabaseUrl){
 if(!/^https:\/\/[a-z0-9.-]+\.supabase\.co$/i.test(supabaseUrl||''))return null;
 const base=supabaseUrl.replace(/\/$/,'')+'/storage/v1/object/public/ws-avatars/';
 const path=String(profile.avatar_path||'').trim();
 if(path&&!path.startsWith('/')&&!path.includes('..')&&!path.includes('\\')&&path.split('/').every(s=>/^[a-z0-9_.-]+$/i.test(s)))return base+path.split('/').map(encodeURIComponent).join('/');
 const stored=String(profile.avatar_url||'');
 try{const u=new URL(stored);if(!u.username&&!u.password&&u.origin===new URL(supabaseUrl).origin&&u.pathname.startsWith('/storage/v1/object/public/ws-avatars/')&&stored.startsWith(base)&&!/[<> \\]/.test(stored)&&!decodeURIComponent(u.pathname).split('/').some(s=>s==='..'||s==='.'))return stored;}catch{}
 return null;
}
export function createStaffProfileLookup({supabase,supabaseUrl,now=Date.now}){
 let cached=null,inflight=null,inflightKey='';
 return async names=>{
  const nicks=[...new Set(names.filter(n=>typeof n==='string').map(staffNicknameKey).filter(n=>NICK.test(n)))].sort();
  const key=nicks.join(',');if(!nicks.length)return new Map();
  if(cached?.key===key&&now()-cached.at<60000)return cached.profiles;
  if(inflight&&inflightKey===key)return inflight;
  inflightKey=key;
  const work=(async()=>{
   const rows=[];
   for(let i=0;i<nicks.length;i+=20){
    // Only public profile fields for names present in the police ranking, never an account directory.
    const terms=[...new Set(nicks.slice(i,i+20).flatMap(n=>[n,n.replace(/_/g,' ')]))].map(n=>'nickname.ilike."'+n.replace(/_/g,'\\\\_')+'"');
    const query=new URLSearchParams({select:'login,nickname,avatar_url,avatar_path',or:'('+terms.join(',')+')',limit:'1000'});
    rows.push(...await supabase('GET','ws_profiles?'+query));
   }
   const profiles=new Map(),duplicates=new Set(),allowed=new Set(nicks);
   for(const row of rows){
    const nick=staffNicknameKey(row.nickname);
    if(!allowed.has(nick)||!LOGIN.test(row.login||''))continue;
    if(profiles.has(nick)){duplicates.add(nick);continue;}
    profiles.set(nick,{login:row.login,avatar_url:publicStaffAvatar(row,supabaseUrl)});
   }
   // An ambiguous nickname must not be linked to an arbitrary account.
   for(const nick of duplicates)profiles.delete(nick);
   cached={key,at:now(),profiles};return profiles;
  })();
  inflight=work;
  try{return await work;}finally{if(inflight===work)inflight=null;}
 };
}
