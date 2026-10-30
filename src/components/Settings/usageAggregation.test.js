import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateSessionUsage,
  buildMonthGrid,
  daysBetweenKeys,
  formatCompactNumber,
  localDayKey,
  messageDayMs,
  UNASSIGNED_AGENT_KEY,
  usageLevel,
  usageTurnTokens,
} from './usageAggregation.js';

test('usageTurnTokens prefers turn totals and falls back sensibly', () => {
  assert.equal(usageTurnTokens(null), 0);
  assert.equal(usageTurnTokens({}), 0);
  assert.equal(usageTurnTokens({ usage: {} }), 0);
  assert.equal(
    usageTurnTokens({ usage: { turn_total_tokens: 1234, total_tokens: 99 } }),
    1234,
  );
  assert.equal(usageTurnTokens({ usage: { total_tokens: 99 } }), 99);
  assert.equal(
    usageTurnTokens({ usage: { prompt_tokens: 60, completion_tokens: 40 } }),
    100,
  );
  // Non-positive values are treated as absent so the chain keeps falling.
  assert.equal(
    usageTurnTokens({ usage: { turn_total_tokens: 0, prompt_tokens: 7, completion_tokens: 3 } }),
    10,
  );
  assert.equal(usageTurnTokens({ usage: { prompt_tokens: -5 } }), 0);
});

test('messageDayMs resolves run timestamps before session metadata', () => {
  const session = { updatedAtMs: Date.UTC(2026, 0, 3), createdAtMs: Date.UTC(2026, 0, 1) };
  assert.equal(
    messageDayMs({ runFinishedAt: '2026-02-10T12:00:00.000Z' }, session),
    Date.parse('2026-02-10T12:00:00.000Z'),
  );
  assert.equal(
    messageDayMs({ runStartedAt: '2026-02-09T08:00:00.000Z' }, session),
    Date.parse('2026-02-09T08:00:00.000Z'),
  );
  // Falls back to session metadata for legacy messages without run stamps.
  assert.equal(messageDayMs({}, session), Date.UTC(2026, 0, 3));
  assert.equal(messageDayMs({}, { createdAtMs: Date.UTC(2026, 0, 1) }), Date.UTC(2026, 0, 1));
  assert.equal(messageDayMs({}, {}), null);
  assert.equal(messageDayMs({ runFinishedAt: 'not-a-date' }, {}), null);
});

test('localDayKey formats local calendar dates', () => {
  const ms = new Date(2026, 1, 7, 23, 59).getTime();
  assert.equal(localDayKey(ms), '2026-02-07');
  assert.equal(localDayKey(Number.NaN), null);
});

test('formatCompactNumber uses human-scale units', () => {
  assert.equal(formatCompactNumber(0), '0');
  assert.equal(formatCompactNumber(undefined), '0');
  assert.equal(formatCompactNumber(42), '42');
  assert.equal(formatCompactNumber(999), '999');
  assert.equal(formatCompactNumber(1234), '1.2K');
  assert.equal(formatCompactNumber(12345), '12.3K');
  assert.equal(formatCompactNumber(3400000), '3.4M');
  assert.equal(formatCompactNumber(1234567891), '1.2B');
});

test('aggregateSessionUsage buckets by day and agent', () => {
  const dayA = new Date(2026, 5, 10, 9, 0).getTime();
  const dayB = new Date(2026, 5, 11, 22, 0).getTime();
  const sessions = [
    {
      id: 's1',
      agentId: 'agent-1',
      updatedAtMs: dayA,
      messages: [
        { usage: { turn_total_tokens: 100 }, runFinishedAt: new Date(dayA).toISOString() },
        { content: 'no usage here' },
        { usage: { total_tokens: 50 }, runFinishedAt: new Date(dayA).toISOString() },
      ],
    },
    {
      id: 's2',
      // Unassigned sessions share the sentinel bucket.
      updatedAtMs: dayB,
      messages: [
        { usage: { turn_total_tokens: 200 }, runFinishedAt: new Date(dayB).toISOString() },
      ],
    },
    { id: 's3', messages: null },
    null,
  ];

  const agg = aggregateSessionUsage(sessions, { todayKey: '2026-06-11' });
  assert.equal(agg.grandTotal, 350);
  assert.equal(agg.todayTotal, 200);
  assert.equal(agg.dayTotals['2026-06-10'], 150);
  assert.equal(agg.dayTotals['2026-06-11'], 200);
  assert.equal(agg.agentTotals['agent-1'], 150);
  assert.equal(agg.agentTotals[UNASSIGNED_AGENT_KEY], 200);
  assert.equal(agg.todayAgents[UNASSIGNED_AGENT_KEY], 200);
  assert.equal(agg.maxDayKey, '2026-06-11');
  assert.equal(agg.maxDayTotal, 200);
});

test('aggregateSessionUsage handles empty input', () => {
  const agg = aggregateSessionUsage([], { todayKey: '2026-06-11' });
  assert.equal(agg.grandTotal, 0);
  assert.equal(agg.todayTotal, 0);
  assert.equal(agg.maxDayKey, null);
  assert.equal(Object.getPrototypeOf(agg.todayAgents), null);
  assert.deepEqual({ ...agg.todayAgents }, {});
});

test('buildMonthGrid lays out weeks of seven with padding', () => {
  // June 2026 starts on a Monday and has 30 days.
  const weeks = buildMonthGrid(2026, 5);
  assert.equal(weeks[0][0], null); // Sunday padding
  assert.equal(weeks[0][1].getDate(), 1);
  assert.equal(weeks[0].length, 7);
  const flat = weeks.flat();
  assert.equal(flat.length % 7, 0);
  const realDays = flat.filter(Boolean);
  assert.equal(realDays.length, 30);
  assert.equal(realDays[0].getDate(), 1);
  assert.equal(realDays[29].getDate(), 30);
  assert.equal(weeks[weeks.length - 1][0].getDate(), 28);
  assert.deepEqual(buildMonthGrid(Number.NaN, 0), []);
});

test('usageLevel maps ratios to five intensity steps', () => {
  assert.equal(usageLevel(0, 1000), 0);
  assert.equal(usageLevel(500, 0), 0);
  assert.equal(usageLevel(100, 1000), 1);
  assert.equal(usageLevel(300, 1000), 2);
  assert.equal(usageLevel(600, 1000), 3);
  assert.equal(usageLevel(900, 1000), 4);
});

test('daysBetweenKeys computes whole-day gaps for local keys', () => {
  assert.equal(daysBetweenKeys('2026-06-10', '2026-06-11'), 1);
  assert.equal(daysBetweenKeys('2026-06-11', '2026-06-10'), -1);
  assert.equal(daysBetweenKeys('2026-06-10', '2026-06-10'), 0);
  assert.equal(daysBetweenKeys('bad', '2026-06-10'), null);
});
