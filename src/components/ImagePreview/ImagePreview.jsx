import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n/context';
import { ChevronDown, ChevronUp, Download, Eye, Spinner, X } from '../Icons/Icons';
import { ensureImageBlobType } from '../FileManage/imagePreviewUtils';
import { resolveImageSwipe } from './swipeNavigation';
import './ImagePreview.css';

const SWIPE_AXIS_LOCK_DISTANCE = 8;
const SWIPE_EDGE_RESISTANCE = 0.22;
const MAX_SWIPE_OFFSET = 160;
const SWIPE_CLICK_SUPPRESSION_MS = 400;

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
}) => {
  const { t } = useI18n();
  const [loadedImageUrl, setLoadedImageUrl] = useState('');
  const [error, setError] = useState(false);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const swipeGestureRef = useRef(null);
  const suppressOverlayClickUntilRef = useRef(0);
  const imageUrl = sourceUrl || loadedImageUrl;

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

  const handleOverlayClick = (event) => {
    if (Date.now() < suppressOverlayClickUntilRef.current) {
      event.preventDefault();
      return;
    }
    onClose();
  };

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
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
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
  }, [hasNext, hasPrevious, onClose, onNext, onPrevious]);

  return createPortal(
    <div className="image-preview-overlay" role="dialog" aria-modal="true" aria-label={`${t('filemanage.preview')}: ${fileName}`} onClick={handleOverlayClick}>
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
            <img src={imageUrl} alt={fileName} draggable="false" onClick={(event) => event.stopPropagation()} onError={() => setError(true)} />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ImagePreview;
