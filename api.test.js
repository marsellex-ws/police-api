import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from './server.js';

const TOKEN = 'a'.repeat(64);
const UID = '31bf20da-3c21-401f-a229-12d6cf7a9d33';
function fakeDatabase({role = 'senior', move, saveChief} = {}) {
  const records = [];
  const request = async (url, options) => {
    const u = new URL(url);
    const path = u.pathname.replace('/rest/v1/', '');
    const body = options.body ? JSON.parse(options.body) : null;
    let code = 200, response;
    if (path === 'rpc/ws_profile_login') response = { ok: 1, session_token: TOKEN, login: 'tester', nickname: 'Tester', department: 'LSPD' };
    else if (path === 'rpc/ws_admin_access_state') response = { ok: 1, login: 'tester', nickname: 'Tester', department: 'LSPD' };
    else if (path === 'rpc/ws_profile_logout') response = { ok: 1 };
    else if (path === 'ws_sessions') response = [{ created_at: new Date().toISOString() }];
    else if (path === 'pd_ws_roles') response = [{ role, department: 'LSPD' }];
    else if (path === 'rpc/pd_move_leadership_slot' && move) response = move(body);
    else if (path === 'rpc/pd_save_leadership_chief' && saveChief) response = saveChief(body);
    else if (path === 'ws_profiles') response = [];
    else if (path === 'pd_access') response = [{ department: 'LSPD', role: 'editor' }];
    else if (path === 'pd_punishments' && options.method === 'POST') {
      const item = { ...body, id: UID, version: 1 };
      records.push(item);response = [item];
    } else if (path === 'pd_punishments' && options.method === 'PATCH') {
      const item = records.find(x => x.id === u.searchParams.get('id').slice(3) && x.version === +u.searchParams.get('version').slice(3));
      if (item) { Object.assign(item, body, { version: item.version + 1 }); response = [{ ...item }]; }
      else response = [];
    } else if (path === 'pd_punishments') {
      const id = u.searchParams.get('id')?.slice(3);
      const dep = u.searchParams.get('department')?.slice(3);
      response = records.filter(x => (!id || x.id === id) && (!dep || x.department === dep));
    } else { code=404; response = { message: 'not found' }; }
    return { ok: code < 400, status: code, text: async () => JSON.stringify(response) };
  };
  return request;
}
async function withApp(fn, overrides = {}, database = fakeDatabase()) {
  const app = createApp({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_very_long_TEST_KEY', ALLOWED_ORIGINS: 'https://marsellex.ru', ...overrides },
    fetchImpl: database
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise(resolve => server.close(resolve)); }
}
async function api(base,path,method='GET',data,token) {
  const r = await fetch(base+path, { method, headers: { Origin: 'https://marsellex.ru', ...(data ? {'Content-Type':'application/json'} : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(data ? {body: JSON.stringify(data)} : {}) });
  return [r.status,await r.json()];
}
test('health route, including querystring',async()=>withApp(async base=>{
  const [status,data] = await api(base,'/health?utm_source=example');
  assert.equal(status,200);assert.equal(data.ok,true);
}));
test('protected writes require a World Script session',async()=>withApp(async base=>{
  const [status] = await api(base,'/api/punishments','POST',{ department:'LSPD' });
  assert.equal(status,401);
}));
test('login, permission checks, create, list, pay, conflict',async()=>withApp(async base=>{
  const [loginStatus,login] = await api(base,'/api/auth/login','POST',{login:'tester',password:'abc'});
  assert.equal(loginStatus,200);assert.equal(login.session_token,TOKEN);
  const [meStatus,me]=await api(base,'/api/auth/me','GET',undefined,TOKEN);
  assert.equal(meStatus,200);assert.deepEqual(me.user.editable_departments,['LSPD']);
  const record={ department:'LSPD',nickname:'Player_Name',account_number:'1234',punishment_type:'Выговор',article:'УК 1.1',reason:'Тест',issued_by:'Admin_Name' };
  const [forbidden]=await api(base,'/api/punishments','POST',{...record,department:'LVPD'},TOKEN);
  assert.equal(forbidden,403);
  const [createStatus,created]=await api(base,'/api/punishments','POST',record,TOKEN);
  assert.equal(createStatus,201);assert.equal(created.item.version,1);
  const [readStatus,listed]=await api(base,'/api/punishments?department=LSPD');
  assert.equal(readStatus,200);assert.equal(listed.count,1);
  const [paidStatus,paid]=await api(base,`/api/punishments/${UID}`,'PATCH',{action:'pay',expected_version:1},TOKEN);
  assert.equal(paidStatus,200);assert.equal(paid.item.status,'paid');
  const [conflict]=await api(base,`/api/punishments/${UID}`,'PATCH',{action:'pay',expected_version:1},TOKEN);
  assert.equal(conflict,409);
}));
test('reject cross-site writes',async()=>withApp(async base=>{
  const r = await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:'https://attacker.example','Content-Type':'application/json'},body:JSON.stringify({login:'x',password:'y'})});
  assert.equal(r.status,403);
}));


