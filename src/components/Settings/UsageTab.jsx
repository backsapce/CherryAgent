import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n/context';
import { listAgents } from '../../agents/agents';
import { loadSessionMetadata, loadSessionMessages } from '../../vfs/opfs';
import { AlertTriangle } from '../Icons/Icons';
import {
  aggregateSessionUsage,
  buildMonthGrid,
  formatCompactNumber,
  localDayKey,
  UNASSIGNED_AGENT_KEY,
  usageLevel,
} from './usageAggregation';

const LOAD_CONCURRENCY = 4;
const SESSION_BODY_CACHE_LIMIT = 400;
const PIE_MAX_SLICES = 7;
const PIE_OTHERS_KEY = '__others__';
const PIE_COLOR_COUNT = 8;

// Session bodies are immutable for a given updatedAtMs once persisted, so
// reopening settings reuses previous reads instead of decompressing chunks.
const sessionBodyCache = new Map();

function cacheSessionBody(id, updatedAtMs, messages) {
  if (sessionBodyCache.size >= SESSION_BODY_CACHE_LIMIT && !sessionBodyCache.has(id)) {
    const oldest = sessionBodyCache.keys().next().value;
    if (oldest !== undefined) sessionBodyCache.delete(oldest);
  }
  sessionBodyCache.set(id, { updatedAtMs, messages });
}

function DonutChart({ slices, total, centerLabel, centerSub, ariaLabel }) {
  // Offsets are derived purely (n <= 8 slices, so the quadratic scan is trivial).
  const arcs = slices.map((slice, i) => {
    const pct = total > 0 ? (slice.tokens / total) * 100 : 0;
    const preceding = slices
      .slice(0, i)
      .reduce((sum, prior) => sum + (total > 0 ? (prior.tokens / total) * 100 : 0), 0);
    return { slice, pct, offset: 25 - preceding };
  });
  return (
    <svg className="usage-donut" viewBox="0 0 42 42" role="img" aria-label={ariaLabel}>
      <circle className="usage-donut-track" cx="21" cy="21" r="15.9155" fill="none" />
      {arcs.map(({ slice, pct, offset }, i) => {
        return (
          <circle
            key={slice.key}
            cx="21"
            cy="21"
            r="15.9155"
            fill="none"
            stroke={`var(--usage-pie-${(i % PIE_COLOR_COUNT) + 1})`}
            strokeWidth="6"
            strokeDasharray={`${Math.max(pct, 0.01)} ${Math.max(100 - pct, 0)}`}
            strokeDashoffset={offset < 0 ? offset + 100 : offset}
          >
            <title>{`${slice.label} · ${formatCompactNumber(slice.tokens)}`}</title>
          </circle>
        );
      })}
      <text className="usage-donut-value" x="21" y="21" textAnchor="middle">{centerLabel}</text>
      <text className="usage-donut-sub" x="21" y="27" textAnchor="middle">{centerSub}</text>
    </svg>
  );
}

