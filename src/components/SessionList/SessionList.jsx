import { useState, useCallback, useEffect, useRef, useMemo, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n/context';
import { Plus, X, Menu, ChevronLeft, ChevronRight, ChevronDown, Bug, Clock, Folder, Check } from '../Icons/Icons';
import {
  formatWakeupCountdown,
  getNextScheduledWakeup,
  hasScheduledWakeup,
} from './wakeupCountdown';
import config from '../../config/config';
import { sortSessions } from '../../sessionRefresh';
import {
  DEFAULT_FOLDER_ID,
  DEFAULT_FOLDER_NAME,
  FOLDER_PAGE_SIZE,
  groupSessionsByFolder,
  sessionFolderKey,
  sortSessionFolders,
} from '../../sessionFolders';
import SessionSortMenu from './SessionSortMenu';
import './SessionList.css';

const getSessionSort = () => config.get('general.sessionSortBy') === 'createdAt' ? 'createdAt' : 'updatedAt';

// Collapsed folder ids persist in config as an array. config.get() returns a
// fresh clone per call, so the external-store snapshot is the joined string.
const COLLAPSED_FOLDERS_KEY = 'general.sessionFoldersCollapsed';

const getCollapsedFoldersSnapshot = () => {
  const value = config.get(COLLAPSED_FOLDERS_KEY);
  return Array.isArray(value)
    ? value.filter((id) => typeof id === 'string' && id).join('\n')
    : '';
};

// Breakpoint for mobile/tablet
const MOBILE_BREAKPOINT = 768;

// Drag-and-drop payload type for moving a session between folders.
const SESSION_DRAG_MIME = 'application/x-cherry-session';

const WakeupCancelButton = ({ sessionId, wakeup, onCancelWakeup }) => {
  const { t } = useI18n();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const runAtMs = wakeup?.runAtMs;

  useEffect(() => {
    if (!Number.isFinite(runAtMs)) return undefined;
    const timerId = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timerId);
  }, [runAtMs]);

  const countdown = formatWakeupCountdown(runAtMs, nowMs);
  const label = countdown
    ? `${t('session.cancelWakeup')} · ${countdown}`
    : t('session.cancelWakeup');

  return (
    <button
      type="button"
      className="session-wakeup-cancel"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onCancelWakeup?.(sessionId);
      }}
    >
      <span className="session-wakeup-icon" aria-hidden="true">
        <Clock width={14} height={14} />
        <X
          width={8}
          height={8}
          className="session-wakeup-cancel-x"
        />
      </span>
      {countdown && (
        <span className="session-wakeup-countdown" role="timer" aria-live="off">
          {countdown}
        </span>
      )}
    </button>
  );
};

const SessionWakeupControl = ({ session, onCancelWakeup }) => {
  const wakeup = getNextScheduledWakeup(session);

  return (
    <WakeupCancelButton
      key={`${wakeup?.id || 'wakeup'}:${wakeup?.runAtMs ?? 'pending'}`}
      sessionId={session.id}
      wakeup={wakeup}
      onCancelWakeup={onCancelWakeup}
    />
  );
};

