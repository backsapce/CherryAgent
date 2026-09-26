import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import config from '../../config/config';
import { useI18n } from '../../i18n/context';
import { Check, ChevronRight } from '../Icons/Icons';

export default function SessionSortMenu({ sortBy }) {
  const { t } = useI18n();
  const [position, setPosition] = useState(null);
  const [sortOpen, setSortOpen] = useState(false);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const sortRef = useRef(null);

  useEffect(() => {
    if (!position) return;
    const dismiss = (event) => {
      if (!menuRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) {
        setPosition(null);
      }
    };
    const close = () => setPosition(null);
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', close);
    sortRef.current?.focus();
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', close);
    };
  }, [position]);

  const selectSort = async (value) => {
    try {
      await config.set('general.sessionSortBy', value);
      setPosition(null);
      triggerRef.current?.focus();
    } catch (error) {
      console.error('Failed to save session sorting:', error);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="session-menu-trigger"
        title={t('session.menu')}
        aria-label={t('session.menu')}
        aria-expanded={Boolean(position)}
        onClick={() => {
          const rect = triggerRef.current.getBoundingClientRect();
          setSortOpen(false);
          setPosition(position ? null : {
            top: rect.bottom + 6,
            left: Math.max(8, Math.min(rect.left, window.innerWidth - 320)),
          });
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {position && createPortal(
        <div
          ref={menuRef}
          className="session-sort-menu"
          style={position}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setPosition(null);
              triggerRef.current?.focus();
            }
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setPosition(null);
          }}
        >
          <div onMouseEnter={() => setSortOpen(true)} onMouseLeave={() => {
            if (!menuRef.current?.contains(document.activeElement) || document.activeElement === sortRef.current) setSortOpen(false);
          }}>
            <button
              ref={sortRef}
              type="button"
              className="session-sort-item"
              aria-expanded={sortOpen}
              onClick={() => setSortOpen(!sortOpen)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight') {
                  event.preventDefault();
                  setSortOpen(true);
                }
              }}
            >
              {t('session.sort')}
              <ChevronRight width={14} height={14} />
            </button>
            {sortOpen && (
              <div className="session-sort-submenu" role="group" aria-label={t('session.sort')}>
                {['updatedAt', 'createdAt'].map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="session-sort-item"
                    aria-pressed={sortBy === value}
                    onClick={() => selectSort(value)}
                  >
                    {t(value === 'updatedAt' ? 'session.sortUpdatedAt' : 'session.sortCreatedAt')}
                    <span className="session-sort-check">{sortBy === value && <Check width={14} height={14} />}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>, document.body,
      )}
    </>
  );
}
