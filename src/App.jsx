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
import config from './config/config';
import llm from './models/llm';
import { executeCommand, initAgents, enableE2b, E2B_AGENT_ID, getSandboxStatus, stopE2bSandbox, startRemoteAgentRun, getRemoteAgentRun, listRemoteAgentRuns, abortRemoteAgentRun } from './models/agent';
import { prepareAgentRuntimeContext, runAgentLoop } from './agent/loop';
import { applyAgentEvent, createAgentEventState } from './agent/events';
import { buildChatDebugExport, createChatDebugFilename } from './agent/debug';
import { ensureDefaultSkills } from './agent/skills';
import { ensureDefaultAgent, listAgents, updateAgentConfig } from './agents/agents';
import { configureAutoSync, suspendAutoSync, waitForSyncIdle } from './sync/syncManager';
import { I18nProvider } from './i18n/index';
import { useI18n } from './i18n/context';
import { editUserMessageAndDiscardFollowing } from './messageHistory';
import {
  reconcileSessionRecoveryJournal,
  reconcileStoredSessions,
  snapshotSessions,
  sortSessions,
} from './sessionRefresh';
import { createSessionSaveCoordinator } from './sessionPersistence';
import { buildWakeupMessage, createWakeup, findNextWakeup } from './agent/wakeup';
import { WifiOff, ChevronRight } from './components/Icons/Icons';
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

