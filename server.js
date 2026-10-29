import http from 'node:http';
import { handleExamRequest } from './exams-api.js';
import { handlePortalRequest } from './portal-api.js';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const LOGIN_RE = /^[a-z0-9_.-]{3,32}$/;
const DEFAULT_ORIGINS = ['https://police-department.ru', 'https://www.police-department.ru', 'https://marsellex.ru', 'https://www.marsellex.ru'];
const PUBLIC_COLUMNS = 'id,department,nickname,account_number,punishment_type,article,reason,evidence_url,issued_by,redemption_type,redemption_proof_url,redemption_proof_label,status,issued_at,paid_at,paid_by,created_at,updated_at,version';
const DEPARTMENTS = new Set(['LSPD', 'SFPD', 'LVPD']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REDEMPTION_TYPES = new Set(['none', 'payment', 'duty', 'conversation', 'demotion', 'other']);
const SEARCH_RE = /^[\p{L}\p{N}_.\- ]{1,100}$/u;
const EDITABLE = ['nickname','account_number','punishment_type','article','reason','evidence_url','redemption_type','redemption_proof_url','redemption_proof_label'];
const PUNISHMENT_TYPES = new Set(['Выговор','Наряд','Понижение','Беседа']);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function requiredEnv(env) {
  const url = env.SUPABASE_URL?.replace(/\/$/, '');
  const key = env.SUPABASE_SECRET_KEY;
  if (!url || !/^https:\/\/[\w.-]+\.supabase\.co$/.test(url) || !key || key.length < 20) {
    throw new HttpError(503, 'Supabase is not configured on the server');
  }
  return { url, key };
}

export function createApp({ env = process.env, fetchImpl = fetch } = {}) {
  const allowedOrigins = new Set((env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(',')).split(',').map(x => x.trim()).filter(Boolean));
  const attempts = new Map();

  async function supabase(method, path, body, opts = {}) {
    const { url, key } = requiredEnv(env);
    const response = await fetchImpl(`${url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: key, // Modern sb_secret_ keys must be sent on apikey, NOT Authorization: Bearer.
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.prefer ? { Prefer: opts.prefer } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) {
      // Do not reflect Supabase internals or SQL details to browser clients.
      console.error('Supabase request failed', { method, route: path.split('?')[0], status: response.status });
      throw new HttpError(502, 'Database request failed');
    }
    const raw = await response.text();
    return raw ? JSON.parse(raw) : null;
  }

  async function storageUpload(path, bytes, contentType) {
    const {url,key}=requiredEnv(env);
    const response=await fetchImpl(`${url}/storage/v1/object/ws-avatars/${path}`,{
      method:'POST',headers:{apikey:key,'Content-Type':contentType,'x-upsert':'false','cache-control':'3600'},body:bytes,signal:AbortSignal.timeout(15000)
    });
    if(!response.ok){console.error('Storage upload failed',response.status);throw new HttpError(502,'Не удалось загрузить аватарку')}
    return `${url}/storage/v1/object/public/ws-avatars/${path}`;
  }
  const rpc = (name, args) => supabase('POST', `rpc/${name}`, args);

  async function bodyJson(req, maxBytes = 16384) {
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      throw new HttpError(415, 'Content-Type must be application/json');
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw new HttpError(413, 'Request body too large');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'JSON object expected');
    return parsed;
  }

  function textField(value, max, { mandatory = false } = {}) {
    if (value === undefined || value === null) {
      if (!mandatory) return null;
      throw new HttpError(400, 'Required field is missing');
    }
    if (typeof value !== 'string' || value.length > max || (mandatory && !value.trim())) throw new HttpError(400, 'Invalid field value');
    return value.trim();
  }

  function validateFields(input, create) {
    const out = {};
    const maxLengths = { nickname: 100, account_number: 64, punishment_type: 120, article: 100, reason: 2000, evidence_url: 2000, issued_by: 100, redemption_type: 32, redemption_proof_url: 2000, redemption_proof_label: 100 };
    for (const key of EDITABLE) {
      if (!create && !Object.hasOwn(input, key)) continue;
      const mandatory = ['nickname','account_number','punishment_type'].includes(key);
      const value = textField(input[key], maxLengths[key], { mandatory });
      if (mandatory && value === '') throw new HttpError(400, 'Required field cannot be empty');
      out[key] = value === null || (value === '' && (key.endsWith('_url') || key === 'redemption_proof_label')) ? (key.endsWith('_url') || key === 'redemption_proof_label' ? null : key === 'redemption_type' ? 'none' : '') : value;
      if (key === 'redemption_proof_label' && out[key] === '') out[key] = null;
    }
    if (Object.hasOwn(out, 'punishment_type') && !PUNISHMENT_TYPES.has(out.punishment_type)) throw new HttpError(400, 'Invalid punishment type');
    for (const field of ['evidence_url', 'redemption_proof_url']) {
      if (!out[field]) continue;
      let value;
      try { value = new URL(out[field]); } catch { throw new HttpError(400, 'Link must be an HTTPS URL'); }
      if (value.protocol !== 'https:' || !value.hostname || value.username || value.password) throw new HttpError(400, 'Link must be an HTTPS URL');
    }
    if (Object.hasOwn(out, 'redemption_type') && !REDEMPTION_TYPES.has(out.redemption_type)) throw new HttpError(400, 'Invalid redemption type');
    if (Object.hasOwn(out, 'redemption_proof_url') || Object.hasOwn(out, 'redemption_proof_label')) {
      if (create || Object.hasOwn(out, 'redemption_proof_url') && Object.hasOwn(out, 'redemption_proof_label')) {
        if (Boolean(out.redemption_proof_url) !== Boolean(out.redemption_proof_label)) throw new HttpError(400, 'Proof link and title must be provided together');
      }
    }
    return out;
  }

  function tokenFrom(req) {
    const match = /^Bearer ([0-9a-f]{64})$/i.exec(req.headers.authorization || '');
    if (!match) throw new HttpError(401, 'Sign in required');
    return match[1].toLowerCase();
  }
  async function identity(req) {
    // Credentials and session ownership are verified by the existing WS functions.
    const state = await rpc('ws_admin_access_state', { p_ws_session_token: tokenFrom(req) });
    if (!state || Number(state.ok) !== 1 || typeof state.login !== 'string') throw new HttpError(401,'Session expired');
    const login = state.login.trim().toLowerCase();
    const r = await supabase('GET', `pd_ws_roles?${new URLSearchParams({select:'role,department',login:`eq.${login}`,limit:'1'})}`);
    const role = r?.[0]?.role || null;
    const dept = r?.[0]?.department || null;
    const all = ['developer','admin','minister'].includes(role);
    const editable = all ? [...DEPARTMENTS] : (role === 'leader' || role === 'senior') && DEPARTMENTS.has(dept) ? [dept] : [];
    return { id: login, login, nickname: state.nickname || state.login, role, role_department: dept, department: dept || '', is_admin: role === 'developer' || role === 'admin', editable_departments: editable };
  }
  function requireManager(user) {
    if (!['developer','admin','minister'].includes(user.role)) throw new HttpError(403,'Access denied');
  }
  // Avatar data belongs to the existing World Script profile; no duplicate profile table.
  async function profileAvatar(login) {
    const query = new URLSearchParams({ select: 'avatar_path,avatar_url', login: `eq.${login}`, limit: '1' });
    const profiles = await supabase('GET', `ws_profiles?${query}`);
    const profile = profiles?.[0];
    if (!profile) return null;
    const base = env.SUPABASE_URL?.replace(/\/$/, '');
    const prefix = `${base}/storage/v1/object/public/ws-avatars/`;
    // Serve only objects from the designated PUBLIC bucket, never an arbitrary remote URL.
    const path = String(profile.avatar_path || '').trim();
    if (path && !path.startsWith('/') && !path.includes('..') && !path.includes('\\') &&
        path.split('/').every(p => p && /^[a-zA-Z0-9_.-]+$/.test(p))) {
      return prefix + path.split('/').map(encodeURIComponent).join('/');
    }
    const stored = String(profile.avatar_url || '');
    if (stored.startsWith(prefix) && !/[< >\\]/.test(stored)) return stored;
    return null;
  }

  async function userNames(logins) {
    const unique=[...new Set(logins.filter(v => typeof v==='string' && LOGIN_RE.test(v)))];
    if (!unique.length) return new Map();
    const q=new URLSearchParams({select:'login,nickname',login:`in.(${unique.join(',')})`,limit:String(Math.min(unique.length,100))});
    const users=await supabase('GET',`ws_profiles?${q}`);
    return new Map(users.map(v=>[v.login?.toLowerCase(),v.nickname]));
  }

  function canEdit(identity, dept) {
    return identity.is_admin || identity.editable_departments.includes(dept);
  }

  function limitLogin(req) {
    // Lightweight demo safeguard. A reverse-proxy/WAF or shared store is required for production-grade protection.
    const forwarded = String(req.headers['x-forwarded-for'] || '');
    const ip = forwarded ? forwarded.split(',').at(-1).trim().slice(0, 64) : (req.socket.remoteAddress || 'unknown');
    const now = Date.now();
    if (attempts.size > 4000) attempts.clear();
    const entry = attempts.get(ip) || { count: 0, expires: now + 10 * 60000 };
    if (entry.expires < now) { entry.count = 0; entry.expires = now + 10 * 60000; }
    entry.count++;
    attempts.set(ip, entry);
    if (entry.count > 10) throw new HttpError(429, 'Too many login attempts');
  }

  async function getRecord(id) {
    const q = new URLSearchParams({ select: PUBLIC_COLUMNS, id: `eq.${id}`, limit: '1' });
    const records = await supabase('GET', `pd_punishments?${q.toString()}`);
    if (!records.length) throw new HttpError(404, 'Punishment not found');
    return records[0];
  }

  function send(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Vary', 'Origin');
    try {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) throw new HttpError(403, 'Origin not allowed');
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      if (req.method === 'OPTIONS') return send(res, 204, {});
      const url = new URL(req.url, 'http://localhost');
      if (await handlePortalRequest({ req, res, url, supabase, identity, rpc, bodyJson, send, HttpError, storageUpload })) return;
      if (await handleExamRequest({ req, res, url, supabase, identity, bodyJson, send, HttpError })) return;

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, service: 'police-api', database_configured: Boolean(env.SUPABASE_SECRET_KEY && env.SUPABASE_URL) });
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/register') {
        limitLogin(req);
        const input=await bodyJson(req,2048);
        const login=String(input.login||'').trim().toLowerCase();
        const nickname=textField(input.nickname,24,{mandatory:true});
        const password=input.password;
        const department=input.department;
        const bankAccount=String(input.bank_account||'').trim();
        if (!LOGIN_RE.test(login) || !/^[A-Za-z0-9_]{3,24}$/.test(nickname) ||
            typeof password!=='string' || password.length<8 || password.length>72 ||
            !DEPARTMENTS.has(department) || !/^[0-9]{1,20}$/.test(bankAccount)) {
          throw new HttpError(400,'Invalid account details');
        }
        const result=await rpc('ws_profile_register',{
          p_nickname:nickname,p_login:login,p_password:password,p_department:department,p_bank_account:bankAccount
        });
        if (!result || Number(result.ok)!==1) throw new HttpError(409,'Account cannot be created');
        // The WS registration RPC creates a session; revoke this unused token.
        if (result.session_token) await rpc('ws_profile_logout',{p_session_token:result.session_token});
        return send(res,201,{ok:true});
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        limitLogin(req);
        const input=await bodyJson(req,2048);
        const login=String(input.login||'').trim().toLowerCase();
        const password=input.password;
        if (!LOGIN_RE.test(login) || typeof password!=='string' || password.length<1 || password.length>128) {
          throw new HttpError(401,'Invalid login or password');
        }
        const result=await rpc('ws_profile_login',{p_login:login,p_password:password});
        if (!result || Number(result.ok)!==1 || !/^[a-f0-9]{64}$/i.test(result.session_token||'')) {
          throw new HttpError(401,'Invalid login or password');
        }
        return send(res,200,{ok:true,session_token:result.session_token});
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/me') {
        const user=await identity(req);
        // A damaged/empty avatar must not break sign-in.
        let avatar_url=null;
        try { avatar_url=await profileAvatar(user.login); }
        catch(error) { console.error('Avatar lookup failed', error?.name || 'Error'); }
        return send(res,200,{ok:true,user:{...user,avatar_url}});
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        const token=tokenFrom(req);
        await rpc('ws_profile_logout',{p_session_token:token});
        return send(res,200,{ok:true});
      }
      if (req.method === 'POST' && url.pathname === '/api/site/bootstrap') {
        limitLogin(req);
        const user=await identity(req);
        const input=await bodyJson(req,1024);
        const supplied=input.bootstrap_token;
        const secret=env.PD_BOOTSTRAP_TOKEN||'';
        if (typeof supplied!=='string'||secret.length<32||supplied.length!==secret.length||
            !timingSafeEqual(Buffer.from(supplied),Buffer.from(secret))) throw new HttpError(403,'Access denied');
        const result=await rpc('pd_ws_initial_admin',{p_login:user.login});
        if (result!==true) throw new HttpError(409,'Administrator already exists');
        return send(res,200,{ok:true});
      }
      if (req.method === 'POST' && url.pathname === '/api/site/developer-bootstrap') {
        limitLogin(req);
        const user=await identity(req);
        if(user.role!=='admin') throw new HttpError(403,'Access denied');
        const input=await bodyJson(req,1024);
        const supplied=input.bootstrap_token;
        const secret=env.PD_DEVELOPER_BOOTSTRAP_TOKEN||'';
        if(typeof supplied!=='string'||secret.length<32||supplied.length!==secret.length||
            !timingSafeEqual(Buffer.from(supplied),Buffer.from(secret))) throw new HttpError(403,'Access denied');
        const result=await rpc('pd_ws_initial_developer',{p_login:user.login});
        if(result!==true) throw new HttpError(409,'Developer already assigned');
        return send(res,200,{ok:true});
      }
      if (req.method === 'GET' && url.pathname === '/api/roles/users') {
        const user=await identity(req); requireManager(user);
        const search=String(url.searchParams.get('search')||'').trim().toLowerCase();
        if(!/^[a-z0-9_.-]{2,32}$/.test(search)) return send(res,200,{ok:true,items:[]});
        const q=new URLSearchParams({select:'login,nickname',login:`ilike.${search}*`,order:'login.asc',limit:'20'});
        const people=await supabase('GET',`ws_profiles?${q}`);
        const ids=people.map(p=>p.login.toLowerCase());
        const roles=ids.length?await supabase('GET',`pd_ws_roles?${new URLSearchParams({select:'login,role,department',login:`in.(${ids.join(',')})`})}`):[];
        const map=new Map(roles.map(r=>[r.login,r]));
        return send(res,200,{ok:true,items:people.map(p=>({id:p.login.toLowerCase(),login:p.login,nickname:p.nickname,role:map.get(p.login.toLowerCase())?.role||null,department:map.get(p.login.toLowerCase())?.department||null}))});
      }
      if (req.method === 'GET' && url.pathname === '/api/roles/requests') {
        const user=await identity(req); requireManager(user);
        const q=new URLSearchParams({select:'id,requested_by,target_login,department,status,created_at',status:'eq.pending',order:'created_at.desc',limit:'100'});
        if (user.role==='leader') q.set('requested_by',`eq.${user.login}`);
        const rows=await supabase('GET',`pd_ws_role_requests?${q}`);
        const names=await userNames(rows.flatMap(r=>[r.requested_by,r.target_login]));
        return send(res,200,{ok:true,items:rows.map(r=>({...r,target_id:r.target_login,
          requested_by_user:names.get(r.requested_by)||r.requested_by,
          target_user:names.get(r.target_login)||r.target_login}))});
      }
      if (req.method === 'POST' && url.pathname === '/api/roles/assign') {
        const user=await identity(req); requireManager(user);
        const input=await bodyJson(req,2048);
        const target=String(input.target_login||input.target_id||'').trim().toLowerCase();
        const role=input.role,dept=input.department;
        if(!LOGIN_RE.test(target)||!['developer','admin','minister','leader','senior'].includes(role)||
           !['ALL',...DEPARTMENTS].includes(dept)) throw new HttpError(400,'Invalid selection');
        if((['developer','admin','minister'].includes(role) && dept!=='ALL') ||
           (['leader','senior'].includes(role) && !DEPARTMENTS.has(dept))) throw new HttpError(400,'Invalid department');
        if(user.role!=='developer' && (['developer','admin'].includes(role) ||
           (role==='minister' && user.role!=='admin'))) throw new HttpError(403,'Access denied');
        const result=await rpc('pd_ws_role_assign',{p_actor:user.login,p_target:target,p_role:role,p_dept:dept});
        return send(res,200,{ok:true,...result});
      }
      if (req.method === 'POST' && url.pathname === '/api/roles/decide') {
        throw new HttpError(404,'Not found');
      }
      if (req.method === 'POST' && url.pathname === '/api/roles/revoke') {
        const user=await identity(req);requireManager(user);
        const input=await bodyJson(req,1024);
        const target=String(input.target_login||input.target_id||'').trim().toLowerCase();
        if (!LOGIN_RE.test(target)) throw new HttpError(400,'Invalid account');
        const result=await rpc('pd_ws_role_revoke',{p_actor:user.login,p_target:target});
        return send(res,200,{ok:true,revoked:result});
      }

      if (req.method === 'GET' && url.pathname === '/api/punishments') {
        const department = url.searchParams.get('department');
        if (department && !DEPARTMENTS.has(department)) throw new HttpError(400, 'Invalid department');
        const limit = Number(url.searchParams.get('limit') || '50');
        const offset = Number(url.searchParams.get('offset') || '0');
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000) throw new HttpError(400, 'Invalid pagination');
        const search = url.searchParams.get('search');
        if (search && !SEARCH_RE.test(search)) throw new HttpError(400, 'Invalid search');
        const q = new URLSearchParams({ select: PUBLIC_COLUMNS, order: 'issued_at.desc', limit: String(limit), offset: String(offset) });
        if (department) q.set('department', `eq.${department}`);
        if (search) q.set('nickname', `ilike.*${search}*`);
        const items = await supabase('GET', `pd_punishments?${q.toString()}`);
        return send(res, 200, { ok: true, items, count: items.length, next_offset: items.length === limit ? offset + limit : null });
      }

      if (req.method === 'POST' && url.pathname === '/api/punishments') {
        const user = await identity(req);
        const input = await bodyJson(req);
        const department = textField(input.department, 4, { mandatory: true });
        if (!DEPARTMENTS.has(department)) throw new HttpError(400, 'Invalid department');
        if (!canEdit(user, department)) throw new HttpError(403, 'Not permitted for this department');
        const record = { ...validateFields(input, true), issued_by: user.login, department, status: 'active', created_by: user.login, updated_by: user.login };
        const results = await supabase('POST', 'pd_punishments?select=' + encodeURIComponent(PUBLIC_COLUMNS), record, { prefer: 'return=representation' });
        if (!results?.[0]) throw new HttpError(502, 'Could not create punishment');
        return send(res, 201, { ok: true, item: results[0] });
      }

      const idMatch = /^\/api\/punishments\/([0-9a-f-]+)$/i.exec(url.pathname);
      if (req.method === 'PATCH' && idMatch) {
        const id = idMatch[1];
        if (!UUID_RE.test(id)) throw new HttpError(400, 'Invalid record ID');
        const user = await identity(req);
        const input = await bodyJson(req);
        const old = await getRecord(id);
        if (!canEdit(user, old.department)) throw new HttpError(403, 'Not permitted for this department');
        if (old.status !== 'active') throw new HttpError(409, 'Only active punishments can be modified');
        const action = input.action;
        const version = Number(input.expected_version);
        if (!Number.isSafeInteger(version) || version < 1 || version !== old.version) throw new HttpError(409, 'Record changed; refresh and retry');
        let patch;
        if (action === 'update') {
          patch = validateFields(input, false);
          if (Object.hasOwn(patch,'redemption_proof_url') !== Object.hasOwn(patch,'redemption_proof_label')) throw new HttpError(400, 'Proof link and title must be provided together');
          if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to update');
        } else if (action === 'pay') {
          patch = { status: 'paid', paid_at: new Date().toISOString(), paid_by: user.login };
          const proof = validateFields(Object.fromEntries(['redemption_type','redemption_proof_url','redemption_proof_label'].filter(k => Object.hasOwn(input,k)).map(k => [k,input[k]])), false);
          if (Object.hasOwn(proof, 'redemption_proof_url') !== Object.hasOwn(proof, 'redemption_proof_label')) throw new HttpError(400, 'Proof link and title must be provided together');
          if (Object.hasOwn(proof, 'redemption_proof_url') && Boolean(proof.redemption_proof_url) !== Boolean(proof.redemption_proof_label)) throw new HttpError(400, 'Proof link and title must be provided together');
          Object.assign(patch, proof);
        } else if (action === 'cancel') {
          patch = { status: 'cancelled' };
        } else {
          throw new HttpError(400, 'Invalid action');
        }
        patch.updated_by = user.login;
        const query = new URLSearchParams({ select: PUBLIC_COLUMNS, id: `eq.${id}`, department: `eq.${old.department}`, status: 'eq.active', version: `eq.${version}` });
        const results = await supabase('PATCH', `pd_punishments?${query.toString()}`, patch, { prefer: 'return=representation' });
        if (!results?.[0]) throw new HttpError(409, 'Record changed; refresh and retry');
        return send(res, 200, { ok: true, item: results[0] });
      }

      throw new HttpError(404, 'Not found');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (!(error instanceof HttpError)) console.error('Unhandled API failure', error?.name || 'Error');
      if (!res.headersSent) send(res, status, { ok: false, error: error instanceof HttpError ? error.message : 'Internal server error' });
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 10000);
  http.createServer(createApp()).listen(port, '0.0.0.0', () => console.log(`police-api listening on port ${port}`));
}

// Vercel entrypoint
export default createApp();
