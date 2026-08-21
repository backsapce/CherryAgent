import { lazy, Suspense, useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import SessionList from './components/SessionList/SessionList';
import MessagePanel from './components/MessagePanel/MessagePanel';
import {
  loadSessionMetadata,
  loadSessionMessages,
  saveSessions,
  clearAll,
  deleteSession as deleteSessionFile,
  exportToZip,
  readSessionRecoveryJournal,
  writeSessionRecoveryJournal,
  clearSessionRecoveryJournal,
} from './vfs/opfs';
import {
  requestPersistentStorage,
  STORAGE_PERSISTENCE_STATUS,
} from './vfs/storagePersistence';
import config from './config/config';
import llm from './models/llm';
import { executeCommand, initAgents, enableE2b, E2B_AGENT_ID, getSandboxStatus, stopE2bSandbox, assertRemoteAgentRunProtocol, startRemoteAgentRun, getRemoteAgentRun, listRemoteAgentRuns, abortRemoteAgentRun } from './models/agent';
import { prepareAgentRuntimeContext, runAgentLoop } from './agent/loop';
import { applyAgentEvent, createAgentEventState } from './agent/events';
import { buildChatDebugExport, createChatDebugFilename } from './agent/debug';
import { ensureDefaultSkills } from './agent/skills';
import { ensureDefaultAgent, listAgents, updateAgentConfig } from './agents/agents';
import { configureAutoSync, suspendAutoSync, waitForSyncIdle } from './sync/syncManager';
import { I18nProvider } from './i18n/index';
import { useI18n } from './i18n/context';
import { resolveLocale } from './i18n/locales';
import {
  buildSessionTitleRequest,
  cleanGeneratedSessionTitle,
  normalizeAutoTitleConfig,
  selectAutoTitleProfileId,
} from './models/sessionTitle';
import { editUserMessageAndDiscardFollowing } from './messageHistory';
import {
  reconcileSessionRecoveryJournal,
  reconcileStoredSessions,
  snapshotSessions,
  sortSessions,
} from './sessionRefresh';
import { createSessionSaveCoordinator } from './sessionPersistence';
import { createSessionRunRegistry } from './sessionRuns';
import { buildWakeupMessage, createOrReplaceTurnWakeup, findNextWakeup } from './agent/wakeup';
import { WifiOff, ChevronRight } from './components/Icons/Icons';
import { boundContextFilesForPrompt, stripLegacyContextFileSummary } from './contextFiles';
import { canSupersedeRemoteRun, formatRunFailureContent } from './remoteRunPresentation';
import {
  assertRemoteRunSnapshot,
  captureRemoteReplyFields,
  findSessionReply,
  isSlowRemoteRetryError,
  markConfirmedRemoteRunFailure,
  markRemoteRunPollError,
  normalizeRemoteAgentEvent,
  prepareRemoteEventReplay,
  shouldPersistRemoteReplayProgress,
  shouldRetryRemoteRunFailure,
  upsertSessionReply,
} from './remoteRunState';
import './App.css';

const FileManage = lazy(() => import('./components/FileManage/FileManage'));

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function downloadJsonFile(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  downloadBlobFile(filename, blob);
}

function downloadBlobFile(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function sessionTimeFields(date = new Date()) {
  return {
    updatedAt: formatTime(date),
    updatedAtMs: date.getTime(),
  };
}

function sessionMetadataOnly(session) {
  if (!Object.prototype.hasOwnProperty.call(session, 'messages')) return session;
  const { messages: _messages, ...metadata } = session;
  return metadata;
}

function metadataSnapshot(sessions) {
  return snapshotSessions((sessions || []).map(sessionMetadataOnly));
}

function sessionHasRunningRemote(sessions, sessionId) {
  return sessions.find((session) => session.id === sessionId)?.remoteRun?.status === 'running';
}

const AGENT_SYSTEM_PROMPT = `You have access to commands, browser-workspace files, sandbox-runtime files, memory, skills, and focused sub-agent delegation.

Filesystem model:
- CherryAgent state lives in browser OPFS, but browser file tools do NOT expose the OPFS root.
- Browser file tools can read/write only the active agent's own persistent files area: workspace/<active-agent>/files/.
- Browser file tools cannot access other agents, OPFS root files, AGENTS.md, memory files, or skill files by path.
- The skill catalog is merged in order from OPFS global skills, active OPFS workspace skills, then selected agent skills; a later same-named skill overrides an earlier one.
- Use the skill tool for all skill reads and writes. In browser runtime, skill writes always go to workspace/<active-agent>/skills/ in OPFS.
- The sandbox filesystem is the selected agent runtime workdir and is separate from browser OPFS. Its skills/ directory is the final browser-runtime skill source, but other OPFS state and browser workspace files are not automatically synchronized in browser runtime.
- Use browser file tools only for persistent files in the active agent's files area: list_browser_files, read_browser_file, display_browser_image, write_browser_file.
- Use sandbox file tools only for files created or needed inside the command runtime: list_sandbox_files, read_sandbox_file, display_sandbox_image, write_sandbox_file.
- If data must move between the active agent files area and sandbox runtime, explicitly read from one side and write to the other side.
- To show an image to the user, always call display_browser_image or display_sandbox_image with its real file path. Never emit Markdown/HTML image tags for local paths, and never place image bytes, binary data, base64, or data URLs in a response or tool result.

Work rules:
- Inspect the correct filesystem before editing when current state matters.
- Do not answer with a promise like "I will inspect/read/create/run". If the next step needs a tool, call the tool in the same response.
- Be careful with destructive actions and ask before irreversible operations.
- Use sub-agents only for bounded independent work.
- When start_command is available, use it for long-running CLI work before schedule_wakeup. Never keep execute_command blocked on training, servers, watchers, or other long/uncertain work. Include the job_id and latest log cursor in the future wake-up instruction.
- When tools fail, use the error output to choose the next useful step.`;

const SANDBOX_AGENT_SYSTEM_PROMPT = `You are running fully inside the selected sandbox. Browser operations, browser OPFS, browser files, browser memory mutation, and sub-agent delegation are unavailable. Enabled OPFS global and workspace skills are synchronized into sandbox skills/ without replacing skills that already exist there. The skill tool reads and writes only sandbox skills/, so skills created during this runtime remain in the sandbox and are not written back to OPFS. Images attached to user messages are copied into the sandbox under attachments/; each image message includes its exact local path, which can be passed to curl and other command-line tools. Use command tools, sandbox file tools, the skill tool, and schedule_wakeup. Start long-running CLI work with start_command, then schedule a future continuation containing its job_id and latest log cursor instead of blocking or repeatedly polling; the agent server keeps both the run and managed command alive while the browser is disconnected. To show an image, always call display_sandbox_image with its real sandbox path; never emit Markdown/HTML image tags for local paths and never put image bytes, binary data, base64, or data URLs in the conversation. The browser may disconnect without stopping this run.`;

const FILE_CONTEXT_MARKER = 'Selected file context:';
const TOOL_HISTORY_MARKER = 'Tool calls performed during this assistant turn:';
const TOOL_HISTORY_RESULT_MAX_CHARS = 4000;
const REMOTE_ABORT_TIMEOUT_MS = 5000;
const REMOTE_ABORT_RETRY_MS = 1500;
const REMOTE_RESUME_RETRY_MS = 1500;
const REMOTE_RESUME_SLOW_RETRY_MS = 30_000;
const REMOTE_WAITING_RECONCILE_MS = 5000;
const LOCAL_RUN_STOP_TIMEOUT_MS = 5000;

async function waitForSettlement(promise, timeoutMs) {
  let timerId;
  const settled = await Promise.race([
    Promise.resolve(promise).then(() => true, () => true),
    new Promise((resolve) => {
      timerId = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  clearTimeout(timerId);
  return settled;
}

async function abortRemoteAgentRunBestEffort(url, runId) {
  if (!url || !runId) return null;
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), REMOTE_ABORT_TIMEOUT_MS);
  try {
    return await abortRemoteAgentRun(url, runId, controller.signal);
  } catch (error) {
    // A local abort must not be held hostage by an unreachable runtime. The
    // server-side run is best-effort once this bounded request has finished.
    // Only a confirmed missing run releases the stale local record. Auth and
    // validation failures do not prove that the server-side run stopped.
    if ([404, 410].includes(error?.status)) return { status: 'unavailable' };
    if ([400, 401, 403, 405, 422].includes(error?.status)) return { status: 'cancel-blocked' };
    return null;
  } finally {
    clearTimeout(timerId);
  }
}

function contextFilePromptPath(file) {
  if (file?.relativePath) return file.relativePath;
  return String(file?.displayPath || '').replace(/^\/workspace\/[^/]+\//, '');
}

function promptAttr(value) {
  return String(value || '').replace(/"/g, '&quot;');
}

function contextFilePromptSource(file) {
  return file?.source === 'sandbox' ? 'sandbox' : 'browser';
}

function messagePreviewText(text, images, contextFiles) {
  if (text) return text;
  if (contextFiles?.length) return contextFilePromptPath(contextFiles[0]) || '[File]';
  if (images?.length) return '[Image]';
  return '';
}

function truncateForPrompt(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

function appendPromptSection(content, marker, body) {
  if (!body) return content || '';
  return `${content || ''}\n\n${marker}\n${body}`.trim();
}

function toolCallPromptAttr(value) {
  return String(value || '').replace(/"/g, '&quot;');
}

function formatToolCallsForLlm(toolCalls) {
  if (!toolCalls?.length) return '';
  return toolCalls
    .map((tc, index) => {
      const lines = [
        `<tool_call index="${index + 1}" name="${toolCallPromptAttr(tc.name)}" status="${toolCallPromptAttr(tc.status || 'unknown')}">`,
      ];
      if (tc.command) lines.push(`command: ${tc.command}`);
      if (tc.summary) lines.push(`summary: ${tc.summary}`);
      if (tc.result) lines.push(`result:\n${truncateForPrompt(tc.result, TOOL_HISTORY_RESULT_MAX_CHARS)}`);
      lines.push('</tool_call>');
      return lines.join('\n');
    })
    .join('\n\n');
}

function expandMessagesForLlm(messages) {
  return messages.map((message) => {
    const {
      contextFiles,
      toolCalls,
      transcript: _transcript,
      usage: _usage,
      remoteEventSequence: _remoteEventSequence,
      remoteReasoningParsers: _remoteReasoningParsers,
      ...rest
    } = message;
    let content = stripLegacyContextFileSummary(message.content, contextFiles);

    if (contextFiles?.length) {
      const fileBlocks = contextFiles
        .map((file) => `<file source="${contextFilePromptSource(file)}" path="${promptAttr(contextFilePromptPath(file))}">\n${file.content}\n</file>`)
        .join('\n\n');
      content = appendPromptSection(content, FILE_CONTEXT_MARKER, fileBlocks);
    }

    const toolHistory = formatToolCallsForLlm(toolCalls);
    if (toolHistory) {
      content = appendPromptSection(content, TOOL_HISTORY_MARKER, toolHistory);
    }

    return {
      ...rest,
      content,
    };
  });
}

function expandMessagesForSandboxRuntime(messages) {
  return expandMessagesForLlm(boundContextFilesForPrompt(messages));
}

function OfflineBanner() {
  const { t } = useI18n();
  return (
    <div className="offline-banner">
      <WifiOff width={16} height={16} />
      <span>{t('offline.banner')}</span>
    </div>
  );
}

function App() {
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [initError, setInitError] = useState(null);
  const [startupRecoveryBusy, setStartupRecoveryBusy] = useState(null);
  const [startupRecoveryError, setStartupRecoveryError] = useState(null);
  const [_llmReady, setLlmReady] = useState(false); // triggers re-render on config change
  const [runningSessionIds, setRunningSessionIds] = useState(() => new Set());
  const [pendingSessionIds, setPendingSessionIds] = useState(() => new Set());
  const [stoppingSessionIds, setStoppingSessionIds] = useState(() => new Set());
  const [loadingSessionIds, setLoadingSessionIds] = useState(() => new Set());
  const [remoteResumeVersion, setRemoteResumeVersion] = useState(0);
  const [remoteDiscoveryVersion, setRemoteDiscoveryVersion] = useState(0);
  const [theme, setTheme] = useState('system'); // 'light' | 'dark' | 'system'
  const [localePref, setLocalePref] = useState('auto'); // persisted language preference
  const [agents, setAgents] = useState([]); // [{url, name, status:'connected'|'disconnected'}]
  const [selectedAgentUrl, setSelectedAgentUrl] = useState(null); // url of active agent or null
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [showFileManage, setShowFileManage] = useState(false);
  const [fileManageWidth, setFileManageWidth] = useState(320);
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false);
  const [userNickname, setUserNickname] = useState('');
  const [avatar, setAvatar] = useState('');
  const [agentList, setAgentList] = useState([]); // [{ id, name, createdAt }]
  const [agentListReady, setAgentListReady] = useState(false);
  const [sessionAgents, setSessionAgents] = useState({}); // { sessionId -> agentId }
  const [lastAgentId, setLastAgentId] = useState(null); // agent used by most recent session
  const [sessionLlmProfiles, setSessionLlmProfiles] = useState({}); // { sessionId -> llmProfileId }
  const [currentLlmProfileId, setCurrentLlmProfileId] = useState(null);
  const [storageVersion, setStorageVersion] = useState(0);
  const [messageQueue, setMessageQueue] = useState([]);
  const sessionPersistenceReadyRef = useRef(false);
  const skipNextSessionSaveRef = useRef(null);
  const persistedSessionsRef = useRef([]);
  const sessionSaveCoordinatorRef = useRef(null);
  const resumedRemoteRunsRef = useRef(new Set());
  const resumingWaitingRunsRef = useRef(new Set());
  const probingWaitingRunsRef = useRef(new Set());
  const waitingRemoteTimersRef = useRef(new Map());
  const remoteResumeRetryTimersRef = useRef(new Map());
  const remoteAbortRetryTimersRef = useRef(new Map());
  const remoteDiscoveryRef = useRef(new Set());
  const remoteDiscoveryRetryTimersRef = useRef(new Map());
  const titleGenerationControllersRef = useRef(new Map());
  const factoryResetInProgressRef = useRef(false);
  const startupRecoveryBusyRef = useRef(false);
  const pendingStreamStartsRef = useRef(new Map());
  const sessionStopPromisesRef = useRef(new Map());
  const claimedWakeupIdsRef = useRef(new Set());
  const cancelledWakeupIdsRef = useRef(new Set());
  const deletedSessionIdsRef = useRef(new Set());
  const deletingSessionIdsRef = useRef(new Set());
  const sessionIncarnationsRef = useRef(new Map());
  const sessionDeletionTailRef = useRef(Promise.resolve());
  const selectedAgentRef = useRef(null); // avoid stale closure
  const messagePanelRef = useRef(null);
  const sessionsRef = useRef(sessions);
  const activeSessionIdRef = useRef(activeSessionId);
  const localePrefRef = useRef(localePref);
  const sessionLoadRequestRef = useRef(0);
  const sessionLoadingRequestsRef = useRef(new Map());
  const sessionRunsRef = useRef(null);

  if (!sessionRunsRef.current) {
    sessionRunsRef.current = createSessionRunRegistry({
      onChange: setRunningSessionIds,
    });
  }

  if (!sessionSaveCoordinatorRef.current) {
    sessionSaveCoordinatorRef.current = createSessionSaveCoordinator({
      save: saveSessions,
      snapshot: snapshotSessions,
      checkpoint: (checkpointSessions, baseline) => writeSessionRecoveryJournal({
        baseline,
        sessions: checkpointSessions,
      }),
      clearCheckpoint: clearSessionRecoveryJournal,
      onCommitted: (snapshot) => {
        persistedSessionsRef.current = metadataSnapshot(snapshot);
      },
      onError: (err) => console.warn('OPFS save failed:', err),
    });
  }

  const flushPendingSessionSave = useCallback(
    () => sessionSaveCoordinatorRef.current.flush(),
    []
  );

  const beginSessionStorageBarrier = useCallback(async () => {
    return sessionSaveCoordinatorRef.current.beginBarrier();
  }, []);

  useLayoutEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useLayoutEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useLayoutEffect(() => {
    localePrefRef.current = localePref;
  }, [localePref]);

  const refreshFromStorage = useCallback(async () => {
    const saveCoordinator = sessionSaveCoordinatorRef.current;
    saveCoordinator.suspend();
    try {
      await config.init();

      const savedTheme = config.get('theme');
      if (savedTheme && ['light', 'dark', 'system'].includes(savedTheme)) {
        setTheme(savedTheme);
      }

      const savedLocale = config.get('locale');
      if (savedLocale) setLocalePref(savedLocale);

      setUserNickname(config.get('general.userNickname') || config.get('general.nickname') || '');
      setAvatar(config.get('general.avatar') || '');

      const persistedBeforeRefresh = persistedSessionsRef.current;
      const savedMetadata = await loadSessionMetadata();
      const selectedId = activeSessionIdRef.current;
      const savedSessions = sortSessions(await Promise.all(savedMetadata.map(async (session) => (
        session.id === selectedId
          ? { ...session, messages: await loadSessionMessages(session.id) }
          : session
      ))));
      // The outer storage barrier already flushed the pre-operation state.
      // Only after both storage reads succeed may we discard snapshots queued
      // while remote/imported files were changing. If either read fails, the
      // finally block resumes this still-pending save instead of losing it.
      // On success, its in-memory edits participate in the three-way merge.
      saveCoordinator.cancelScheduled();
      const previewMerge = reconcileStoredSessions(
        savedSessions,
        sessionsRef.current,
        persistedBeforeRefresh
      );
      // The freshly loaded objects are already an immutable persisted
      // baseline. Sharing them avoids cloning the entire history during sync
      // refresh; React replaces changed session branches instead of mutating
      // this baseline.
      persistedSessionsRef.current = savedSessions;
      // Reconcile again inside the functional update. React may have accepted
      // streaming chunks or another local edit while OPFS was being read, and
      // sessionsRef intentionally only updates after a committed render.
      setSessions((currentSessions) => {
        const { sessions: latestMergedSessions, needsPersist } = reconcileStoredSessions(
          savedSessions,
          currentSessions,
          persistedBeforeRefresh
        );
        skipNextSessionSaveRef.current = needsPersist ? null : latestMergedSessions;
        sessionsRef.current = latestMergedSessions;
        return latestMergedSessions;
      });

      // The non-session state below only depends on session metadata. This
      // preview is refreshed from the same three-way merge; the functional
      // update above remains authoritative for message content.
      const mergedSessions = previewMerge.sessions;

      // A restored session with the same id is a new incarnation. Clear the
      // completed deletion fence while invalidating callbacks captured by the
      // old incarnation.
      for (const session of mergedSessions) {
        if (
          deletedSessionIdsRef.current.has(session.id)
          && !deletingSessionIdsRef.current.has(session.id)
        ) {
          deletedSessionIdsRef.current.delete(session.id);
          sessionIncarnationsRef.current.set(
            session.id,
            (sessionIncarnationsRef.current.get(session.id) || 0) + 1
          );
        }
      }

      const agentMap = {};
      const llmMap = {};
      for (const session of mergedSessions) {
        if (session.agentId) agentMap[session.id] = session.agentId;
        if (session.llmProfileId) llmMap[session.id] = session.llmProfileId;
      }
      setSessionAgents(agentMap);
      setSessionLlmProfiles(llmMap);

      const lastWithAgent = mergedSessions.find((c) => c.agentId);
      setLastAgentId(lastWithAgent?.agentId || null);

      const selectedSessionId = activeSessionIdRef.current;
      if (mergedSessions.length === 0) {
        setActiveSessionId(null);
      } else if (!mergedSessions.some((session) => session.id === selectedSessionId)) {
        setActiveSessionId(mergedSessions[0].id);
      }

      await llm.init();
      const activeLlmId = llm.getActiveProfileId();
      const selectedSession = mergedSessions.find((session) => session.id === selectedSessionId) || mergedSessions[0];
      const sessionLlmId = selectedSession?.llmProfileId;
      setCurrentLlmProfileId(sessionLlmId || activeLlmId || null);
      setLlmReady((prev) => !prev);

      const savedAgents = await listAgents();
      setAgentList(savedAgents);
      setAgentListReady(true);

      // config.yaml may have gained or lost sandbox hosts during sync/import.
      // Rebuild the runtime view so Settings and sandbox selectors reflect the
      // restored config without requiring a page reload. The global
      // file-manager selection remains local to this device.
      const { agents: restoredSandboxes, selectedUrl } = await initAgents();
      setAgents(restoredSandboxes);
      setSelectedAgentUrl(selectedUrl);
      selectedAgentRef.current = selectedUrl;
      setStorageVersion((prev) => prev + 1);
    } finally {
      saveCoordinator.resume();
    }
  }, []);

  // Load config, sessions and LLM settings from OPFS on mount
  useEffect(() => {
    let sessionLoadSucceeded = false;
    config.init()
      .then(() => {
        // OSS/S3 credentials intentionally stay local and cannot bootstrap a
        // restore after the browser evicts this origin. Ask the browser to
        // protect the OPFS bucket for existing sync users on every startup;
        // persist() is idempotent and Chromium may grant it as engagement or
        // PWA-install state changes.
        if (config.get('sync.enabled')) {
          requestPersistentStorage().then((status) => {
            if (status !== STORAGE_PERSISTENCE_STATUS.PERSISTENT) {
              console.warn(`Browser storage remains ${status}; local sync credentials may be evicted.`);
            }
          });
        }
        // Restore persisted theme preference
        const saved = config.get('theme');
        if (saved && ['light', 'dark', 'system'].includes(saved)) {
          setTheme(saved);
        }
        // Restore persisted language preference
        const savedLocale = config.get('locale');
        if (savedLocale) setLocalePref(savedLocale);
        // Restore persisted user nickname, falling back to the legacy nickname key.
        const savedNickname = config.get('general.userNickname') || config.get('general.nickname');
        if (savedNickname) setUserNickname(savedNickname);
        const savedAvatar = config.get('general.avatar');
        if (savedAvatar) setAvatar(savedAvatar);
        return Promise.all([
          loadSessionMetadata()
            .then(async (saved) => {
              const sortedSaved = sortSessions(saved);
              let recoveryJournal = null;
              try {
                recoveryJournal = await readSessionRecoveryJournal();
              } catch (error) {
                // A malformed recovery journal must never make otherwise-good
                // primary session storage unopenable. Leave it untouched for
                // inspection and replace it after the next durable save.
                console.warn('Ignoring invalid session recovery journal:', error);
              }
              const sorted = recoveryJournal
                ? reconcileSessionRecoveryJournal(sortedSaved, recoveryJournal).sessions
                : sortedSaved;
              // Keep the loaded value itself as the initial immutable
              // baseline. Deep-cloning hundreds of MB of history here can
              // exhaust the tab before the first render.
              persistedSessionsRef.current = sortedSaved;
              // Even a stale recovery journal gets one normal save. Only that
              // durable save is allowed to clear the isolated checkpoint.
              skipNextSessionSaveRef.current = recoveryJournal ? null : sorted;
              sessionsRef.current = sorted;
              setSessions(sorted);
              if (saved.length) {
                // Restore per-session agent assignments from persisted session metadata
                const agentMap = {};
                const llmMap = {};
                for (const session of sorted) {
                  if (session.agentId) agentMap[session.id] = session.agentId;
                  if (session.llmProfileId) llmMap[session.id] = session.llmProfileId;
                }
                setSessionAgents(agentMap);
                setSessionLlmProfiles(llmMap);
                // Set lastAgentId from the most recent session that has an agent
                const lastWithAgent = sorted.find((c) => c.agentId);
                if (lastWithAgent) setLastAgentId(lastWithAgent.agentId);
              }
              sessionLoadSucceeded = true;
              sessionPersistenceReadyRef.current = true;
            })
            .catch((err) => { console.error('OPFS load failed:', err); setInitError('Failed to load sessions'); }),
          llm.init()
            .then(() => {
              setCurrentLlmProfileId(llm.getActiveProfileId());
              setLlmReady(true);
            })
            .catch((err) => { console.error('LLM init failed:', err); }),
        ]);
      })
      .then(() => {
        // Do not create or rewrite any secondary workspace data while primary
        // config/session storage is corrupt. The recovery screen must see a
        // stable snapshot that the user can export before choosing a reset.
        if (!sessionLoadSucceeded) return;

        initAgents().then(({ agents: allAgents, selectedUrl }) => {
          setAgents(allAgents);
          setSelectedAgentUrl(selectedUrl);
          selectedAgentRef.current = selectedUrl;
        }).catch((err) => console.warn('Agent init failed:', err));

        ensureDefaultSkills().catch((err) => console.warn('Ensure default skills failed:', err));

        ensureDefaultAgent()
          .catch((err) => console.warn('Ensure default agent failed:', err))
          .then(() => listAgents())
          .then((agentItems) => {
            setAgentList(agentItems);
            setAgentListReady(true);
          })
          .catch((err) => {
            // Agentless browser sessions can still use the configured LLM.
            // A stale agent-bound session will show an explicit unavailable
            // message instead of silently switching runtimes.
            console.warn('Load agents failed:', err);
            setAgentListReady(true);
          });
      })
      .catch((err) => {
        console.error('Config init failed:', err);
        setInitError(err.message || 'Failed to load configuration');
      })
      .finally(() => {
        // Never enable persistence over an empty fallback after a failed OPFS
        // load: doing so could replace recoverable session data on disk.
        if (sessionLoadSucceeded) setLoaded(true);
      });

  }, []);

  // Debounced save to OPFS whenever sessions change
  useEffect(() => {
    if (!loaded || !sessionPersistenceReadyRef.current) return;
    if (skipNextSessionSaveRef.current === sessions) {
      skipNextSessionSaveRef.current = null;
      sessionSaveCoordinatorRef.current.cancelScheduled();
      return;
    }
    skipNextSessionSaveRef.current = null;
    // Cloning is intentionally deferred into the timer so streaming renders
    // only replace one array reference instead of cloning/stringifying history.
    sessionSaveCoordinatorRef.current.schedule(sessions, persistedSessionsRef.current);
  }, [sessions, loaded]);

  useEffect(() => {
    const persistForLifecycle = () => {
      if (!sessionPersistenceReadyRef.current) return;
      const coordinator = sessionSaveCoordinatorRef.current;
      const persistence = coordinator.isSuspended()
        ? coordinator.checkpoint(sessionsRef.current, persistedSessionsRef.current)
        : coordinator.flush();
      persistence.catch((err) => console.warn('OPFS lifecycle save failed:', err));
    };
    const persistWhenHidden = () => {
      if (document.visibilityState === 'hidden') persistForLifecycle();
    };
    window.addEventListener('pagehide', persistForLifecycle);
    document.addEventListener('visibilitychange', persistWhenHidden);
    return () => {
      window.removeEventListener('pagehide', persistForLifecycle);
      document.removeEventListener('visibilitychange', persistWhenHidden);
      sessionSaveCoordinatorRef.current.cancelScheduled();
    };
  }, []);

  useEffect(() => {
    if (!loaded || !sessionPersistenceReadyRef.current || !config.initialized) return undefined;
    let cleanup = configureAutoSync(refreshFromStorage, { beforeSync: beginSessionStorageBarrier });
    const unsubscribe = config.subscribe(() => {
      cleanup?.();
      cleanup = configureAutoSync(refreshFromStorage, {
        beforeSync: beginSessionStorageBarrier,
        runStartup: false,
      });
    });
    return () => {
      cleanup?.();
      unsubscribe?.();
    };
  }, [loaded, refreshFromStorage, beginSessionStorageBarrier]);

  // Apply theme to <html> and listen for system preference changes
  useEffect(() => {
    const applyTheme = (mode) => {
      if (mode === 'system') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
      } else {
        document.documentElement.setAttribute('data-theme', mode);
      }
    };

    applyTheme(theme);

    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => { if (theme === 'system') applyTheme('system'); };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [theme]);

  const handleThemeChange = useCallback(async (newTheme) => {
    setTheme(newTheme);
    await config.set('theme', newTheme);
  }, []);

  const handleLocaleChange = useCallback(async (pref) => {
    localePrefRef.current = pref;
    setLocalePref(pref);
    await config.set('locale', pref);
  }, []);

  const activeSession = sessions.find((c) => c.id === activeSessionId);
  const messages = activeSession?.messages || [];
  const activeSessionStreaming = Boolean(
    activeSessionId
    && (
      runningSessionIds.has(activeSessionId)
      || pendingSessionIds.has(activeSessionId)
      || stoppingSessionIds.has(activeSessionId)
      || activeSession?.remoteRun?.status === 'running'
    )
  );
  const activeSessionLoading = Boolean(activeSessionId && loadingSessionIds.has(activeSessionId));
  const activeSessionAgentLoading = Boolean(
    !agentListReady && (!activeSessionId || activeSession?.agentId)
  );
  const busySessionIdsForUi = new Set([
    ...runningSessionIds,
    ...pendingSessionIds,
    ...stoppingSessionIds,
    ...sessions
      .filter((session) => session.remoteRun?.status === 'running')
      .map((session) => session.id),
  ]);
  const selectedAgentId = activeSession?.agentId || lastAgentId || null;
  const activeAgentConfig = selectedAgentId ? agentList.find((agent) => agent.id === selectedAgentId) : null;
  const firstLlmProfileId = llm.getProfiles()[0]?.id || null;
  const activeLlmProfileId = activeSession?.llmProfileId || currentLlmProfileId || activeAgentConfig?.llmProfileId || llm.getActiveProfileId() || firstLlmProfileId;
  const activeSandboxUrl = activeAgentConfig?.sandboxUrl || null;

  const getFirstLlmProfileId = useCallback(() => llm.getProfiles()[0]?.id || null, []);
  const getAgentDefaultLlmId = useCallback((agentId) => {
    if (!agentId) return null;
    const agent = agentList.find((a) => a.id === agentId);
    return agent?.llmProfileId || null;
  }, [agentList]);

  const cancelPendingSessionStart = useCallback((sessionId) => {
    const pendingStart = pendingStreamStartsRef.current.get(sessionId);
    if (!pendingStart) return null;
    clearTimeout(pendingStart.timerId);
    pendingStreamStartsRef.current.delete(sessionId);
    setPendingSessionIds((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
    return pendingStart;
  }, []);

  const stopSessionRun = useCallback((sessionId, { skipAutomaticTitle = false } = {}) => {
    const sessionIncarnation = sessionIncarnationsRef.current.get(sessionId) || 0;
    const run = sessionRunsRef.current.get(sessionId);
    if (skipAutomaticTitle && run) run.skipAutomaticTitle = true;
    const existingStop = sessionStopPromisesRef.current.get(sessionId);
    if (existingStop) return existingStop;
    const storedRemote = sessionsRef.current.find((session) => session.id === sessionId)?.remoteRun;
    const remote = run?.remoteRun || (
      storedRemote && (storedRemote.status === 'running' || skipAutomaticTitle)
        ? storedRemote
        : null
    );
    if (!run && !remote) return Promise.resolve();
    setStoppingSessionIds((prev) => {
      if (prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.add(sessionId);
      return next;
    });
    if (remote) {
      resumedRemoteRunsRef.current.add(remote.id);
      resumingWaitingRunsRef.current.delete(remote.id);
    }
    run?.controller.abort();
    const remoteAbort = remote
      ? abortRemoteAgentRunBestEffort(remote.url, remote.id).then(function handleResult(result) {
          if (
            factoryResetInProgressRef.current
            || deletedSessionIdsRef.current.has(sessionId)
            || (sessionIncarnationsRef.current.get(sessionId) || 0) !== sessionIncarnation
          ) return;
          if (result?.status === 'cancel-blocked') return;
          if (result && !['running', 'waiting'].includes(result.status)) {
            const retryTimer = remoteAbortRetryTimersRef.current.get(remote.id);
            if (retryTimer) clearTimeout(retryTimer);
            remoteAbortRetryTimersRef.current.delete(remote.id);
            setSessions((prev) => prev.map((session) => (
              session.id === sessionId && session.remoteRun?.id === remote.id
                ? { ...session, remoteRun: { ...session.remoteRun, status: 'aborted' } }
                : session
            )));
            return;
          }
          if (remoteAbortRetryTimersRef.current.has(remote.id)) return;
          const timerId = setTimeout(() => {
            remoteAbortRetryTimersRef.current.delete(remote.id);
            const currentSession = sessionsRef.current.find((session) => session.id === sessionId);
            if (
              factoryResetInProgressRef.current
              || deletedSessionIdsRef.current.has(sessionId)
              || (sessionIncarnationsRef.current.get(sessionId) || 0) !== sessionIncarnation
              || currentSession?.remoteRun?.id !== remote.id
              || !['running', 'waiting'].includes(currentSession.remoteRun.status)
            ) return;
            void abortRemoteAgentRunBestEffort(remote.url, remote.id).then(handleResult);
          }, REMOTE_ABORT_RETRY_MS);
          remoteAbortRetryTimersRef.current.set(remote.id, timerId);
        })
      : Promise.resolve();
    const localStop = run
      ? waitForSettlement(run.completion, LOCAL_RUN_STOP_TIMEOUT_MS).then((settled) => {
          // A broken provider/tool may ignore AbortSignal forever. Detach its
          // UI generation after a bounded grace period; identity checks in the
          // stream callbacks prevent that late task from touching a newer run.
          if (!settled) sessionRunsRef.current.finish(sessionId, run);
        })
      : Promise.resolve();
    const stopPromise = Promise.allSettled([remoteAbort, localStop])
      .finally(() => {
        if (sessionStopPromisesRef.current.get(sessionId) !== stopPromise) return;
        sessionStopPromisesRef.current.delete(sessionId);
        setStoppingSessionIds((prev) => {
          if (!prev.has(sessionId)) return prev;
          const next = new Set(prev);
          next.delete(sessionId);
          return next;
        });
      });
    sessionStopPromisesRef.current.set(sessionId, stopPromise);
    return stopPromise;
  }, []);

  const handleCancelWakeup = useCallback((sessionId) => {
    const session = sessionsRef.current.find((item) => item.id === sessionId);
    if (!session) return;

    const localWakeupIds = new Set(
      (session.wakeups || []).map((wakeup) => wakeup?.id).filter(Boolean)
    );
    const waitingRemote = session.remoteRun?.status === 'waiting' && session.remoteRun.wakeup
      ? session.remoteRun
      : null;
    if (localWakeupIds.size === 0 && !waitingRemote) return;

    // Fence local timers immediately, including a timer callback that was
    // already queued before React commits the metadata update below.
    for (const wakeupId of localWakeupIds) {
      claimedWakeupIdsRef.current.add(wakeupId);
      cancelledWakeupIdsRef.current.add(wakeupId);
    }

    const pendingStart = pendingStreamStartsRef.current.get(sessionId);
    if (pendingStart?.opts?.wakeupId && localWakeupIds.has(pendingStart.opts.wakeupId)) {
      cancelPendingSessionStart(sessionId);
    }

    const activeRun = sessionRunsRef.current.get(sessionId);
    const localWakeupAlreadyStarted = Boolean(
      activeRun?.wakeupId && localWakeupIds.has(activeRun.wakeupId)
    );

    if (waitingRemote) {
      resumedRemoteRunsRef.current.add(waitingRemote.id);
      resumingWaitingRunsRef.current.delete(waitingRemote.id);
      const timerId = waitingRemoteTimersRef.current.get(waitingRemote.id);
      if (timerId) clearTimeout(timerId);
      waitingRemoteTimersRef.current.delete(waitingRemote.id);
    }

    if (localWakeupIds.size > 0) {
      setSessions((prev) => {
        const next = prev.map((item) => (
          item.id === sessionId
            ? {
                ...item,
                wakeups: (item.wakeups || []).filter(
                  (wakeup) => !localWakeupIds.has(wakeup?.id)
                ),
              }
            : item
        ));
        return next;
      });
    }

    if (localWakeupAlreadyStarted || waitingRemote) {
      void stopSessionRun(sessionId, { skipAutomaticTitle: true });
    }
  }, [cancelPendingSessionStart, stopSessionRun]);

  const handleNewSession = useCallback(async () => {
    messagePanelRef.current?.focusInput();
    if (!agentListReady) return;

    // If the active session is still empty, just keep it — don't spawn another
    const current = sessions.find((c) => c.id === activeSessionId);
    if (current && Array.isArray(current.messages) && current.messages.length === 0) return;

    // Use last used agent, falling back to first available agent
    const agentId = lastAgentId ?? (agentList.length > 0 ? agentList[0].id : null);

    const llmProfileId = currentLlmProfileId || getAgentDefaultLlmId(agentId) || llm.getActiveProfileId();

    const newSession = {
      id: generateId(),
      title: 'New Session',
      lastMessage: '',
      ...sessionTimeFields(),
      messages: [],
      ...(llmProfileId && { llmProfileId }),
      ...(agentId && { agentId }),
    };
    // Invalidate any metadata-only session load that belonged to the previous
    // selection before switching to the newly materialized conversation.
    sessionLoadRequestRef.current += 1;
    let preserveLoadedMessages = sessionRunsRef.current.values().length > 0
      || pendingStreamStartsRef.current.size > 0
      || sessionStopPromisesRef.current.size > 0
      || messageQueue.length > 0;
    if (!preserveLoadedMessages) await flushPendingSessionSave();
    preserveLoadedMessages ||= sessionRunsRef.current.values().length > 0
      || pendingStreamStartsRef.current.size > 0
      || sessionStopPromisesRef.current.size > 0
      || messageQueue.length > 0;
    if (!activeSessionId) messagePanelRef.current?.adoptNewSessionDraft(newSession.id);
    setSessions((prev) => sortSessions([
      newSession,
      ...prev.map((session) => preserveLoadedMessages ? session : sessionMetadataOnly(session)),
    ]));
    setActiveSessionId(newSession.id);

    if (agentId) {
      setSessionAgents((prev) => ({ ...prev, [newSession.id]: agentId }));
    }
    if (llmProfileId) {
      setSessionLlmProfiles((prev) => ({ ...prev, [newSession.id]: llmProfileId }));
      setCurrentLlmProfileId(llmProfileId);
    }
  }, [sessions, activeSessionId, agentList, agentListReady, lastAgentId, currentLlmProfileId, getAgentDefaultLlmId, flushPendingSessionSave, messageQueue]);

  const handleSelectSession = useCallback(async (sessionId) => {
    const requestId = ++sessionLoadRequestRef.current;
    const sessionIncarnation = sessionIncarnationsRef.current.get(sessionId) || 0;
    setActiveSessionId(sessionId);
    // Restore the agent for this session and update tracking
    const session = sessions.find((c) => c.id === sessionId);
    const agentId = session?.agentId;
    if (agentId) {
      setLastAgentId(agentId);
    }
    const llmProfileId = session?.llmProfileId || llm.getActiveProfileId();
    setCurrentLlmProfileId(llmProfileId || null);
    if (session?.messages) {
      sessionLoadingRequestsRef.current.delete(sessionId);
      setLoadingSessionIds((prev) => {
        if (!prev.has(sessionId)) return prev;
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
      if (
        sessionRunsRef.current.values().length > 0
        || pendingStreamStartsRef.current.size > 0
        || sessionStopPromisesRef.current.size > 0
        || messageQueue.length > 0
      ) return;
      await flushPendingSessionSave();
      if (
        requestId !== sessionLoadRequestRef.current
        || deletedSessionIdsRef.current.has(sessionId)
        || (sessionIncarnationsRef.current.get(sessionId) || 0) !== sessionIncarnation
        || sessionRunsRef.current.values().length > 0
        || pendingStreamStartsRef.current.size > 0
        || sessionStopPromisesRef.current.size > 0
        || messageQueue.length > 0
      ) return;
      setSessions((prev) => prev.map((item) => (
        item.id === sessionId
          ? (Object.prototype.hasOwnProperty.call(item, 'messages')
              ? item
              : { ...item, messages: session.messages })
          : sessionMetadataOnly(item)
      )));
      return;
    }

    sessionLoadingRequestsRef.current.set(sessionId, requestId);
    setLoadingSessionIds((prev) => {
      if (prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.add(sessionId);
      return next;
    });
    try {
      let preserveLoadedMessages = sessionRunsRef.current.values().length > 0
        || pendingStreamStartsRef.current.size > 0
        || sessionStopPromisesRef.current.size > 0
        || messageQueue.length > 0;
      if (!preserveLoadedMessages) await flushPendingSessionSave();
      const loadedMessages = await loadSessionMessages(sessionId);
      if (
        requestId !== sessionLoadRequestRef.current
        || deletedSessionIdsRef.current.has(sessionId)
        || (sessionIncarnationsRef.current.get(sessionId) || 0) !== sessionIncarnation
      ) return;
      preserveLoadedMessages ||= sessionRunsRef.current.values().length > 0
        || pendingStreamStartsRef.current.size > 0
        || sessionStopPromisesRef.current.size > 0
        || messageQueue.length > 0;
      setSessions((prev) => {
        return prev.map((item) => {
          if (item.id === sessionId) {
            return Object.prototype.hasOwnProperty.call(item, 'messages')
              ? item
              : { ...item, messages: loadedMessages };
          }
          return preserveLoadedMessages ? item : sessionMetadataOnly(item);
        });
      });
    } catch (error) {
      console.error(`Failed to load session ${sessionId}:`, error);
    } finally {
      if (sessionLoadingRequestsRef.current.get(sessionId) === requestId) {
        sessionLoadingRequestsRef.current.delete(sessionId);
        setLoadingSessionIds((prev) => {
          if (!prev.has(sessionId)) return prev;
          const next = new Set(prev);
          next.delete(sessionId);
          return next;
        });
      }
    }
  }, [sessions, flushPendingSessionSave, messageQueue]);

  const handleDeleteSession = useCallback(async (sessionId) => {
    // A stale row can dispatch twice before React removes it. One owner per id
    // keeps the deletion fence and its cleanup reference-count safe.
    if (
      deletingSessionIdsRef.current.has(sessionId)
      || deletedSessionIdsRef.current.has(sessionId)
    ) return;
    deletingSessionIdsRef.current.add(sessionId);
    sessionIncarnationsRef.current.set(
      sessionId,
      (sessionIncarnationsRef.current.get(sessionId) || 0) + 1
    );
    deletedSessionIdsRef.current.add(sessionId);
    let deleteSucceeded = false;
    try {
      titleGenerationControllersRef.current.get(sessionId)?.abort();
      cancelPendingSessionStart(sessionId);
      sessionLoadingRequestsRef.current.delete(sessionId);
      setLoadingSessionIds((prev) => {
        if (!prev.has(sessionId)) return prev;
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
      setMessageQueue((prev) => prev.filter((item) => item.sessionId !== sessionId));

      const session = sessionsRef.current.find((item) => item.id === sessionId);
      if (session?.remoteRun && !sessionRunsRef.current.has(sessionId)) {
        resumedRemoteRunsRef.current.add(session.remoteRun.id);
        resumingWaitingRunsRef.current.delete(session.remoteRun.id);
      }
      const waitingTimer = session?.remoteRun
        ? waitingRemoteTimersRef.current.get(session.remoteRun.id)
        : null;
      if (waitingTimer) {
        clearTimeout(waitingTimer);
        waitingRemoteTimersRef.current.delete(session.remoteRun.id);
      }
      const abortRetryTimer = session?.remoteRun
        ? remoteAbortRetryTimersRef.current.get(session.remoteRun.id)
        : null;
      if (abortRetryTimer) {
        clearTimeout(abortRetryTimer);
        remoteAbortRetryTimersRef.current.delete(session.remoteRun.id);
      }
      await stopSessionRun(sessionId, { skipAutomaticTitle: true });
      titleGenerationControllersRef.current.get(sessionId)?.abort();

      // Serialize destructive session-index writes. A storage barrier suspends
      // normal saves, but it is not itself a mutex between two rapid deletes.
      const previousDeletion = sessionDeletionTailRef.current;
      let releaseDeletion;
      const deletionTurn = new Promise((resolve) => { releaseDeletion = resolve; });
      sessionDeletionTailRef.current = previousDeletion.then(() => deletionTurn);
      await previousDeletion;
      try {
        // Fence the delete against persistence from other sessions that may still
        // be streaming. Their later updates remain queued behind this barrier.
        const releaseBarrier = await beginSessionStorageBarrier();
        try {
          const deletionSnapshot = sessionsRef.current.filter((item) => (
            !deletedSessionIdsRef.current.has(item.id)
          ));
          await deleteSessionFile(deletionSnapshot, sessionId);
          messagePanelRef.current?.discardSessionDraft(sessionId);

          setSessionAgents((prev) => {
            const next = { ...prev };
            delete next[sessionId];
            return next;
          });
          setSessionLlmProfiles((prev) => {
            const next = { ...prev };
            delete next[sessionId];
            return next;
          });

          setSessions((prev) => {
            const updated = prev.filter((item) => item.id !== sessionId);
            sessionsRef.current = updated;
            if (sessionId === activeSessionIdRef.current) {
              setActiveSessionId(updated.length > 0 ? updated[0].id : null);
            }
            return updated;
          });
        } finally {
          releaseBarrier();
        }
      } finally {
        releaseDeletion();
      }
      deleteSucceeded = true;
    } finally {
      deletingSessionIdsRef.current.delete(sessionId);
      if (!deleteSucceeded) deletedSessionIdsRef.current.delete(sessionId);
    }
  }, [beginSessionStorageBarrier, cancelPendingSessionStart, stopSessionRun]);

  const handleExportDebug = useCallback(() => {
    const session = sessions.find((c) => c.id === activeSessionId);
    if (!session?.messages) return;

    const agentId = session.agentId || sessionAgents[session.id] || null;
    const agent = agentId ? agentList.find((item) => item.id === agentId) : null;
    const llmProfileId = session.llmProfileId
      || sessionLlmProfiles[session.id]
      || currentLlmProfileId
      || agent?.llmProfileId
      || llm.getActiveProfileId()
      || getFirstLlmProfileId();
    const llmProfile = llm.getActiveConfig(llmProfileId);
    const provider = llm.getProviders().find((item) => item.id === llmProfile?.provider) || null;
    const hasToolContext = Boolean(agent?.sandboxUrl || agentId);

    const payload = buildChatDebugExport({
      session,
      messages: session.messages,
      llmMessages: expandMessagesForLlm(session.messages),
      systemPrompt: hasToolContext ? AGENT_SYSTEM_PROMPT : '',
      llmProfile,
      provider,
      agent,
      runtime: {
        activeSessionId,
        streaming: runningSessionIds.has(session.id) || pendingSessionIds.has(session.id),
        hasToolContext,
      },
    });

    downloadJsonFile(createChatDebugFilename(session), payload);
  }, [
    activeSessionId,
    agentList,
    currentLlmProfileId,
    getFirstLlmProfileId,
    sessionAgents,
    sessionLlmProfiles,
    sessions,
    runningSessionIds,
    pendingSessionIds,
  ]);

  const generateAutomaticSessionTitle = useCallback(async ({
    sessionId,
    sessionMessages,
    replyId,
    finalContent,
  }) => {
    if (factoryResetInProgressRef.current || !String(finalContent || '').trim()) return;

    const settings = normalizeAutoTitleConfig(config.get('general.autoTitle'));
    const currentSession = sessionsRef.current.find((session) => session.id === sessionId);
    if (!settings.enabled || !currentSession || currentSession.autoTitleGeneratedAtMs) return;
    if (titleGenerationControllersRef.current.has(sessionId)) return;

    const profileId = selectAutoTitleProfileId(llm.getProfiles(), settings.llmProfileId);
    if (!profileId) return;

    let replacedReply = false;
    const completedMessages = (sessionMessages || []).map((message) => {
      if (message.id !== replyId) return message;
      replacedReply = true;
      return { ...message, role: 'assistant', content: finalContent };
    });
    if (!replacedReply) {
      completedMessages.push({ id: replyId, role: 'assistant', content: finalContent });
    }

    const sourceFirstUser = completedMessages.find((message) => message.role === 'user');
    const sourceFirstUserKey = sourceFirstUser
      ? `${sourceFirstUser.id || ''}\n${String(sourceFirstUser.content || '')}`
      : null;
    const locale = resolveLocale(localePrefRef.current);
    const request = buildSessionTitleRequest(completedMessages, locale);
    const controller = new AbortController();
    titleGenerationControllersRef.current.set(sessionId, controller);

    try {
      const generated = await llm.completeSession(request.messages, {
        llmProfileId: profileId,
        systemPrompt: request.systemPrompt,
        signal: controller.signal,
        maxTokens: 160,
      });
      if (controller.signal.aborted || factoryResetInProgressRef.current) return;
      if (!normalizeAutoTitleConfig(config.get('general.autoTitle')).enabled) return;
      const title = cleanGeneratedSessionTitle(generated);
      if (!title) return;

      setSessions((prev) => prev.map((session) => {
        if (session.id !== sessionId || session.autoTitleGeneratedAtMs) return session;
        const currentFirstUser = session.messages?.find((message) => message.role === 'user');
        const currentFirstUserKey = currentFirstUser
          ? `${currentFirstUser.id || ''}\n${String(currentFirstUser.content || '')}`
          : null;
        if (currentFirstUserKey !== sourceFirstUserKey) return session;
        return {
          ...session,
          title,
          autoTitleGeneratedAtMs: Date.now(),
          autoTitleLocale: locale,
          autoTitleLlmProfileId: profileId,
        };
      }));
    } catch (error) {
      if (!controller.signal.aborted && error?.name !== 'AbortError') {
        console.warn('Automatic session title generation failed:', error);
      }
    } finally {
      if (titleGenerationControllersRef.current.get(sessionId) === controller) {
        titleGenerationControllersRef.current.delete(sessionId);
      }
    }
  }, []);

  // Stream LLM response for a given session using the agent loop
  const streamResponse = useCallback(async (sessionId, sessionMessages, opts = {}) => {
    // A reset invalidates every in-memory session/message reference. Keep this
    // guard at the final entry point as well as in the timer scheduler so a
    // callback that was already dequeued cannot start work during the reset.
    if (factoryResetInProgressRef.current || deletedSessionIdsRef.current.has(sessionId)) return null;

    // Prevent duplicate turns only within the same conversation. Different
    // sessions intentionally own independent run records and may execute at
    // the same time.
    const runRegistry = sessionRunsRef.current;
    if (runRegistry.has(sessionId) || sessionStopPromisesRef.current.has(sessionId)) return null;

    const sessionSnapshot = sessionsRef.current.find((session) => session.id === sessionId);
    if (!opts.resumeRunId && sessionSnapshot?.remoteRun?.status === 'running') return null;
    const sessionAgentId = opts.agentId ?? sessionSnapshot?.agentId ?? sessionAgents[sessionId] ?? null;
    if (!opts.resumeRunId && sessionAgentId && !agentListReady) return { status: 'blocked' };
    const agentConfig = sessionAgentId ? agentList.find((agent) => agent.id === sessionAgentId) : null;
    if (!opts.resumeRunId && sessionAgentId && !agentConfig) {
      const hintId = generateId();
      setSessions((prev) => sortSessions(prev.map((session) => (
        session.id === sessionId
          ? {
              ...session,
              lastMessage: 'The selected agent is unavailable.',
              ...sessionTimeFields(),
              messages: [
                ...(session.messages || sessionMessages || []),
                { id: hintId, role: 'assistant', content: 'The selected agent is unavailable. Choose an available agent and try again.' },
              ],
            }
          : session
      ))));
      return { status: 'blocked' };
    }
    const llmProfileId = opts.llmProfileId ?? sessionSnapshot?.llmProfileId ?? sessionLlmProfiles[sessionId] ?? agentConfig?.llmProfileId ?? currentLlmProfileId ?? llm.getActiveProfileId() ?? getFirstLlmProfileId();
    if (!opts.resumeRunId && !llm.isProfileConfigured(llmProfileId)) {
      const hintId = generateId();
      setSessions((prev) =>
        sortSessions(prev.map((c) =>
          c.id === sessionId
            ? {
                ...c,
                lastMessage: 'Please configure an LLM provider in Settings.',
                ...sessionTimeFields(),
                messages: [
                  ...(c.messages || sessionMessages || []),
                  { id: hintId, role: 'assistant', content: 'No LLM provider configured yet. Please open Settings (gear icon) to add your API key and select a provider.' },
                ],
              }
            : c
        ))
      );
      return { status: 'blocked' };
    }

    const replyId = opts.replyId || generateId();
    const run = runRegistry.begin(sessionId, {
      remoteRun: null,
      wakeupId: opts.wakeupId || null,
      streamingContent: '',
      streamingThinking: '',
      rafId: null,
      skipAutomaticTitle: false,
    });
    if (!run) return null;
    const isRunCurrent = () => runRegistry.get(sessionId) === run;
    const assertRunActive = () => {
      if (!isRunCurrent() || run.controller.signal.aborted) {
        throw new DOMException('Agent run aborted', 'AbortError');
      }
    };
    const updateSessionsForRun = (updater) => {
      // Validate ownership when the update is enqueued. React may execute a
      // functional updater after this run has been removed from the registry;
      // checking inside the updater would then discard its terminal waiting /
      // completed state and leave the UI permanently stuck on "running".
      runRegistry.enqueueIfCurrent(sessionId, run, () => setSessions(updater));
    };

    // Hydrate a lazily-unloaded session before either a fresh stream or a
    // remote reattachment can write to it. Treating missing messages as [] here
    // used to overwrite the complete OPFS history when a sleeping run woke
    // while another conversation was selected.
    updateSessionsForRun((prev) => prev.map((session) => (
      session.id === sessionId
        ? {
            ...session,
            messages: upsertSessionReply(
              session.messages,
              sessionMessages,
              replyId
            ),
          }
        : session
    )));
    let automaticTitleInput = null;
    let runOutcome = { status: 'completed' };
    let remoteExecution = false;
    let remoteRunRecoverable = Boolean(
      opts.resumeRunId
      && sessionSnapshot?.remoteRun?.id === opts.resumeRunId
    );
    let remoteRunReachedAcceptedTerminal = false;
    let confirmedRemoteFailureStatus = null;

    // Track tool calls for this message
    const seedReply = findSessionReply(
      sessionSnapshot?.messages || sessionMessages,
      replyId
    );
    const remoteEventReplay = prepareRemoteEventReplay(
      seedReply,
      Boolean(opts.resumeRunId)
    );
    const toolCalls = [...(remoteEventReplay.seed?.toolCalls || [])];
    let agentEventState = createAgentEventState(remoteEventReplay.seed || {});
    let lastRemoteEventSequence = remoteEventReplay.cursor;
    let hasAppliedRemoteEvents = remoteEventReplay.cursor > 0;
    run.streamingContent = agentEventState.content;
    run.streamingThinking = agentEventState.thinking;

    const applyStreamEvent = (event) => {
      if (!isRunCurrent() || run.controller.signal.aborted) return;
      const normalizedEvent = event?.remoteSequence
        ? normalizeRemoteAgentEvent(event)
        : event;
      agentEventState = applyAgentEvent(agentEventState, normalizedEvent);
      lastRemoteEventSequence = Math.max(
        lastRemoteEventSequence,
        Number(event?.remoteSequence) || 0
      );
      if (Number(event?.remoteSequence) > 0) hasAppliedRemoteEvents = true;
      run.streamingContent = agentEventState.content;
      run.streamingThinking = agentEventState.thinking;
      toolCalls.splice(0, toolCalls.length, ...agentEventState.toolCalls);
      scheduleFlush();
    };

    // Helper: update message in state
    const updateMessage = (fields, { touch = false } = {}) => {
      // Capture the reducer output and its cursor before React queues the
      // functional update. Reading these mutable closure values inside the
      // updater could pair older text with a newer cursor and skip events on
      // the next resume.
      const replyFields = captureRemoteReplyFields(
        fields,
        lastRemoteEventSequence,
        agentEventState.reasoningParsers
      );
      const preview = String(fields.content ?? run.streamingContent ?? '');
      updateSessionsForRun((prev) => {
        const next = prev.map((c) =>
          c.id === sessionId
            ? {
                ...c,
                // Lifecycle/text-start events legitimately flush before any
                // text exists. Keep the last meaningful preview in that gap.
                lastMessage: preview.trim() ? preview.slice(0, 60) : c.lastMessage,
                ...(touch ? sessionTimeFields() : {}),
                messages: upsertSessionReply(
                  c.messages,
                  sessionMessages,
                  replyId,
                  replyFields
                ),
              }
            : c
        );
        return touch ? sortSessions(next) : next;
      });
    };

    // Flush accumulated content to React state via rAF for real-time char sync
    const scheduleFlush = () => {
      if (run.rafId) return; // already scheduled for this session
      run.rafId = requestAnimationFrame(() => {
        run.rafId = null;
        updateMessage({
          content: run.streamingContent,
          thinking: run.streamingThinking,
          toolCalls: [...toolCalls],
          transcript: agentEventState.transcript,
          ...(agentEventState.usage ? { usage: agentEventState.usage } : {}),
        });
      });
    };

    try {
      const activeConfig = llm.getActiveConfig(llmProfileId);
      const sandboxUrl = opts.sandboxUrl ?? agentConfig?.sandboxUrl ?? null;
      const hasToolContext = sandboxUrl || sessionAgentId;
      const useRemoteRuntime = Boolean(opts.resumeRunId || agentConfig?.runtimeMode === 'sandbox');
      remoteExecution = useRemoteRuntime;
      // Freeze the executable model/config at turn start. Settings changes in
      // another session must not retarget an already-started turn.
      const languageModel = useRemoteRuntime ? null : llm.getLanguageModel(llmProfileId);
      const remoteModelConfig = useRemoteRuntime && !opts.resumeRunId
        ? llm.getRuntimeConfig(llmProfileId)
        : null;

      let result;
      let responseCompleted = false;
      if (useRemoteRuntime) {
        if (opts.resumeRunId) {
          run.remoteRun = { id: opts.resumeRunId, url: sandboxUrl };
        }
        if (!sandboxUrl || sandboxUrl === E2B_AGENT_ID) {
          const error = new Error('Sandbox runtime requires a connected CherryAgent agent server; direct E2B sandboxes currently provide command execution only.');
          error.code = 'AGENT_RUN_CONFIGURATION_ERROR';
          throw error;
        }
        if (opts.resumeRunId) {
          // Bind ownership before the protocol preflight. A failed health
          // request must still be classified against (and update) the durable
          // run that this reattachment owns.
          await assertRemoteAgentRunProtocol(sandboxUrl, run.controller.signal);
          assertRunActive();
        }
        const persistProvisionalRemoteRun = (provisionalRunId) => {
          remoteRunRecoverable = true;
          updateSessionsForRun((prev) => prev.map((session) => session.id === sessionId ? {
            ...session,
            remoteRun: {
              id: provisionalRunId,
              url: sandboxUrl,
              replyId,
              status: 'running',
            },
            ...sessionTimeFields(),
          } : session));
        };
        let remoteRun;
        if (opts.resumeRunId) {
          remoteRun = { id: opts.resumeRunId, status: 'running' };
        } else {
          const requestedRunId = `run-${globalThis.crypto?.randomUUID?.() || generateId()}`;
          // Keep the id locally before POST resolves so Stop/Delete/Reset can
          // address a run that the server accepted while the response is still
          // in flight.
          run.remoteRun = { id: requestedRunId, url: sandboxUrl };
          const runtimeContext = await prepareAgentRuntimeContext(sessionAgentId, {
            runtimeMode: 'sandbox',
            agentUrl: sandboxUrl,
            signal: run.controller.signal,
          });
          assertRunActive();
          try {
            remoteRun = await startRemoteAgentRun(sandboxUrl, {
              runId: requestedRunId,
              sessionId,
              replyId,
              messages: expandMessagesForSandboxRuntime(sessionMessages),
              systemPrompt: SANDBOX_AGENT_SYSTEM_PROMPT,
              agentId: sessionAgentId,
              modelConfig: remoteModelConfig,
              runtimeContext: {
                ...runtimeContext,
                // Memory stays browser-only; identity and enabled skills are a
                // bounded startup snapshot for the isolated runtime.
                memorySnapshot: { memory: null, user: null },
              },
            }, run.controller.signal);
            assertRunActive();
          } catch (startError) {
            if (run.controller.signal.aborted) throw startError;
            if (startError?.agentRunRequestStarted !== true) throw startError;
            try {
              // The POST may have committed even if its response was lost.
              // Confirm the client-generated id before treating start as a
              // failure, then let the normal polling path replay all events.
              const recoveredRun = await getRemoteAgentRun(
                sandboxUrl,
                requestedRunId,
                0,
                run.controller.signal
              );
              assertRemoteRunSnapshot(recoveredRun, requestedRunId);
              assertRunActive();
              remoteRun = { id: requestedRunId, status: 'running' };
            } catch (probeError) {
              if (run.controller.signal.aborted || !isRunCurrent()) {
                throw new DOMException('Agent run aborted', 'AbortError');
              }
              if ([404, 410].includes(Number(probeError?.status))) {
                // The authoritative id probe confirmed that the POST did not
                // create a recoverable run. Do not persist a ghost running id.
                throw probeError;
              }
              if (!Number.isFinite(startError?.status)) {
                // Both responses can be lost after the POST committed. Persist
                // the provisional id so the normal resume loop keeps probing
                // instead of orphaning an unknown server-owned run.
                persistProvisionalRemoteRun(requestedRunId);
              }
              throw startError;
            }
          }
          assertRunActive();
          try {
            assertRemoteRunSnapshot(remoteRun, requestedRunId);
          } catch (validationError) {
            // A successful response with a missing/unknown status may still
            // represent a committed POST. Retain the client-generated id and
            // let a later GET establish the authoritative status. A different
            // returned id is not recoverable under this request contract.
            if (remoteRun?.id == null || String(remoteRun.id) === requestedRunId) {
              persistProvisionalRemoteRun(requestedRunId);
            }
            throw validationError;
          }
          remoteRunRecoverable = true;
          updateSessionsForRun((prev) => prev.map((session) => session.id === sessionId ? {
            ...session,
            remoteRun: {
              id: remoteRun.id,
              url: sandboxUrl,
              replyId,
              status: remoteRun.status,
              sequence: Number(remoteRun.sequence) || 0,
            },
            ...sessionTimeFields(),
          } : session));
        }
        run.remoteRun = { id: remoteRun.id, url: sandboxUrl };
        // The assistant reply and its applied event cursor are persisted in one
        // object. Seed the reducer from that reply and request only later events
        // instead of replaying a long (up to 20 MB) run log from zero on every
        // wake-up.
        let remoteEventCursor = remoteEventReplay.cursor;
        while (true) {
          const polledRun = await getRemoteAgentRun(
            sandboxUrl,
            remoteRun.id,
            remoteEventCursor,
            run.controller.signal
          );
          assertRemoteRunSnapshot(polledRun, remoteRun.id);
          remoteRun = polledRun;
          assertRunActive();
          for (const event of remoteRun.events || []) {
            applyStreamEvent(event);
            remoteEventCursor = Math.max(remoteEventCursor, Number(event.remoteSequence) || 0);
          }
          updateSessionsForRun((prev) => prev.map((session) => session.id === sessionId ? {
            ...session,
            remoteRun: {
              id: remoteRun.id,
              url: sandboxUrl,
              replyId,
              status: remoteRun.status,
              sequence: Number(remoteRun.sequence) || remoteEventCursor,
              ...(remoteRun.wakeup ? { wakeup: remoteRun.wakeup } : {}),
            },
          } : session));
          if (remoteRun.status !== 'running') break;
          await new Promise((resolve, reject) => {
            const onAbort = () => {
              clearTimeout(timer);
              reject(new DOMException('Polling aborted', 'AbortError'));
            };
            const timer = setTimeout(() => {
              run.controller.signal.removeEventListener('abort', onAbort);
              resolve();
            }, 750);
            run.controller.signal.addEventListener('abort', onAbort, { once: true });
          });
        }
        if (!['completed', 'waiting'].includes(remoteRun.status)) {
          confirmedRemoteFailureStatus = remoteRun.status;
          throw new Error(remoteRun.error || `Sandbox run ${remoteRun.status}`);
        }
        result = remoteRun.result;
        responseCompleted = remoteRun.status === 'completed';
        runOutcome = { status: remoteRun.status };
        remoteRunReachedAcceptedTerminal = true;
      } else {
        let scheduledWakeup = null;
        result = await runAgentLoop({
          messages: expandMessagesForLlm(sessionMessages),
          systemPrompt: hasToolContext ? AGENT_SYSTEM_PROMPT : '',
          agentUrl: sandboxUrl,
          agentId: sessionAgentId,
          signal: run.controller.signal,
          provider: activeConfig.provider,
          model: activeConfig.model,
          contextWindow: activeConfig.contextWindow,
          llmProfileId,
          languageModel,
          scheduleWakeup: async ({ delaySeconds, prompt }) => {
            assertRunActive();
            const wakeup = createOrReplaceTurnWakeup({
              currentWakeup: scheduledWakeup,
              id: scheduledWakeup?.id || generateId(),
              delaySeconds,
              prompt,
            });
            if (wakeup === scheduledWakeup) return wakeup;
            scheduledWakeup = wakeup;
            updateSessionsForRun((prev) => sortSessions(prev.map((session) => (
              session.id === sessionId
                ? {
                    ...session,
                    wakeups: [
                      ...(session.wakeups || []).filter((candidate) => candidate.id !== wakeup.id),
                      wakeup,
                    ],
                    ...sessionTimeFields(),
                  }
                : session
            ))));
            return wakeup;
          },
          onEvent: applyStreamEvent,
        });
        assertRunActive();
        responseCompleted = true;
      }

      // A wake-up preempts sibling tools in the same model step. If their
      // final abort event raced with the server's waiting transition, reflect
      // that control flow instead of presenting them as successfully finished.
      const wakeupEndedTurn = runOutcome.status === 'waiting'
        || (!remoteExecution
          && toolCalls.some((tc) => (
            tc.name === 'schedule_wakeup' && tc.status === 'completed'
          )));
      toolCalls.splice(0, toolCalls.length, ...toolCalls.map((tc) => {
        if (!['pending', 'running', 'writing'].includes(tc.status)) return tc;
        if (wakeupEndedTurn && tc.name !== 'schedule_wakeup') {
          return {
            ...tc,
            status: 'aborted',
            result: tc.result || 'Stopped when the wake-up was scheduled.',
          };
        }
        return { ...tc, status: 'completed' };
      }));

      // A durable sandbox run can span several wake-up turns. Its per-turn
      // result contains only the latest turn, while the namespaced event state
      // is the complete assistant transcript across all continuations.
      const finalContent = remoteExecution
        ? (run.streamingContent || result?.content)
        : (result?.content || run.streamingContent);
      const finalThinking = remoteExecution
        ? (run.streamingThinking || result?.thinking)
        : (result?.thinking || run.streamingThinking);
      if (
        responseCompleted
        && !String(finalContent || '').trim()
        && !String(finalThinking || '').trim()
        && toolCalls.length === 0
      ) {
        const error = new Error(
          'The model completed without returning text, reasoning, or a tool call. Retry the request or check whether this model supports streaming responses.'
        );
        error.name = 'EmptyModelResponseError';
        error.code = 'EMPTY_MODEL_RESPONSE';
        throw error;
      }
      updateMessage({ content: finalContent, thinking: finalThinking, toolCalls: [...toolCalls], transcript: agentEventState.transcript, usage: result?.usage }, { touch: true });
      if (responseCompleted) {
        automaticTitleInput = { sessionId, sessionMessages, replyId, finalContent };
      }
      if (result?.toolCalls?.some((tc) => tc.name === 'spawn_agent')) {
        const nextAgentList = await listAgents();
        assertRunActive();
        setAgentList(nextAgentList);
      }
    } catch (err) {
      // Only the run owner's signal makes this a silent user cancellation.
      // Providers and proxies also use AbortError for transport failures; if
      // our signal is still live those errors must be visible in the message.
      if (run.controller.signal.aborted || !isRunCurrent()) {
        runOutcome = { status: 'aborted', error: err };
        toolCalls.splice(0, toolCalls.length, ...toolCalls.map((tc) => (
          ['pending', 'running', 'writing'].includes(tc.status)
            ? { ...tc, status: 'aborted', result: tc.result || 'Aborted' }
            : tc
        )));
        if (shouldPersistRemoteReplayProgress({
          remoteExecution,
          hasAppliedRemoteEvents,
          savedReply: seedReply,
        })) {
          updateMessage({ content: run.streamingContent, thinking: run.streamingThinking, toolCalls: [...toolCalls], transcript: agentEventState.transcript }, { touch: true });
        }
      } else {
        const slowRemoteRetry = isSlowRemoteRetryError(err);
        const retryableRemoteFailure = shouldRetryRemoteRunFailure({
          remoteExecution,
          remoteRunId: run.remoteRun?.id,
          recoverable: remoteRunRecoverable,
          reachedAcceptedTerminal: remoteRunReachedAcceptedTerminal,
          confirmedFailureStatus: confirmedRemoteFailureStatus,
          error: err,
        });
        runOutcome = {
          status: retryableRemoteFailure ? 'retryable-error' : 'error',
          error: err,
          ...(retryableRemoteFailure
            ? {
                retryDelayMs: slowRemoteRetry
                  ? REMOTE_RESUME_SLOW_RETRY_MS
                  : REMOTE_RESUME_RETRY_MS,
              }
            : {}),
        };
        if (run.remoteRun?.id) {
          updateSessionsForRun((prev) => prev.map((session) => {
            if (session.id !== sessionId || session.remoteRun?.id !== run.remoteRun.id) return session;
            const nextRemoteRun = retryableRemoteFailure
              ? markRemoteRunPollError(session.remoteRun, run.remoteRun.id, err)
              : markConfirmedRemoteRunFailure(
                  session.remoteRun,
                  run.remoteRun.id,
                  confirmedRemoteFailureStatus,
                  err
                );
            if (nextRemoteRun === session.remoteRun) return session;
            return {
              ...session,
              remoteRun: nextRemoteRun,
              ...(retryableRemoteFailure ? {} : sessionTimeFields()),
            };
          }));
        }
        if (retryableRemoteFailure) {
          // Losing one browser poll must not mutate a server-owned run into a
          // terminal failure or erase its persisted transcript. Commit only
          // events received before the disconnect; the resume effects will
          // retry from remoteEventSequence.
          // A legacy reply has no cursor and therefore must be rebuilt from
          // event zero. If the connection fails before the first replay event,
          // leave its saved content untouched instead of replacing it with the
          // intentionally empty reducer seed.
          if (shouldPersistRemoteReplayProgress({
            remoteExecution,
            hasAppliedRemoteEvents,
            savedReply: seedReply,
          })) {
            updateMessage({
              content: run.streamingContent,
              thinking: run.streamingThinking,
              toolCalls: [...toolCalls],
              transcript: agentEventState.transcript,
              ...(agentEventState.usage ? { usage: agentEventState.usage } : {}),
            });
          }
          return runOutcome;
        }
        const preserveUnreplayedReply = Boolean(
          remoteExecution
          && !hasAppliedRemoteEvents
          && seedReply
        );
        if (preserveUnreplayedReply) {
          toolCalls.splice(0, toolCalls.length, ...(seedReply.toolCalls || []));
        }
        toolCalls.splice(0, toolCalls.length, ...toolCalls.map((tc) => (
          ['pending', 'running', 'writing'].includes(tc.status)
            ? { ...tc, status: 'error', result: tc.result || `Error: ${err.message}` }
            : tc
        )));
        const errorContent = formatRunFailureContent(
          preserveUnreplayedReply ? seedReply.content : run.streamingContent,
          err
        );
        updateMessage({
          content: errorContent,
          thinking: preserveUnreplayedReply
            ? (seedReply.thinking || '')
            : run.streamingThinking,
          toolCalls: [...toolCalls],
          // A visible transcript replaces fallback content entirely. Clear it
          // on failure so the error and Retry action cannot be hidden behind a
          // partial or empty text segment.
          transcript: [],
        }, { touch: true });
      }
    } finally {
      if (run.rafId) {
        cancelAnimationFrame(run.rafId);
        run.rafId = null;
      }
      const finishedCurrentRun = runRegistry.finish(sessionId, run);
      if (finishedCurrentRun && automaticTitleInput && !run.skipAutomaticTitle) {
        void generateAutomaticSessionTitle(automaticTitleInput);
      }
    }
    return runOutcome;
  }, [agentList, agentListReady, sessionAgents, sessionLlmProfiles, currentLlmProfileId, generateAutomaticSessionTitle, getFirstLlmProfileId]);

  const scheduleStreamResponse = useCallback((sessionId, sessionMessages, opts = {}) => {
    const session = sessionsRef.current.find((item) => item.id === sessionId);
    if (
      factoryResetInProgressRef.current
      || deletedSessionIdsRef.current.has(sessionId)
      || sessionRunsRef.current.has(sessionId)
      || pendingStreamStartsRef.current.has(sessionId)
      || sessionStopPromisesRef.current.has(sessionId)
      || (!opts.resumeRunId && session?.agentId && !agentListReady)
      || (!opts.resumeRunId && session?.remoteRun?.status === 'running')
    ) return false;

    const scheduledAgentId = opts.agentId ?? session?.agentId ?? null;
    const scheduledAgent = scheduledAgentId
      ? agentList.find((agent) => agent.id === scheduledAgentId)
      : null;
    const pendingStart = {
      sessionId,
      sessionMessages,
      opts: {
        ...opts,
        agentId: scheduledAgentId,
        llmProfileId: opts.llmProfileId
          ?? session?.llmProfileId
          ?? scheduledAgent?.llmProfileId
          ?? currentLlmProfileId
          ?? llm.getActiveProfileId()
          ?? getFirstLlmProfileId(),
      },
      timerId: null,
    };
    const timerId = setTimeout(() => {
      void (async () => {
        // Superseding a sleeping remote turn must reach the server before the
        // replacement starts. Keeping this session in the pending registry
        // also prevents a second replacement from racing through the gap.
        await Promise.resolve(pendingStart.opts.startAfter).catch(() => {});
        if (pendingStreamStartsRef.current.get(sessionId) !== pendingStart) return;
        pendingStreamStartsRef.current.delete(sessionId);
        setPendingSessionIds((prev) => {
          if (!prev.has(sessionId)) return prev;
          const next = new Set(prev);
          next.delete(sessionId);
          return next;
        });
        if (
          factoryResetInProgressRef.current
          || deletedSessionIdsRef.current.has(sessionId)
        ) return;
        const { startAfter: _startAfter, ...streamOpts } = pendingStart.opts;
        void streamResponse(sessionId, sessionMessages, streamOpts);
      })();
    }, 0);
    pendingStart.timerId = timerId;
    pendingStreamStartsRef.current.set(sessionId, pendingStart);
    setPendingSessionIds((prev) => {
      if (prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.add(sessionId);
      return next;
    });
    return true;
  }, [agentList, agentListReady, currentLlmProfileId, getFirstLlmProfileId, streamResponse]);

  // Reattach to runs that were started before a reload/browser close. The
  // server owns execution; this effect only rebuilds UI state from its log.
  useEffect(() => {
    if (!loaded || factoryResetInProgressRef.current) return;
    const scheduleRetry = (runId, delayMs = REMOTE_RESUME_RETRY_MS) => {
      if (factoryResetInProgressRef.current) return;
      if (remoteResumeRetryTimersRef.current.has(runId)) return;
      const timerId = setTimeout(() => {
        remoteResumeRetryTimersRef.current.delete(runId);
        if (factoryResetInProgressRef.current) return;
        resumedRemoteRunsRef.current.delete(runId);
        setRemoteResumeVersion((version) => version + 1);
      }, Math.max(REMOTE_RESUME_RETRY_MS, Number(delayMs) || 0));
      remoteResumeRetryTimersRef.current.set(runId, timerId);
    };
    const resumable = sessions.filter((session) => (
      session.remoteRun?.status === 'running'
      && !deletedSessionIdsRef.current.has(session.id)
      && !resumedRemoteRunsRef.current.has(session.remoteRun.id)
      && !sessionRunsRef.current.has(session.id)
      && !pendingStreamStartsRef.current.has(session.id)
      && !sessionStopPromisesRef.current.has(session.id)
    ));
    for (const session of resumable) {
      const sessionIncarnation = sessionIncarnationsRef.current.get(session.id) || 0;
      resumedRemoteRunsRef.current.add(session.remoteRun.id);
      void (async () => {
        try {
          const runMessages = session.messages || await loadSessionMessages(session.id);
          const currentSession = sessionsRef.current.find((item) => item.id === session.id);
          if (
            factoryResetInProgressRef.current
            || deletedSessionIdsRef.current.has(session.id)
            || (sessionIncarnationsRef.current.get(session.id) || 0) !== sessionIncarnation
            || !currentSession
            || currentSession.remoteRun?.id !== session.remoteRun.id
            || sessionRunsRef.current.has(session.id)
            || pendingStreamStartsRef.current.has(session.id)
            || sessionStopPromisesRef.current.has(session.id)
          ) {
            resumedRemoteRunsRef.current.delete(session.remoteRun.id);
            return;
          }
          setSessions((prev) => prev.map((item) => (
            item.id === session.id ? { ...item, messages: runMessages } : item
          )));
          const outcome = await streamResponse(session.id, runMessages, {
            agentId: session.agentId,
            llmProfileId: session.llmProfileId,
            sandboxUrl: session.remoteRun.url,
            resumeRunId: session.remoteRun.id,
            replyId: session.remoteRun.replyId,
          });
          if (
            (!outcome || outcome.status === 'retryable-error')
            && !factoryResetInProgressRef.current
          ) {
            scheduleRetry(session.remoteRun.id, outcome?.retryDelayMs);
          }
        } catch (error) {
          console.warn('Remote agent run resume failed:', error);
          if (!factoryResetInProgressRef.current) scheduleRetry(session.remoteRun.id);
        }
      })();
    }
  }, [agentList, loaded, pendingSessionIds, remoteResumeVersion, runningSessionIds, sessions, streamResponse]);

  // A waiting sandbox run is owned by the agent server, so it does not keep
  // the browser UI in streaming mode. Reattach around its scheduled time.
  useEffect(() => {
    if (!loaded || factoryResetInProgressRef.current) return;
    const waitingRunIds = new Set();

    const scheduleResume = (session, delay) => {
      const runId = session.remoteRun.id;
      const sessionIncarnation = sessionIncarnationsRef.current.get(session.id) || 0;
      const timerId = setTimeout(() => {
        waitingRemoteTimersRef.current.delete(runId);
        const currentSession = sessionsRef.current.find((item) => item.id === session.id);
        if (
          !currentSession
          || deletedSessionIdsRef.current.has(currentSession.id)
          || (sessionIncarnationsRef.current.get(currentSession.id) || 0) !== sessionIncarnation
          || currentSession.remoteRun?.id !== runId
          || currentSession.remoteRun.status !== 'waiting'
          || factoryResetInProgressRef.current
        ) return;

        const remainingDelay = currentSession.remoteRun.wakeup?.runAtMs - Date.now();
        if (Number.isFinite(remainingDelay) && remainingDelay > 50) {
          scheduleResume(currentSession, remainingDelay);
          return;
        }

        if (
          sessionRunsRef.current.has(currentSession.id)
          || pendingStreamStartsRef.current.has(currentSession.id)
          || sessionStopPromisesRef.current.has(currentSession.id)
          || probingWaitingRunsRef.current.has(runId)
          || resumingWaitingRunsRef.current.has(runId)
        ) {
          scheduleResume(currentSession, 250);
          return;
        }

        resumingWaitingRunsRef.current.add(runId);
        void (async () => {
          let outcome = null;
          try {
            const runMessages = currentSession.messages || await loadSessionMessages(currentSession.id);
            if (
              factoryResetInProgressRef.current
              || deletedSessionIdsRef.current.has(currentSession.id)
              || (sessionIncarnationsRef.current.get(currentSession.id) || 0) !== sessionIncarnation
            ) return;
            setSessions((prev) => prev.map((item) => (
              item.id === currentSession.id && !Object.prototype.hasOwnProperty.call(item, 'messages')
                ? { ...item, messages: runMessages }
                : item
            )));
            outcome = await streamResponse(currentSession.id, runMessages, {
              agentId: currentSession.agentId,
              llmProfileId: currentSession.llmProfileId,
              sandboxUrl: currentSession.remoteRun.url,
              resumeRunId: runId,
              replyId: currentSession.remoteRun.replyId,
            });
          } finally {
            resumingWaitingRunsRef.current.delete(runId);
            const latestSession = sessionsRef.current.find((item) => item.id === currentSession.id);
            if (
              latestSession?.remoteRun?.id === runId
              && latestSession.remoteRun.status === 'waiting'
              && !deletedSessionIdsRef.current.has(latestSession.id)
              && !waitingRemoteTimersRef.current.has(runId)
              && !factoryResetInProgressRef.current
            ) {
              scheduleResume(
                latestSession,
                outcome?.status === 'retryable-error'
                  ? (outcome.retryDelayMs || REMOTE_RESUME_RETRY_MS)
                  : Math.max(1000, latestSession.remoteRun.wakeup?.runAtMs - Date.now() || 0)
              );
            }
          }
        })().catch((error) => console.warn('Waiting sandbox run resume failed:', error));
      }, Math.min(Math.max(delay, 250), 2_147_483_647));
      waitingRemoteTimersRef.current.set(runId, timerId);
    };

    for (const session of sessions) {
      if (deletedSessionIdsRef.current.has(session.id)) continue;
      if (!session.remoteRun?.wakeup?.runAtMs || session.remoteRun.status !== 'waiting') continue;
      const runId = session.remoteRun.id;
      waitingRunIds.add(runId);
      if (
        waitingRemoteTimersRef.current.has(runId)
        || resumingWaitingRunsRef.current.has(runId)
      ) continue;
      scheduleResume(session, Math.max(0, session.remoteRun.wakeup.runAtMs - Date.now()));
    }

    for (const [runId, timerId] of waitingRemoteTimersRef.current) {
      if (waitingRunIds.has(runId)) continue;
      clearTimeout(timerId);
      waitingRemoteTimersRef.current.delete(runId);
    }
  }, [loaded, sessions, streamResponse]);

  // Browser timers can be throttled or discarded while a tab is backgrounded.
  // Reconcile visible waiting sessions with the server independently of the
  // deadline timer so a server-owned wake-up cannot finish without the final
  // events being replayed into the conversation UI.
  useEffect(() => {
    if (!loaded || factoryResetInProgressRef.current) return undefined;
    const controller = new AbortController();
    let disposed = false;

    const reconcileWaitingRuns = async () => {
      if (
        disposed
        || controller.signal.aborted
        || factoryResetInProgressRef.current
        || document.visibilityState === 'hidden'
      ) return;

      const waitingSessions = sessionsRef.current.filter((session) => (
        session.remoteRun?.status === 'waiting'
        && session.remoteRun.id
        && session.remoteRun.url
        && !deletedSessionIdsRef.current.has(session.id)
      ));

      await Promise.all(waitingSessions.map(async (session) => {
        const runId = session.remoteRun.id;
        if (
          probingWaitingRunsRef.current.has(runId)
          || resumingWaitingRunsRef.current.has(runId)
          || sessionRunsRef.current.has(session.id)
          || pendingStreamStartsRef.current.has(session.id)
          || sessionStopPromisesRef.current.has(session.id)
        ) return;

        probingWaitingRunsRef.current.add(runId);
        try {
          const remoteRun = await getRemoteAgentRun(
            session.remoteRun.url,
            runId,
            Number(session.remoteRun.sequence) || 0,
            controller.signal
          );
          if (disposed || controller.signal.aborted) return;

          if (remoteRun.status === 'waiting') {
            setSessions((prev) => prev.map((item) => {
              if (item.id !== session.id || item.remoteRun?.id !== runId) return item;
              const sequence = Number(remoteRun.sequence) || item.remoteRun.sequence || 0;
              const currentWakeup = item.remoteRun.wakeup;
              const nextWakeup = remoteRun.wakeup || currentWakeup;
              if (
                item.remoteRun.sequence === sequence
                && currentWakeup?.id === nextWakeup?.id
                && currentWakeup?.runAtMs === nextWakeup?.runAtMs
                && currentWakeup?.prompt === nextWakeup?.prompt
              ) return item;
              return {
                ...item,
                remoteRun: {
                  ...item.remoteRun,
                  status: 'waiting',
                  sequence,
                  ...(nextWakeup ? { wakeup: nextWakeup } : {}),
                },
              };
            }));
            return;
          }

          const currentSession = sessionsRef.current.find((item) => item.id === session.id);
          if (
            !currentSession
            || currentSession.remoteRun?.id !== runId
            || currentSession.remoteRun.status !== 'waiting'
            || deletedSessionIdsRef.current.has(currentSession.id)
            || sessionRunsRef.current.has(currentSession.id)
            || pendingStreamStartsRef.current.has(currentSession.id)
            || sessionStopPromisesRef.current.has(currentSession.id)
            || resumingWaitingRunsRef.current.has(runId)
          ) return;

          const waitingTimer = waitingRemoteTimersRef.current.get(runId);
          if (waitingTimer) clearTimeout(waitingTimer);
          waitingRemoteTimersRef.current.delete(runId);
          resumingWaitingRunsRef.current.add(runId);
          try {
            const runMessages = currentSession.messages || await loadSessionMessages(currentSession.id);
            setSessions((prev) => prev.map((item) => (
              item.id === currentSession.id && !Object.prototype.hasOwnProperty.call(item, 'messages')
                ? { ...item, messages: runMessages }
                : item
            )));
            await streamResponse(currentSession.id, runMessages, {
              agentId: currentSession.agentId,
              llmProfileId: currentSession.llmProfileId,
              sandboxUrl: currentSession.remoteRun.url,
              resumeRunId: runId,
              replyId: currentSession.remoteRun.replyId,
            });
          } finally {
            resumingWaitingRunsRef.current.delete(runId);
          }
        } catch (error) {
          if (error?.name !== 'AbortError' && !disposed) {
            console.warn('Waiting sandbox run reconciliation failed:', error);
          }
        } finally {
          probingWaitingRunsRef.current.delete(runId);
        }
      }));
    };

    const intervalId = setInterval(() => {
      void reconcileWaitingRuns();
    }, REMOTE_WAITING_RECONCILE_MS);
    const onFocus = () => { void reconcileWaitingRuns(); };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void reconcileWaitingRuns();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    void reconcileWaitingRuns();

    return () => {
      disposed = true;
      controller.abort();
      clearInterval(intervalId);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [loaded, streamResponse]);

  // A page can close in the narrow interval before the returned run id is
  // flushed to OPFS. Discover server-owned runs by session id as a fallback.
  useEffect(() => {
    if (!loaded || factoryResetInProgressRef.current || agentList.length === 0) return;
    const scheduleDiscoveryRetry = (discoveryKey) => {
      if (factoryResetInProgressRef.current) return;
      if (remoteDiscoveryRetryTimersRef.current.has(discoveryKey)) return;
      const timerId = setTimeout(() => {
        remoteDiscoveryRetryTimersRef.current.delete(discoveryKey);
        if (factoryResetInProgressRef.current) return;
        remoteDiscoveryRef.current.delete(discoveryKey);
        setRemoteDiscoveryVersion((version) => version + 1);
      }, 1500);
      remoteDiscoveryRetryTimersRef.current.set(discoveryKey, timerId);
    };
    for (const session of sessions) {
      if (deletedSessionIdsRef.current.has(session.id)) continue;
      if (
        session.remoteRun
        || sessionRunsRef.current.has(session.id)
        || pendingStreamStartsRef.current.has(session.id)
        || sessionStopPromisesRef.current.has(session.id)
      ) continue;
      const agent = agentList.find((item) => item.id === session.agentId);
      if (agent?.runtimeMode !== 'sandbox' || !agent.sandboxUrl || agent.sandboxUrl === E2B_AGENT_ID) continue;
      const discoveryKey = `${agent.sandboxUrl}:${session.id}`;
      const sessionIncarnation = sessionIncarnationsRef.current.get(session.id) || 0;
      if (remoteDiscoveryRef.current.has(discoveryKey)) continue;
      remoteDiscoveryRef.current.add(discoveryKey);
      void listRemoteAgentRuns(agent.sandboxUrl, session.id).then(async ({ runs }) => {
        if (
          factoryResetInProgressRef.current
          || deletedSessionIdsRef.current.has(session.id)
          || (sessionIncarnationsRef.current.get(session.id) || 0) !== sessionIncarnation
        ) return;
        const latest = runs?.[0];
        if (!latest || latest.status === 'aborted') return;
        const storedMessages = session.messages || await loadSessionMessages(session.id);
        if (
          factoryResetInProgressRef.current
          || deletedSessionIdsRef.current.has(session.id)
          || (sessionIncarnationsRef.current.get(session.id) || 0) !== sessionIncarnation
        ) return;
        const terminalFailure = latest.status === 'error' || latest.status === 'interrupted';
        const replyId = latest.replyId || generateId();
        const terminalDetail = String(latest.error || '').trim()
          || (latest.status === 'interrupted'
            ? 'Sandbox run was interrupted before it could finish.'
            : 'Sandbox run failed before it could return a response.');
        const terminalContent = formatRunFailureContent('', terminalDetail);
        setSessions((prev) => prev.map((item) => {
          if (item.id !== session.id || item.remoteRun) return item;
          const currentMessages = item.messages || storedMessages;
          const hasReply = currentMessages.some((message) => message.id === replyId);
          const messages = terminalFailure
            ? (hasReply
                ? currentMessages.map((message) => message.id === replyId
                    ? {
                        ...message,
                        content: formatRunFailureContent(message.content, terminalDetail),
                        transcript: [],
                      }
                    : message)
                : [...currentMessages, {
                    id: replyId,
                    role: 'assistant',
                    content: terminalContent,
                    thinking: '',
                    toolCalls: [],
                    transcript: [],
                  }])
            : (hasReply ? currentMessages : [...currentMessages, {
                id: replyId,
                role: 'assistant',
                content: '',
                thinking: '',
                toolCalls: [],
                transcript: [],
              }]);
          return {
            ...item,
            messages,
            ...(terminalFailure ? { lastMessage: terminalContent.slice(0, 60), ...sessionTimeFields() } : {}),
            remoteRun: {
              id: latest.id,
              url: agent.sandboxUrl,
              replyId,
              sequence: Number(latest.sequence) || 0,
              // Mark completed discoveries as pending once so streamResponse
              // fetches their event log and durable result.
              status: terminalFailure
                ? latest.status
                : (latest.status === 'waiting' ? 'waiting' : 'running'),
              ...(terminalFailure ? { error: terminalDetail } : {}),
              ...(latest.wakeup ? { wakeup: latest.wakeup } : {}),
            },
          };
        }));
      }).catch((error) => {
        console.warn('Remote agent run discovery failed:', error);
        if (!factoryResetInProgressRef.current) scheduleDiscoveryRetry(discoveryKey);
      });
    }
  }, [agentList, loaded, pendingSessionIds, remoteDiscoveryVersion, runningSessionIds, sessions]);

  const cancelPendingStreamStarts = useCallback(({ notify = true } = {}) => {
    const pendingStarts = [...pendingStreamStartsRef.current.values()];
    for (const pendingStart of pendingStarts) {
      clearTimeout(pendingStart.timerId);
    }
    pendingStreamStartsRef.current.clear();
    if (notify) setPendingSessionIds(new Set());
    return pendingStarts;
  }, []);

  useEffect(() => () => {
    cancelPendingStreamStarts({ notify: false });
    for (const timerId of waitingRemoteTimersRef.current.values()) clearTimeout(timerId);
    waitingRemoteTimersRef.current.clear();
    probingWaitingRunsRef.current.clear();
    resumingWaitingRunsRef.current.clear();
    for (const timerId of remoteResumeRetryTimersRef.current.values()) clearTimeout(timerId);
    remoteResumeRetryTimersRef.current.clear();
    for (const timerId of remoteAbortRetryTimersRef.current.values()) clearTimeout(timerId);
    remoteAbortRetryTimersRef.current.clear();
    for (const timerId of remoteDiscoveryRetryTimersRef.current.values()) clearTimeout(timerId);
    remoteDiscoveryRetryTimersRef.current.clear();
  }, [cancelPendingStreamStarts]);

  const handleStopStreaming = useCallback(() => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    cancelPendingSessionStart(sessionId);
    void stopSessionRun(sessionId);
  }, [cancelPendingSessionStart, stopSessionRun]);

  const sendMessageNow = useCallback(
    (text, images, contextFiles, targetSessionId = activeSessionId) => {
      const targetSession = targetSessionId
        ? sessionsRef.current.find((session) => session.id === targetSessionId)
        : null;
      if (
        (!agentListReady && (!targetSessionId || targetSession?.agentId))
        || factoryResetInProgressRef.current
        || deletedSessionIdsRef.current.has(targetSessionId)
      ) return false;

      // A new user turn in the same conversation supersedes its sleeping
      // continuation. This prevents the server from later resuming with a
      // stale message snapshot while the new turn is already in progress.
      const supersededRemote = sessionsRef.current.find((item) => item.id === targetSessionId)?.remoteRun;
      let startAfter;
      if (canSupersedeRemoteRun(supersededRemote)) {
        startAfter = abortRemoteAgentRunBestEffort(supersededRemote.url, supersededRemote.id);
        resumedRemoteRunsRef.current.add(supersededRemote.id);
        resumingWaitingRunsRef.current.delete(supersededRemote.id);
        const waitingTimer = waitingRemoteTimersRef.current.get(supersededRemote.id);
        if (waitingTimer) clearTimeout(waitingTimer);
        waitingRemoteTimersRef.current.delete(supersededRemote.id);
      }

      if (!targetSessionId) {
        // Auto-create a session if none selected
        const userMsg = { id: generateId(), role: 'user', content: text, ...(images && { images }), ...(contextFiles && { contextFiles }) };
        const previewText = messagePreviewText(text, images, contextFiles);
        const agentId = lastAgentId ?? (agentList.length > 0 ? agentList[0].id : null);
        const llmProfileId = currentLlmProfileId || getAgentDefaultLlmId(agentId) || llm.getActiveProfileId();
        const newSession = {
          id: generateId(),
          title: previewText.slice(0, 30) + (previewText.length > 30 ? '...' : ''),
          lastMessage: previewText,
          ...sessionTimeFields(),
          messages: [userMsg],
          ...(llmProfileId && { llmProfileId }),
          ...(agentId && { agentId }),
        };
        setSessions((prev) => sortSessions([newSession, ...prev]));
        setActiveSessionId(newSession.id);
        if (agentId) {
          setSessionAgents((prev) => ({ ...prev, [newSession.id]: agentId }));
        }
        if (llmProfileId) {
          setSessionLlmProfiles((prev) => ({ ...prev, [newSession.id]: llmProfileId }));
        }
        scheduleStreamResponse(newSession.id, [userMsg], { agentId, llmProfileId });
        return true;
      }

      const userMsg = { id: generateId(), role: 'user', content: text, ...(images && { images }), ...(contextFiles && { contextFiles }) };
      const previewText = messagePreviewText(text, images, contextFiles);
      const sessionId = targetSessionId;
      const currentSession = sessionsRef.current.find((session) => session.id === sessionId);
      if (!currentSession?.messages) return false;
      const nextMessages = [...currentSession.messages, userMsg];

      setSessions((prev) => sortSessions(prev.map((session) => {
        if (session.id !== sessionId) return session;
        const next = {
          ...session,
          title: (session.messages || []).length === 0
            ? previewText.slice(0, 30) + (previewText.length > 30 ? '...' : '')
            : session.title,
          lastMessage: previewText,
          ...sessionTimeFields(),
          messages: [...(session.messages || currentSession.messages), userMsg],
        };
        if (canSupersedeRemoteRun(session.remoteRun)) delete next.remoteRun;
        return next;
      })));
      scheduleStreamResponse(sessionId, nextMessages, {
        agentId: currentSession.agentId,
        llmProfileId: currentSession.llmProfileId,
        ...(startAfter ? { startAfter } : {}),
      });
      return true;
    },
    [activeSessionId, agentListReady, scheduleStreamResponse, lastAgentId, agentList, currentLlmProfileId, getAgentDefaultLlmId]
  );

  // Wake-ups are persisted in session metadata. Only the next one needs an
  // in-memory timer; overdue work is picked up once after the app is reopened.
  useEffect(() => {
    if (!loaded || factoryResetInProgressRef.current) return undefined;

    const unavailableWakeupIds = new Set([
      ...claimedWakeupIdsRef.current,
      ...cancelledWakeupIdsRef.current,
    ]);
    for (const session of sessions) {
      if (
        !sessionRunsRef.current.has(session.id)
        && !pendingStreamStartsRef.current.has(session.id)
        && !sessionStopPromisesRef.current.has(session.id)
        && session.remoteRun?.status !== 'running'
      ) continue;
      for (const wakeup of session.wakeups || []) unavailableWakeupIds.add(wakeup.id);
    }
    const next = findNextWakeup(sessions, unavailableWakeupIds);
    if (!next) return undefined;

    const delay = Math.max(0, next.wakeup.runAtMs - Date.now());
    const sessionIncarnation = sessionIncarnationsRef.current.get(next.session.id) || 0;
    const timerId = setTimeout(() => {
      if (
        cancelledWakeupIdsRef.current.has(next.wakeup.id)
        || sessionRunsRef.current.has(next.session.id)
        || pendingStreamStartsRef.current.has(next.session.id)
        || sessionStopPromisesRef.current.has(next.session.id)
        || sessionHasRunningRemote(sessionsRef.current, next.session.id)
        || (sessionIncarnationsRef.current.get(next.session.id) || 0) !== sessionIncarnation
        || factoryResetInProgressRef.current
      ) return;

      const { session: scheduledSession, wakeup } = next;
      claimedWakeupIdsRef.current.add(wakeup.id);

      void (async () => {
        try {
          const currentSession = sessionsRef.current.find((item) => item.id === scheduledSession.id);
          if (
            !currentSession
            || deletedSessionIdsRef.current.has(currentSession.id)
            || cancelledWakeupIdsRef.current.has(wakeup.id)
            || !(currentSession.wakeups || []).some((candidate) => candidate.id === wakeup.id)
          ) return;
          const messages = currentSession.messages || await loadSessionMessages(currentSession.id);
          // Loading a metadata-only session is asynchronous. Another turn may
          // have started in that gap, so leave this wake-up pending for retry.
          const latestSession = sessionsRef.current.find((item) => item.id === currentSession.id);
          if (
            !latestSession
            || cancelledWakeupIdsRef.current.has(wakeup.id)
            || !(latestSession.wakeups || []).some((candidate) => candidate.id === wakeup.id)
            || sessionRunsRef.current.has(currentSession.id)
            || pendingStreamStartsRef.current.has(currentSession.id)
            || sessionStopPromisesRef.current.has(currentSession.id)
            || sessionHasRunningRemote(sessionsRef.current, currentSession.id)
            || deletedSessionIdsRef.current.has(currentSession.id)
            || (sessionIncarnationsRef.current.get(currentSession.id) || 0) !== sessionIncarnation
          ) {
            claimedWakeupIdsRef.current.delete(wakeup.id);
            return;
          }
          const wakeMessage = {
            id: generateId(),
            role: 'user',
            content: buildWakeupMessage(wakeup),
          };
          const nextMessages = [...messages, wakeMessage];

          const scheduled = scheduleStreamResponse(currentSession.id, nextMessages, {
            agentId: latestSession.agentId,
            llmProfileId: latestSession.llmProfileId,
            wakeupId: wakeup.id,
          });
          if (!scheduled) {
            claimedWakeupIdsRef.current.delete(wakeup.id);
            return;
          }

          setSessions((prev) => sortSessions(prev.map((item) => {
            if (item.id !== currentSession.id) return item;
            return {
              ...item,
              messages: nextMessages,
              wakeups: (item.wakeups || []).filter((candidate) => candidate.id !== wakeup.id),
              lastMessage: wakeMessage.content.slice(0, 60),
              ...sessionTimeFields(),
            };
          })));
        } catch (error) {
          claimedWakeupIdsRef.current.delete(wakeup.id);
          console.warn('Scheduled wake-up failed:', error);
        }
      })();
    }, Math.min(delay, 2_147_483_647));

    return () => clearTimeout(timerId);
  }, [loaded, pendingSessionIds, runningSessionIds, scheduleStreamResponse, sessions, stoppingSessionIds]);

  const handleSendMessage = useCallback(
    (text, images, contextFiles) => {
      if (activeSessionAgentLoading || factoryResetInProgressRef.current) return false;

      if (activeSessionId && sessionLoadingRequestsRef.current.has(activeSessionId)) return false;
      if (
        activeSessionId
        && !sessionsRef.current.find((session) => session.id === activeSessionId)?.messages
      ) {
        void handleSelectSession(activeSessionId);
        return false;
      }

      if (
        activeSessionId
        && (
          sessionRunsRef.current.has(activeSessionId)
          || pendingStreamStartsRef.current.has(activeSessionId)
          || sessionStopPromisesRef.current.has(activeSessionId)
          || sessionHasRunningRemote(sessionsRef.current, activeSessionId)
        )
      ) {
        setMessageQueue((prev) => [
          ...prev,
          {
            id: generateId(),
            sessionId: activeSessionId,
            text,
            ...(images && { images }),
            ...(contextFiles && { contextFiles }),
          },
        ]);
        return true;
      }

      return sendMessageNow(text, images, contextFiles);
    },
    [activeSessionId, activeSessionAgentLoading, handleSelectSession, sendMessageNow]
  );

  const handleRemoveQueuedMessage = useCallback((queueId) => {
    setMessageQueue((prev) => prev.filter((item) => item.id !== queueId));
  }, []);

  useEffect(() => {
    if (factoryResetInProgressRef.current) return;
    if (messageQueue.length === 0) return;

    const claimedSessions = new Set();
    const ready = [];
    for (const item of messageQueue) {
      if (
        claimedSessions.has(item.sessionId)
        || sessionRunsRef.current.has(item.sessionId)
        || pendingStreamStartsRef.current.has(item.sessionId)
        || sessionStopPromisesRef.current.has(item.sessionId)
        || sessionHasRunningRemote(sessionsRef.current, item.sessionId)
      ) continue;
      claimedSessions.add(item.sessionId);
      ready.push(item);
    }
    if (ready.length === 0) return;

    const acceptedIds = new Set();
    for (const item of ready) {
      if (sendMessageNow(item.text, item.images, item.contextFiles, item.sessionId)) {
        acceptedIds.add(item.id);
      }
    }
    if (acceptedIds.size > 0) {
      setMessageQueue((prev) => prev.filter((item) => !acceptedIds.has(item.id)));
    }
  }, [runningSessionIds, pendingSessionIds, stoppingSessionIds, messageQueue, sendMessageNow, sessions]);

  const handleEditMessage = useCallback((messageId, text) => {
    if (activeSessionAgentLoading || factoryResetInProgressRef.current || activeSessionStreaming || !activeSessionId) return;
    const sessionId = activeSessionId;
    const session = sessions.find((c) => c.id === sessionId);
    if (!session) return;

    const editResult = editUserMessageAndDiscardFollowing(session.messages, messageId, text);
    if (!editResult) return;

    const { messageIndex, messages: trimmedMessages } = editResult;
    if (messageIndex === 0) {
      titleGenerationControllersRef.current.get(sessionId)?.abort();
    }
    setMessageQueue((prev) => prev.filter((item) => item.sessionId !== sessionId));

    setSessions((prev) =>
      sortSessions(prev.map((c) => {
        if (c.id !== sessionId) return c;
        const next = {
          ...c,
          title: messageIndex === 0 ? text.slice(0, 30) + (text.length > 30 ? '...' : '') : c.title,
          lastMessage: text,
          ...sessionTimeFields(),
          messages: trimmedMessages,
        };
        if (messageIndex === 0) {
          delete next.autoTitleGeneratedAtMs;
          delete next.autoTitleLocale;
          delete next.autoTitleLlmProfileId;
        }
        return next;
      }))
    );

    scheduleStreamResponse(sessionId, trimmedMessages);
  }, [activeSessionId, activeSessionStreaming, activeSessionAgentLoading, sessions, scheduleStreamResponse]);

  const handleSelectLLM = useCallback(async (profileId) => {
    const nextProfileId = profileId || null;
    await llm.selectProfile(profileId || null);
    setCurrentLlmProfileId(nextProfileId);
    setLlmReady((prev) => !prev);
    if (!activeSessionId) return;
    setSessionLlmProfiles((prev) => {
      const next = { ...prev };
      if (nextProfileId) next[activeSessionId] = nextProfileId;
      else delete next[activeSessionId];
      return next;
    });
    setSessions((prev) =>
      sortSessions(prev.map((c) => {
        if (c.id !== activeSessionId) return c;
        const nextSession = { ...c, ...sessionTimeFields() };
        if (nextProfileId) nextSession.llmProfileId = nextProfileId;
        else delete nextSession.llmProfileId;
        return nextSession;
      }))
    );
  }, [activeSessionId]);

  const performFactoryReset = useCallback(async () => {
    if (factoryResetInProgressRef.current) return;
    factoryResetInProgressRef.current = true;
    const cancelledStreamStarts = cancelPendingStreamStarts();
    const activeRuns = sessionRunsRef.current.values();
    const activeStops = [...sessionStopPromisesRef.current.values()];
    let resumeAutoSync;
    let resetComplete = false;
    let configResetStarted = false;
    const coordinator = sessionSaveCoordinatorRef.current;
    let releaseSessionBarrier;
    try {
      resumeAutoSync = suspendAutoSync();
      for (const timerId of waitingRemoteTimersRef.current.values()) clearTimeout(timerId);
      waitingRemoteTimersRef.current.clear();
      for (const timerId of remoteResumeRetryTimersRef.current.values()) clearTimeout(timerId);
      remoteResumeRetryTimersRef.current.clear();
      for (const timerId of remoteAbortRetryTimersRef.current.values()) clearTimeout(timerId);
      remoteAbortRetryTimersRef.current.clear();
      for (const timerId of remoteDiscoveryRetryTimersRef.current.values()) clearTimeout(timerId);
      remoteDiscoveryRetryTimersRef.current.clear();
      remoteDiscoveryRef.current.clear();
      const remoteAborts = [];
      for (const run of activeRuns) {
        run.skipAutomaticTitle = true;
        if (run.remoteRun) {
          remoteAborts.push(abortRemoteAgentRunBestEffort(run.remoteRun.url, run.remoteRun.id));
        }
      }
      for (const session of sessionsRef.current) {
        if (session.remoteRun && !sessionRunsRef.current.has(session.id)) {
          remoteAborts.push(abortRemoteAgentRunBestEffort(session.remoteRun.url, session.remoteRun.id));
        }
      }
      sessionRunsRef.current.abortAll();
      const runCompletions = activeRuns.map(async (run) => {
        const settled = await waitForSettlement(run.completion, LOCAL_RUN_STOP_TIMEOUT_MS);
        if (!settled) sessionRunsRef.current.finish(run.sessionId, run);
      });
      for (const controller of titleGenerationControllersRef.current.values()) controller.abort();
      await Promise.allSettled([...remoteAborts, ...runCompletions, ...activeStops]);
      await waitForSyncIdle();
      releaseSessionBarrier = await coordinator.beginBarrier();
      coordinator.cancelScheduled();
      // Drain config's independent persistence queue and synchronously fence
      // any later Settings writes before deleting the OPFS tree. Otherwise a
      // queued config.set() could recreate API keys after clearAll().
      await config.clearForFactoryReset();
      configResetStarted = true;
      await clearAll();
      sessionPersistenceReadyRef.current = false;
      const emptySessions = [];
      persistedSessionsRef.current = emptySessions;
      skipNextSessionSaveRef.current = emptySessions;
      sessionsRef.current = emptySessions;
      setSessions(emptySessions);
      setActiveSessionId(null);
      sessionLoadingRequestsRef.current.clear();
      setLoadingSessionIds(new Set());
      sessionStopPromisesRef.current.clear();
      setStoppingSessionIds(new Set());
      setMessageQueue([]);
      resetComplete = true;
      setTimeout(() => window.location.reload(), 500);
    } finally {
      // Keep auto-sync paused after a successful reset so stale in-memory
      // credentials cannot repopulate storage before the reload.
      if (!resetComplete) {
        if (configResetStarted) config.cancelFactoryReset();
        factoryResetInProgressRef.current = false;
        releaseSessionBarrier?.();
        resumeAutoSync?.();
        for (const pendingStart of cancelledStreamStarts) {
          scheduleStreamResponse(
            pendingStart.sessionId,
            pendingStart.sessionMessages,
            pendingStart.opts
          );
        }
        // If aborting runs made queued messages eligible while the reset gate
        // was closed, retrigger the per-session queue effect now.
        if (activeRuns.length > 0 && cancelledStreamStarts.length === 0) {
          setMessageQueue((current) => [...current]);
        }
      }
    }
  }, [cancelPendingStreamStarts, scheduleStreamResponse]);

  const handleStartupBackup = useCallback(async () => {
    if (startupRecoveryBusyRef.current) return;
    startupRecoveryBusyRef.current = true;
    setStartupRecoveryBusy('export');
    setStartupRecoveryError(null);
    const resumeAutoSync = suspendAutoSync();
    try {
      await waitForSyncIdle();
      const blob = await exportToZip({ materializeSessionRecovery: true });
      downloadBlobFile(
        `cherry-agent-recovery-${new Date().toISOString().slice(0, 10)}.zip`,
        blob
      );
    } catch (error) {
      setStartupRecoveryError(`Backup export failed: ${error.message}`);
    } finally {
      resumeAutoSync();
      startupRecoveryBusyRef.current = false;
      setStartupRecoveryBusy(null);
    }
  }, []);

  const handleStartupFactoryReset = useCallback(async () => {
    if (startupRecoveryBusyRef.current) return;
    if (!window.confirm(
      'Factory reset permanently deletes all local CherryAgent data. '
      + 'Export a recovery backup first if you may need this data. Continue?'
    )) return;

    startupRecoveryBusyRef.current = true;
    setStartupRecoveryBusy('reset');
    setStartupRecoveryError(null);
    try {
      await performFactoryReset();
    } catch (error) {
      setStartupRecoveryError(`Factory reset failed: ${error.message}`);
      startupRecoveryBusyRef.current = false;
      setStartupRecoveryBusy(null);
    }
  }, [performFactoryReset]);

  // Track online/offline status
  useEffect(() => {
    const goOffline = () => setIsOffline(true);
    const goOnline = () => setIsOffline(false);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  // No cleanup on unmount — E2B sandbox survives page refreshes.
  // Sandbox auto-expires after 30 minutes of inactivity.

  if (!loaded) {
    return <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
      {initError ? (
        <div style={{ width: 'min(560px, calc(100vw - 32px))', textAlign: 'center' }}>
          <h2 style={{ margin: '0 0 8px' }}>Local data needs recovery</h2>
          <p style={{ color: '#e53935', margin: 0 }}>Initialization failed: {initError}</p>
          <p style={{ margin: '12px 0 0', lineHeight: 1.5 }}>
            Reloading may help after a temporary storage error. If it does not,
            export a backup before resetting. Recovery backups can contain API keys and other private data.
          </p>
          {startupRecoveryError && (
            <p role="alert" style={{ color: '#e53935', margin: '12px 0 0' }}>
              {startupRecoveryError}
            </p>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 16 }}>
            <button
              disabled={Boolean(startupRecoveryBusy)}
              onClick={() => window.location.reload()}
              style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #ccc', background: '#fff', cursor: startupRecoveryBusy ? 'default' : 'pointer' }}
            >
              Reload
            </button>
            <button
              disabled={Boolean(startupRecoveryBusy)}
              onClick={handleStartupBackup}
              style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #888', background: '#fff', cursor: startupRecoveryBusy ? 'default' : 'pointer' }}
            >
              {startupRecoveryBusy === 'export' ? 'Exporting backup…' : 'Export recovery backup'}
            </button>
            <button
              disabled={Boolean(startupRecoveryBusy)}
              onClick={handleStartupFactoryReset}
              style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #c62828', background: '#c62828', color: '#fff', cursor: startupRecoveryBusy ? 'default' : 'pointer' }}
            >
              {startupRecoveryBusy === 'reset' ? 'Resetting…' : 'Factory reset'}
            </button>
          </div>
        </div>
      ) : 'Loading...'}
    </div>;
  }

  return (
    <I18nProvider initialLocale={localePref} onLocaleChange={handleLocaleChange}>
    <div className="app">
      {isOffline && <OfflineBanner />}
      <SessionList
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        onDeleteSession={handleDeleteSession}
        onCancelWakeup={handleCancelWakeup}
        onExportDebug={handleExportDebug}
        debugExportDisabled={!activeSessionId || !activeSession?.messages}
        collapsed={leftPanelCollapsed}
        onToggleCollapse={() => setLeftPanelCollapsed(prev => !prev)}
        sessionAgents={sessionAgents}
        agentList={agentList}
        runningSessionIds={busySessionIdsForUi}
      />
      {/* Expand button - visible when left panel is collapsed (PC mode only) */}
      {leftPanelCollapsed && (
        <button
          className="session-list-expand-btn"
          onClick={() => setLeftPanelCollapsed(false)}
          aria-label="Expand session list"
          title="Expand"
        >
          <ChevronRight width={14} height={14} />
        </button>
      )}
      <MessagePanel
        ref={messagePanelRef}
        messages={messages}
        activeSessionId={activeSessionId}
        onSendMessage={handleSendMessage}
        queuedMessages={messageQueue.filter((item) => item.sessionId === activeSessionId)}
        onRemoveQueuedMessage={handleRemoveQueuedMessage}
        onEditMessage={handleEditMessage}
        onRetry={() => {
          if (activeSessionAgentLoading || factoryResetInProgressRef.current || activeSessionStreaming) return;
          const sessionId = activeSessionId;
          const session = sessions.find((c) => c.id === sessionId);
          if (!session) return;
          const lastUserIdx = session.messages.reduce((acc, m, i) => m.role === 'user' ? i : acc, -1);
          if (lastUserIdx === -1) return;
          const trimmed = session.messages.slice(0, lastUserIdx + 1);
          const failedRemote = ['error', 'interrupted'].includes(session.remoteRun?.status)
            ? session.remoteRun
            : null;
          const startAfter = failedRemote
            ? abortRemoteAgentRunBestEffort(failedRemote.url, failedRemote.id)
            : null;
          setSessions((prev) => prev.map((c) => {
            if (c.id !== sessionId) return c;
            const next = { ...c, messages: trimmed };
            if (failedRemote && c.remoteRun?.id === failedRemote.id) delete next.remoteRun;
            return next;
          }));
          scheduleStreamResponse(sessionId, trimmed, startAfter ? { startAfter } : {});
        }}
        streaming={activeSessionStreaming}
        inputDisabled={activeSessionLoading || activeSessionAgentLoading}
        onStopStreaming={handleStopStreaming}
        llmConfig={llm.getActiveConfig(activeLlmProfileId)}
        llmProfiles={llm.getProfiles()}
        activeLlmProfileId={activeLlmProfileId}
        onSelectLLM={handleSelectLLM}
        providers={llm.getProviderTypes?.() || llm.getProviders()}
        providerConfigs={llm.getProviderConfigs?.() || []}
        onConfigureProvider={async (providerConfig) => {
          if (!llm.configureProvider) throw new Error('Provider management is not ready.');
          const saved = await llm.configureProvider(providerConfig);
          setLlmReady((prev) => !prev);
          return saved;
        }}
        onDeleteProvider={async (providerId) => {
          if (!llm.deleteProvider) throw new Error('Provider management is not ready.');
          await llm.deleteProvider(providerId);
          setLlmReady((prev) => !prev);
        }}
        onConfigureLLM={async (cfg) => {
          const saved = await (llm.configureLlm ? llm.configureLlm(cfg) : llm.configure(cfg));
          setCurrentLlmProfileId(saved.id);
          if (activeSessionId) {
            setSessionLlmProfiles((prev) => ({ ...prev, [activeSessionId]: saved.id }));
            setSessions((prev) => prev.map((c) => c.id === activeSessionId ? { ...c, llmProfileId: saved.id } : c));
          }
          setLlmReady((prev) => !prev);
          return saved;
        }}
        onDeleteLLM={async (profileId) => {
          await (llm.deleteLlm ? llm.deleteLlm(profileId) : llm.deleteProfile(profileId));
          const nextId = llm.getActiveProfileId();
          setCurrentLlmProfileId(nextId);
          setSessionLlmProfiles((prev) => {
            const next = { ...prev };
            for (const [sessionId, id] of Object.entries(next)) {
              if (id === profileId) {
                if (nextId) next[sessionId] = nextId;
                else delete next[sessionId];
              }
            }
            return next;
          });
          setSessions((prev) => prev.map((c) => c.llmProfileId === profileId ? { ...c, llmProfileId: nextId } : c));
          const agentsUsingProfile = agentList.filter((agent) => agent.llmProfileId === profileId);
          if (agentsUsingProfile.length > 0) {
            await Promise.all(agentsUsingProfile.map((agent) => updateAgentConfig(agent.id, { llmProfileId: null })));
            setAgentList(await listAgents());
          }
          setLlmReady((prev) => !prev);
        }}
        onFetchModels={(providerId, config, profileId) => (
          llm.fetchProviderModels
            ? llm.fetchProviderModels(providerId)
            : llm.fetchModels(providerId, config, profileId)
        )}
        theme={theme}
        onThemeChange={handleThemeChange}
        agents={agents}
        selectedAgentUrl={activeSandboxUrl}
        onSelectAgent={async (url) => {
          if (activeAgentConfig) {
            await updateAgentConfig(activeAgentConfig.id, { sandboxUrl: url || null });
            const updated = await listAgents();
            setAgentList(updated);
          }
          setSelectedAgentUrl(url || null);
          selectedAgentRef.current = url || null;
          await config.set('selectedAgent', url);
        }}
        onAgentsChange={async (newAgents) => {
          // Track dismissed / un-dismissed agents for auto-detect
          const dismissed = config.get('dismissedAgents') || [];
          const nonE2bAgents = newAgents.filter((a) => a.url !== E2B_AGENT_ID);
          const removed = agents.filter((a) => a.url !== E2B_AGENT_ID && !nonE2bAgents.some((n) => n.url === a.url));
          const added = nonE2bAgents.filter((n) => !agents.some((a) => a.url === n.url && a.url !== E2B_AGENT_ID));
          let updatedDismissed = dismissed;
          if (removed.length > 0) {
            updatedDismissed = [...new Set([...updatedDismissed, ...removed.map((a) => a.url)])];
          }
          if (added.length > 0) {
            const addedUrls = new Set(added.map((a) => a.url));
            updatedDismissed = updatedDismissed.filter((u) => !addedUrls.has(u));
          }
          if (updatedDismissed.length !== dismissed.length || removed.length || added.length) {
            await config.set('dismissedAgents', updatedDismissed);
          }
          setAgents(newAgents);
          const toSave = nonE2bAgents.map(({ url, name }) => ({ url, name }));
          await config.set('agents', toSave);
          const validSandboxUrls = new Set(newAgents.map((agent) => agent.url));
          const agentsWithRemovedSandbox = agentList.filter((agent) => agent.sandboxUrl && !validSandboxUrls.has(agent.sandboxUrl));
          if (agentsWithRemovedSandbox.length > 0) {
            await Promise.all(agentsWithRemovedSandbox.map((agent) => updateAgentConfig(agent.id, { sandboxUrl: null })));
            setAgentList(await listAgents());
          }
          // Keep the global file-manager sandbox valid, but don't auto-enable sandbox use for sessions.
          if (selectedAgentUrl && !newAgents.some((a) => a.url === selectedAgentUrl)) {
            const next = null;
            setSelectedAgentUrl(next);
            selectedAgentRef.current = next;
            await config.set('selectedAgent', next);
          }
        }}
        onE2bChange={async (apiKey) => {
          const nextKey = apiKey || null;
          const oldKey = config.get('e2b.apiKey') || null;
          // A connected lifecycle belongs to the credentials that created it.
          // Retire it before replacing or clearing the key so commands can
          // never continue in the old account under a new Settings value.
          if (!nextKey || (oldKey && oldKey !== nextKey)) await stopE2bSandbox();
          await config.set('e2b.apiKey', nextKey);
          if (nextKey) {
            // startSandbox is single-flight; this also retries a prior failed
            // connection when the user corrects/re-enters credentials.
            const { connected, error } = await enableE2b();
            const e2bSandboxInfo = getSandboxStatus();
            const e2bAgent = { url: E2B_AGENT_ID, name: 'E2B Cloud', status: connected ? 'connected' : 'error', isE2b: true, sandboxId: e2bSandboxInfo.sandboxId };
            setAgents((prev) => {
              const updated = [...prev.filter((a) => a.url !== E2B_AGENT_ID), e2bAgent];
              return updated;
            });
            if (error) throw new Error(`E2B sandbox failed: ${error}`);
          } else if (oldKey) {
            setAgents((prev) => prev.filter((a) => a.url !== E2B_AGENT_ID));
            if (selectedAgentUrl === E2B_AGENT_ID) {
              setSelectedAgentUrl(null);
              selectedAgentRef.current = null;
              await config.set('selectedAgent', null);
            }
          }
        }}
        onExecuteCommand={(cmd) => executeCommand(cmd, selectedAgentUrl)}
        onFactoryReset={performFactoryReset}
        showFileManage={showFileManage}
        onToggleFileManage={() => setShowFileManage(!showFileManage)}
        userNickname={userNickname}
        onUserNicknameChange={async (newNickname) => {
          setUserNickname(newNickname);
          await config.set('general.userNickname', newNickname);
        }}
        avatar={avatar}
        onAvatarChange={async (newAvatar) => {
          setAvatar(newAvatar);
          await config.set('general.avatar', newAvatar || null);
        }}
        agentList={agentList}
        agentId={activeSessionId ? sessionAgents[activeSessionId] || null : lastAgentId}
        onAgentChange={async (sessionId, newAgentId) => {
          const updatedTime = sessionTimeFields();
          const llmProfileId = getAgentDefaultLlmId(newAgentId);
          if (newAgentId) {
            setLastAgentId(newAgentId);
          }
          if (llmProfileId) {
            setCurrentLlmProfileId(llmProfileId);
          }

          if (!sessionId) return;

          setSessionAgents((prev) => ({ ...prev, [sessionId]: newAgentId }));
          if (llmProfileId) {
            setSessionLlmProfiles((prev) => ({ ...prev, [sessionId]: llmProfileId }));
          }

          // Switching agents applies that agent's default LLM to the current session.
          // The LLM selector can still override the session after this.
          setSessions((prev) =>
            prev.map((c) =>
              c.id === sessionId
                ? { ...c, ...updatedTime, agentId: newAgentId, ...(llmProfileId && { llmProfileId }) }
                : c
            )
          );
        }}
        onAgentListChange={async (newList) => {
          const changedAgentDefaults = newList.filter((nextAgent) => {
            const previousAgent = agentList.find((agent) => agent.id === nextAgent.id);
            return previousAgent && previousAgent.llmProfileId !== nextAgent.llmProfileId;
          });

          setAgentList(newList);

          if (changedAgentDefaults.length > 0) {
            const changesByAgentId = new Map(changedAgentDefaults.map((nextAgent) => {
              const previousAgent = agentList.find((agent) => agent.id === nextAgent.id);
              return [nextAgent.id, {
                previousLlmProfileId: previousAgent?.llmProfileId || null,
                nextLlmProfileId: nextAgent.llmProfileId || null,
              }];
            }));

            setSessions((prev) => prev.map((session) => {
              const change = changesByAgentId.get(session.agentId);
              if (!change) return session;
              const sessionWasUsingAgentDefault = (session.llmProfileId || null) === change.previousLlmProfileId;
              return sessionWasUsingAgentDefault
                ? { ...session, llmProfileId: change.nextLlmProfileId }
                : session;
            }));

            setSessionLlmProfiles((prev) => {
              const next = { ...prev };
              for (const session of sessions) {
                const change = changesByAgentId.get(session.agentId);
                if (!change) continue;
                const sessionLlmProfileId = Object.prototype.hasOwnProperty.call(next, session.id)
                  ? next[session.id]
                  : session.llmProfileId;
                const sessionWasUsingAgentDefault = (sessionLlmProfileId || null) === change.previousLlmProfileId;
                if (!sessionWasUsingAgentDefault) continue;
                if (change.nextLlmProfileId) next[session.id] = change.nextLlmProfileId;
                else delete next[session.id];
              }
              return next;
            });

            const activeSession = sessions.find((session) => session.id === activeSessionId);
            const activeChange = activeSession ? changesByAgentId.get(activeSession.agentId) : null;
            if (activeChange && (activeSession.llmProfileId || null) === activeChange.previousLlmProfileId) {
              setCurrentLlmProfileId(activeChange.nextLlmProfileId || llm.getActiveProfileId() || getFirstLlmProfileId());
            }
          }
        }}
        onStorageRestored={refreshFromStorage}
        onBeforeStorageSync={beginSessionStorageBarrier}
        storageVersion={storageVersion}
      />
      {showFileManage && (
        <Suspense fallback={null}>
          <FileManage
            show={showFileManage}
            onClose={() => setShowFileManage(false)}
            refreshTrigger={storageVersion}
            width={fileManageWidth}
            onWidthChange={setFileManageWidth}
            sandboxUrl={activeSandboxUrl}
            agents={agentListReady ? agentList : null}
            activeAgentId={selectedAgentId}
          />
        </Suspense>
      )}
    </div>
    </I18nProvider>
  );
}

export default App;
