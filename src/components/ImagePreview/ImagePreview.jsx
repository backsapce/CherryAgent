import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n/context';
import { Check, ChevronDown, ChevronUp, Copy, Download, Eye, Sparkles, Spinner, X } from '../Icons/Icons';
import { ensureImageBlobType } from '../FileManage/imagePreviewUtils';
import { buildAiInfoFields, parseAiImageMeta } from './aiImageMeta';
import { resolveImageSwipe } from './swipeNavigation';
import './ImagePreview.css';

const SWIPE_AXIS_LOCK_DISTANCE = 8;
const SWIPE_EDGE_RESISTANCE = 0.22;
const MAX_SWIPE_OFFSET = 160;
const SWIPE_CLICK_SUPPRESSION_MS = 400;
const OVERLAY_DRAG_TOLERANCE_PX = 4;
const AI_COPY_RESET_MS = 1600;

const ImagePreview = ({
  fileName,
  filePath,
  loadBlob,
  sourceUrl = '',
  downloadName = '',
  position,
  total,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  onClose,
  showAiInfo = false,
  onAiInfoVisibilityChange,
}) => {
  const { t } = useI18n();
  const [loadedImageUrl, setLoadedImageUrl] = useState('');
  const [error, setError] = useState(false);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const [aiMeta, setAiMeta] = useState(null);
  const [naturalSize, setNaturalSize] = useState(null);
  const [copiedAiFieldKey, setCopiedAiFieldKey] = useState(null);
  const swipeGestureRef = useRef(null);
  const suppressOverlayClickUntilRef = useRef(0);
  const overlayMouseDownRef = useRef(null);
  const copiedAiFieldTimerRef = useRef(null);
  const imageUrl = sourceUrl || loadedImageUrl;
  const aiInfoFields = useMemo(() => buildAiInfoFields(aiMeta, naturalSize, t), [aiMeta, naturalSize, t]);
  const hasAiInfo = aiInfoFields.length > 0;
  const setAiInfoVisible = (visible) => onAiInfoVisibilityChange?.(visible);

  const resetSwipe = () => {
    swipeGestureRef.current = null;
    setSwipeOffset(0);
    setIsSwiping(false);
  };

  const handleTouchStart = (event) => {
    if (total <= 1 || event.touches.length !== 1) return;
    const touch = event.touches[0];
    suppressOverlayClickUntilRef.current = 0;
    swipeGestureRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      deltaX: 0,
      deltaY: 0,
      axis: null,
    };
    setIsSwiping(true);
  };

  const handleTouchMove = (event) => {
    const gesture = swipeGestureRef.current;
    if (!gesture || event.touches.length !== 1) return;

    const touch = event.touches[0];
    gesture.deltaX = touch.clientX - gesture.startX;
    gesture.deltaY = touch.clientY - gesture.startY;

    if (!gesture.axis) {
      const distance = Math.max(Math.abs(gesture.deltaX), Math.abs(gesture.deltaY));
      if (distance < SWIPE_AXIS_LOCK_DISTANCE) return;
      gesture.axis = Math.abs(gesture.deltaX) > Math.abs(gesture.deltaY) ? 'horizontal' : 'vertical';
    }

    if (gesture.axis !== 'horizontal') {
      setIsSwiping(false);
      return;
    }

    suppressOverlayClickUntilRef.current = Date.now() + SWIPE_CLICK_SUPPRESSION_MS;
    const canNavigate = gesture.deltaX > 0 ? hasPrevious : hasNext;
    const resistedOffset = gesture.deltaX * (canNavigate ? 1 : SWIPE_EDGE_RESISTANCE);
    setSwipeOffset(Math.max(-MAX_SWIPE_OFFSET, Math.min(MAX_SWIPE_OFFSET, resistedOffset)));
  };

  const handleTouchEnd = () => {
    const gesture = swipeGestureRef.current;
    if (!gesture) return;

    const direction = gesture.axis === 'horizontal'
      ? resolveImageSwipe({
        deltaX: gesture.deltaX,
        deltaY: gesture.deltaY,
        hasPrevious,
        hasNext,
      })
      : 0;

    resetSwipe();
    if (direction < 0) onPrevious();
    if (direction > 0) onNext();
  };

  const handleOverlayMouseDown = (event) => {
    overlayMouseDownRef.current = { x: event.clientX, y: event.clientY };
  };

  const handleOverlayClick = (event) => {
    if (Date.now() < suppressOverlayClickUntilRef.current) {
      event.preventDefault();
      return;
    }
    // A click that landed here after a drag selected panel text (or moved at
    // all) must not close the preview — otherwise selecting a prompt dismisses it.
    const start = overlayMouseDownRef.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > OVERLAY_DRAG_TOLERANCE_PX) return;
    if (typeof window.getSelection === 'function' && String(window.getSelection())) return;
    onClose();
  };

  const copyAiField = (field) => {
    navigator.clipboard?.writeText(field.value).then(() => {
      setCopiedAiFieldKey(field.key);
      if (copiedAiFieldTimerRef.current) clearTimeout(copiedAiFieldTimerRef.current);
      copiedAiFieldTimerRef.current = setTimeout(() => setCopiedAiFieldKey(null), AI_COPY_RESET_MS);
    }).catch(() => {});
  };

  useEffect(() => () => {
    if (copiedAiFieldTimerRef.current) clearTimeout(copiedAiFieldTimerRef.current);
  }, []);

  useEffect(() => {
    if (sourceUrl || !loadBlob) return undefined;

    let disposed = false;
    let objectUrl = '';
    loadBlob(fileName, filePath)
      .then((blob) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(ensureImageBlobType(blob, fileName));
        setLoadedImageUrl(objectUrl);
      })
      .catch(() => {
        if (!disposed) setError(true);
      });

    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileName, filePath, loadBlob, sourceUrl]);

  useEffect(() => {
    let disposed = false;
    if (!imageUrl) return undefined;

    (async () => {
      let meta = null;
      try {
        const buffer = await (await fetch(imageUrl)).arrayBuffer();
        meta = await parseAiImageMeta(buffer);
      } catch {
        // Metadata is optional; leave the button hidden when it can't be read.
      }
      if (!disposed) setAiMeta(meta);
    })();

    return () => {
      disposed = true;
    };
  }, [imageUrl]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (showAiInfo) {
          onAiInfoVisibilityChange?.(false);
        } else {
          onClose();
        }
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        event.preventDefault();
        if (hasPrevious) onPrevious();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        event.preventDefault();
        if (hasNext) onNext();
      }
    };

    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [hasNext, hasPrevious, onClose, onAiInfoVisibilityChange, onNext, onPrevious, showAiInfo]);

  return createPortal(
    <div
      className="image-preview-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`${t('filemanage.preview')}: ${fileName}`}
      onMouseDown={handleOverlayMouseDown}
      onClick={handleOverlayClick}
    >
      <div className="image-preview-modal">
        <div className="image-preview-header" onClick={(event) => event.stopPropagation()}>
          <div className="image-preview-title">
            <Eye width={20} height={20} />
            <span title={fileName}>{fileName}</span>
          </div>
          <div className="image-preview-navigation">
            <button className="image-preview-nav-btn" type="button" onClick={onPrevious} disabled={!hasPrevious} title={`${t('filemanage.previousImage')} (↑)`} aria-label={t('filemanage.previousImage')}>
              <ChevronUp width={20} height={20} />
            </button>
            <span className="image-preview-position">{position} / {total}</span>
            <button className="image-preview-nav-btn" type="button" onClick={onNext} disabled={!hasNext} title={`${t('filemanage.nextImage')} (↓)`} aria-label={t('filemanage.nextImage')}>
              <ChevronDown width={20} height={20} />
            </button>
          </div>
          <div className="image-preview-actions">
            {hasAiInfo && (
              <button
                className={`image-preview-ai-toggle${showAiInfo ? ' active' : ''}`}
                type="button"
                onClick={() => setAiInfoVisible(!showAiInfo)}
                title={t('filemanage.aiInfo')}
                aria-label={t('filemanage.aiInfo')}
                aria-pressed={showAiInfo}
              >
                <Sparkles width={20} height={20} />
              </button>
            )}
            {downloadName && imageUrl && (
              <a className="image-preview-download" href={imageUrl} download={downloadName} title={t('filemanage.download')} aria-label={t('filemanage.download')}>
                <Download width={20} height={20} />
              </a>
            )}
            <button className="image-preview-close" type="button" onClick={onClose} title={t('filemanage.close')} autoFocus>
              <X width={20} height={20} />
            </button>
          </div>
        </div>
        <div
          className={`image-preview-content${isSwiping ? ' swiping' : ''}`}
          style={{ '--image-preview-swipe-offset': `${swipeOffset}px` }}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={resetSwipe}
        >
          {!imageUrl && !error && (
            <div className="image-preview-status">
              <Spinner width={28} height={28} />
              <span>{t('filemanage.loadingPreview')}</span>
            </div>
          )}
          {error && <div className="image-preview-status error">{t('filemanage.previewImageError')}</div>}
          {imageUrl && !error && (
            <img
              src={imageUrl}
              alt={fileName}
              draggable="false"
              onClick={(event) => event.stopPropagation()}
              onLoad={(event) => setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              onError={() => setError(true)}
            />
          )}
        </div>
      </div>
      {hasAiInfo && showAiInfo && (
        <aside className="image-preview-ai-panel" aria-label={t('filemanage.aiInfo')} onClick={(event) => event.stopPropagation()}>
          <div className="image-preview-ai-panel-header">
            <Sparkles width={16} height={16} />
            <span className="image-preview-ai-source">{aiMeta.sourceLabel}</span>
            <button className="image-preview-ai-close" type="button" onClick={() => setAiInfoVisible(false)} title={t('filemanage.close')} aria-label={t('filemanage.close')}>
              <X width={16} height={16} />
            </button>
          </div>
          <div className="image-preview-ai-fields">
            {aiInfoFields.map((field) => (
              <div key={field.key} className="image-preview-ai-field">
                <div className="image-preview-ai-field-label">{field.label}</div>
                {field.multiline ? (
                  <div className="image-preview-ai-value-wrap">
                    <div className="image-preview-ai-field-value multiline">{field.value}</div>
                    <button
                      className={`image-preview-ai-copy${copiedAiFieldKey === field.key ? ' copied' : ''}`}
                      type="button"
                      onClick={() => copyAiField(field)}
                      title={copiedAiFieldKey === field.key ? t('filemanage.copied') : t('filemanage.copy')}
                      aria-label={copiedAiFieldKey === field.key ? t('filemanage.copied') : t('filemanage.copy')}
                    >
                      {copiedAiFieldKey === field.key ? <Check width={14} height={14} /> : <Copy width={14} height={14} />}
                    </button>
                  </div>
                ) : (
                  <div className="image-preview-ai-field-value">{field.value}</div>
                )}
              </div>
            ))}
          </div>
        </aside>
      )}
    </div>,
    document.body
  );
};

export default ImagePreview;