const SessionItem = ({
  session,
  active,
  agentBadge,
  running,
  onSelect,
  onDelete,
  onCancelWakeup,
  onDragStart,
  onDragEnd,
  onOpenMenu,
  menuOpen,
  dragging,
}) => {
  const { t } = useI18n();

  return (
    <div
      className={`session-item ${active ? 'active' : ''} ${dragging ? 'dragging' : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => onSelect(session.id)}
    >
      <div className="session-item-row">
        <div className="session-item-title">
          {running && (
            <span
              className="session-running-indicator"
              title={t('message.running')}
              aria-label={t('message.running')}
            />
          )}
          {hasScheduledWakeup(session) && (
            <SessionWakeupControl
              session={session}
              onCancelWakeup={onCancelWakeup}
            />
          )}
          {session.title}
          {agentBadge && <span className="session-agent-badge">{agentBadge}</span>}
        </div>
        <button
          className="session-item-menu"
          title={t('session.moveToFolder')}
          aria-label={`${t('session.moveToFolder')}: ${session.title}`}
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation();
            onOpenMenu(e, session);
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="19" cy="12" r="1.8" />
          </svg>
        </button>
        <button
          className="session-item-delete"
          title={t('session.deleteSession')}
          aria-label={t('session.deleteSession')}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(session.id);
          }}
        >
          <X width={14} height={14} />
        </button>
      </div>
      <div className="session-item-preview">{session.lastMessage || t('session.noMessages')}</div>
      <div className="session-item-time">{session.updatedAt}</div>
    </div>
  );
};

// Contextual menu for one folder row (rename). Rendered in a portal like the
// header sort menu so it can overlay the scrollable session list.
const FolderMenu = ({ folder, position, onClose, onRename }) => {
  const { t } = useI18n();
  const menuRef = useRef(null);

  useEffect(() => {
    const dismiss = (event) => {
      // Trigger clicks are excluded so the trigger's own onClick can toggle
      // the menu closed instead of racing this dismissal into a reopen.
      if (
        !menuRef.current?.contains(event.target)
        && !event.target.closest?.('.session-folder-menu-trigger')
      ) onClose(event);
    };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', onClose);
    menuRef.current?.focus();
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="session-sort-menu session-folder-menu"
      style={position}
      role="menu"
      aria-label={folder.name}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onClose();
      }}
    >
      <button
        type="button"
        className="session-sort-item"
        role="menuitem"
        onClick={onRename}
      >
        {t('session.renameFolder')}
      </button>
    </div>, document.body,
  );
};

// Contextual menu for one session row: move it to another folder. This is the
// touch-friendly counterpart of dragging a session onto a folder header.
const SessionFolderMenu = ({ session, folders, position, onClose, onMove }) => {
  const { t } = useI18n();
  const menuRef = useRef(null);

  useEffect(() => {
    const dismiss = (event) => {
      if (
        !menuRef.current?.contains(event.target)
        && !event.target.closest?.('.session-item-menu')
      ) onClose(event);
    };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', onClose);
    menuRef.current?.focus();
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const currentKey = sessionFolderKey(session);
  const targetFolders = [
    { id: DEFAULT_FOLDER_ID, name: DEFAULT_FOLDER_NAME },
    ...sortSessionFolders(folders),
  ];

  return createPortal(
    <div
      ref={menuRef}
      className="session-sort-menu session-move-menu"
      style={position}
      role="menu"
      aria-label={t('session.moveToFolder')}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onClose();
      }}
    >
      <div className="session-move-menu-title">{t('session.moveToFolder')}</div>
      <div className="session-move-menu-list" role="group">
        {targetFolders.map((folder) => (
          <button
            key={folder.id}
            type="button"
            className="session-sort-item"
            role="menuitem"
            aria-current={currentKey === folder.id || undefined}
            onClick={() => onMove(folder.id)}
          >
            <span className="session-move-menu-name">{folder.name}</span>
            <span className="session-sort-check">
              {currentKey === folder.id && <Check width={14} height={14} />}
            </span>
          </button>
        ))}
      </div>
    </div>, document.body,
  );
};

const SessionList = ({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onCancelWakeup,
  onExportDebug,
  debugExportDisabled = false,
  collapsed = false,
  onToggleCollapse,
  sessionAgents = {},
  agentList = [],
  runningSessionIds = new Set(),
  folders = [],
  onAddFolder,
  onRenameFolder,
  onMoveSessionToFolder,
}) => {
  const { t } = useI18n();
  const sortBy = useSyncExternalStore(config.subscribe, getSessionSort);
  const sortedSessions = useMemo(() => sortSessions(sessions, sortBy), [sessions, sortBy]);
  const folderGroups = useMemo(() => groupSessionsByFolder(sortedSessions, folders), [sortedSessions, folders]);
  const [width, setWidth] = useState(280);
  const [isResizing, setIsResizing] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const panelRef = useRef(null);

  // Inline folder-name editing. The draft lives in a ref so keystrokes never
  // re-render the whole list; commit happens on blur/Enter, revert on Escape.
  const [editingFolderId, setEditingFolderId] = useState(null);
  const editingFolderNameRef = useRef('');
  const folderDraftRef = useRef('');
  const editCancelledRef = useRef(false);
  const folderNameInputRef = useRef(null);

  // Extra sessions revealed past the first page of a folder.
  const [visibleExtra, setVisibleExtra] = useState({});
  // Folder ids whose session list is collapsed (all folders start expanded).
  // The state lives in config so it survives reloads.
  const collapsedFoldersKey = useSyncExternalStore(config.subscribe, getCollapsedFoldersSnapshot);
  const collapsedFolders = useMemo(
    () => new Set(collapsedFoldersKey ? collapsedFoldersKey.split('\n') : []),
    [collapsedFoldersKey],
  );
  // Folder id whose header is currently highlighted as a drag-drop target.
  const [dragOverFolderId, setDragOverFolderId] = useState(null);
  const [draggingSessionId, setDraggingSessionId] = useState(null);
  const [folderMenu, setFolderMenu] = useState(null);
  // Move-to-folder menu for one session row: { session, position }.
  const [sessionMenu, setSessionMenu] = useState(null);

  useEffect(() => {
    if (editingFolderId) {
      folderNameInputRef.current?.focus();
      folderNameInputRef.current?.select();
      folderNameInputRef.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [editingFolderId]);

  // Check screen size
  useEffect(() => {
    const checkScreen = () => {
      const mobile = window.innerWidth <= MOBILE_BREAKPOINT;
      setIsMobile(mobile);
      if (!mobile) {
        setMobileOpen(false);
      }
    };
    checkScreen();
    window.addEventListener('resize', checkScreen);
    return () => window.removeEventListener('resize', checkScreen);
  }, []);

  const handleSelectSession = useCallback((sessionId) => {
    onSelectSession(sessionId);
  }, [onSelectSession]);

  // Declared before handleNewSession, which references expandFolder in its
  // dependency array: a later declaration would be a use-before-initialization
  // ReferenceError during the component's first render.
  const toggleFolder = useCallback((folderId) => {
    const next = new Set(collapsedFolders);
    if (next.has(folderId)) next.delete(folderId);
    else next.add(folderId);
    config.set(COLLAPSED_FOLDERS_KEY, [...next])
      .catch((err) => console.error('Failed to persist folder collapse state:', err));
  }, [collapsedFolders]);

  const expandFolder = useCallback((folderId) => {
    config.set(COLLAPSED_FOLDERS_KEY, [...collapsedFolders].filter((id) => id !== folderId))
      .catch((err) => console.error('Failed to persist folder collapse state:', err));
  }, [collapsedFolders]);

  const handleNewSession = useCallback((folderId = null) => {
    if (isMobile) {
      setMobileOpen(false);
    }
    // A session created inside a collapsed folder should be visible right away.
    if (folderId && collapsedFolders.has(folderId)) expandFolder(folderId);
    onNewSession(folderId);
  }, [isMobile, onNewSession, collapsedFolders, expandFolder]);

  const startFolderEdit = useCallback((folderId, name) => {
    editingFolderNameRef.current = name;
    folderDraftRef.current = name;
    editCancelledRef.current = false;
    setFolderMenu(null);
    setEditingFolderId(folderId);
  }, []);

  const finishFolderEdit = useCallback(() => {
    const folderId = editingFolderId;
    if (!folderId) return;
    setEditingFolderId(null);
    if (editCancelledRef.current) {
      editCancelledRef.current = false;
      return;
    }
    const trimmed = folderDraftRef.current.trim();
    if (trimmed && trimmed !== editingFolderNameRef.current) {
      onRenameFolder?.(folderId, trimmed);
    }
  }, [editingFolderId, onRenameFolder]);

  const handleAddFolder = useCallback(async () => {
    const folder = await onAddFolder?.(t('session.untitledFolder'));
    if (folder) startFolderEdit(folder.id, folder.name);
  }, [onAddFolder, startFolderEdit, t]);

  const handleExportDebug = useCallback(() => {
    onExportDebug?.();
  }, [onExportDebug]);

  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const handleMouseMove = useCallback((e) => {
    if (!isResizing) return;
    const newWidth = e.clientX;
    if (newWidth >= 200 && newWidth <= 600) {
      setWidth(newWidth);
    }
  }, [isResizing]);

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  // Close panel when clicking outside on mobile
  useEffect(() => {
    if (!isMobile || !mobileOpen) return;

    const handleClickOutside = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setMobileOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isMobile, mobileOpen]);

  // Only carry the mousemove cost while a resize drag is active.
  useEffect(() => {
    if (!isResizing) return;
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, handleMouseMove, handleMouseUp]);

  // Toggle mobile panel
  const toggleMobile = useCallback(() => {
    setMobileOpen(prev => !prev);
  }, []);

  // Toggle collapse (PC mode only)
  const handleToggleCollapse = useCallback(() => {
    if (!isMobile && onToggleCollapse) {
      onToggleCollapse();
    }
  }, [isMobile, onToggleCollapse]);

  const handleSessionDragStart = useCallback((event, session) => {
    event.dataTransfer.setData(SESSION_DRAG_MIME, session.id);
    event.dataTransfer.effectAllowed = 'move';
    setDraggingSessionId(session.id);
  }, []);

  const handleSessionDragEnd = useCallback(() => {
    setDraggingSessionId(null);
    setDragOverFolderId(null);
  }, []);

  const handleFolderDragOver = useCallback((event, folderId) => {
    if (![...event.dataTransfer.types].includes(SESSION_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverFolderId(folderId);
  }, []);

  const handleFolderDragLeave = useCallback((event, folderId) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setDragOverFolderId((prev) => (prev === folderId ? null : prev));
  }, []);

  const handleFolderDrop = useCallback((event, folderId) => {
    if (![...event.dataTransfer.types].includes(SESSION_DRAG_MIME)) return;
    event.preventDefault();
    setDragOverFolderId(null);
    setDraggingSessionId(null);
    const sessionId = event.dataTransfer.getData(SESSION_DRAG_MIME);
    if (sessionId) onMoveSessionToFolder?.(sessionId, folderId);
  }, [onMoveSessionToFolder]);

  const showMore = useCallback((folderId) => {
    setVisibleExtra((prev) => ({ ...prev, [folderId]: (prev[folderId] || 0) + FOLDER_PAGE_SIZE }));
  }, []);

  const openFolderMenu = useCallback((event, folder) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setFolderMenu({
      folder,
      position: {
        top: Math.min(rect.bottom + 6, window.innerHeight - 60),
        left: Math.max(8, Math.min(rect.right - 148, window.innerWidth - 156)),
      },
    });
  }, []);

  const openSessionMenu = useCallback((event, session) => {
    if (sessionMenu?.session?.id === session.id) {
      setSessionMenu(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setSessionMenu({
      session,
      position: {
        top: Math.min(rect.bottom + 6, window.innerHeight - 80),
        left: Math.max(8, Math.min(rect.right - 170, window.innerWidth - 178)),
      },
    });
  }, [sessionMenu]);

  return (
    <>
      {/* Toggle button - visible only on mobile */}
      <button
        className={`session-list-toggle-btn ${mobileOpen ? 'open' : ''}`}
        onClick={toggleMobile}
        aria-label="Toggle session list"
      >
        <Menu width={20} height={20} />
      </button>

      {/* Backdrop */}
      {isMobile && mobileOpen && (
        <div className="session-list-backdrop show" onClick={() => setMobileOpen(false)} />
      )}

      {/* Session list panel */}
      <div
        ref={panelRef}
        className={`session-list ${isMobile && mobileOpen ? 'mobile-open' : ''} ${!isMobile && collapsed ? 'collapsed' : ''}`}
        style={!isMobile ? { width: collapsed ? 0 : width, minWidth: collapsed ? 0 : width } : {}}
      >
        <div className="session-list-inner">
          <div className="session-list-header">
            <h2>{t('app.name')}</h2>
            <div className="session-header-actions">
              <button className="new-session-btn" onClick={() => handleNewSession()} title={t('session.newSession')}>
                <Plus width={20} height={20} />
              </button>
              <SessionSortMenu sortBy={sortBy} onAddFolder={handleAddFolder} />
            </div>
          </div>
          <div className="session-list-items">
            {folderGroups.map((group) => {
              const isDefaultFolder = !group.folder;
              const isEditing = editingFolderId === group.id;
              const isDropTarget = dragOverFolderId === group.id;
              const isCollapsed = collapsedFolders.has(group.id);
              const extraCount = visibleExtra[group.id] || 0;
              const visibleSessions = group.sessions.slice(0, FOLDER_PAGE_SIZE + extraCount);
              const hiddenCount = group.sessions.length - visibleSessions.length;
              return (
                <div key={group.id} className="session-folder">
                  <div
                    className={[
                      'session-folder-header',
                      isDropTarget ? 'drop-target' : '',
                      isEditing ? 'editing' : '',
                    ].filter(Boolean).join(' ')}
                    onDragOver={(event) => handleFolderDragOver(event, group.id)}
                    onDragLeave={(event) => handleFolderDragLeave(event, group.id)}
                    onDrop={(event) => handleFolderDrop(event, group.id)}
                  >
                    {isEditing ? (
                      <input
                        ref={folderNameInputRef}
                        className="session-folder-name-input"
                        type="text"
                        defaultValue={group.name}
                        maxLength={60}
                        aria-label={t('session.renameFolder')}
                        onChange={(event) => { folderDraftRef.current = event.target.value; }}
                        onBlur={finishFolderEdit}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            event.currentTarget.blur();
                          } else if (event.key === 'Escape') {
                            event.preventDefault();
                            editCancelledRef.current = true;
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          className="session-folder-toggle"
                          title={group.name}
                          aria-expanded={!isCollapsed}
                          onClick={() => toggleFolder(group.id)}
                        >
                          {isCollapsed ? (
                            <ChevronRight className="session-folder-chevron" width={14} height={14} />
                          ) : (
                            <ChevronDown className="session-folder-chevron" width={14} height={14} />
                          )}
                          <Folder className="session-folder-icon" width={15} height={15} />
                          <span className="session-folder-name">{group.name}</span>
                        </button>
                        <span className="session-folder-actions">
                          <button
                            type="button"
                            className="session-folder-add"
                            title={t('session.newSessionHere')}
                            aria-label={`${t('session.newSessionHere')}: ${group.name}`}
                            onClick={() => handleNewSession(group.folder ? group.id : null)}
                          >
                            <Plus width={14} height={14} />
                          </button>
                          {!isDefaultFolder && (
                            <button
                              type="button"
                              className="session-folder-menu-trigger"
                              title={t('session.folderMenu')}
                              aria-label={`${t('session.folderMenu')}: ${group.name}`}
                              aria-expanded={folderMenu?.folder?.id === group.id}
                              onClick={(event) => {
                                event.stopPropagation();
                                if (folderMenu?.folder?.id === group.id) {
                                  setFolderMenu(null);
                                } else {
                                  openFolderMenu(event, group.folder);
                                }
                              }}
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                <circle cx="5" cy="12" r="1.8" />
                                <circle cx="12" cy="12" r="1.8" />
                                <circle cx="19" cy="12" r="1.8" />
                              </svg>
                            </button>
                          )}
                        </span>
                      </>
                    )}
                  </div>
                  {!isCollapsed && (
                    <div className="session-folder-items">
                      {visibleSessions.map((session) => (
                        <SessionItem
                          key={session.id}
                          session={session}
                          active={session.id === activeSessionId}
                          agentBadge={(() => {
                            const agentId = sessionAgents[session.id];
                            if (!agentId) return null;
                            const agent = agentList.find((a) => a.id === agentId);
                            return agent ? agent.name : agentId;
                          })()}
                          running={runningSessionIds.has(session.id)}
                          onSelect={handleSelectSession}
                          onDelete={onDeleteSession}
                          onCancelWakeup={onCancelWakeup}
                          onDragStart={(event) => handleSessionDragStart(event, session)}
                          onDragEnd={handleSessionDragEnd}
                          onOpenMenu={openSessionMenu}
                          menuOpen={sessionMenu?.session?.id === session.id}
                          dragging={draggingSessionId === session.id}
                        />
                      ))}
                      {hiddenCount > 0 && (
                        <button
                          type="button"
                          className="session-folder-more"
                          onClick={() => showMore(group.id)}
                        >
                          {t('session.showMore', { count: Math.min(hiddenCount, FOLDER_PAGE_SIZE) })}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {sessions.length === 0 && folders.length === 0 && (
              <div className="session-list-empty">
                <p>{t('session.noConversations')}</p>
                <p>{t('session.clickToStart')}</p>
              </div>
            )}
          </div>
          <div className="session-list-debug-action">
            <button
              className="session-debug-export-btn"
              onClick={handleExportDebug}
              title={t('session.exportDebug')}
              aria-label={t('session.exportDebug')}
              disabled={!onExportDebug || debugExportDisabled}
            >
              <Bug width={18} height={18} />
            </button>
          </div>
          {!isMobile && !collapsed && (
            <div
              className={`session-list-resize-handle ${isResizing ? 'resizing' : ''}`}
              onMouseDown={handleMouseDown}
            />
          )}
        </div>
        {/* Collapse toggle button - PC mode only, positioned on right border (hidden when collapsed) */}
        {!isMobile && !collapsed && (
          <button
            className="session-list-collapse-btn"
            onClick={handleToggleCollapse}
            aria-label="Collapse session list"
            title="Collapse"
          >
            <ChevronLeft width={14} height={14} />
          </button>
        )}
      </div>
      {folderMenu && (
        <FolderMenu
          folder={folderMenu.folder}
          position={folderMenu.position}
          onClose={() => setFolderMenu(null)}
          onRename={() => startFolderEdit(folderMenu.folder.id, folderMenu.folder.name)}
        />
      )}
      {sessionMenu && (
        <SessionFolderMenu
          session={sessionMenu.session}
          folders={folders}
          position={sessionMenu.position}
          onClose={() => setSessionMenu(null)}
          onMove={(folderId) => {
            onMoveSessionToFolder?.(sessionMenu.session.id, folderId);
            setSessionMenu(null);
          }}
        />
      )}
    </>
  );
};

export default SessionList;