test('leadership order writes validate privilege, version and the session actor', async () => {
  const route = '/api/portal/admin/leadership/order';
  const move = {slot:'swat_commander', neighbor:'swat_deputy', version:1, actor:'untrusted'};
  await withApp(async base => {
    assert.equal((await api(base,route,'POST',move))[0],401);
    assert.equal((await api(base,route,'POST',move,TOKEN))[0],403);
  });

  const calls = [];
  const database = fakeDatabase({role:'admin', move: args => {
    calls.push(args);
    return calls.length === 1 ? {ok:true,slots:['swat_deputy','swat_commander'],version:2} :
      {ok:false,conflict:true,slots:['swat_deputy','swat_commander'],version:2};
  }});
  await withApp(async base => {
    assert.equal((await api(base,route,'POST',{...move,version:0},TOKEN))[0],400);
    assert.equal(calls.length,0);
    const [status, data] = await api(base,route,'POST',move,TOKEN);
    assert.equal(status,200);
    assert.equal(data.version,2);
    assert.deepEqual(calls[0],{p_slot:move.slot,p_neighbor:move.neighbor,p_version:1,p_actor:'tester'});
    const [stale, conflict] = await api(base,route,'POST',move,TOKEN);
    assert.equal(stale,409);
    assert.deepEqual(conflict.slots,data.slots);
  },{},database);
});


test('chief leadership writes persist identity and appointment together with the session actor', async () => {
  const route = '/api/portal/admin/leadership/leader_sfpd';
  const body = {nickname:'Officer_Test',avatar_url:'',vk_url:'',forum_url:'',gender:'male',
    account_number:'99881',appointed_on:'2026-10-21',actor:'ignored'};
  await withApp(async base => {
    assert.equal((await api(base,route,'PUT',body))[0],401);
    assert.equal((await api(base,route,'PUT',body,TOKEN))[0],403);
  });
  const calls = [];
  const database = fakeDatabase({role:'admin',saveChief:args=>{
    calls.push(args);
    return {ok:true,item:{slot:args.p_slot},chief:{appointed_on:args.p_appointed_on}};
  }});
  await withApp(async base => {
    assert.equal((await api(base,route,'PUT',{...body,appointed_on:'2026-02-30'},TOKEN))[0],400);
    assert.equal((await api(base,route,'PUT',{...body,account_number:'invalid'},TOKEN))[0],400);
    assert.equal((await api(base,'/api/portal/admin/leadership/minister','PUT',body,TOKEN))[0],400);
    assert.equal(calls.length,0);
    const [status,result] = await api(base,route,'PUT',body,TOKEN);
    assert.equal(status,200);
    assert.equal(result.chief.appointed_on,body.appointed_on);
    assert.deepEqual(calls[0],{p_slot:'leader_sfpd',p_nickname:body.nickname,p_avatar_url:'',p_vk_url:'',
      p_forum_url:'',p_gender:'male',p_account_number:'99881',p_appointed_on:'2026-10-21',p_actor:'tester'});
    assert.equal((await api(base,route,'PUT',{...body,appointed_on:null},TOKEN))[0],200);
    assert.equal(calls.at(-1).p_appointed_on,null);
  },{},database);
});
