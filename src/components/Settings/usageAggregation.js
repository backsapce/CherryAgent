/**
 * Pure helpers that aggregate per-message token usage into the shapes used by
 * the settings usage tab: daily totals, per-agent splits, compact number
 * formatting, and calendar heatmap grids.
 *
 * Data shape reference (see src/vfs/opfs.js and src/agent/loop.js):
 * - Assistant messages persisted with a turn carry `usage.turn_total_tokens`
 *   (whole-turn total including sub-agents), with `total_tokens` and
 *   `prompt_tokens + completion_tokens` as older fallbacks.
 * - `runFinishedAt` / `runStartedAt` on those messages are ISO timestamps;
 *   session metadata carries `createdAtMs` / `updatedAtMs` epoch millis.
 * - Sessions may reference an agent through `agentId` (absent = unassigned).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sentinel agent key for sessions without an `agentId`. */
export const UNASSIGNED_AGENT_KEY = '';

export function usageTurnTokens(message) {
  if (!message || typeof message !== 'object') return 0;
  const usage = message.usage;
  if (!usage || typeof usage !== 'object') return 0;
  const candidates = [
    usage.turn_total_tokens,
    usage.total_tokens,
    (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0),
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

/** Resolve the timestamp (epoch ms) a message's usage should be booked on. */
export function messageDayMs(message, session) {
  const iso = message?.runFinishedAt || message?.runStartedAt;
  if (typeof iso === 'string' && iso) {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return ms;
  }
  for (const key of ['updatedAtMs', 'createdAtMs']) {
    const ms = Number(session?.[key]);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return null;
}

/** Local-calendar YYYY-MM-DD key, matching what the user sees on a calendar. */
export function localDayKey(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatScaled(value, divisor, suffix) {
  const scaled = value / divisor;
  const rounded = scaled >= 100
    ? Math.round(scaled)
    : Math.round(scaled * 10) / 10;
  return `${rounded}${suffix}`;
}

/** Human-scale numbers: 1234567891 → "1.2B", 3400000 → "3.4M", 1234 → "1.2K". */
export function formatCompactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1e9) return formatScaled(n, 1e9, 'B');
  if (n >= 1e6) return formatScaled(n, 1e6, 'M');
  if (n >= 1e3) return formatScaled(n, 1e3, 'K');
  return `${Math.round(n)}`;
}

/**
 * Aggregate loaded sessions into usage buckets.
 * @param {Array} sessions Session objects, each optionally carrying `messages`.
 * @param {{ todayKey?: string }} options Local YYYY-MM-DD key for "today".
 * @returns {{
 *   dayTotals: Record<string, number>,
 *   dayAgents: Record<string, Record<string, number>>,
 *   agentTotals: Record<string, number>,
 *   grandTotal: number,
 *   todayTotal: number,
 *   todayAgents: Record<string, number>,
 *   maxDayKey: string | null,
 *   maxDayTotal: number,
 * }}
 */
export function aggregateSessionUsage(sessions, { todayKey } = {}) {
  const dayTotals = Object.create(null);
  const dayAgents = Object.create(null);
  const agentTotals = Object.create(null);
  let grandTotal = 0;

  if (Array.isArray(sessions)) {
    for (const session of sessions) {
      if (!session || typeof session !== 'object') continue;
      const messages = Array.isArray(session.messages) ? session.messages : [];
      const agentKey = typeof session.agentId === 'string' && session.agentId
        ? session.agentId
        : UNASSIGNED_AGENT_KEY;
      for (const message of messages) {
        const tokens = usageTurnTokens(message);
        if (tokens <= 0) continue;
        grandTotal += tokens;
        agentTotals[agentKey] = (agentTotals[agentKey] || 0) + tokens;
        const dayMs = messageDayMs(message, session);
        const dayKey = dayMs != null ? localDayKey(dayMs) : null;
        if (!dayKey) continue;
        dayTotals[dayKey] = (dayTotals[dayKey] || 0) + tokens;
        const agents = (dayAgents[dayKey] ||= Object.create(null));
        agents[agentKey] = (agents[agentKey] || 0) + tokens;
      }
    }
  }

  let maxDayKey = null;
  let maxDayTotal = 0;
  for (const [key, total] of Object.entries(dayTotals)) {
    if (total > maxDayTotal) {
      maxDayTotal = total;
      maxDayKey = key;
    }
  }

  return {
    dayTotals,
    dayAgents,
    agentTotals,
    grandTotal,
    todayTotal: todayKey ? (dayTotals[todayKey] || 0) : 0,
    todayAgents: todayKey ? Object.assign(Object.create(null), dayAgents[todayKey] || {}) : {},
    maxDayKey,
    maxDayTotal,
  };
}

/**
 * Build a GitHub-style month grid: one column per week, 7 cells per column
 * (Sunday first). Leading/trailing padding cells are `null`.
 * @param {number} year Full year.
 * @param {number} monthIndex 0-11.
 * @returns {Array<Array<Date | null>>}
 */
export function buildMonthGrid(year, monthIndex) {
  const first = new Date(year, monthIndex, 1);
  if (Number.isNaN(first.getTime())) return [];
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const cells = new Array(first.getDay()).fill(null);
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push(new Date(year, monthIndex, day));
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }
  return weeks;
}

/** Map a day's usage to a 0-4 heatmap intensity level, relative to `max`. */
export function usageLevel(value, max) {
  const v = Number(value) || 0;
  if (v <= 0 || !(Number(max) > 0)) return 0;
  const ratio = v / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

/** Difference in whole days between two local YYYY-MM-DD keys. */
export function daysBetweenKeys(fromKey, toKey) {
  const from = Date.parse(`${fromKey}T00:00:00`);
  const to = Date.parse(`${toKey}T00:00:00`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / DAY_MS);
}
