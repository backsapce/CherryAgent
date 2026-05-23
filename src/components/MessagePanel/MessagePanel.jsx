import { forwardRef, lazy, Suspense, useImperativeHandle, useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { useI18n } from '../../i18n/context';
import { getAgentDir, normalizeWorkspaceRelativePath } from '../../vfs/opfs';
import { ChevronRight, Settings as SettingsIcon, Folder, File, FileEdit, MessageSquare, Plus, X, Send, Stop, Plug, PieChart, Cloud, User } from '../Icons/Icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './MessagePanel.css';

const Settings = lazy(() => import('../Settings/Settings'));

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB target (well under 10 MB API limit)
const MAX_DIMENSION = 2048;
const MESSAGE_HISTORY_PAGE_SIZE = 100;
const AUTO_SCROLL_BOTTOM_THRESHOLD = 48;
const LOAD_HISTORY_TOP_THRESHOLD = 24;
const SCROLL_DIRECTION_EPSILON = 2;

function resetEmptyTextareaCaret(textarea) {
  if (!textarea || textarea.value) return;
  textarea.scrollLeft = 0;
  textarea.scrollTop = 0;
  textarea.setSelectionRange(0, 0);
}

function getMentionRange(value, caret) {
  const head = value.slice(0, caret);
  const start = head.lastIndexOf('@');
  if (start === -1) return null;
  if (start > 0 && !/\s/.test(value[start - 1])) return null;
  const query = value.slice(start + 1, caret);
  if (/\s/.test(query)) return null;
  return { start, end: caret, query };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function estimateTokensFromText(text) {
  return Math.ceil((text?.length || 0) / 4);
}

async function collectAgentWorkspaceFiles(agentId) {
  if (!agentId) return [];
  const root = await getAgentDir(agentId);
  const files = [];

  async function walk(dir, prefix = '') {
    for await (const [name, handle] of dir) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') {
        await walk(handle, relativePath);
      } else {
        const file = await handle.getFile();
        files.push({
          name,
          relativePath,
          displayPath: relativePath,
          size: file.size,
          lastModified: file.lastModified,
        });
      }
    }
  }

  await walk(root);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function readAgentWorkspaceFile(agentId, relativePath) {
  const safePath = normalizeWorkspaceRelativePath(relativePath);
  const parts = safePath.split('/').filter(Boolean);
  const fileName = parts.pop();
  const dir = parts.length > 0 ? await getAgentDir(agentId, ...parts) : await getAgentDir(agentId);
  const fileHandle = await dir.getFileHandle(fileName);
  const file = await fileHandle.getFile();
  return file.text();
}

function buildDisplayMessageWithFileRefs(text, files) {
  if (!files.length) return text;
  const totalTokens = files.reduce((sum, file) => sum + estimateTokensFromText(file.content), 0);
  const refs = files
    .map((file) => `- ${file.relativePath || file.displayPath} (${formatBytes(file.size)}, ~${estimateTokensFromText(file.content)} tokens)`)
    .join('\n');
  return `${text}\n\nReferenced files: ${files.length} (~${totalTokens} tokens)\n${refs}`.trim();
}

/**
 * Compress / resize an image file so the resulting data-URL stays under the API limit.
 * Returns a base64 data-URL string.
 */
function compressImage(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;

      // Scale down if either dimension exceeds MAX_DIMENSION
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        const scale = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      // Try JPEG at decreasing quality until under the byte limit
      let quality = 0.85;
      let dataUrl = canvas.toDataURL('image/jpeg', quality);
      while (dataUrl.length > MAX_IMAGE_BYTES && quality > 0.1) {
        quality -= 0.15;
        dataUrl = canvas.toDataURL('image/jpeg', quality);
      }
      resolve(dataUrl);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      // Fallback: read raw (will likely fail at the API, but at least doesn't block UI)
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    };
    img.src = url;
  });
}

