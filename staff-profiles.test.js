import test from 'node:test';import assert from 'node:assert/strict';
import {createStaffProfileLookup,publicStaffAvatar} from './staff-profiles.js';
import {createTheftLeaderboard} from './theft-leaderboard.js';
const url='https://example.supabase.co';
test('public avatars accept only the profile bucket and safe object paths',()=>{
 assert.equal(publicStaffAvatar({avatar_path:'users/cop.png'},url),url+'/storage/v1/object/public/ws-avatars/users/cop.png');
 assert.equal(publicStaffAvatar({avatar_url:url+'/storage/v1/object/public/ws-avatars/cop.webp'},url),url+'/storage/v1/object/public/ws-avatars/cop.webp');
 for(const profile of [{avatar_url:'https://evil.example/a.png'},{avatar_path:'../private.png'},{avatar_url:url+'/storage/v1/object/public/ws-avatars/../private/a.png'},{avatar_url:url+'/storage/v1/object/public/ws-avatars/%2e%2e/private.png'}])assert.equal(publicStaffAvatar(profile,url),null);
});
test('nickname lookup returns only exact matching public fields, skips ambiguous matches and caches reads',async()=>{
 let calls=0;const lookup=createStaffProfileLookup({supabaseUrl:url,supabase:async(method,path)=>{calls++;assert.equal(method,'GET');const query=new URL('https://local/'+path).searchParams;assert.equal(query.get('select'),'login,nickname,avatar_url,avatar_path');assert.match(query.get('or'),/nickname\.ilike/);return [{nickname:'Alpha_Cop',login:'alpha',avatar_path:'alpha.png',private_email:'hidden'},{nickname:'Duplicate',login:'first'},{nickname:'Duplicate',login:'second'},{nickname:'Other_Cop',login:'other'}];}});
 const result=await lookup(['ALPHA COP','Duplicate',');bad filter']);assert.equal(result.get('alpha_cop').login,'alpha');assert.deepEqual(Object.keys(result.get('alpha_cop')).sort(),['avatar_url','login']);assert.equal(result.has('duplicate'),false);assert.equal(result.has('other_cop'),false);await lookup(['ALPHA COP','Duplicate']);assert.equal(calls,1);
});
test('profile enrichment matches casing, preserves ranking and degrades safely when profiles fail',async()=>{
 const now=Date.now();const fetchImpl=async()=>new Response(JSON.stringify([{policeName:'Alpha Cop',reward:100,timestamp:now/1000-10}]));
 const load=createTheftLeaderboard({fetchImpl,lookupProfiles:async()=>new Map([['alpha_cop',{login:'alpha',avatar_url:null}]])});const data=await load();assert.equal(data.periods.day.items[0].login,'alpha');assert.equal(data.periods.day.items[0].reward,100);assert.equal(data.profiles_available,true);
 const fallback=await createTheftLeaderboard({fetchImpl,lookupProfiles:async()=>{throw Error('unavailable')}})();assert.equal(fallback.periods.day.items[0].login,null);assert.equal(fallback.periods.day.total,1);assert.equal(fallback.profiles_available,false);
});
