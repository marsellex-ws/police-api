import { timingSafeEqual } from 'node:crypto';
import { createTheftLeaderboard } from '../../../theft-leaderboard.js';
import { createStaffProfileLookup } from '../../../staff-profiles.js';

const base = Deno.env.get('SUPABASE_URL')?.replace(/\/$/, '');
const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
const key = secretKeys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

async function request(method: string, path: string, body?: unknown) {
  if (!base || !key) throw new Error('Supabase credentials unavailable');

  const headers = new Headers({ apikey: key, Accept: 'application/json' });
  if (key.startsWith('eyJ')) headers.set('Authorization', 'Bearer ' + key);
  if (body !== undefined) headers.set('Content-Type', 'application/json');

  const response = await fetch(base + '/rest/v1/' + path, {
    method,
    headers,
    signal: AbortSignal.timeout(8000),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Supabase HTTP ' + response.status);
  return response.status === 204 ? null : response.json();
}

const loadRanking = createTheftLeaderboard({
  lookupProfiles: createStaffProfileLookup({ supabase: request, supabaseUrl: base }),
});

async function authorize(token: string) {
  const rows = await request('GET', 'pd_theft_sync_auth?select=token_sha256&id=eq.1');
  const expected = rows[0]?.token_sha256;
  if (!/^[a-f0-9]{64}$/.test(expected ?? '')) return false;

  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const bytes = Uint8Array.from(expected.match(/../g)!, (pair) => parseInt(pair, 16));
  return timingSafeEqual(new Uint8Array(hash), bytes);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response(null, { status: 405 });

  const token = req.headers.get('x-pd-sync-token') || '';
  if (!/^[a-f0-9]{64}$/.test(token)) return new Response(null, { status: 401 });

  try {
    if (!(await authorize(token))) return new Response(null, { status: 401 });
    const payload = await loadRanking();
    await request('POST', 'rpc/pd_store_theft_snapshot', { p_payload: payload });
    return Response.json({ ok: true, updated_at: payload.updated_at });
  } catch (error) {
    console.error('Employee theft sync failed:', error instanceof Error ? error.message : 'unknown error');
    return Response.json({ ok: false }, { status: 502 });
  }
});