const ContextBudget = ({ messages, llmConfig }) => {
  // Check if the last assistant message has real usage data from the API
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.usage);
  const contextWindow = Number(llmConfig?.contextWindow);
  const total = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null;

  let used = null;
  if (total && lastAssistant?.usage) {
    const u = lastAssistant.usage;
    used = u.total_tokens
      || (u.prompt_tokens || 0) + (u.completion_tokens || u.output_tokens || 0)
      || (u.input_tokens || 0) + (u.output_tokens || 0);
  }
  const ratio = total && used ? Math.min(used / total, 1) : 0;
  const tooltip = total
    ? `${used != null ? formatTokens(used) : '0'} / ${formatTokens(total)}`
    : 'Context window not configured';

  const percent = Math.round(ratio * 100);

  // Color based on usage
  let color = 'var(--color-primary)';
  if (ratio > 0.85) color = 'var(--color-error, #e53935)';
  else if (ratio > 0.6) color = 'var(--color-warning, #fb8c00)';

  function formatTokens(n) {
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return n.toString();
  }

  return (
    <div className="context-budget">
      <div className="context-budget-tooltip">{tooltip}</div>
      <div className="context-budget-pie">
        <PieChart size={26} ratio={ratio} color={color} />
        <span className="context-budget-pct" style={{ color }}>{percent}</span>
      </div>
    </div>
  );
};

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

const ThinkingBlock = ({ thinking, isThinking }) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const startTimeRef = useRef(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (isThinking) {
      if (!startTimeRef.current) startTimeRef.current = Date.now();
      const timer = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 200);
      return () => clearInterval(timer);
    } else {
      if (startTimeRef.current && thinking) {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
      startTimeRef.current = null;
    }
  }, [isThinking, thinking]);

  if (!thinking && !isThinking) return null;

  const labelText = isThinking
    ? t('message.thinking')
    : thinking
      ? t('message.thoughtFor', { seconds: formatDuration(elapsed) })
      : null;

  return (
    <div className="thinking-block">
      <button className="thinking-toggle" onClick={() => setExpanded((v) => !v)}>
        <ChevronRight className={`thinking-chevron ${expanded ? 'expanded' : ''}`} width={14} height={14} />
        <span className="thinking-label">
          {labelText}
          {isThinking && (
            <>
              {' '}
              <span className="thinking-elapsed">{formatDuration(elapsed)}</span>
              <span className="thinking-dots"><span>.</span><span>.</span><span>.</span></span>
            </>
          )}
        </span>
      </button>
      {expanded && (
        <div className="thinking-content">{thinking}</div>
      )}
    </div>
  );
};

const normalizeTerminalOutput = (value) => String(value || '').replace(/\r?\n/g, '\r\n');

function fitAndScrollTerminal(terminal, fitAddon) {
  if (!terminal?.element || !fitAddon) return;
  try {
    fitAddon.fit();
    if (terminal.cols > 0 && terminal.rows > 0) {
      terminal.scrollToBottom();
    }
  } catch {
    // xterm can briefly lack renderer dimensions while mounting or resizing.
  }
}

const ToolTerminal = ({ output }) => {
  const containerRef = useRef(null);
  const terminalRef = useRef(null);
  const fitAddonRef = useRef(null);
  const previousOutputRef = useRef('');

  useEffect(() => {
    if (!containerRef.current) return;

    const style = getComputedStyle(containerRef.current);
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: false,
      cursorInactiveStyle: 'none',
      disableStdin: true,
      fontFamily: "'SF Mono', 'Fira Code', ui-monospace, monospace",
      fontSize: 12,
      lineHeight: 1.45,
      scrollback: 5000,
      theme: {
        background: style.getPropertyValue('--color-bg').trim() || '#0f172a',
        foreground: style.getPropertyValue('--color-text-content').trim() || '#e5e7eb',
        cursor: style.getPropertyValue('--color-text-content').trim() || '#e5e7eb',
        selectionBackground: style.getPropertyValue('--color-accent').trim() || '#2563eb',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    previousOutputRef.current = '';

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        fitAndScrollTerminal(terminalRef.current, fitAddonRef.current);
      });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      previousOutputRef.current = '';
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const nextOutput = String(output || '');
    const previousOutput = previousOutputRef.current;
    if (nextOutput.startsWith(previousOutput)) {
      terminal.write(normalizeTerminalOutput(nextOutput.slice(previousOutput.length)));
    } else {
      terminal.reset();
      terminal.write(normalizeTerminalOutput(nextOutput));
    }
    previousOutputRef.current = nextOutput;
    requestAnimationFrame(() => {
      fitAndScrollTerminal(terminal, fitAddonRef.current);
    });
  }, [output]);

  return <div className="tool-terminal" ref={containerRef} />;
};

