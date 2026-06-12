import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useI18n } from '../../i18n/context';
import { loadFiles, saveFile, createFile, createDirectory, deleteFile as deleteLocalFile, getFileBlob } from '../../vfs/opfs';
import { listFiles, createFile as createRemoteFile, deleteFile as deleteRemoteFile, uploadFile as uploadRemoteFile, downloadFile as downloadRemoteFile } from '../../models/agent';
import { ChevronRight, ChevronDown, Folder, File, FilePlus, FolderPlus, Refresh, X, Upload, Cloud, HardDrive, Trash, Download, FileEdit, Spinner } from '../Icons/Icons';
import FileEditor from './FileEditor';
import { joinFileManagerPath, normalizeFileManagerPath } from './pathUtils';
import './FileManage.css';

// Breakpoint for mobile/tablet
const MOBILE_BREAKPOINT = 768;

const ROOT_ID = 'root';

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const FileManage = ({ show, onClose, refreshTrigger, width, onWidthChange }) => {
  const { t } = useI18n();
  const [fileSource, setFileSource] = useState('local');
  const [isMobile, setIsMobile] = useState(false);
  const panelRef = useRef(null);

  // Check screen size
  useEffect(() => {
    const checkScreen = () => {
      setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    };
    checkScreen();
    window.addEventListener('resize', checkScreen);
    return () => window.removeEventListener('resize', checkScreen);
  }, []);
  const [fileTree, setFileTree] = useState(null);
  const [expandedDirs, setExpandedDirs] = useState(new Set());
  const expandedDirsRef = useRef(new Set());
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingDirs, setLoadingDirs] = useState(new Set());
  const [isResizing, setIsResizing] = useState(false);
  const [error, setError] = useState(null);
  const [selectedPath, setSelectedPath] = useState(null);
  const [selectedName, setSelectedName] = useState(null);
  const fileInputRef = useRef(null);
  const dropZoneRef = useRef(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingFile, setEditingFile] = useState(null);

  // Adapter: local vs remote file operations, eliminates branching in every handler
  const fileOps = useMemo(() => {
    return fileSource === 'local' ? {
      list: () => loadFiles(),
      createFile: (name, path) => createFile(name, path),
      createDir: (name, path) => createDirectory(name, path),
      delete: (name, path, isDir) => deleteLocalFile(name, path ?? null, isDir),
      download: (name, path) => getFileBlob(name, path ?? null),
      upload: (name, blob, path) => saveFile(name, blob, path ?? null),
    } : {
      list: () => listFiles(''),
      createFile: (name, path) => createRemoteFile(joinFileManagerPath(path, name), '', false),
      createDir: (name, path) => createRemoteFile(joinFileManagerPath(path, name), '', true),
      delete: (name, path) => {
        const fullPath = joinFileManagerPath(path, name);
        return deleteRemoteFile(fullPath);
      },
      download: (name, path) => {
        const fullPath = joinFileManagerPath(path, name);
        return downloadRemoteFile(fullPath);
      },
      upload: (name, file, path) => {
        const fullPath = joinFileManagerPath(path, name);
        return uploadRemoteFile(fullPath, file);
      },
    };
  }, [fileSource]);

  const listDirectoryChildren = useCallback(async (path) => {
    const dirPath = normalizeFileManagerPath(path);
    let children = fileSource === 'local'
      ? await loadFiles(dirPath)
      : await listFiles(dirPath);
    if (!Array.isArray(children) && children?.children) children = children.children;
    return Array.isArray(children) ? children : [];
  }, [fileSource]);

  const hydrateExpandedDirs = useCallback(async (rootDir, expandedIds) => {
    const existingDirIds = new Set([ROOT_ID]);

    const hydrateNode = async (node, parentDir = '') => {
      if (node.type !== 'directory') return node;

      existingDirIds.add(node.id);
      const dirPath = node.id === ROOT_ID
        ? ''
        : joinFileManagerPath(parentDir, node.name);
      let children = Array.isArray(node.children) ? node.children : [];

      if (node.id !== ROOT_ID && expandedIds.has(node.id)) {
        try {
          children = await listDirectoryChildren(dirPath);
        } catch (err) {
          console.warn(`Failed to refresh directory ${dirPath}:`, err);
        }
      }

      const hydratedChildren = [];
      for (const child of children) {
        hydratedChildren.push(await hydrateNode(child, dirPath));
      }
      return { ...node, children: hydratedChildren };
    };

    const tree = await hydrateNode({ ...rootDir, expanded: true });
    const nextExpanded = new Set([ROOT_ID]);
    for (const id of expandedIds) {
      if (existingDirIds.has(id)) nextExpanded.add(id);
    }
    return { tree, expanded: nextExpanded };
  }, [listDirectoryChildren]);

  // Reload tree after any mutation
  const refreshTree = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rootDir = await fileOps.list();
      const expandedIds = new Set(expandedDirsRef.current);
      expandedIds.add(ROOT_ID);
      const { tree, expanded } = await hydrateExpandedDirs(rootDir, expandedIds);
      setFileTree(tree);
      setExpandedDirs(expanded);
      expandedDirsRef.current = expanded;
    } catch (_err) {
      setError(fileSource === 'local' ? t('filemanage.loadLocalError') : t('filemanage.loadRemoteError'));
      setFileTree({ id: 'root', name: '/', type: 'directory', expanded: true, children: [] });
      const expanded = new Set([ROOT_ID]);
      setExpandedDirs(expanded);
      expandedDirsRef.current = expanded;
    } finally {
      setLoading(false);
    }
  }, [fileOps, fileSource, hydrateExpandedDirs, t]);

  // Initial load when shown or source/trigger changes
  useEffect(() => {
    if (show) refreshTree();
  }, [show, refreshTrigger, fileSource]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep ref in sync with state
  useEffect(() => { expandedDirsRef.current = expandedDirs; }, [expandedDirs]);

  // Upload files (local or remote via adapter)
  const handleFileUpload = useCallback(async (files, targetPath) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    const fileArray = Array.from(files);
    let successCount = 0;
    let failCount = 0;

    try {
      for (const file of fileArray) {
        try {
          await fileOps.upload(file.name, file, targetPath);
          successCount++;
        } catch { failCount++; }
      }
      await refreshTree();

      if (failCount === 0) alert(t('filemanage.uploadSuccess').replace('{count}', successCount));
      else if (successCount > 0) alert(t('filemanage.uploadPartialSuccess').replace('{success}', successCount).replace('{fail}', failCount));
      else alert(fileSource === 'local' ? t('filemanage.uploadLocalError') : t('filemanage.uploadRemoteError'));
    } catch {
      alert(fileSource === 'local' ? t('filemanage.uploadLocalError') : t('filemanage.uploadRemoteError'));
    } finally {
      setUploading(false);
    }
  }, [fileOps, refreshTree, fileSource, t]);

  const handleFileInputChange = useCallback(async (e) => {
    await handleFileUpload(e.target.files, selectedPath);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [handleFileUpload, selectedPath]);

  // Drag and drop
  useEffect(() => {
    const dropZone = dropZoneRef.current;
    if (!dropZone || !show) return;
    const handleDragOver = (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); };
    const handleDragLeave = (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); };
    const handleDrop = (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); handleFileUpload(e.dataTransfer.files); };
    dropZone.addEventListener('dragover', handleDragOver);
    dropZone.addEventListener('dragleave', handleDragLeave);
    dropZone.addEventListener('drop', handleDrop);
    return () => {
      dropZone.removeEventListener('dragover', handleDragOver);
      dropZone.removeEventListener('dragleave', handleDragLeave);
      dropZone.removeEventListener('drop', handleDrop);
    };
  }, [show, handleFileUpload]);

  // Resize handlers
  const handleMouseDown = useCallback((e) => { e.preventDefault(); setIsResizing(true); }, []);
  const handleMouseMove = useCallback((e) => {
    if (!isResizing) return;
    const newWidth = window.innerWidth - e.clientX;
    if (newWidth >= 200 && newWidth <= 600) onWidthChange?.(newWidth);
  }, [isResizing, onWidthChange]);
  const handleMouseUp = useCallback(() => setIsResizing(false), []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  // Toggle directory expansion
  const toggleDirectory = useCallback(async (dirId, dirName, parentDir = '') => {
    const isCurrentlyExpanded = expandedDirsRef.current.has(dirId);
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (isCurrentlyExpanded) next.delete(dirId);
      else next.add(dirId);
      expandedDirsRef.current = new Set(next);
      return next;
    });

    if (!isCurrentlyExpanded) {
      setLoadingDirs((prev) => new Set(prev).add(dirId));
      const path = joinFileManagerPath(parentDir, dirName);
      try {
        const children = await listDirectoryChildren(path);
        setFileTree((prevTree) => {
          const updateNode = (node) => {
            if (node.id === dirId) return { ...node, children };
            if (node.children) return { ...node, children: node.children.map(updateNode) };
            return node;
          };
          return updateNode(prevTree);
        });
      } catch (err) {
        console.warn(`Failed to load directory ${dirName}:`, err);
      } finally {
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(dirId);
          return next;
        });
      }
    }
  }, [listDirectoryChildren]);

  // New file / dir — unified via adapter
  const handleNewFile = useCallback(async () => {
    const fileName = prompt(t('filemanage.newFileNamePrompt'), 'untitled.txt');
    if (!fileName) return;
    try { await fileOps.createFile(fileName, selectedPath); } catch { alert(t('filemanage.createFileError')); return; }
    await refreshTree();
  }, [t, fileOps, refreshTree, selectedPath]);

  const handleNewDir = useCallback(async () => {
    const dirName = prompt(t('filemanage.newDirNamePrompt'), 'new-folder');
    if (!dirName) return;
    try { await fileOps.createDir(dirName, selectedPath); } catch { alert(t('filemanage.createDirError')); return; }
    await refreshTree();
  }, [t, fileOps, refreshTree, selectedPath]);

  // Delete — unified via adapter
  const handleDeleteFile = useCallback(async (fileName, filePath, isDirectory) => {
    const confirmMsg = isDirectory
      ? t('filemanage.confirmDeleteDir').replace('{name}', fileName)
      : t('filemanage.confirmDeleteFile').replace('{name}', fileName);
    if (!window.confirm(confirmMsg)) return;
    try { await fileOps.delete(fileName, filePath, isDirectory); } catch { alert(t('filemanage.deleteFileError')); return; }
    await refreshTree();
  }, [t, fileOps, refreshTree]);

  // Download — unified via adapter
  const handleDownloadFile = useCallback(async (fileName, filePath) => {
    try {
      const blob = await fileOps.download(fileName, filePath);
      triggerDownload(blob, fileName);
    } catch { alert(t('filemanage.downloadFileError')); }
  }, [t, fileOps]);

  const handleEditFile = useCallback((fileName, filePath) => {
    setEditingFile({ fileName, filePath });
    setEditorOpen(true);
  }, []);

  const handleEditorClose = useCallback(() => { setEditorOpen(false); setEditingFile(null); }, []);
  const handleEditorSave = useCallback(() => refreshTree(), [refreshTree]);

  const handleSelectItem = useCallback((path, name, type) => {
    if (type === 'directory') {
      const normalized = joinFileManagerPath(path, name);
      setSelectedPath(normalized || null);
    } else {
      setSelectedPath(null);
    }
    setSelectedName(name);
  }, []);

  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const renderTreeNode = (node, depth = 0, parentDir = '') => {
    if (node.type === 'directory') {
      const isExpanded = expandedDirs.has(node.id);
      const nodeParentDir = normalizeFileManagerPath(parentDir || node.parentDir || '');
      const dirPath = node.id === ROOT_ID ? '' : joinFileManagerPath(nodeParentDir, node.name);
      const isSelected = selectedPath === dirPath && selectedName === node.name;

      return (
        <div key={node.id} className={`tree-node directory-node ${isSelected ? 'selected' : ''}`} style={{ paddingLeft: depth * 8 }}>
          <div
            className="tree-item"
            onClick={(e) => {
              e.stopPropagation();
              handleSelectItem(nodeParentDir, node.name, 'directory');
              toggleDirectory(node.id, node.name, nodeParentDir);
            }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleSelectItem(nodeParentDir, node.name, 'directory'); }}
          >
            {isExpanded ? <ChevronDown className="tree-chevron" width={12} height={12} /> : <ChevronRight className="tree-chevron" width={12} height={12} />}
            <Folder className="tree-icon folder-icon" width={18} height={18} />
            {loadingDirs.has(node.id) && <Spinner className="tree-icon tree-spinner" width={18} height={18} />}
            <span className="tree-label">{node.name}</span>
            {isExpanded && node.children?.length > 0 && <span className="tree-count">({node.children.length})</span>}
            {isSelected && <span className="tree-selected-badge">✓</span>}
            {node.id !== 'root' && (
              <div className="file-actions">
                <button className="file-action-btn delete-btn" onClick={(e) => { e.stopPropagation(); handleDeleteFile(node.name, nodeParentDir, true); }} title={t('filemanage.delete')}><Trash width={16} height={16} /></button>
              </div>
            )}
          </div>
          {isExpanded && Array.isArray(node.children) && node.children.length > 0 && (
            <div className="tree-children">
              {node.children.map((child) => renderTreeNode(child, depth + 1, dirPath))}
            </div>
          )}
        </div>
      );
    } else {
      const nodeParentDir = normalizeFileManagerPath(parentDir || node.parentDir || '');
      const filePath = joinFileManagerPath(nodeParentDir, node.name);
      const isSelected = selectedPath === filePath && selectedName === node.name;
      return (
        <div key={node.id} className={`tree-node file-node ${isSelected ? 'selected' : ''}`} style={{ paddingLeft: depth * 8 }}>
          <div className="tree-item file-item" onClick={(e) => { e.stopPropagation(); handleSelectItem(nodeParentDir, node.name, 'file'); }} onDoubleClick={(e) => { e.stopPropagation(); handleEditFile(node.name, nodeParentDir); }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleSelectItem(nodeParentDir, node.name, 'file'); }}>
            <span className="tree-icon-spacer" />
            <File className="tree-icon file-icon" width={18} height={18} />
            <span className="tree-label">{node.name}</span>
            {node.size && <span className="tree-size">{formatFileSize(node.size)}</span>}
            {isSelected && <span className="tree-selected-badge">✓</span>}
            <div className="file-actions">
              <button className="file-action-btn" onClick={(e) => { e.stopPropagation(); handleEditFile(node.name, nodeParentDir); }} title={t('filemanage.edit')}><FileEdit width={16} height={16} /></button>
              <button className="file-action-btn" onClick={(e) => { e.stopPropagation(); handleDownloadFile(node.name, nodeParentDir); }} title={t('filemanage.download')}><Download width={16} height={16} /></button>
              <button className="file-action-btn delete-btn" onClick={(e) => { e.stopPropagation(); handleDeleteFile(node.name, nodeParentDir, false); }} title={t('filemanage.delete')}><Trash width={16} height={16} /></button>
            </div>
          </div>
        </div>
      );
    }
  };

  if (!show) return null;

  return (
    <>
      {/* Backdrop for mobile */}
      {isMobile && (
        <div className="filemanage-backdrop show" onClick={onClose} />
      )}
      <div ref={panelRef} className={`filemanage-panel ${show ? 'show' : ''}`} style={{ '--panel-width': `${width}px` }}>
      <div className="filemanage-header">
        <div className="filemanage-header-left">
          <div className="filemanage-source-selector">
            <button className={`source-btn ${fileSource === 'local' ? 'active' : ''}`} onClick={() => setFileSource('local')} title={t('filemanage.localFiles')}><HardDrive width={16} height={16} /></button>
            <button className={`source-btn ${fileSource === 'remote' ? 'active' : ''}`} onClick={() => setFileSource('remote')} title={t('filemanage.remoteFiles')}><Cloud width={16} height={16} /></button>
          </div>
        </div>
        <div className="filemanage-header-buttons">
          <button className="filemanage-header-btn" onClick={handleNewFile} title={t('filemanage.newFile')}><FilePlus width={18} height={18} /></button>
          <button className="filemanage-header-btn" onClick={handleNewDir} title={t('filemanage.newDir')}><FolderPlus width={18} height={18} /></button>
          <button className="filemanage-header-btn" onClick={refreshTree} title={t('filemanage.refresh')}><Refresh width={18} height={18} /></button>
          <button className="filemanage-close-btn" onClick={onClose}><X width={18} height={18} /></button>
        </div>
      </div>

      <div className="filemanage-content" ref={dropZoneRef}>
        <div className="filemanage-tree">
          {loading ? (
            <div className="filemanage-empty"><Folder width={48} height={48} /><p>{t('filemanage.loading')}</p></div>
          ) : error ? (
            <div className="filemanage-empty"><Folder width={48} height={48} /><p className="filemanage-error">{error}</p></div>
          ) : fileTree?.children?.length === 0 ? (
            <div className="filemanage-empty"><Folder width={48} height={48} /><p>{fileSource === 'local' ? t('filemanage.empty') : t('filemanage.remoteEmpty')}</p></div>
          ) : (
            fileTree && renderTreeNode(fileTree)
          )}
        </div>

        <div className="filemanage-upload-zone">
          <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileInputChange} />
          <button className="filemanage-upload-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            <Upload width={20} height={20} />
            {uploading ? t('filemanage.uploading') : t('filemanage.upload')}
          </button>
          <span className="filemanage-drop-hint">{t('filemanage.dropHint')}</span>
          {selectedName && <span className="filemanage-selected-hint">{t('filemanage.selectedHint').replace('{name}', selectedName)}</span>}
        </div>
      </div>

      {!isMobile && (
        <div className={`filemanage-resize-handle ${isResizing ? 'resizing' : ''}`} onMouseDown={handleMouseDown} />
      )}
      <FileEditor show={editorOpen} onClose={handleEditorClose} fileName={editingFile?.fileName} filePath={editingFile?.filePath} fileSource={fileSource} onSave={handleEditorSave} />
    </div>
    </>
  );
};

export default FileManage;