export default function UsageTab({ agentList = [] }) {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState('loading');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState(null);
  const [loadedSessions, setLoadedSessions] = useState([]);
  const [pieMode, setPieMode] = useState('today');
  const [reloadToken, setReloadToken] = useState(0);

  // Mount-time clock snapshot; the tab remounts whenever it is reopened.
  const [now] = useState(() => new Date());
  const todayKey = useMemo(() => localDayKey(now.getTime()), [now]);

  // Resolve agent display names: prefer the parent-provided list, fall back to
  // loading once. A ref keeps the async fallback from re-running per render.
  const [agents, setAgents] = useState(agentList);
  const initialAgentListRef = useRef(agentList);
  useEffect(() => {
    if (initialAgentListRef.current.length > 0) {
      setAgents(initialAgentListRef.current);
      return undefined;
    }
    let cancelled = false;
    listAgents()
      .then((list) => { if (!cancelled) setAgents(list); })
      .catch(() => { /* names fall back to raw agent ids */ });
    return () => { cancelled = true; };
  }, []);

  // Load session metadata first, then every session body with bounded
  // concurrency, coalescing re-aggregation into periodic flushes.
  useEffect(() => {
    let cancelled = false;
    let flushTimer = null;
    const loaded = [];

    const flushSessions = () => {
      if (cancelled) return;
      setLoadedSessions([...loaded]);
    };

    const scheduleFlush = () => {
      if (flushTimer != null || cancelled) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushSessions();
      }, 120);
    };

    (async () => {
      try {
        const sessions = await loadSessionMetadata();
        if (cancelled) return;
        const queue = [];
        for (const session of sessions || []) {
          const cached = sessionBodyCache.get(session.id);
          if (cached && cached.updatedAtMs === session.updatedAtMs) {
            loaded.push({ ...session, messages: cached.messages });
          } else {
            queue.push(session);
          }
        }
        setProgress({ done: 0, total: queue.length });
        flushSessions();
        if (queue.length === 0) {
          setStatus('ready');
          return;
        }

        let cursor = 0;
        let completed = 0;
        const worker = async () => {
          while (!cancelled) {
            const index = cursor;
            cursor += 1;
            if (index >= queue.length) return;
            const session = queue[index];
            let messages = [];
            try {
              messages = await loadSessionMessages(session.id);
            } catch (err) {
              console.warn(`Usage tab: failed to load session ${session.id}:`, err);
            }
            if (cancelled) return;
            cacheSessionBody(session.id, session.updatedAtMs, messages);
            loaded.push({ ...session, messages });
            completed += 1;
            setProgress({ done: completed, total: queue.length });
            if (completed >= queue.length) {
              if (flushTimer != null) clearTimeout(flushTimer);
              flushTimer = null;
              flushSessions();
            } else {
              scheduleFlush();
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(LOAD_CONCURRENCY, queue.length) }, () => worker())
        );
        if (!cancelled) {
          if (flushTimer != null) clearTimeout(flushTimer);
          flushSessions();
          setStatus('ready');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err);
          setStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      if (flushTimer != null) clearTimeout(flushTimer);
    };
  }, [reloadToken]);

  const aggregate = useMemo(
    () => aggregateSessionUsage(loadedSessions, { todayKey }),
    [loadedSessions, todayKey],
  );

  const agentNameById = useMemo(() => {
    const map = Object.create(null);
    for (const agent of agents) {
      if (agent && typeof agent.id === 'string') map[agent.id] = agent.name || agent.id;
    }
    return map;
  }, [agents]);

  const agentLabel = useCallback((key) => (
    key === UNASSIGNED_AGENT_KEY
      ? t('usageStats.unassigned')
      : (agentNameById[key] || key)
  ), [agentNameById, t]);

  const pieData = useMemo(() => {
    const source = pieMode === 'today' ? aggregate.todayAgents : aggregate.agentTotals;
    const entries = Object.entries(source)
      .map(([key, tokens]) => ({ key, tokens: Number(tokens) || 0 }))
      .filter((entry) => entry.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens);
    const slices = entries.slice(0, PIE_MAX_SLICES).map((entry) => ({
      ...entry,
      label: agentLabel(entry.key),
    }));
    const restTokens = entries
      .slice(PIE_MAX_SLICES)
      .reduce((sum, entry) => sum + entry.tokens, 0);
    if (restTokens > 0) {
      slices.push({ key: PIE_OTHERS_KEY, tokens: restTokens, label: t('usageStats.others') });
    }
    const total = slices.reduce((sum, slice) => sum + slice.tokens, 0);
    return { slices, total };
  }, [pieMode, aggregate, agentLabel, t]);

  const monthGrid = useMemo(
    () => (now ? buildMonthGrid(now.getFullYear(), now.getMonth()) : []),
    [now],
  );
  const monthMax = useMemo(() => {
    let max = 0;
    for (const week of monthGrid) {
      for (const date of week) {
        if (!date) continue;
        const total = aggregate.dayTotals[localDayKey(date.getTime())] || 0;
        if (total > max) max = total;
      }
    }
    return max;
  }, [monthGrid, aggregate]);

  const weekdayLabels = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
    // 2023-10-01 is a Sunday; step a week from there for Sun..Sat labels.
    return Array.from({ length: 7 }, (_, i) => formatter.format(new Date(2023, 9, 1 + i)));
  }, [locale]);

  const monthLabel = useMemo(
    () => (now
      ? new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(now)
      : ''),
    [locale, now],
  );

  const exactTokens = useCallback(
    (value) => `${Number(value || 0).toLocaleString()} ${t('usageStats.tokensUnit')}`,
    [t],
  );

  const pieTotalLabel = pieMode === 'today'
    ? t('usageStats.pieTitleToday')
    : t('usageStats.pieTitleTotal');

  return (
    <div className="settings-section usage-tab">
      <h3>{t('usageStats.title')}</h3>
      <p className="settings-desc">{t('usageStats.desc')}</p>

      {status === 'error' && (
        <div className="usage-status usage-status-error" role="alert">
          <AlertTriangle width={16} height={16} />
          <span>{error?.message || t('usageStats.loadError')}</span>
          <button
            type="button"
            className="usage-retry-btn"
            onClick={() => { setError(null); setReloadToken((v) => v + 1); }}
          >
            {t('usageStats.retry')}
          </button>
        </div>
      )}

      <div className="usage-cards">
        <div className="usage-card">
          <span className="usage-card-label">{t('usageStats.today')}</span>
          <span className="usage-card-value" title={exactTokens(aggregate.todayTotal)}>
            {formatCompactNumber(aggregate.todayTotal)}
          </span>
          <span className="usage-card-sub">{t('usageStats.tokensUnit')}</span>
        </div>
        <div className="usage-card">
          <span className="usage-card-label">{t('usageStats.maxDay')}</span>
          <span
            className="usage-card-value"
            title={exactTokens(aggregate.maxDayTotal)}
          >
            {formatCompactNumber(aggregate.maxDayTotal)}
          </span>
          <span className="usage-card-sub">{aggregate.maxDayKey || '—'}</span>
        </div>
        <div className="usage-card">
          <span className="usage-card-label">{t('usageStats.grandTotal')}</span>
          <span className="usage-card-value" title={exactTokens(aggregate.grandTotal)}>
            {formatCompactNumber(aggregate.grandTotal)}
          </span>
          <span className="usage-card-sub">{t('usageStats.tokensUnit')}</span>
        </div>
      </div>

      <div className="usage-panel">
        <div className="usage-panel-header">
          <h4>{t('usageStats.activity')}</h4>
          <span className="usage-panel-hint">{monthLabel}</span>
        </div>
        <div className="usage-heatmap" role="img" aria-label={t('usageStats.activity')}>
          <div className="usage-heatmap-days" aria-hidden="true">
            {weekdayLabels.map((label, i) => (
              <span key={`${label}-${i}`} className="usage-heatmap-day-label">{label}</span>
            ))}
          </div>
          <div className="usage-heatmap-cols">
            {monthGrid.map((week, weekIndex) => (
              <div key={weekIndex} className="usage-heatmap-col">
                {week.map((date, dayIndex) => {
                  if (!date) return <span key={dayIndex} className="usage-heatmap-cell usage-heatmap-pad" />;
                  const key = localDayKey(date.getTime());
                  const total = aggregate.dayTotals[key] || 0;
                  const isFuture = now != null && date.getTime() > now.getTime();
                  const level = usageLevel(total, monthMax);
                  const classNames = ['usage-heatmap-cell'];
                  if (isFuture) classNames.push('usage-heatmap-future');
                  else if (level > 0) classNames.push(`usage-heatmap-l${level}`);
                  if (key === todayKey) classNames.push('usage-heatmap-today');
                  return (
                    <span
                      key={key}
                      className={classNames.join(' ')}
                      title={`${key} · ${exactTokens(total)}`}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <div className="usage-heatmap-legend">
          <span>{t('usageStats.less')}</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span
              key={level}
              className={`usage-heatmap-cell usage-heatmap-legend-cell ${level > 0 ? `usage-heatmap-l${level}` : ''}`}
            />
          ))}
          <span>{t('usageStats.more')}</span>
        </div>
        <p className="usage-panel-note">{t('usageStats.activityHint')}</p>
      </div>

      <div className="usage-panel">
        <div className="usage-panel-header">
          <h4>{pieTotalLabel}</h4>
          <div className="usage-pie-tabs">
            <button
              type="button"
              className={pieMode === 'today' ? 'active' : ''}
              onClick={() => setPieMode('today')}
            >
              {t('usageStats.pieToday')}
            </button>
            <button
              type="button"
              className={pieMode === 'total' ? 'active' : ''}
              onClick={() => setPieMode('total')}
            >
              {t('usageStats.pieTotal')}
            </button>
          </div>
        </div>
        {pieData.total > 0 ? (
          <div className="usage-pie-wrap">
            <DonutChart
              slices={pieData.slices}
              total={pieData.total}
              centerLabel={formatCompactNumber(pieData.total)}
              centerSub={t('usageStats.tokensUnit')}
              ariaLabel={pieTotalLabel}
            />
            <ul className="usage-pie-legend">
              {pieData.slices.map((slice, i) => (
                <li key={slice.key} className="usage-pie-legend-item">
                  <span
                    className="usage-pie-swatch"
                    style={{ background: `var(--usage-pie-${(i % PIE_COLOR_COUNT) + 1})` }}
                  />
                  <span className="usage-pie-name" title={slice.label}>{slice.label}</span>
                  <span className="usage-pie-stats">
                    {formatCompactNumber(slice.tokens)}
                    {' · '}
                    {Math.round((slice.tokens / pieData.total) * 100)}%
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="usage-empty">{t('usageStats.empty')}</p>
        )}
      </div>

      {status === 'loading' && (
        <p className="usage-status">
          {t('usageStats.loadingProgress', progress)}
        </p>
      )}
    </div>
  );
}
