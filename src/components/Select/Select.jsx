import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from '../Icons/Icons';
import { readSelectOptions } from './selectOptions';
import './Select.css';

const POPUP_GAP = 4;
const POPUP_MAX_HEIGHT = 280;
const TYPEAHEAD_RESET_MS = 500;
const TYPEAHEAD_MAX_BUFFER = 12;

/**
 * Theme-aware drop-in replacement for the native <select>.
 *
 * Renders <option> children into a custom themed listbox (portal at body level
 * so it never gets clipped by scroll containers) while keeping familiar
 * semantics: value/onChange(value), disabled options, optgroup labels,
 * keyboard navigation (arrows / Home / End / type-ahead / Enter / Esc).
 *
 * Props beyond the native subset:
 *  - renderValue(option) → custom trigger content (defaults to option label)
 *  - showChevron: set false for inline/bare usages (default true)
 */
export default function Select({
  value,
  onChange,
  children,
  disabled = false,
  className = '',
  title,
  ariaLabel,
  renderValue,
  showChevron = true,
}) {
  const reactId = useId().replace(/[^a-zA-Z0-9-]/g, '');
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const listRef = useRef(null);
  const typeaheadRef = useRef({ buffer: '', at: 0 });
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [popupStyle, setPopupStyle] = useState(null);

  const options = useMemo(() => readSelectOptions(children), [children]);
  const selectedOption = useMemo(
    () => options.find((option) => String(option.value) === String(value ?? '')) || null,
    [options, value],
  );

  const enabledIndexes = useMemo(
    () => options.reduce((acc, option, index) => {
      if (!option.disabled) acc.push(index);
      return acc;
    }, []),
    [options],
  );

  const closePopup = useCallback((refocusTrigger) => {
    setOpen(false);
    setActiveIndex(-1);
    typeaheadRef.current = { buffer: '', at: 0 };
    if (refocusTrigger) triggerRef.current?.focus();
  }, []);

  const commitIndex = useCallback((index) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange?.(option.value);
    closePopup(true);
  }, [options, onChange, closePopup]);

  const openPopup = useCallback(() => {
    if (disabled || !options.length) return;
    const selectedIndex = options.indexOf(selectedOption);
    const fallback = enabledIndexes.find((index) => index >= selectedIndex) ?? enabledIndexes[0] ?? 0;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : fallback);
    setOpen(true);
  }, [disabled, options, selectedOption, enabledIndexes]);

  /* ── Popup positioning (fixed, portal-level, follows the trigger) ── */
  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const estimated = Math.min(POPUP_MAX_HEIGHT, Math.max(options.length * 32 + 12, 48));
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < Math.min(estimated, 160) && rect.top > spaceBelow;
    setPopupStyle({
      left: `${Math.round(rect.left)}px`,
      minWidth: `${Math.round(rect.width)}px`,
      maxHeight: `${POPUP_MAX_HEIGHT}px`,
      ...(openUp
        ? { bottom: `${Math.round(window.innerHeight - rect.top + POPUP_GAP)}px` }
        : { top: `${Math.round(rect.bottom + POPUP_GAP)}px` }),
    });
  }, [options.length]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    listRef.current?.focus({ preventScroll: true });
  }, [open, updatePosition]);

  // Keep the popup inside the viewport horizontally once it has real content.
  useLayoutEffect(() => {
    if (!open || !popupStyle || !listRef.current) return;
    const popupRect = listRef.current.getBoundingClientRect();
    const overflowRight = popupRect.right - (window.innerWidth - 8);
    if (overflowRight > 0) {
      listRef.current.style.left = `${Math.max(8, popupRect.left - overflowRight)}px`;
    }
  }, [open, popupStyle]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => updatePosition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, updatePosition]);

  // Close on outside pointerdown (the popup lives in a portal, so both the
  // trigger root and the list itself must count as "inside").
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event) => {
      const target = event.target;
      if (rootRef.current?.contains(target) || listRef.current?.contains(target)) return;
      closePopup(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, closePopup]);

  // Scroll the active option into view whenever it moves.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const node = listRef.current?.querySelector(`[data-option-index="${activeIndex}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const moveActive = useCallback((step) => {
    if (!enabledIndexes.length) return;
    setActiveIndex((current) => {
      const pos = enabledIndexes.indexOf(current);
      const next = pos === -1
        ? (step > 0 ? 0 : enabledIndexes.length - 1)
        : (pos + step + enabledIndexes.length) % enabledIndexes.length;
      return enabledIndexes[next];
    });
  }, [enabledIndexes]);

  const handleTypeahead = useCallback((char) => {
    const now = Date.now();
    const state = typeaheadRef.current;
    const lower = char.toLowerCase();
    const buffer = now - state.at > TYPEAHEAD_RESET_MS
      ? lower
      : `${state.buffer}${lower}`.slice(-TYPEAHEAD_MAX_BUFFER);
    typeaheadRef.current = { buffer, at: now };
    const matches = (option) => !option.disabled && option.text.toLowerCase().startsWith(buffer);
    const from = activeIndex >= 0 ? activeIndex : 0;
    const forward = options.findIndex((option, index) => index >= from && matches(option));
    if (forward >= 0) {
      setActiveIndex(forward);
      return;
    }
    const wrap = options.findIndex((option, index) => index < from && matches(option));
    if (wrap >= 0) setActiveIndex(wrap);
  }, [options, activeIndex]);

  const handleListKeyDown = (event) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        break;
      case 'Home':
        event.preventDefault();
        if (enabledIndexes.length) setActiveIndex(enabledIndexes[0]);
        break;
      case 'End':
        event.preventDefault();
        if (enabledIndexes.length) setActiveIndex(enabledIndexes[enabledIndexes.length - 1]);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        commitIndex(activeIndex);
        break;
      case 'Escape':
        event.preventDefault();
        closePopup(true);
        break;
      case 'Tab':
        closePopup(false);
        break;
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          handleTypeahead(event.key);
        }
    }
  };

  const handleTriggerKeyDown = (event) => {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter') {
      event.preventDefault();
      if (!open) openPopup();
    }
  };

  const optionId = (index) => `cherry-select-${reactId}-opt-${index}`;
  const activeId = activeIndex >= 0 ? optionId(activeIndex) : undefined;
  const listId = `cherry-select-${reactId}-list`;

  return (
    <div ref={rootRef} className={`cherry-select${className ? ` ${className}` : ''}`} data-open={open}>
      <button
        ref={triggerRef}
        type="button"
        className="cherry-select-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={() => (open ? closePopup(false) : openPopup())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="cherry-select-value">
          {renderValue
            ? renderValue(selectedOption)
            : (selectedOption ? selectedOption.content : null)}
        </span>
        {showChevron && (
          <ChevronDown width={12} height={12} className="cherry-select-chevron" aria-hidden="true" />
        )}
      </button>
      {open && popupStyle && createPortal(
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          className="cherry-select-popup"
          style={popupStyle}
          aria-activedescendant={activeId}
          aria-label={ariaLabel || title}
          onKeyDown={handleListKeyDown}
          onMouseDown={(event) => event.preventDefault()}
        >
          {options.map((option, index) => {
            const previousGroup = index > 0 ? options[index - 1].group : null;
            const groupHeader = option.group && option.group !== previousGroup ? option.group : null;
            return (
              <span key={option.key} className="cherry-select-entry">
                {groupHeader !== null && <span className="cherry-select-group" aria-hidden="true">{groupHeader}</span>}
                <span
                  id={optionId(index)}
                  role="option"
                  aria-selected={option === selectedOption}
                  aria-disabled={option.disabled || undefined}
                  data-option-index={index}
                  className={[
                    'cherry-select-option',
                    option === selectedOption ? 'selected' : '',
                    index === activeIndex ? 'active' : '',
                    option.disabled ? 'disabled' : '',
                  ].filter(Boolean).join(' ')}
                  onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                  onClick={() => commitIndex(index)}
                >
                  <span className="cherry-select-option-label">{option.content}</span>
                  {option === selectedOption && (
                    <Check width={13} height={13} className="cherry-select-check" aria-hidden="true" />
                  )}
                </span>
              </span>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
