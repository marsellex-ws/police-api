import { timingSafeEqual } from 'node:crypto';
import { parseChiefTerms } from '../../../chief-terms-sheet.js';

const sheet = 'https://docs.google.com/spreadsheets/d/12_hevQ5hzcww3l8LQ2DYQ9wmfScp0YtRdYTUj-FAEgQ/export?format=xlsx&gid=1782955489';
const base = Deno.env.get('SUPABASE_URL')?.replace(/\/$/, '');
const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
const key = secretKeys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

async function database(path: string, body?: unknown) {
  if (!base || !key) throw Error('Supabase credentials unavailable');
  const headers = new Headers({ apikey: key });
  if (key.startsWith('eyJ')) headers.set('Authorization', 'Bearer ' + key);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(base + '/rest/v1/' + path, {
    headers, method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(7500),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw Error('Supabase HTTP ' + response.status);
  return response.status === 204 ? null : response.json();
}

async function getWorkbook() {
  const response = await fetch(sheet, {signal: AbortSignal.timeout(12000)});
  if (!response.ok || !response.body) throw Error('Google Sheets HTTP ' + response.status);
  const read = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const {value, done} = await read.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw Error('Spreadsheet export exceeds size limit');
      chunks.push(value);
    }
  } catch (error) {
    await read.cancel().catch(() => {});
    throw error;
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response(null,{status:405});
  const token = req.headers.get('x-pd-sync-token') || '';
  if (!/^[a-f0-9]{64}$/.test(token)) return new Response(null,{status:401});
  try {
    const rows = await database('pd_chief_term_sync_auth?select=token_sha256&id=eq.1');
    const expected = rows[0]?.token_sha256;
    if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw Error('Sync authorization unavailable');
    const actual = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
    const wanted = Uint8Array.from(expected.match(/../g)!,(pair) => parseInt(pair,16));
    if (!timingSafeEqual(new Uint8Array(actual),wanted)) return new Response(null,{status:401});

    const started = new Date().toISOString();
    const entries = parseChiefTerms(await getWorkbook());
    await database('rpc/pd_store_chief_term_snapshot',{p_updated_at:started,p_entries:entries});
    return Response.json({ok:true,count:entries.length});
  } catch (error) {
    console.error('Chief term sync failed:',error instanceof Error ? error.message : 'unknown error');
    return Response.json({ok:false},{status:502});
  }
});
