import {staffNicknameKey} from './staff-profiles.js';
const SOURCE='https://djoniohanter.com/car_theft/get_arrests.php';
const WINDOWS={day:86400,week:7*86400,month:30*86400};
export function aggregatePoliceArrests(records,now=Date.now()){
 const end=Math.floor(now/1000),periods={};
 for(const [period,seconds] of Object.entries(WINDOWS)){
  const start=end-seconds,groups=new Map();
  for(const row of records){
   const name=typeof row?.policeName==='string'?row.policeName.trim():'';
   const timestamp=Number(row?.timestamp);
   if(!name||name.length>100||!Number.isFinite(timestamp)||timestamp<=start||timestamp>end)continue;
   const key=staffNicknameKey(name);
   const item=groups.get(key)||{nickname:name,count:0,reward:0,reward_count:0,last_at:0,events:[]};
   item.count++;const reward=Number(row.reward);
   const knownReward=row.reward!==null&&row.reward!==undefined&&row.reward!==''&&Number.isFinite(reward)&&reward>=0;
   if(knownReward){item.reward+=reward;item.reward_count++;}
   item.events.push({timestamp,reward:knownReward?reward:null});
   item.last_at=Math.max(item.last_at,timestamp);groups.set(key,item);
  }
  for(const item of groups.values()){item.average_reward=item.reward_count?item.reward/item.reward_count:null;item.events.sort((a,b)=>b.timestamp-a.timestamp);}
  const items=[...groups.values()].sort((a,b)=>b.count-a.count||b.reward-a.reward||a.nickname.localeCompare(b.nickname,'en'));
  periods[period]={from:new Date(start*1000).toISOString(),to:new Date(end*1000).toISOString(),items,total:items.reduce((sum,x)=>sum+x.count,0),total_reward:items.reduce((sum,x)=>sum+x.reward,0),reward_count:items.reduce((sum,x)=>sum+x.reward_count,0)};
 }
 return periods;
}
export function createTheftLeaderboard({fetchImpl=fetch,now=Date.now,lookupProfiles=async()=>new Map()}={}){
 let cached=null,inflight=null;
 async function refresh(){
  const response=await fetchImpl(SOURCE+'?t='+now(),{headers:{Accept:'application/json',Referer:'https://djoniohanter.com/car_theft/'},signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw Error('Upstream HTTP '+response.status);
  const reader=response.body.getReader();let size=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024)throw Error('Upstream response too large');chunks.push(value)}}catch(error){await reader.cancel().catch(()=>{});throw error}
  const records=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!Array.isArray(records)||records.length>100000)throw Error('Invalid police archive');
  cached={records,at:now()};return cached;
 }
 return async()=>{
  if(!cached||now()-cached.at>=60000){
   if(!inflight)inflight=refresh().finally(()=>{inflight=null});
   await inflight;
  }
  const periods=aggregatePoliceArrests(cached.records,now());
  let profiles=new Map(),profiles_available=true;
  try{profiles=await lookupProfiles([...new Set(Object.values(periods).flatMap(p=>p.items.map(x=>x.nickname)))]);}
  catch{profiles_available=false;console.warn('Staff profile lookup temporarily unavailable');}
  for(const period of Object.values(periods))for(const item of period.items){
   const profile=profiles.get(staffNicknameKey(item.nickname));
   item.login=profile?.login||null;item.avatar_url=profile?.avatar_url||null;
  }
  return {ok:true,source:'djoniohanter.com/car_theft',updated_at:new Date(cached.at).toISOString(),profiles_available,periods};
 };
}
