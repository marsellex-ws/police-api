import { Buffer } from 'node:buffer';

const archive = 'https://djoniohanter.com/car_theft/';
const headers = { Accept: 'application/json', Referer: archive };
const cleanName = value => typeof value === 'string' ? value.trim().slice(0, 100) : '';
const accountId = value => /^\d{1,18}$/.test(String(value)) ? String(value) : '';
const positiveNumber = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;

export async function fetchTheftSource(file, limit, fetchImpl = fetch, now = Date.now, timeout = 12000) {
  const response = await fetchImpl(archive + file + '?t=' + now(), {
    headers, signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok || !response.body) throw Error(file + ' HTTP ' + response.status);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error(file + ' exceeds archive size limit');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}

export function projectCurrentTheft(data) {
  if (!data || typeof data !== 'object' || typeof data.theftInProgress !== 'boolean') {
    throw Error('Invalid current theft data');
  }
  const player = data.theftInProgress && Object.values(data.players || {}).find(entry => Number(entry?.state) > 0);
  if (!player) return {active: null};
  const state = Number(player.state);
  const hidden = state === 1 || state === 2;
  return {active: {
    state,
    name: hidden ? '' : cleanName(player.name),
    account: hidden ? '' : accountId(player.playerId),
    started_at: positiveNumber(player.startTime),
  }};
}

export function projectTheftArchive(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid theft history');
  const history = [];
  const players = [];
  const totals = {players: 0, successes: 0, failures: 0, arrests: 0};
  for (const [key, profile] of Object.entries(data)) {
    const account = accountId(key);
    if (!account || !Array.isArray(profile?.theftHistory)) continue;
    const name = profile.theftHistory.map(event => cleanName(event?.name)).find(Boolean) || 'Неизвестно';
    const player = {account, name, level: positiveNumber(profile.level) || 1, successes: 0, failures: 0, arrests: 0, earnings: 0};
    for (const event of profile.theftHistory) {
      if (!event || typeof event !== 'object') continue;
      const reward = positiveNumber(event.reward);
      const status = Number(event.state) === 5 ? 'arrested' : (event.success === true || Number(event.success) === 1) ? 'success' : 'failed';
      if (status === 'success') {
        player.successes++;
        player.earnings += reward;
      } else if (status === 'arrested') player.arrests++;
      else player.failures++;
      history.push({account, name, timestamp: positiveNumber(event.timestamp || event.startTime || event.start_time), reward, status});
    }
    totals.successes += player.successes;
    totals.failures += player.failures;
    totals.arrests += player.arrests;
    players.push(player);
  }
  totals.players = players.length;
  players.sort((a, b) => b.successes - a.successes || b.earnings - a.earnings || a.name.localeCompare(b.name, 'ru'));
  history.sort((a, b) => b.timestamp - a.timestamp);
  return {players, totals, history};
}
