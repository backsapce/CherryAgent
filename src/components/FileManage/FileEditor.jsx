import { useState, useEffect, useCallback, useMemo } from 'react';
import { useI18n } from '../../i18n/context';
import { readFileContent, saveFileContent } from '../../vfs/opfs';
import { readFileText, writeFile } from '../../models/agent';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { xml } from '@codemirror/lang-xml';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { X, Save, FileEdit } from '../Icons/Icons';
import './FileEditor.css';

// Supported file extensions
const EDITABLE_EXTENSIONS = [
  'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'js', 'jsx', 'ts', 'tsx',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg', 'sql', 'sh', 'bash',
  'zsh', 'py', 'rb', 'php', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs',
  'vue', 'svelte', 'graphql', 'gql', 'toml', 'ini', 'env', 'gitignore',
  'dockerfile', 'makefile', 'cmake', 'r', 'm', 'swift', 'kt', 'kts'
];

const FileEditor = ({ show, onClose, fileName, filePath, fileSource, sandboxUrl, onSave }) => {
  const { t } = useI18n();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [isDirty, setIsDirty] = useState(false);
  const [originalContent, setOriginalContent] = useState('');

  // Check if file is editable based on extension
  const isEditable = useMemo(() => {
    if (!fileName) return false;
    const ext = fileName.split('.').pop().toLowerCase();
    return EDITABLE_EXTENSIONS.includes(ext);
  }, [fileName]);

  // Get language extension for CodeMirror based on file extension
  const getLanguageExtension = useCallback(() => {
    if (!fileName) return [];
    const ext = fileName.split('.').pop().toLowerCase();
    
    switch (ext) {
      case 'js':
      case 'jsx':
      case 'mjs':
      case 'cjs':
        return [javascript({ jsx: true })];
      case 'ts':
      case 'tsx':
        return [javascript({ jsx: true, typescript: true })];
      case 'json':
        return [json()];
      case 'md':
      case 'markdown':
        return [markdown()];
      case 'yaml':
      case 'yml':
        return [yaml()];
      case 'css':
      case 'scss':
      case 'less':
        return [css()];
      case 'html':
      case 'htm':
        return [html()];
      case 'xml':
      case 'svg':
        return [xml()];
      default:
        return [];
    }
  }, [fileName]);

  // Load file content when editor is shown
  useEffect(() => {
    if (show && fileName && isEditable) {
      loadFileContent();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, fileName, filePath, fileSource, sandboxUrl]);

  const loadFileContent = async () => {
    setLoading(true);
    setError(null);

    try {
      let fileContent;

      if (fileSource === 'local') {
        fileContent = await readFileContent(fileName, filePath);
      } else {
        const path = filePath ? `${filePath}/${fileName}` : fileName;
        fileContent = await readFileText(path, sandboxUrl);
      }

      setContent(fileContent || '');
      setOriginalContent(fileContent || '');
      setIsDirty(false);
    } catch (err) {
      console.error('Failed to load file content:', err);
      setError(t('filemanage.loadFileError'));
      setContent('');
      setOriginalContent('');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);

    try {
      if (fileSource === 'local') {
        await saveFileContent(fileName, content, filePath);
      } else {
        const path = filePath ? `${filePath}/${fileName}` : fileName;
        await writeFile(path, content, sandboxUrl);
      }

      setOriginalContent(content);
      setIsDirty(false);

      // Notify parent to refresh file list
      onSave?.();

      // Show success feedback
      const successMsg = document.createElement('div');
      successMsg.className = 'file-save-success';
      successMsg.textContent = t('filemanage.fileSaved');
      document.body.appendChild(successMsg);
      setTimeout(() => {
        successMsg.remove();
      }, 2000);
    } catch (err) {
      console.error('Failed to save file:', err);
      setError(t('filemanage.saveFileError'));
    } finally {
      setSaving(false);
    }
  }, [fileName, filePath, fileSource, sandboxUrl, content, onSave, t]);

  const handleContentChange = useCallback((newContent) => {
    setContent(newContent);
    setIsDirty(newContent !== originalContent);
  }, [originalContent]);

  const handleClose = useCallback(() => {
    if (isDirty) {
      const confirmMsg = t('filemanage.confirmDiscardChanges');
      if (!window.confirm(confirmMsg)) {
        return;
      }
    }
    onClose();
  }, [isDirty, onClose, t]);

  const handleKeyDown = useCallback((e) => {
    // Escape to close
    if (e.key === 'Escape') {
      e.preventDefault();
      handleClose();
      return;
    }
    // Ctrl/Cmd + S to save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (isDirty && !saving) {
        handleSave();
      }
    }
  }, [isDirty, saving, handleSave, handleClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  if (!show || !isEditable) {
    return null;
  }

  return (
    <div className="file-editor-overlay" tabIndex={-1}>
      <div className="file-editor-modal">
        {/* Header */}
        <div className="file-editor-header">
          <div className="file-editor-title">
            <FileEdit width={20} height={20} />
            <span>{fileName}</span>
            {isDirty && <span className="file-dirty-indicator">*</span>}
          </div>
          <div className="file-editor-buttons">
            <button
              className="file-editor-btn save"
              onClick={handleSave}
              disabled={saving || !isDirty}
              title={t('filemanage.save') + ' (Ctrl+S)'}
            >
              <Save width={18} height={18} />
              <span>{saving ? t('filemanage.saving') : t('filemanage.save')}</span>
            </button>
            <button
              className="file-editor-btn close"
              onClick={handleClose}
              title={t('filemanage.close')}
            >
              <X width={18} height={18} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="file-editor-content">
          {loading ? (
            <div className="file-editor-loading">
              <div className="loading-spinner"></div>
              <p>{t('filemanage.loadingFile')}</p>
            </div>
          ) : error ? (
            <div className="file-editor-error">
              <p>{error}</p>
            </div>
          ) : (
            <CodeMirror
              value={content}
              height="100%"
              theme={oneDark}
              extensions={[
                ...getLanguageExtension(),
                EditorView.lineWrapping,
              ]}
              onChange={handleContentChange}
              basicSetup={true}
              className="file-editor-codemirror"
            />
          )}
        </div>

        {/* Footer */}
        <div className="file-editor-footer">
          <span className="file-editor-status">
            {isDirty ? t('filemanage.unsavedChanges') : t('filemanage.saved')}
          </span>
          <span className="file-editor-hint">
            {t('filemanage.saveHint')}
          </span>
        </div>
      </div>
    </div>
  );
};

export default FileEditor;