const OldExecuteTerminalOutput = ({ result }) => {
  let output = '';
  if (result?.stdout) output += result.stdout;
  if (result?.stderr) output += `${output ? '\n' : ''}${result.stderr}`;
  return <ToolTerminal output={output} />;
};

const ToolBlock = ({ toolCall, onStopStreaming }) => {
  const { t } = useI18n();
  const isLegacyExecute = !!toolCall?.cmd;
  const isRunningExecute = isLegacyExecute
    ? !toolCall?.result
    : toolCall?.name === 'execute_command' && toolCall?.status === 'running';
  const [expanded, setExpanded] = useState(false);
  const effectiveExpanded = expanded || isRunningExecute;

  if (!toolCall) return null;

  // Old execute format: { cmd, result }
  if (toolCall.cmd) {
    const { cmd, result } = toolCall;
    const hasOutput = result && (result.stdout || result.stderr);
    return (
      <div className="tool-block">
        <div className="tool-header" onClick={() => setExpanded((v) => !v)}>
          <ChevronRight className={effectiveExpanded ? 'expanded' : ''} width={14} height={14} />
          <span className="tool-label">{t('message.execute')}</span>
          <span className="tool-cmd">{cmd}</span>
          {result && (
            <span className={`tool-exit-code ${result.code === 0 ? 'success' : 'error'}`}>
              {t('message.exitCode', { code: result.code })}
            </span>
          )}
          {!result && <span className="tool-exit-code">{t('message.running')}</span>}
        </div>
        {effectiveExpanded && hasOutput && (
          <div className="tool-output terminal-output">
            <OldExecuteTerminalOutput result={result} />
          </div>
        )}
      </div>
    );
  }

  // New tool call format: { name, status?, result?, summary? }
  const { name, status, result, summary, command } = toolCall;
  const showShutdown = name === 'execute_command' && status === 'running' && onStopStreaming;
  const renderTerminal = name === 'execute_command';
  const label = renderTerminal ? t('message.execute') : name;

  return (
    <div className="tool-block">
      <div className="tool-header" onClick={() => setExpanded((v) => !v)}>
        <ChevronRight className={effectiveExpanded ? 'expanded' : ''} width={14} height={14} />
        <span className="tool-label">{label}</span>
        {renderTerminal && command && <span className="tool-cmd" title={command}>{command}</span>}
        {summary && <span className="tool-summary">{summary}</span>}
        {status === 'writing' && <span className="tool-exit-code writing">{t('message.writing')}</span>}
        {status === 'running' && <span className="tool-exit-code">{t('message.running')}</span>}
        {status === 'completed' && <span className="tool-exit-code success">{t('message.completed')}</span>}
        {status === 'error' && <span className="tool-exit-code error">{t('message.error')}</span>}
        {status === 'aborted' && <span className="tool-exit-code aborted">{t('message.aborted')}</span>}
        {showShutdown && (
          <button
            type="button"
            className="tool-shutdown-button"
            onClick={(event) => {
              event.stopPropagation();
              onStopStreaming();
            }}
            title={t('message.stop')}
            aria-label={t('message.stop')}
          >
            <Stop width={12} height={12} />
          </button>
        )}
      </div>
      {effectiveExpanded && (result || (renderTerminal && status === 'running')) && (
        <div className={`tool-output ${renderTerminal ? 'terminal-output' : ''}`}>
          {renderTerminal ? <ToolTerminal output={result} /> : <pre>{result}</pre>}
        </div>
      )}
    </div>
  );
};

