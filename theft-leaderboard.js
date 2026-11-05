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
   const key=name.toLocaleLowerCase('en-US');
   const item=groups.get(key)||{nickname:name,count:0,reward:0,last_at:0};
   item.count++;const reward=Number(row.reward);if(Number.isFinite(reward)&&reward>=0)item.reward+=reward;
   item.last_at=Math.max(item.last_at,timestamp);groups.set(key,item);
  }
  const items=[...groups.values()].sort((a,b)=>b.count-a.count||b.reward-a.reward||a.nickname.localeCompare(b.nickname,'en'));
  periods[period]={from:new Date(start*1000).toISOString(),to:new Date(end*1000).toISOString(),items,total:items.reduce((sum,x)=>sum+x.count,0)};
 }
 return periods;
}
export function createTheftLeaderboard({fetchImpl=fetch,now=Date.now}={}){
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
  return {ok:true,source:'djoniohanter.com/car_theft',updated_at:new Date(cached.at).toISOString(),periods:aggregatePoliceArrests(cached.records,now())};
 };
}
