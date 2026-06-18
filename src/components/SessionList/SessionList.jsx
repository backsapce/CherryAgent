import { useState, useCallback, useEffect, useRef } from 'react';
import { useI18n } from '../../i18n/context';
import { Plus, X, Menu, ChevronLeft, ChevronRight, Bug } from '../Icons/Icons';
import './SessionList.css';

// Breakpoint for mobile/tablet
const MOBILE_BREAKPOINT = 768;

const SessionList = ({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onExportDebug,
  debugExportDisabled = false,
  collapsed = false,
  onToggleCollapse,
  sessionAgents = {},
  agentList = [],
}) => {
  const { t } = useI18n();
  const [width, setWidth] = useState(280);
  const [isResizing, setIsResizing] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const panelRef = useRef(null);

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

  const handleNewSession = useCallback(() => {
    if (isMobile) {
      setMobileOpen(false);
    }
    onNewSession();
  }, [isMobile, onNewSession]);

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

  // Global mouse event listeners for resizing
  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

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
            <button className="new-session-btn" onClick={handleNewSession} title={t('session.newSession')}>
              <Plus width={20} height={20} />
            </button>
          </div>
          <div className="session-list-items">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={`session-item ${session.id === activeSessionId ? 'active' : ''}`}
                onClick={() => handleSelectSession(session.id)}
              >
                <div className="session-item-row">
                  <div className="session-item-title">
                    {session.title}
                    {sessionAgents[session.id] && (
                      <span className="session-agent-badge">
                        {(() => {
                          const agent = agentList.find((a) => a.id === sessionAgents[session.id]);
                          return agent ? agent.name : sessionAgents[session.id];
                        })()}
                      </span>
                    )}
                  </div>
                  <button
                    className="session-item-delete"
                    title={t('session.deleteSession')}
                    aria-label={t('session.deleteSession')}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteSession(session.id);
                    }}
                  >
                    <X width={14} height={14} />
                  </button>
                </div>
                <div className="session-item-preview">{session.lastMessage || t('session.noMessages')}</div>
                <div className="session-item-time">{session.updatedAt}</div>
              </div>
            ))}
            {sessions.length === 0 && (
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
    </>
  );
};

export default SessionList;
