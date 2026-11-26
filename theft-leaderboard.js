import {fetchTheftSource} from './theft-archive.js';
import {staffNicknameKey} from './staff-profiles.js';
const WINDOWS={day:86400,week:7*86400,month:30*86400};
function aggregatePeriod(records,start,end){
  const groups=new Map();
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
  return {from:new Date(start*1000).toISOString(),to:new Date(end*1000).toISOString(),items,total:items.reduce((sum,x)=>sum+x.count,0),total_reward:items.reduce((sum,x)=>sum+x.reward,0),reward_count:items.reduce((sum,x)=>sum+x.reward_count,0)};
}
export function aggregatePoliceArrests(records,now=Date.now()){
 const end=Math.floor(now/1000);
 return Object.fromEntries(Object.entries(WINDOWS).map(([period,seconds])=>[period,aggregatePeriod(records,end-seconds,end)]));
}
export function aggregatePoliceWeeks(records, now=Date.now()){
 const groups=new Map(), end=Math.floor(now/1000);
 for(const row of records){
  const timestamp=Number(row?.timestamp);
  if(!Number.isFinite(timestamp)||timestamp<=0||timestamp>end)continue;
  // Moscow is UTC+3. Day zero was Thursday, three days after Monday.
  const day=Math.floor((timestamp+10800)/86400);
  const monday=(day-((day+3)%7))*86400-10800;
  if(!groups.has(monday))groups.set(monday,[]);
  groups.get(monday).push(row);
 }
 return [...groups].sort(([a],[b])=>b-a).map(([monday,rows])=>({
  ...aggregatePeriod(rows,monday-1,monday+7*86400-1),
  from:new Date(monday*1000).toISOString(),
  to:new Date((monday+7*86400-1)*1000).toISOString()
 }));
}
export function createTheftLeaderboard({fetchImpl=fetch,now=Date.now,lookupProfiles=async()=>new Map(),includeWeeks=false}={}){
 let cached=null,inflight=null;
 async function refresh(){
  const records=await fetchTheftSource('get_arrests.php',2*1024*1024,fetchImpl,now,8000);
  if(!Array.isArray(records)||records.length>100000)throw Error('Invalid police archive');
  cached={records,at:now()};return cached;
 }
 return async()=>{
  if(!cached||now()-cached.at>=60000){
   if(!inflight)inflight=refresh().finally(()=>{inflight=null});
   await inflight;
  }
  const asOf=now();
  const periods=aggregatePoliceArrests(cached.records,asOf);
  const weeks=includeWeeks?aggregatePoliceWeeks(cached.records,asOf):[];
  let profiles=new Map(),profiles_available=true;
  try{profiles=await lookupProfiles([...new Set([...Object.values(periods),...weeks.slice(0,5)].flatMap(p=>p.items.map(x=>x.nickname)))]);}
  catch{profiles_available=false;console.warn('Staff profile lookup temporarily unavailable');}
  for(const period of [...Object.values(periods),...weeks])for(const item of period.items){
   const profile=profiles.get(staffNicknameKey(item.nickname));
   item.login=profile?.login||null;item.avatar_url=profile?.avatar_url||null;
  }
  return {ok:true,source:'djoniohanter.com/car_theft',updated_at:new Date(cached.at).toISOString(),profiles_available,periods,...(includeWeeks?{weeks}:{})};
 };
}
