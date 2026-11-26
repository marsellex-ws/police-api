import { timingSafeEqual } from 'node:crypto';
import { createTheftLeaderboard } from '../../../theft-leaderboard.js';
import { createStaffProfileLookup } from '../../../staff-profiles.js';
import { fetchTheftSource, projectCurrentTheft, projectTheftArchive } from '../../../theft-archive.js';

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
    signal: AbortSignal.timeout(15000),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Supabase HTTP ' + response.status);
  return response.status === 204 ? null : response.json();
}

const loadRanking = createTheftLeaderboard({
  includeWeeks: true,
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

function store(section: string, payload: unknown, updatedAt: string) {
  return request('POST', 'rpc/pd_store_theft_portal', {
    p_section: section, p_payload: payload, p_updated_at: updatedAt,
  });
}

async function syncCurrent() {
  const data = await fetchTheftSource('get_data.php', 256 * 1024);
  await store('current', projectCurrentTheft(data), new Date().toISOString());
}

async function syncArchive() {
  const data = await fetchTheftSource('get_progress.php', 24 * 1024 * 1024);
  await store('archive', projectTheftArchive(data), new Date().toISOString());
}

async function syncPolice() {
  const {weeks, ...ranking} = await loadRanking();
  await Promise.all([
    request('POST', 'rpc/pd_store_theft_snapshot', { p_payload: ranking }),
    store('police', {weeks, profiles_available: ranking.profiles_available}, ranking.updated_at),
  ]);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response(null, { status: 405 });

  const token = req.headers.get('x-pd-sync-token') || '';
  if (!/^[a-f0-9]{64}$/.test(token)) return new Response(null, { status: 401 });

  try {
    if (!(await authorize(token))) return new Response(null, { status: 401 });
    const {kind} = await req.json().catch(() => ({})) || {};
    if (kind === 'current') {
      await syncCurrent();
      return Response.json({ ok: true });
    }
    const outcomes = await Promise.allSettled([syncPolice(), syncArchive()]);
    const failures = outcomes.flatMap(outcome => outcome.status === 'rejected'
      ? [outcome.reason instanceof Error ? outcome.reason.message : 'unknown error'] : []);
    if (failures.length) {
      console.error('Theft archive sync failed:', failures.join(', '));
      return Response.json({ ok: false }, { status: 502 });
    }
    return Response.json({ ok: true });
  } catch (error) {
    console.error('Employee theft sync failed:', error instanceof Error ? error.message : 'unknown error');
    return Response.json({ ok: false }, { status: 502 });
  }
});
