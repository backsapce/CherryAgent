import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n/context';
import { ChevronDown, ChevronUp, Download, Eye, Spinner, X } from '../Icons/Icons';
import { ensureImageBlobType } from '../FileManage/imagePreviewUtils';
import './ImagePreview.css';

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
  const imageUrl = sourceUrl || loadedImageUrl;

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
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (hasPrevious) onPrevious();
      } else if (event.key === 'ArrowDown') {
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
    <div className="image-preview-overlay" role="dialog" aria-modal="true" aria-label={`${t('filemanage.preview')}: ${fileName}`} onClick={onClose}>
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
        <div className="image-preview-content">
          {!imageUrl && !error && (
            <div className="image-preview-status">
              <Spinner width={28} height={28} />
              <span>{t('filemanage.loadingPreview')}</span>
            </div>
          )}
          {error && <div className="image-preview-status error">{t('filemanage.previewImageError')}</div>}
          {imageUrl && !error && (
            <img src={imageUrl} alt={fileName} onClick={(event) => event.stopPropagation()} onError={() => setError(true)} />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ImagePreview;