const MessagePanel = forwardRef(({
  messages,
  onSendMessage,
  queuedMessages = [],
  onRemoveQueuedMessage,
  onEditMessage,
  onRetry,
  streaming,
  onStopStreaming,
  llmConfig,
  llmProfiles,
  activeLlmProfileId,
  onSelectLLM,
  providers,
  onConfigureLLM,
  onDeleteLLM,
  onFetchModels,
  theme,
  onThemeChange,
  agents,
  selectedAgentUrl,
  onSelectAgent,
  onAgentsChange,
  onE2bChange,
  onFactoryReset,
  showFileManage,
  onToggleFileManage,
  userNickname,
  onUserNicknameChange,
  avatar,
  onAvatarChange,
  agentList,
  agentId,
  onAgentChange,
  onAgentListChange,
  activeSessionId,
  onStorageRestored,
}, ref) => {
  const { t } = useI18n();
  const [input, setInput] = useState('');
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editingText, setEditingText] = useState('');
  const [pendingImages, setPendingImages] = useState([]); // [{dataUrl, name}]
  const [pendingContextFiles, setPendingContextFiles] = useState([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionRange, setMentionRange] = useState(null);
  const [mentionFiles, setMentionFiles] = useState([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionError, setMentionError] = useState('');
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [visibleMessageCount, setVisibleMessageCount] = useState(MESSAGE_HISTORY_PAGE_SIZE);
  const messageListRef = useRef(null);
  const shouldAutoScrollRef = useRef(true);
  const scrollRafRef = useRef(null);
  const lastScrollTopRef = useRef(0);
  const pendingHistoryScrollRestoreRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const selectedAgent = agentList.find((agent) => agent.id === agentId) || agentList[0];
  const userName = userNickname?.trim() || t('message.you');
  const userInitial = Array.from(userName)[0]?.toUpperCase() || 'U';
  const assistantName = selectedAgent?.name || t('message.assistant');
  const assistantInitial = Array.from(assistantName)[0]?.toUpperCase() || 'V';
  const selectedLlmProfile = llmProfiles?.find((profile) => profile.id === activeLlmProfileId) || llmProfiles?.[0];
  const selectedProvider = providers?.find((provider) => provider.id === selectedLlmProfile?.provider);
  const selectedLlmProviderLabel = selectedProvider?.name || selectedLlmProfile?.provider || t('message.noProviderConfigured');
  const selectedLlmModelLabel = selectedLlmProfile?.model || selectedLlmProfile?.name || '';
  const showCenteredInput = !activeSessionId || messages.length === 0;
  const visibleMessages = useMemo(() => {
    const start = Math.max(messages.length - visibleMessageCount, 0);
    return messages.slice(start);
  }, [messages, visibleMessageCount]);
  const hasHiddenMessages = visibleMessages.length < messages.length;

  useImperativeHandle(ref, () => ({
    focusInput() {
      textareaRef.current?.focus({ preventScroll: true });
      resetEmptyTextareaCaret(textareaRef.current);
    },
  }), []);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      const list = messageListRef.current;
      if (list) {
        list.scrollTop = list.scrollHeight;
        lastScrollTopRef.current = list.scrollTop;
      }
      scrollRafRef.current = null;
    });
  }, [messages]);

  useEffect(() => {
    shouldAutoScrollRef.current = true;
    setVisibleMessageCount(MESSAGE_HISTORY_PAGE_SIZE);
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      const list = messageListRef.current;
      if (list) {
        list.scrollTop = list.scrollHeight;
        lastScrollTopRef.current = list.scrollTop;
      }
      scrollRafRef.current = null;
    });
  }, [activeSessionId]);

  useLayoutEffect(() => {
    const restore = pendingHistoryScrollRestoreRef.current;
    if (!restore) return;
    const list = messageListRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight - restore.scrollHeight + restore.scrollTop;
      lastScrollTopRef.current = list.scrollTop;
    }
    pendingHistoryScrollRestoreRef.current = null;
  }, [visibleMessages.length]);

  useEffect(() => () => {
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
  }, []);

  const handleMessageListScroll = (e) => {
    const list = e.currentTarget;
    const isScrollingUp = list.scrollTop < lastScrollTopRef.current - SCROLL_DIRECTION_EPSILON;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (hasHiddenMessages && list.scrollTop <= LOAD_HISTORY_TOP_THRESHOLD) {
      pendingHistoryScrollRestoreRef.current = {
        scrollHeight: list.scrollHeight,
        scrollTop: list.scrollTop,
      };
      shouldAutoScrollRef.current = false;
      setVisibleMessageCount((count) => Math.min(messages.length, count + MESSAGE_HISTORY_PAGE_SIZE));
    }
    if (isScrollingUp) {
      shouldAutoScrollRef.current = false;
    } else if (distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD) {
      shouldAutoScrollRef.current = true;
    }
    lastScrollTopRef.current = list.scrollTop;
  };

  useEffect(() => {
    let cancelled = false;

    async function loadWorkspaceFiles() {
      if (!mentionOpen || !agentId) {
        if (!cancelled) {
          setMentionFiles([]);
          setMentionLoading(false);
          setMentionError('');
        }
        return;
      }

      setMentionLoading(true);
      setMentionError('');
      try {
        const files = await collectAgentWorkspaceFiles(agentId);
        if (!cancelled) setMentionFiles(files);
      } catch (err) {
        if (!cancelled) {
          setMentionFiles([]);
          setMentionError(err.message || 'Unable to search files');
        }
      } finally {
        if (!cancelled) setMentionLoading(false);
      }
    }

    loadWorkspaceFiles();

    return () => {
      cancelled = true;
    };
  }, [mentionOpen, agentId]);

  const filteredMentionFiles = useMemo(() => {
    const query = mentionQuery.trim().toLowerCase();
    const selected = new Set(pendingContextFiles.map((file) => file.relativePath));
    return mentionFiles
      .filter((file) => !selected.has(file.relativePath))
      .filter((file) => !query || file.relativePath.toLowerCase().includes(query))
      .slice(0, 12);
  }, [mentionFiles, mentionQuery, pendingContextFiles]);
  const safeMentionActiveIndex = Math.min(mentionActiveIndex, Math.max(filteredMentionFiles.length - 1, 0));

  const handleSend = () => {
    const text = input.trim();
    if (!text && pendingImages.length === 0 && pendingContextFiles.length === 0) return;
    onSendMessage(
      buildDisplayMessageWithFileRefs(text, pendingContextFiles),
      pendingImages.length > 0 ? pendingImages : undefined,
      pendingContextFiles.length > 0 ? pendingContextFiles : undefined
    );
    setInput('');
    setPendingImages([]);
    setPendingContextFiles([]);
    setMentionOpen(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      requestAnimationFrame(() => resetEmptyTextareaCaret(textareaRef.current));
    }
  };

  const startEditMessage = (msg) => {
    if (streaming || msg.role !== 'user') return;
    setEditingMessageId(msg.id);
    setEditingText(msg.content || '');
  };

  const cancelEditMessage = () => {
    setEditingMessageId(null);
    setEditingText('');
  };

  const submitEditMessage = () => {
    const text = editingText.trim();
    if (!text || streaming || !editingMessageId) return;
    onEditMessage?.(editingMessageId, text);
    cancelEditMessage();
  };

  const handleEditKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEditMessage();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const ta = e.target;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const val = ta.value;
      const newVal = val.substring(0, start) + '\n' + val.substring(end);
      setEditingText(newVal);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 1;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
      });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      submitEditMessage();
    }
  };

  const handleEditTextChange = (e) => {
    const ta = e.target;
    setEditingText(ta.value);
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
  };

  const handleImageUpload = (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    files.forEach((file) => {
      if (!file.type.startsWith('image/')) return;
      compressImage(file).then((dataUrl) => {
        setPendingImages((prev) => [...prev, { dataUrl, name: file.name }]);
      });
    });
    // Reset so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeImage = (index) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  };

  const removeContextFile = (relativePath) => {
    setPendingContextFiles((prev) => prev.filter((file) => file.relativePath !== relativePath));
  };

  const closeMentionSelector = () => {
    setMentionOpen(false);
    setMentionQuery('');
    setMentionRange(null);
    setMentionActiveIndex(0);
  };

  const selectMentionFile = async (file) => {
    if (!agentId || !file) return;
    try {
      const content = await readAgentWorkspaceFile(agentId, file.relativePath);
      setPendingContextFiles((prev) => {
        if (prev.some((item) => item.relativePath === file.relativePath)) return prev;
        return [...prev, { ...file, content }];
      });
      if (mentionRange) {
        const nextInput = input.slice(0, mentionRange.start) + input.slice(mentionRange.end);
        setInput(nextInput);
        requestAnimationFrame(() => {
          if (!textareaRef.current) return;
          textareaRef.current.focus({ preventScroll: true });
          textareaRef.current.selectionStart = textareaRef.current.selectionEnd = mentionRange.start;
          textareaRef.current.style.height = 'auto';
          textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + 'px';
        });
      }
      closeMentionSelector();
    } catch (err) {
      setMentionError(err.message || `Unable to read ${file.relativePath}`);
    }
  };

  const handleKeyDown = (e) => {
    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionActiveIndex((prev) => Math.min(prev + 1, Math.max(filteredMentionFiles.length - 1, 0)));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionActiveIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMentionSelector();
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && filteredMentionFiles.length > 0) {
        e.preventDefault();
        selectMentionFile(filteredMentionFiles[safeMentionActiveIndex]);
        return;
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const ta = e.target;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const val = ta.value;
      const newVal = val.substring(0, start) + '\n' + val.substring(end);
      setInput(newVal);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 1;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
      });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInputChange = (e) => {
    const ta = e.target;
    const value = ta.value;
    const nextMentionRange = getMentionRange(value, ta.selectionStart);
    setInput(value);
    if (nextMentionRange) {
      setMentionOpen(true);
      setMentionRange(nextMentionRange);
      setMentionQuery(nextMentionRange.query);
      setMentionActiveIndex(0);
    } else if (mentionOpen) {
      closeMentionSelector();
    }
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  };

  const handleInputFocus = (e) => {
    resetEmptyTextareaCaret(e.target);
  };

  const handleInputPointerUp = (e) => {
    requestAnimationFrame(() => resetEmptyTextareaCaret(e.currentTarget));
  };


  return (
    <div className={`message-panel${showCenteredInput ? ' empty-input-state' : ''}`}>
      {showSettings && (
        <Suspense fallback={null}>
          <Settings
            show={showSettings}
            onClose={() => setShowSettings(false)}
            llmConfig={llmConfig}
            llmProfiles={llmProfiles}
            activeLlmProfileId={activeLlmProfileId}
            providers={providers}
            onConfigureLLM={onConfigureLLM}
            onDeleteLLM={onDeleteLLM}
            onFetchModels={onFetchModels}
            theme={theme}
            onThemeChange={onThemeChange}
            agents={agents}
            onAgentsChange={onAgentsChange}
            onE2bChange={onE2bChange}
            onFactoryReset={onFactoryReset}
            userNickname={userNickname}
            onUserNicknameChange={onUserNicknameChange}
            avatar={avatar}
            onAvatarChange={onAvatarChange}
            agentList={agentList}
            onAgentListChange={onAgentListChange}
            onStorageRestored={onStorageRestored}
          />
        </Suspense>
      )}


      {/* Header bar with settings and file manager */}
      <div className="message-panel-header">
        
        {agentList.length > 0 && (
          <div className="agent-selector">
            <User width={14} height={14} />
            <div className="agent-selector-control">
              <div className="agent-selector-label" aria-hidden="true">
                <span className="agent-selector-name">{selectedAgent?.name}</span>
                <span className="agent-selector-id">{selectedAgent?.id}</span>
              </div>
              <select
                value={agentId || ''}
                onChange={(e) => onAgentChange?.(activeSessionId, e.target.value || null)}
                title="Select agent"
                aria-label="Select agent"
              >
                {agentList.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="llm-selector-group">
          <div className="llm-selector">
            <Cloud width={14} height={14} />
            <div className="llm-selector-control">
              <div className="llm-selector-label" aria-hidden="true">
                <span className="llm-selector-provider">{selectedLlmProviderLabel}</span>
                <span className="llm-selector-model">{selectedLlmModelLabel}</span>
              </div>
              <select
                value={activeLlmProfileId || ''}
                onChange={(e) => onSelectLLM?.(e.target.value || null)}
                title={t('llmSettings.profile')}
                aria-label={t('llmSettings.profile')}
              >
                {llmProfiles?.length ? (
                  llmProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name || `${profile.provider} / ${profile.model}`}
                    </option>
                  ))
                ) : (
                  <option value="">{t('message.noProviderConfigured')}</option>
                )}
              </select>
            </div>
          </div>
        </div>

        <div className="header-buttons">
          <button className="settings-btn" onClick={() => setShowSettings(true)} title={t('settings.title')}>
            <SettingsIcon width={18} height={18} />
          </button>
          <button className={`filemanage-btn ${showFileManage ? 'active' : ''}`} onClick={() => onToggleFileManage?.()} title={t('filemanage.title')}>
            <Folder width={18} height={18} />
          </button>
        </div>
      </div>

      <div className="message-list" ref={messageListRef} onScroll={handleMessageListScroll}>
        {messages.length === 0 ? (
          <div className="message-empty">
            <div className="message-empty-icon">
              <MessageSquare width={48} height={48} />
            </div>
            <h3>{t('app.name')}</h3>
            <p>{t('app.tagline')}</p>
            <p className="message-empty-hint">{t('app.sendHint')}</p>
          </div>
        ) : (
          <>
          {hasHiddenMessages && (
            <div className="message-history-marker" aria-hidden="true" />
          )}
          {visibleMessages.map((msg) => (
            <div key={msg.id} className={`message ${msg.role}`}>
              <div className="message-avatar">
                {msg.role === 'assistant' && avatar ? (
                  <img src={avatar} alt="" />
                ) : (
                  msg.role === 'user' ? userInitial : assistantInitial
                )}
              </div>
              <div className="message-content">
                <div className="message-role">
                  <span>{msg.role === 'user' ? userName : assistantName}</span>
                  {msg.role === 'user' && editingMessageId !== msg.id && (
                    <button
                      type="button"
                      className="message-edit-btn"
                      onClick={() => startEditMessage(msg)}
                      disabled={streaming}
                      title={t('message.edit')}
                      aria-label={t('message.edit')}
                    >
                      <FileEdit width={14} height={14} />
                    </button>
                  )}
                </div>
                {msg.role === 'assistant' && (msg.thinking || (streaming && msg.content === '')) && (
                  <ThinkingBlock thinking={msg.thinking} isThinking={streaming && msg === messages[messages.length - 1]} />
                )}
                {msg.images && msg.images.length > 0 && (
                  <div className="message-images">
                    {msg.images.map((img, i) => (
                      <img key={i} src={img.dataUrl} alt={img.name || t('message.uploaded')} className="message-image" />
                    ))}
                  </div>
                )}
                {msg.role === 'assistant' && msg.toolCalls?.length > 0 && (
                  msg.toolCalls.map((tc, i) => (
                    <ToolBlock
                      key={tc.id || i}
                      toolCall={tc}
                      onStopStreaming={onStopStreaming}
                    />
                  ))
                )}
                <div className="message-text">
                  {editingMessageId === msg.id ? (
                    <div className="message-edit-form">
                      <textarea
                        className="message-edit-input"
                        value={editingText}
                        onChange={handleEditTextChange}
                        onKeyDown={handleEditKeyDown}
                        autoFocus
                        rows={Math.min(editingText.split('\n').length || 1, 6)}
                      />
                      <div className="message-edit-actions">
                        <button type="button" className="message-edit-cancel" onClick={cancelEditMessage}>
                          {t('message.cancel')}
                        </button>
                        <button
                          type="button"
                          className="message-edit-submit"
                          onClick={submitEditMessage}
                          disabled={!editingText.trim() || streaming}
                        >
                          {t('message.submitEdit')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{msg.content}</ReactMarkdown>
                      {msg.role === 'assistant' && msg.content?.startsWith('Error:') && !streaming && onRetry && (
                        <button className="retry-btn" onClick={() => onRetry()} title={t('message.retry')}>Retry</button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
          </>
        )}
      </div>

      <div className="message-input-area">
        {pendingImages.length > 0 && (
          <div className="image-preview-strip">
            {pendingImages.map((img, i) => (
              <div key={i} className="image-preview-item">
                <img src={img.dataUrl} alt={img.name} />
                <button className="image-preview-remove" onClick={() => removeImage(i)} title={t('message.remove')}>
                  <X width={12} height={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {pendingContextFiles.length > 0 && (
          <div className="file-context-strip">
            {pendingContextFiles.map((file) => (
              <div key={file.relativePath} className="file-context-chip" title={file.displayPath}>
                <File width={14} height={14} />
                <span>{file.relativePath}</span>
                <button
                  type="button"
                  className="file-context-remove"
                  onClick={() => removeContextFile(file.relativePath)}
                  title="Remove file context"
                >
                  <X width={12} height={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {queuedMessages.length > 0 && (
          <div className="message-queue-list" aria-label="Queued messages">
            {queuedMessages.map((item, index) => (
              <div key={item.id} className="message-queue-item">
                <span className="message-queue-index">{index + 1}</span>
                <span className="message-queue-text">{item.text || (item.images?.length ? t('app.image') : '')}</span>
                <button
                  type="button"
                  className="message-queue-remove"
                  onClick={() => onRemoveQueuedMessage?.(item.id)}
                  title={t('message.remove')}
                  aria-label={t('message.remove')}
                >
                  <X width={12} height={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="message-input-wrapper">
          {mentionOpen && (
            <div className="file-mention-popover">
              <div className="file-mention-header">
                <span>@ files</span>
                <span>workspace</span>
              </div>
              <div className="file-mention-list">
                {mentionLoading ? (
                  <div className="file-mention-empty">Searching files...</div>
                ) : mentionError ? (
                  <div className="file-mention-empty">{mentionError}</div>
                ) : filteredMentionFiles.length === 0 ? (
                  <div className="file-mention-empty">{agentId ? 'No matching files' : 'Select an agent first'}</div>
                ) : (
                  filteredMentionFiles.map((file, index) => (
                    <button
                      key={file.relativePath}
                      type="button"
                      className={`file-mention-item${index === safeMentionActiveIndex ? ' active' : ''}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectMentionFile(file);
                      }}
                    >
                      <File width={15} height={15} />
                      <span className="file-mention-path">{file.relativePath}</span>
                      <span className="file-mention-size">{formatBytes(file.size)}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={handleImageUpload}
          />
          <button
            className="attach-btn"
            onClick={() => fileInputRef.current?.click()}
            title={t('message.uploadImage')}
            disabled={streaming}
          >
            <Plus width={20} height={20} />
          </button>
          <textarea
            ref={textareaRef}
            className="message-input"
            placeholder={t('message.placeholder')}
            value={input}
            onChange={handleInputChange}
            onFocus={handleInputFocus}
            onPointerUp={handleInputPointerUp}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <button
            className="send-btn"
            onClick={streaming ? onStopStreaming : handleSend}
            disabled={!streaming && !input.trim() && pendingImages.length === 0 && pendingContextFiles.length === 0}
            title={streaming ? t('message.stop') : t('message.send')}
          >
            {streaming ? (
              <Stop width={20} height={20} />
            ) : (
              <Send width={20} height={20} />
            )}
          </button>
        </div>
        <div className="message-input-hint">
          <span>{t('message.inputHint', { modifier: /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl' })}</span>
          <div className="hint-right">
            {agents.filter((a) => a.status === 'connected').length > 0 && (() => {
              const connectedAgents = agents.filter((a) => a.status === 'connected');
              const isE2b = connectedAgents.some((a) => a.isE2b && a.url === selectedAgentUrl);
              const e2bAgent = connectedAgents.find((a) => a.isE2b && a.url === selectedAgentUrl);
              return (
                <span className={`sandbox-badge${isE2b ? ' e2b' : ''}`}>
                  <div className="sandbox-badge-tooltip">
                    {isE2b && e2bAgent?.sandboxId
                      ? `E2B Cloud — ${e2bAgent.sandboxId}`
                      : selectedAgentUrl || t('message.noSandboxSelected')}
                  </div>
                  {isE2b ? (
                    <Cloud width={14} height={14} />
                  ) : (
                    <Plug width={14} height={14} />
                  )}
                  <select
                    className="sandbox-select-inline"
                    value={selectedAgentUrl || ''}
                    onChange={(e) => onSelectAgent(e.target.value || null)}
                  >
                    <option value="">{t('message.noSandboxSelected')}</option>
                    {connectedAgents.map((a) => (
                      <option key={a.url} value={a.url}>{a.name}</option>
                    ))}
                  </select>
                </span>
              );
            })()}
            <ContextBudget messages={messages} llmConfig={llmConfig} />
          </div>
        </div>
      </div>
    </div>
  );
});

MessagePanel.displayName = 'MessagePanel';

export default MessagePanel;