const AGENT_SYSTEM_PROMPT = `You have access to commands, browser-workspace files, sandbox-runtime files, memory, skills, and focused sub-agent delegation.

Filesystem model:
- VertexAgent state lives in browser OPFS, but browser file tools do NOT expose the OPFS root.
- Browser file tools can read/write only the active agent's own persistent files area: workspace/<active-agent>/files/.
- Browser file tools cannot access other agents, OPFS root files, AGENTS.md, memory files, or skill files by path.
- Use the skill tool for catalog/read operations, and skill file tools for explicit edits under workspace/<active-agent>/skills/.
- The sandbox filesystem is only the runtime workdir for command tools. It is separate from browser OPFS and does not automatically contain AGENTS.md, memory, skills, or browser workspace files.
- Use browser file tools only for persistent files in the active agent's files area: list_browser_files, read_browser_file, display_browser_image, write_browser_file.
- Use skill file tools only for active-agent skills: list_skill_files, read_skill_file, write_skill_file.
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

const SANDBOX_AGENT_SYSTEM_PROMPT = `You are running fully inside the selected sandbox. Browser operations, browser OPFS, browser files, browser memory mutation, browser skill mutation, and sub-agent delegation are unavailable. A startup snapshot of the browser agent identity and enabled skills is available as AGENTS.md and skills/ when those paths did not already exist. Images attached to user messages are copied into the sandbox under attachments/; each image message includes its exact local path, which can be passed to curl and other command-line tools. Use command tools, sandbox file tools, and schedule_wakeup. Start long-running CLI work with start_command, then schedule a future continuation containing its job_id and latest log cursor instead of blocking or repeatedly polling; the agent server keeps both the run and managed command alive while the browser is disconnected. To show an image, always call display_sandbox_image with its real sandbox path; never emit Markdown/HTML image tags for local paths and never put image bytes, binary data, base64, or data URLs in the conversation. The browser may disconnect without stopping this run.`;

const FILE_CONTEXT_MARKER = 'Selected file context:';
const TOOL_HISTORY_MARKER = 'Tool calls performed during this assistant turn:';
const TOOL_HISTORY_RESULT_MAX_CHARS = 4000;

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
    const { contextFiles, toolCalls, transcript: _transcript, usage: _usage, ...rest } = message;
    let content = message.content || '';

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
  return messages.map(({ contextFiles: _contextFiles, toolCalls: _toolCalls, transcript: _transcript, usage: _usage, ...message }) => message);
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
  const [streaming, setStreaming] = useState(false);
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
  const abortRef = useRef(null);
  const remoteRunRef = useRef(null);
  const resumedRemoteRunsRef = useRef(new Set());
  const resumingWaitingRunsRef = useRef(new Set());
  const remoteDiscoveryRef = useRef(new Set());
  const streamCompletionRef = useRef(null);
  const factoryResetInProgressRef = useRef(false);
  const startupRecoveryBusyRef = useRef(false);
  const pendingStreamStartsRef = useRef(new Map());
  const claimedWakeupIdsRef = useRef(new Set());
  const streamingContentRef = useRef('');  // accumulates chunks outside React state
  const streamingThinkingRef = useRef(''); // accumulates thinking/reasoning chunks
  const rafRef = useRef(null);            // requestAnimationFrame id for UI sync
  const selectedAgentRef = useRef(null); // avoid stale closure
  const messagePanelRef = useRef(null);
  const wasStreamingRef = useRef(false);
  const sessionsRef = useRef(sessions);
  const activeSessionIdRef = useRef(activeSessionId);
  const sessionLoadRequestRef = useRef(0);

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

        ensureDefaultAgent().then(() => listAgents()).then((agents) => {
          setAgentList(agents);
        }).catch((err) => console.warn('Ensure default agent failed:', err));
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
    setLocalePref(pref);
    await config.set('locale', pref);
  }, []);

  const activeSession = sessions.find((c) => c.id === activeSessionId);
  const messages = activeSession?.messages || [];
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

  const handleNewSession = useCallback(async () => {
    messagePanelRef.current?.focusInput();

    // If the active session is still empty, just keep it — don't spawn another
    const current = sessions.find((c) => c.id === activeSessionId);
    if (current && (current.messages || []).length === 0) return;

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
    if (!streaming) await flushPendingSessionSave();
    setSessions((prev) => sortSessions([
      newSession,
      ...prev.map((session) => streaming ? session : sessionMetadataOnly(session)),
    ]));
    setActiveSessionId(newSession.id);

    if (agentId) {
      setSessionAgents((prev) => ({ ...prev, [newSession.id]: agentId }));
    }
    if (llmProfileId) {
      setSessionLlmProfiles((prev) => ({ ...prev, [newSession.id]: llmProfileId }));
      setCurrentLlmProfileId(llmProfileId);
    }
  }, [sessions, activeSessionId, agentList, lastAgentId, currentLlmProfileId, getAgentDefaultLlmId, streaming, flushPendingSessionSave]);

  const handleSelectSession = useCallback(async (sessionId) => {
    const requestId = ++sessionLoadRequestRef.current;
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
      if (!streaming) {
        setSessions((prev) => prev.map((item) => (
          item.id === sessionId ? item : sessionMetadataOnly(item)
        )));
      }
      return;
    }

    try {
      if (!streaming) await flushPendingSessionSave();
      const loadedMessages = await loadSessionMessages(sessionId);
      if (requestId !== sessionLoadRequestRef.current) return;
      setSessions((prev) => prev.map((item) => {
        if (item.id === sessionId) return { ...item, messages: loadedMessages };
        return streaming ? item : sessionMetadataOnly(item);
      }));
    } catch (error) {
      console.error(`Failed to load session ${sessionId}:`, error);
    }
  }, [sessions, streaming, flushPendingSessionSave]);

  const handleDeleteSession = useCallback(async (sessionId) => {
    await flushPendingSessionSave();

    // First, delete the session file from OPFS
    await deleteSessionFile(sessions, sessionId);

    // Clean up agent assignment for this session
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

    // Then update the React state
    setSessions((prev) => {
      const updated = prev.filter((c) => c.id !== sessionId);
      // If we deleted the active session, select the next one (or none)
      if (sessionId === activeSessionId) {
        setActiveSessionId(updated.length > 0 ? updated[0].id : null);
      }
      return updated;
    });
  }, [activeSessionId, sessions, flushPendingSessionSave]);

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
        streaming: streaming && session.id === activeSessionId,
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
    streaming,
  ]);

  // Stream LLM response for a given session using the agent loop
  const streamResponse = useCallback(async (sessionId, sessionMessages, opts = {}) => {
    // A reset invalidates every in-memory session/message reference. Keep this
    // guard at the final entry point as well as in the timer scheduler so a
    // callback that was already dequeued cannot start work during the reset.
    if (factoryResetInProgressRef.current) return;

    // Prevent duplicate calls (StrictMode double-invoke guard)
    if (abortRef.current) return;

    const sessionAgentId = opts.agentId ?? sessionAgents[sessionId] ?? null;
    const agentConfig = sessionAgentId ? agentList.find((agent) => agent.id === sessionAgentId) : null;
    const llmProfileId = opts.llmProfileId ?? sessionLlmProfiles[sessionId] ?? currentLlmProfileId ?? agentConfig?.llmProfileId ?? llm.getActiveProfileId() ?? getFirstLlmProfileId();
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
                  ...c.messages,
                  { id: hintId, role: 'assistant', content: 'No LLM provider configured yet. Please open Settings (gear icon) to add your API key and select a provider.' },
                ],
              }
            : c
        ))
      );
      return;
    }

    const replyId = opts.replyId || generateId();
    // Add empty assistant message for streaming
    if (!opts.resumeRunId) {
      setSessions((prev) =>
        prev.map((c) =>
          c.id === sessionId
            ? {
                ...c,
                messages: [...c.messages, { id: replyId, role: 'assistant', content: '', thinking: '', toolCalls: [], transcript: [] }],
              }
            : c
        )
      );
    }

    const controller = new AbortController();
    abortRef.current = controller;
    let finishStream;
    const streamCompletion = new Promise((resolve) => { finishStream = resolve; });
    streamCompletionRef.current = streamCompletion;
    streamingContentRef.current = '';
    streamingThinkingRef.current = '';
    setStreaming(true);

    // Track tool calls for this message
    const toolCalls = [];
    let agentEventState = createAgentEventState();

    const applyStreamEvent = (event) => {
      agentEventState = applyAgentEvent(agentEventState, event);
      streamingContentRef.current = agentEventState.content;
      streamingThinkingRef.current = agentEventState.thinking;
      toolCalls.splice(0, toolCalls.length, ...agentEventState.toolCalls);
      scheduleFlush();
    };

    // Helper: update message in state
    const updateMessage = (fields) => {
      setSessions((prev) =>
        sortSessions(prev.map((c) =>
          c.id === sessionId
            ? {
                ...c,
                lastMessage: (fields.content || streamingContentRef.current).slice(0, 60),
                ...sessionTimeFields(),
                messages: c.messages.map((m) =>
                  m.id === replyId ? { ...m, ...fields } : m
                ),
              }
            : c
        ))
      );
    };

    // Flush accumulated content to React state via rAF for real-time char sync
    const scheduleFlush = () => {
      if (rafRef.current) return; // already scheduled
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        updateMessage({
          content: streamingContentRef.current,
          thinking: streamingThinkingRef.current,
          toolCalls: [...toolCalls],
          transcript: agentEventState.transcript,
        });
      });
    };

    try {
      const activeConfig = llm.getActiveConfig(llmProfileId);

      const sandboxUrl = opts.sandboxUrl ?? agentConfig?.sandboxUrl ?? null;
      const hasToolContext = sandboxUrl || sessionAgentId;

      let result;
      if (opts.resumeRunId || agentConfig?.runtimeMode === 'sandbox') {
        if (!sandboxUrl || sandboxUrl === E2B_AGENT_ID) {
          throw new Error('Sandbox runtime requires a connected VertexAgent agent server; direct E2B sandboxes currently provide command execution only.');
        }
        let remoteRun;
        if (opts.resumeRunId) {
          remoteRun = { id: opts.resumeRunId, status: 'running' };
        } else {
          const runtimeContext = await prepareAgentRuntimeContext(sessionAgentId, { runtimeMode: 'sandbox' });
          remoteRun = await startRemoteAgentRun(sandboxUrl, {
            sessionId,
            replyId,
            messages: expandMessagesForSandboxRuntime(sessionMessages),
            systemPrompt: SANDBOX_AGENT_SYSTEM_PROMPT,
            agentId: sessionAgentId,
            modelConfig: llm.getRuntimeConfig(llmProfileId),
            runtimeContext: {
              ...runtimeContext,
              // Memory stays browser-only; identity and enabled skills are a
              // bounded startup snapshot for the isolated runtime.
              memorySnapshot: { memory: null, user: null },
            },
          }, controller.signal);
          setSessions((prev) => prev.map((session) => session.id === sessionId ? {
            ...session,
            remoteRun: { id: remoteRun.id, url: sandboxUrl, replyId, status: remoteRun.status },
            ...sessionTimeFields(),
          } : session));
        }
        remoteRunRef.current = { id: remoteRun.id, url: sandboxUrl };
        while (remoteRun.status === 'running') {
          remoteRun = await getRemoteAgentRun(sandboxUrl, remoteRun.id, 0, controller.signal);
          agentEventState = createAgentEventState();
          for (const event of remoteRun.events || []) applyStreamEvent(event);
          setSessions((prev) => prev.map((session) => session.id === sessionId ? {
            ...session,
            remoteRun: {
              id: remoteRun.id,
              url: sandboxUrl,
              replyId,
              status: remoteRun.status,
              ...(remoteRun.wakeup ? { wakeup: remoteRun.wakeup } : {}),
            },
          } : session));
          if (remoteRun.status === 'running') {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 750);
              controller.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new DOMException('Polling aborted', 'AbortError'));
              }, { once: true });
            });
          }
        }
        if (!['completed', 'waiting'].includes(remoteRun.status)) {
          throw new Error(remoteRun.error || `Sandbox run ${remoteRun.status}`);
        }
        result = remoteRun.result;
      } else {
        result = await runAgentLoop({
          messages: expandMessagesForLlm(sessionMessages),
          systemPrompt: hasToolContext ? AGENT_SYSTEM_PROMPT : '',
          agentUrl: sandboxUrl,
          agentId: sessionAgentId,
          signal: controller.signal,
          provider: activeConfig.provider,
          model: activeConfig.model,
          contextWindow: activeConfig.contextWindow,
          llmProfileId,
          scheduleWakeup: async ({ delaySeconds, prompt }) => {
            const wakeup = createWakeup({
              id: generateId(),
              delaySeconds,
              prompt,
            });
            setSessions((prev) => sortSessions(prev.map((session) => (
              session.id === sessionId
                ? {
                    ...session,
                    wakeups: [...(session.wakeups || []), wakeup],
                    ...sessionTimeFields(),
                  }
                : session
            ))));
            return wakeup;
          },
          onEvent: applyStreamEvent,
        });
      }

      // Mark unfinished tool calls as completed.
      for (const tc of toolCalls) {
        if (tc.status === 'running' || tc.status === 'writing') tc.status = 'completed';
      }

      const finalContent = result.content || streamingContentRef.current;
      const finalThinking = result.thinking || streamingThinkingRef.current;
      updateMessage({ content: finalContent, thinking: finalThinking, toolCalls: [...toolCalls], transcript: agentEventState.transcript, usage: result.usage });
      if (result.toolCalls?.some((tc) => tc.name === 'spawn_agent')) {
        setAgentList(await listAgents());
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        for (const tc of toolCalls) {
          if (tc.status === 'running' || tc.status === 'writing') {
            tc.status = 'aborted';
            tc.result = tc.result || 'Aborted';
          }
        }
        updateMessage({ content: streamingContentRef.current, thinking: streamingThinkingRef.current, toolCalls: [...toolCalls], transcript: agentEventState.transcript });
      } else {
        const errorContent = streamingContentRef.current || `Error: ${err.message}`;
        updateMessage({ content: errorContent, toolCalls: [...toolCalls], transcript: agentEventState.transcript });
      }
    } finally {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      abortRef.current = null;
      remoteRunRef.current = null;
      streamingContentRef.current = '';
      streamingThinkingRef.current = '';
      setStreaming(false);
      if (streamCompletionRef.current === streamCompletion) {
        streamCompletionRef.current = null;
      }
      finishStream();
    }
  }, [agentList, sessionAgents, sessionLlmProfiles, currentLlmProfileId, getFirstLlmProfileId]);

  const scheduleStreamResponse = useCallback((sessionId, sessionMessages, opts = {}) => {
    if (factoryResetInProgressRef.current) return;

    const pendingStart = { sessionId, sessionMessages, opts };
    const timerId = setTimeout(() => {
      pendingStreamStartsRef.current.delete(timerId);
      if (factoryResetInProgressRef.current) return;
      void streamResponse(sessionId, sessionMessages, opts);
    }, 0);
    pendingStreamStartsRef.current.set(timerId, pendingStart);
  }, [streamResponse]);

  // Reattach to runs that were started before a reload/browser close. The
  // server owns execution; this effect only rebuilds UI state from its log.
  useEffect(() => {
    if (!loaded || agentList.length === 0 || abortRef.current) return;
    const session = sessions.find((item) => item.remoteRun?.status === 'running');
    if (!session || resumedRemoteRunsRef.current.has(session.remoteRun.id)) return;
    const agent = agentList.find((item) => item.id === session.agentId);
    if (!agent) return;
    resumedRemoteRunsRef.current.add(session.remoteRun.id);
    void (async () => {
      const runMessages = session.messages || await loadSessionMessages(session.id);
      setSessions((prev) => prev.map((item) => (
        item.id === session.id ? { ...item, messages: runMessages } : item
      )));
      await streamResponse(session.id, runMessages, {
        agentId: session.agentId,
        llmProfileId: session.llmProfileId,
        sandboxUrl: session.remoteRun.url,
        resumeRunId: session.remoteRun.id,
        replyId: session.remoteRun.replyId,
      });
    })().catch((error) => console.warn('Remote agent run resume failed:', error));
  }, [agentList, loaded, sessions, streamResponse]);

  // A waiting sandbox run is owned by the agent server, so it does not keep
  // the browser UI in streaming mode. Reattach around its scheduled time.
  useEffect(() => {
    if (!loaded || abortRef.current || pendingStreamStartsRef.current.size > 0) return undefined;
    const session = sessions
      .filter((item) => item.remoteRun?.status === 'waiting' && item.remoteRun?.wakeup?.runAtMs)
      .sort((a, b) => a.remoteRun.wakeup.runAtMs - b.remoteRun.wakeup.runAtMs)[0];
    if (!session || resumingWaitingRunsRef.current.has(session.remoteRun.id)) return undefined;

    const delay = Math.max(0, session.remoteRun.wakeup.runAtMs - Date.now());
    const timerId = setTimeout(() => {
      if (abortRef.current || pendingStreamStartsRef.current.size > 0) return;
      resumingWaitingRunsRef.current.add(session.remoteRun.id);
      void (async () => {
        try {
          const messages = session.messages || await loadSessionMessages(session.id);
          await streamResponse(session.id, messages, {
            agentId: session.agentId,
            llmProfileId: session.llmProfileId,
            sandboxUrl: session.remoteRun.url,
            resumeRunId: session.remoteRun.id,
            replyId: session.remoteRun.replyId,
          });
        } finally {
          resumingWaitingRunsRef.current.delete(session.remoteRun.id);
        }
      })().catch((error) => console.warn('Waiting sandbox run resume failed:', error));
    }, Math.min(Math.max(delay, 250), 2_147_483_647));

    return () => clearTimeout(timerId);
  }, [loaded, sessions, streamResponse]);

  // A page can close in the narrow interval before the returned run id is
  // flushed to OPFS. Discover server-owned runs by session id as a fallback.
  useEffect(() => {
    if (!loaded || agentList.length === 0) return;
    for (const session of sessions) {
      if (session.remoteRun) continue;
      const agent = agentList.find((item) => item.id === session.agentId);
      if (agent?.runtimeMode !== 'sandbox' || !agent.sandboxUrl || agent.sandboxUrl === E2B_AGENT_ID) continue;
      const discoveryKey = `${agent.sandboxUrl}:${session.id}`;
      if (remoteDiscoveryRef.current.has(discoveryKey)) continue;
      remoteDiscoveryRef.current.add(discoveryKey);
      void listRemoteAgentRuns(agent.sandboxUrl, session.id).then(async ({ runs }) => {
        const latest = runs?.[0];
        if (!latest || latest.status === 'aborted' || latest.status === 'error' || latest.status === 'interrupted') return;
        const storedMessages = session.messages || await loadSessionMessages(session.id);
        setSessions((prev) => prev.map((item) => {
          if (item.id !== session.id || item.remoteRun) return item;
          const currentMessages = item.messages || storedMessages;
          const hasReply = currentMessages.some((message) => message.id === latest.replyId);
          return {
            ...item,
            messages: hasReply ? currentMessages : [...currentMessages, {
              id: latest.replyId || generateId(),
              role: 'assistant',
              content: '',
              thinking: '',
              toolCalls: [],
              transcript: [],
            }],
            remoteRun: {
              id: latest.id,
              url: agent.sandboxUrl,
              replyId: latest.replyId,
              // Mark completed discoveries as pending once so streamResponse
              // fetches their event log and durable result.
              status: latest.status === 'waiting' ? 'waiting' : 'running',
              ...(latest.wakeup ? { wakeup: latest.wakeup } : {}),
            },
          };
        }));
      }).catch((error) => console.warn('Remote agent run discovery failed:', error));
    }
  }, [agentList, loaded, sessions]);

  const cancelPendingStreamStarts = useCallback(() => {
    const pendingStarts = [...pendingStreamStartsRef.current.values()];
    for (const timerId of pendingStreamStartsRef.current.keys()) {
      clearTimeout(timerId);
    }
    pendingStreamStartsRef.current.clear();
    return pendingStarts;
  }, []);

  useEffect(() => () => {
    cancelPendingStreamStarts();
  }, [cancelPendingStreamStarts]);

  const handleStopStreaming = useCallback(() => {
    const remote = remoteRunRef.current;
    if (remote) void abortRemoteAgentRun(remote.url, remote.id).catch(() => {});
    if (abortRef.current) abortRef.current.abort();
  }, []);

  const sendMessageNow = useCallback(
    (text, images, contextFiles, targetSessionId = activeSessionId) => {
      if (factoryResetInProgressRef.current) return;

      // A new user turn in the same conversation supersedes its sleeping
      // continuation. This prevents the server from later resuming with a
      // stale message snapshot while the new turn is already in progress.
      const waitingRemote = sessionsRef.current.find((item) => item.id === targetSessionId)?.remoteRun;
      if (waitingRemote?.status === 'waiting') {
        void abortRemoteAgentRun(waitingRemote.url, waitingRemote.id).catch(() => {});
      }

      if (!targetSessionId) {
        // Auto-create a session if none selected
        const userMsg = { id: generateId(), role: 'user', content: text, ...(images && { images }), ...(contextFiles && { contextFiles }) };
        const agentId = lastAgentId ?? (agentList.length > 0 ? agentList[0].id : null);
        const llmProfileId = currentLlmProfileId || getAgentDefaultLlmId(agentId) || llm.getActiveProfileId();
        const newSession = {
          id: generateId(),
          title: text.slice(0, 30) + (text.length > 30 ? '...' : ''),
          lastMessage: text || (images ? '[Image]' : ''),
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
        return;
      }

      const userMsg = { id: generateId(), role: 'user', content: text, ...(images && { images }), ...(contextFiles && { contextFiles }) };
      const sessionId = targetSessionId;

      setSessions((prev) => {
        const updated = sortSessions(prev.map((c) =>
          c.id === sessionId
            ? {
                ...c,
                title: c.messages.length === 0 ? text.slice(0, 30) + (text.length > 30 ? '...' : '') : c.title,
                lastMessage: text || (images ? '[Image]' : ''),
                ...sessionTimeFields(),
                messages: [...c.messages, userMsg],
              }
            : c
        ));
        // Schedule stream outside of state updater
        const session = updated.find((c) => c.id === sessionId);
        if (session) {
          scheduleStreamResponse(sessionId, session.messages);
        }
        return updated;
      });
    },
    [activeSessionId, scheduleStreamResponse, lastAgentId, agentList, currentLlmProfileId, getAgentDefaultLlmId]
  );

  // Wake-ups are persisted in session metadata. Only the next one needs an
  // in-memory timer; overdue work is picked up once after the app is reopened.
  useEffect(() => {
    if (!loaded || factoryResetInProgressRef.current) return undefined;

    const next = findNextWakeup(sessions, claimedWakeupIdsRef.current);
    if (!next) return undefined;

    const delay = Math.max(0, next.wakeup.runAtMs - Date.now());
    const timerId = setTimeout(() => {
      if (
        streaming
        || abortRef.current
        || pendingStreamStartsRef.current.size > 0
        || factoryResetInProgressRef.current
      ) return;

      const { session: scheduledSession, wakeup } = next;
      claimedWakeupIdsRef.current.add(wakeup.id);

      void (async () => {
        try {
          const currentSession = sessionsRef.current.find((item) => item.id === scheduledSession.id);
          if (!currentSession) return;
          const messages = currentSession.messages || await loadSessionMessages(currentSession.id);
          // Loading a metadata-only session is asynchronous. Another turn may
          // have started in that gap, so leave this wake-up pending for retry.
          if (abortRef.current || pendingStreamStartsRef.current.size > 0) {
            claimedWakeupIdsRef.current.delete(wakeup.id);
            return;
          }
          const wakeMessage = {
            id: generateId(),
            role: 'user',
            content: buildWakeupMessage(wakeup),
          };
          const nextMessages = [...messages, wakeMessage];

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

          scheduleStreamResponse(currentSession.id, nextMessages, {
            agentId: currentSession.agentId,
            llmProfileId: currentSession.llmProfileId,
          });
        } catch (error) {
          claimedWakeupIdsRef.current.delete(wakeup.id);
          console.warn('Scheduled wake-up failed:', error);
        }
      })();
    }, Math.min(delay, 2_147_483_647));

    return () => clearTimeout(timerId);
  }, [loaded, scheduleStreamResponse, sessions, streaming]);

  const handleSendMessage = useCallback(
    (text, images, contextFiles) => {
      if (factoryResetInProgressRef.current) return;

      if (streaming && activeSessionId) {
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
        return;
      }

      sendMessageNow(text, images, contextFiles);
    },
    [activeSessionId, streaming, sendMessageNow]
  );

  const handleRemoveQueuedMessage = useCallback((queueId) => {
    setMessageQueue((prev) => prev.filter((item) => item.id !== queueId));
  }, []);

  useEffect(() => {
    if (factoryResetInProgressRef.current) return;

    const justFinishedStreaming = wasStreamingRef.current && !streaming;
    wasStreamingRef.current = streaming;
    if (!justFinishedStreaming || messageQueue.length === 0) return;

    const [next, ...rest] = messageQueue;
    setMessageQueue(rest);
    sendMessageNow(next.text, next.images, next.contextFiles, next.sessionId);
  }, [streaming, messageQueue, sendMessageNow]);

  const handleEditMessage = useCallback((messageId, text) => {
    if (factoryResetInProgressRef.current || streaming || !activeSessionId) return;
    const sessionId = activeSessionId;
    const session = sessions.find((c) => c.id === sessionId);
    if (!session) return;

    const editResult = editUserMessageAndDiscardFollowing(session.messages, messageId, text);
    if (!editResult) return;

    const { messageIndex, messages: trimmedMessages } = editResult;
    setMessageQueue((prev) => prev.filter((item) => item.sessionId !== sessionId));

    setSessions((prev) =>
      sortSessions(prev.map((c) =>
        c.id === sessionId
          ? {
              ...c,
              title: messageIndex === 0 ? text.slice(0, 30) + (text.length > 30 ? '...' : '') : c.title,
              lastMessage: text,
              ...sessionTimeFields(),
              messages: trimmedMessages,
            }
          : c
      ))
    );

    scheduleStreamResponse(sessionId, trimmedMessages);
  }, [activeSessionId, sessions, streaming, scheduleStreamResponse]);

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
    const streamCompletion = streamCompletionRef.current;
    let resumeAutoSync;
    let resetComplete = false;
    let configResetStarted = false;
    const coordinator = sessionSaveCoordinatorRef.current;
    let releaseSessionBarrier;
    try {
      resumeAutoSync = suspendAutoSync();
      abortRef.current?.abort();
      if (streamCompletion) await streamCompletion;
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
        // If aborting the active stream made a queued message eligible while
        // the gate was closed, retrigger the queue effect now.
        if (streamCompletion && cancelledStreamStarts.length === 0) {
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
        `vertex-agent-recovery-${new Date().toISOString().slice(0, 10)}.zip`,
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
      'Factory reset permanently deletes all local VertexAgent data. '
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
        onExportDebug={handleExportDebug}
        debugExportDisabled={!activeSessionId || !activeSession?.messages}
        collapsed={leftPanelCollapsed}
        onToggleCollapse={() => setLeftPanelCollapsed(prev => !prev)}
        sessionAgents={sessionAgents}
        agentList={agentList}
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
          if (factoryResetInProgressRef.current) return;
          const sessionId = activeSessionId;
          const session = sessions.find((c) => c.id === sessionId);
          if (!session) return;
          const lastUserIdx = session.messages.reduce((acc, m, i) => m.role === 'user' ? i : acc, -1);
          if (lastUserIdx === -1) return;
          const trimmed = session.messages.slice(0, lastUserIdx + 1);
          setSessions((prev) => prev.map((c) => c.id === sessionId ? { ...c, messages: trimmed } : c));
          scheduleStreamResponse(sessionId, trimmed);
        }}
        streaming={streaming}
        onStopStreaming={handleStopStreaming}
        llmConfig={llm.getActiveConfig(activeLlmProfileId)}
        llmProfiles={llm.getProfiles()}
        activeLlmProfileId={activeLlmProfileId}
        onSelectLLM={handleSelectLLM}
        providers={llm.getProviders()}
        onConfigureLLM={async (cfg) => {
          const saved = await llm.configure(cfg);
          setCurrentLlmProfileId(saved.id);
          if (activeSessionId) {
            setSessionLlmProfiles((prev) => ({ ...prev, [activeSessionId]: saved.id }));
            setSessions((prev) => prev.map((c) => c.id === activeSessionId ? { ...c, llmProfileId: saved.id } : c));
          }
          setLlmReady((prev) => !prev);
          return saved;
        }}
        onDeleteLLM={async (profileId) => {
          await llm.deleteProfile(profileId);
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
        onFetchModels={(providerId, config, profileId) => llm.fetchModels(providerId, config, profileId)}
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
          />
        </Suspense>
      )}
    </div>
    </I18nProvider>
  );
}

export default App;
