import { lazy, Suspense, useState, useCallback, useEffect, useRef } from 'react';
import SessionList from './components/SessionList/SessionList';
import MessagePanel from './components/MessagePanel/MessagePanel';
import { loadSessions, saveSessions, clearAll, deleteSession as deleteSessionFile } from './vfs/opfs';
import config from './config/config';
import llm from './models/llm';
import { executeCommand, initAgents, cleanupE2b, enableE2b, E2B_AGENT_ID, getSandboxStatus } from './models/agent';
import { runAgentLoop } from './agent/loop';
import { buildChatDebugExport, createChatDebugFilename } from './agent/debug';
import { ensureDefaultSkills } from './agent/skills';
import { ensureDefaultAgent, listAgents, updateAgentConfig } from './agents/agents';
import { configureAutoSync } from './sync/syncManager';
import { I18nProvider } from './i18n/index';
import { useI18n } from './i18n/context';
import { editUserMessageAndDiscardFollowing } from './messageHistory';
import { WifiOff, ChevronRight } from './components/Icons/Icons';
import './App.css';

const FileManage = lazy(() => import('./components/FileManage/FileManage'));

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function downloadJsonFile(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
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

function timestampFromGeneratedId(id) {
  const value = parseInt(String(id || '').slice(0, 8), 36);
  const min = new Date('2000-01-01T00:00:00Z').getTime();
  const max = new Date('2100-01-01T00:00:00Z').getTime();
  return Number.isFinite(value) && value >= min && value <= max ? value : 0;
}

function sessionTimestamp(session) {
  if (Number.isFinite(session?.updatedAtMs)) return session.updatedAtMs;
  const messageTimes = (session?.messages || []).map((message) => timestampFromGeneratedId(message.id));
  return Math.max(timestampFromGeneratedId(session?.id), ...messageTimes, 0);
}

function sortSessions(sessions) {
  return [...sessions].sort((a, b) => sessionTimestamp(b) - sessionTimestamp(a));
}

function sessionDataChanged(left, right) {
  return JSON.stringify(left) !== JSON.stringify(right);
}

function mergeStoredSessions(savedSessions, currentSessions) {
  const mergedById = new Map();
  let keptLocalState = false;

  for (const session of savedSessions) {
    if (session?.id != null) mergedById.set(String(session.id), session);
  }

  for (const session of currentSessions) {
    if (session?.id == null) continue;

    const id = String(session.id);
    const saved = mergedById.get(id);
    if (!saved) {
      mergedById.set(id, session);
      keptLocalState = true;
      continue;
    }

    if (sessionTimestamp(session) > sessionTimestamp(saved)) {
      mergedById.set(id, session);
      keptLocalState = true;
    }
  }

  const merged = sortSessions([...mergedById.values()]);
  return {
    sessions: merged,
    keptLocalState: keptLocalState || sessionDataChanged(merged, savedSessions),
  };
}

const AGENT_SYSTEM_PROMPT = `You have access to commands, browser-workspace files, sandbox-runtime files, memory, skills, and focused sub-agent delegation.

Filesystem model:
- VertexAgent state lives in browser OPFS, but browser file tools do NOT expose the OPFS root.
- Browser file tools can read/write only the active agent's own persistent files area: workspace/<active-agent>/files/.
- Browser file tools cannot access other agents, OPFS root files, AGENTS.md, memory files, or skill files by path.
- Use the skill tool for catalog/read operations, and skill file tools for explicit edits under workspace/<active-agent>/skills/.
- The sandbox filesystem is only the runtime workdir for execute_command. It is separate from browser OPFS and does not automatically contain AGENTS.md, memory, skills, or browser workspace files.
- Use browser file tools only for persistent files in the active agent's files area: list_browser_files, read_browser_file, read_browser_image, write_browser_file.
- Use skill file tools only for active-agent skills: list_skill_files, read_skill_file, write_skill_file.
- Use sandbox file tools only for files created or needed inside the command runtime: list_sandbox_files, read_sandbox_file, read_sandbox_image, write_sandbox_file.
- If data must move between the active agent files area and sandbox runtime, explicitly read from one side and write to the other side.

Work rules:
- Inspect the correct filesystem before editing when current state matters.
- Do not answer with a promise like "I will inspect/read/create/run". If the next step needs a tool, call the tool in the same response.
- Be careful with destructive actions and ask before irreversible operations.
- Use sub-agents only for bounded independent work.
- When tools fail, use the error output to choose the next useful step.`;

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
    const { contextFiles, toolCalls, usage: _usage, ...rest } = message;
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
  const savePending = useRef(null);
  const suppressNextSaveRef = useRef(false);
  const abortRef = useRef(null);
  const streamingContentRef = useRef('');  // accumulates chunks outside React state
  const streamingThinkingRef = useRef(''); // accumulates thinking/reasoning chunks
  const rafRef = useRef(null);            // requestAnimationFrame id for UI sync
  const selectedAgentRef = useRef(null); // avoid stale closure
  const messagePanelRef = useRef(null);
  const wasStreamingRef = useRef(false);
  const sessionsRef = useRef(sessions);
  const activeSessionIdRef = useRef(activeSessionId);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const refreshFromStorage = useCallback(async () => {
    await config.init();

    const savedTheme = config.get('theme');
    if (savedTheme && ['light', 'dark', 'system'].includes(savedTheme)) {
      setTheme(savedTheme);
    }

    const savedLocale = config.get('locale');
    if (savedLocale) setLocalePref(savedLocale);

    setUserNickname(config.get('general.userNickname') || config.get('general.nickname') || '');
    setAvatar(config.get('general.avatar') || '');

    const savedSessions = sortSessions(await loadSessions());
    const { sessions: mergedSessions, keptLocalState } = mergeStoredSessions(savedSessions, sessionsRef.current);
    suppressNextSaveRef.current = !keptLocalState;
    setSessions(mergedSessions);

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
    setStorageVersion((prev) => prev + 1);
  }, []);

  // Load config, sessions and LLM settings from OPFS on mount
  useEffect(() => {
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
          loadSessions()
            .then((saved) => {
              if (saved.length) {
                const sorted = sortSessions(saved);
                setSessions(sorted);
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
      .catch((err) => {
        console.error('Config init failed:', err);
        setInitError(err.message || 'Failed to load configuration');
      })
      .finally(() => setLoaded(true));

    // Initialize agents after config is ready
    initAgents().then(({ agents: allAgents, selectedUrl }) => {
      setAgents(allAgents);
      setSelectedAgentUrl(selectedUrl);
      selectedAgentRef.current = selectedUrl;
    }).catch((err) => console.warn('Agent init failed:', err));

    // Ensure default skills exist in OPFS at startup
    ensureDefaultSkills().catch((err) => console.warn('Ensure default skills failed:', err));

    // Ensure at least one agent workspace exists
    ensureDefaultAgent().then(() => listAgents()).then((agents) => {
      setAgentList(agents);
    }).catch((err) => console.warn('Ensure default agent failed:', err));
  }, []);

  // Debounced save to OPFS whenever sessions change
  useEffect(() => {
    if (!loaded) return;
    if (suppressNextSaveRef.current) {
      suppressNextSaveRef.current = false;
      return;
    }
    if (savePending.current) clearTimeout(savePending.current);
    savePending.current = setTimeout(() => {
      saveSessions(sessions).catch((err) => console.warn('OPFS save failed:', err));
    }, 300);
    return () => clearTimeout(savePending.current);
  }, [sessions, loaded]);

  useEffect(() => {
    if (!loaded || !config.initialized) return undefined;
    let cleanup = configureAutoSync(refreshFromStorage);
    const unsubscribe = config.subscribe(() => {
      cleanup?.();
      cleanup = configureAutoSync(refreshFromStorage, { runStartup: false });
    });
    return () => {
      cleanup?.();
      unsubscribe?.();
    };
  }, [loaded, refreshFromStorage]);

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
  const messages = activeSession ? activeSession.messages : [];
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

  const handleNewSession = useCallback(() => {
    messagePanelRef.current?.focusInput();

    // If the active session is still empty, just keep it — don't spawn another
    const current = sessions.find((c) => c.id === activeSessionId);
    if (current && current.messages.length === 0) return;

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
    setSessions((prev) => sortSessions([newSession, ...prev]));
    setActiveSessionId(newSession.id);

    if (agentId) {
      setSessionAgents((prev) => ({ ...prev, [newSession.id]: agentId }));
    }
    if (llmProfileId) {
      setSessionLlmProfiles((prev) => ({ ...prev, [newSession.id]: llmProfileId }));
      setCurrentLlmProfileId(llmProfileId);
    }
  }, [sessions, activeSessionId, agentList, lastAgentId, currentLlmProfileId, getAgentDefaultLlmId]);

  const handleSelectSession = useCallback((sessionId) => {
    setActiveSessionId(sessionId);
    // Restore the agent for this session and update tracking
    const session = sessions.find((c) => c.id === sessionId);
    const agentId = session?.agentId;
    if (agentId) {
      setLastAgentId(agentId);
    }
    const llmProfileId = session?.llmProfileId || llm.getActiveProfileId();
    setCurrentLlmProfileId(llmProfileId || null);
  }, [sessions]);

  const handleDeleteSession = useCallback(async (sessionId) => {
    if (savePending.current) {
      clearTimeout(savePending.current);
      savePending.current = null;
    }

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
  }, [activeSessionId, sessions]);

  const handleExportDebug = useCallback(() => {
    const session = sessions.find((c) => c.id === activeSessionId);
    if (!session) return;

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
    // Prevent duplicate calls (StrictMode double-invoke guard)
    if (abortRef.current) return;

    const sessionAgentId = opts.agentId ?? sessionAgents[sessionId] ?? null;
    const agentConfig = sessionAgentId ? agentList.find((agent) => agent.id === sessionAgentId) : null;
    const llmProfileId = opts.llmProfileId ?? sessionLlmProfiles[sessionId] ?? currentLlmProfileId ?? agentConfig?.llmProfileId ?? llm.getActiveProfileId() ?? getFirstLlmProfileId();
    if (!llm.isProfileConfigured(llmProfileId)) {
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

    const replyId = generateId();
    // Add empty assistant message for streaming
    setSessions((prev) =>
      prev.map((c) =>
        c.id === sessionId
          ? {
              ...c,
              messages: [...c.messages, { id: replyId, role: 'assistant', content: '', thinking: '', toolCalls: [] }],
            }
          : c
      )
    );

    const controller = new AbortController();
    abortRef.current = controller;
    streamingContentRef.current = '';
    streamingThinkingRef.current = '';
    setStreaming(true);

    // Track tool calls for this message
    const toolCalls = [];

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
        });
      });
    };

    try {
      const activeConfig = llm.getActiveConfig(llmProfileId);

      const sandboxUrl = opts.sandboxUrl ?? agentConfig?.sandboxUrl ?? null;
      const hasToolContext = sandboxUrl || sessionAgentId;

      const result = await runAgentLoop({
        messages: expandMessagesForLlm(sessionMessages),
        systemPrompt: hasToolContext ? AGENT_SYSTEM_PROMPT : '',
        agentUrl: sandboxUrl,
        agentId: sessionAgentId,
        signal: controller.signal,
        provider: activeConfig.provider,
        model: activeConfig.model,
        contextWindow: activeConfig.contextWindow,
        llmProfileId,
        onUpdate: ({ content, thinking, toolCalls: tcList }) => {
          streamingContentRef.current = content;
          if (thinking) streamingThinkingRef.current = thinking;
          if (tcList) {
            // Sync tool calls display by unique id
            for (const tc of tcList) {
              const existing = toolCalls.find((t) => t.id === tc.id);
              if (!existing) {
                toolCalls.push({
                  id: tc.id,
                  name: tc.name,
                  status: tc.status,
                  result: tc.result,
                  summary: tc.summary,
                  command: tc.command,
                  parsedArgs: tc.parsedArgs,
                  rawArgs: tc.rawArgs,
                });
              } else if (tc.result !== undefined || tc.status !== undefined) {
                if (tc.status !== undefined) existing.status = tc.status;
                if (tc.result !== undefined) existing.result = tc.result;
                if (tc.summary !== undefined) existing.summary = tc.summary;
                if (tc.command !== undefined) existing.command = tc.command;
                if (tc.parsedArgs !== undefined) existing.parsedArgs = tc.parsedArgs;
                if (tc.rawArgs !== undefined) existing.rawArgs = tc.rawArgs;
              } else if (tc.summary !== undefined) {
                existing.summary = tc.summary;
                if (tc.command !== undefined) existing.command = tc.command;
                if (tc.parsedArgs !== undefined) existing.parsedArgs = tc.parsedArgs;
                if (tc.rawArgs !== undefined) existing.rawArgs = tc.rawArgs;
              }
            }
          }
          scheduleFlush();
        },
      });

      // Mark unfinished tool calls as completed.
      for (const tc of toolCalls) {
        if (tc.status === 'running' || tc.status === 'writing') tc.status = 'completed';
      }

      const finalContent = result.content || streamingContentRef.current;
      const finalThinking = result.thinking || streamingThinkingRef.current;
      updateMessage({ content: finalContent, thinking: finalThinking, toolCalls: [...toolCalls], usage: result.usage });
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
        updateMessage({ content: streamingContentRef.current, thinking: streamingThinkingRef.current, toolCalls: [...toolCalls] });
      } else {
        const errorContent = streamingContentRef.current || `Error: ${err.message}`;
        updateMessage({ content: errorContent, toolCalls: [...toolCalls] });
      }
    } finally {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      abortRef.current = null;
      streamingContentRef.current = '';
      streamingThinkingRef.current = '';
      setStreaming(false);
    }
  }, [agentList, sessionAgents, sessionLlmProfiles, currentLlmProfileId, getFirstLlmProfileId]);

  const handleStopStreaming = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
  }, []);

  const sendMessageNow = useCallback(
    (text, images, contextFiles, targetSessionId = activeSessionId) => {
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
        setTimeout(() => streamResponse(newSession.id, [userMsg], { agentId, llmProfileId }), 0);
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
          setTimeout(() => streamResponse(sessionId, session.messages), 0);
        }
        return updated;
      });
    },
    [activeSessionId, streamResponse, lastAgentId, agentList, currentLlmProfileId, getAgentDefaultLlmId]
  );

  const handleSendMessage = useCallback(
    (text, images, contextFiles) => {
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
    const justFinishedStreaming = wasStreamingRef.current && !streaming;
    wasStreamingRef.current = streaming;
    if (!justFinishedStreaming || messageQueue.length === 0) return;

    const [next, ...rest] = messageQueue;
    setMessageQueue(rest);
    sendMessageNow(next.text, next.images, next.contextFiles, next.sessionId);
  }, [streaming, messageQueue, sendMessageNow]);

  const handleEditMessage = useCallback((messageId, text) => {
    if (streaming || !activeSessionId) return;
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

    setTimeout(() => streamResponse(sessionId, trimmedMessages), 0);
  }, [activeSessionId, sessions, streaming, streamResponse]);

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
        <>
          <p style={{ color: '#e53935', margin: 0 }}>Initialization failed: {initError}</p>
          <button onClick={() => window.location.reload()} style={{ marginTop: 16, padding: '8px 16px', borderRadius: 6, border: '1px solid #ccc', background: '#fff', cursor: 'pointer' }}>Reload</button>
        </>
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
        debugExportDisabled={!activeSessionId}
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
          const sessionId = activeSessionId;
          const session = sessions.find((c) => c.id === sessionId);
          if (!session) return;
          const lastUserIdx = session.messages.reduce((acc, m, i) => m.role === 'user' ? i : acc, -1);
          if (lastUserIdx === -1) return;
          const trimmed = session.messages.slice(0, lastUserIdx + 1);
          setSessions((prev) => prev.map((c) => c.id === sessionId ? { ...c, messages: trimmed } : c));
          setTimeout(() => streamResponse(sessionId, trimmed), 0);
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
          const oldKey = config.get('e2b.apiKey');
          await config.set('e2b.apiKey', apiKey || null);
          if (apiKey && !oldKey) {
            // E2B was just enabled — start sandbox and update agent list
            const { connected, error } = await enableE2b();
            const e2bSandboxInfo = getSandboxStatus();
            const e2bAgent = { url: E2B_AGENT_ID, name: 'E2B Cloud', status: connected ? 'connected' : 'error', isE2b: true, sandboxId: e2bSandboxInfo.sandboxId };
            setAgents((prev) => {
              const updated = [...prev.filter((a) => a.url !== E2B_AGENT_ID), e2bAgent];
              return updated;
            });
            if (error) throw new Error(`E2B sandbox failed: ${error}`);
          } else if (!apiKey && oldKey) {
            // E2B was just disabled — stop sandbox
            cleanupE2b();
            setAgents((prev) => prev.filter((a) => a.url !== E2B_AGENT_ID));
            if (selectedAgentUrl === E2B_AGENT_ID) {
              setSelectedAgentUrl(null);
              selectedAgentRef.current = null;
              config.set('selectedAgent', null);
            }
          }
        }}
        onExecuteCommand={(cmd) => executeCommand(cmd, selectedAgentUrl)}
        onFactoryReset={async () => {
          await clearAll();
          setSessions([]);
          setActiveSessionId(null);
          setTimeout(() => window.location.reload(), 500);
        }}
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
          />
        </Suspense>
      )}
    </div>
    </I18nProvider>
  );
}

export default App;
