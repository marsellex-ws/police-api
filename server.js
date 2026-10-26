import http from 'node:http';
import { pathToFileURL } from 'node:url';

const DEFAULT_ORIGINS = ['https://marsellex.ru', 'https://www.marsellex.ru'];
const PUBLIC_COLUMNS = 'id,department,nickname,account_number,punishment_type,article,reason,evidence_url,issued_by,redemption_type,redemption_proof_url,redemption_proof_label,status,issued_at,paid_at,paid_by,created_at,updated_at,version';
const DEPARTMENTS = new Set(['LSPD', 'SFPD', 'LVPD']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REDEMPTION_TYPES = new Set(['none', 'payment', 'duty', 'conversation', 'demotion', 'other']);
const SEARCH_RE = /^[\p{L}\p{N}_.\- ]{1,100}$/u;
const EDITABLE = ['nickname','account_number','punishment_type','article','reason','evidence_url','issued_by','redemption_type','redemption_proof_url','redemption_proof_label'];

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

  const rpc = (name, args) => supabase('POST', `rpc/${name}`, args);

  async function bodyJson(req, maxBytes = 16384) {
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      throw new HttpError(415, 'Content-Type must be application/json');
    }
    let text = '';
    for await (const chunk of req) {
      text += chunk.toString('utf8');
      if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new HttpError(413, 'Request body too large');
    }
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
      const mandatory = ['nickname','account_number','punishment_type','issued_by'].includes(key);
      const value = textField(input[key], maxLengths[key], { mandatory });
      if (mandatory && value === '') throw new HttpError(400, 'Required field cannot be empty');
      out[key] = value === null || (value === '' && (key.endsWith('_url') || key === 'redemption_proof_label')) ? (key.endsWith('_url') || key === 'redemption_proof_label' ? null : key === 'redemption_type' ? 'none' : '') : value;
      if (key === 'redemption_proof_label' && out[key] === '') out[key] = null;
    }
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
    if (!match) throw new HttpError(401, 'World Script session is required');
    return match[1];
  }

  async function identity(req) {
    const token = tokenFrom(req);
    const result = await rpc('ws_admin_access_state', { p_ws_session_token: token });
    if (!result || Number(result.ok) !== 1 || typeof result.login !== 'string') throw new HttpError(401, 'Session expired');
    const login = result.login.trim().toLowerCase();
    const q = new URLSearchParams({ select: 'department,role', ws_login: `eq.${login}` });
    const roles = await supabase('GET', `pd_access?${q.toString()}`);
    const isAdmin = roles.some(x => x.role === 'admin' && x.department === 'ALL');
    const departments = isAdmin ? [...DEPARTMENTS] : roles.filter(x => x.role === 'editor' && DEPARTMENTS.has(x.department)).map(x => x.department);
    return { login, nickname: result.nickname || result.login, department: result.department || '', is_admin: isAdmin, editable_departments: departments };
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
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      if (req.method === 'OPTIONS') return send(res, 204, {});
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, service: 'police-api', database_configured: Boolean(env.SUPABASE_SECRET_KEY && env.SUPABASE_URL) });
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        limitLogin(req);
        const input = await bodyJson(req, 2048);
        const login = textField(input.login, 100, { mandatory: true });
        const password = input.password;
        if (typeof password !== 'string' || password.length < 1 || password.length > 256) throw new HttpError(400, 'Invalid password');
        const result = await rpc('ws_profile_login', { p_login: login, p_password: password });
        if (!result || Number(result.ok) !== 1 || !/^[a-f0-9]{64}$/i.test(result.session_token || '')) {
          return send(res, 401, { ok: false, error: 'Invalid login or password' });
        }
        return send(res, 200, { ok: true, session_token: result.session_token, login: result.login, nickname: result.nickname, department: result.department });
      }

      if (req.method === 'GET' && url.pathname === '/api/auth/me') {
        const user = await identity(req);
        return send(res, 200, { ok: true, user });
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        const token = tokenFrom(req);
        await rpc('ws_profile_logout', { p_session_token: token });
        return send(res, 200, { ok: true });
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
        const record = { ...validateFields(input, true), department, status: 'active', created_by: user.login, updated_by: user.login };
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
