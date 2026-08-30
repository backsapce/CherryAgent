import { useState, useRef, useEffect } from 'react';
import { checkAgentAvailable, connectAgent } from '../../models/agent';
import { exportToZip, getOpfsDataStats, importFromZip } from '../../vfs/opfs';
import {
  getStoragePersistenceStatus,
  requestPersistentStorage,
  STORAGE_PERSISTENCE_STATUS,
} from '../../vfs/storagePersistence';
import config from '../../config/config';
import {
  cancelPendingAutoSync,
  pullSync,
  pushSync,
  suspendAutoSync,
  syncNow,
  syncResultChangedLocal,
  testSyncConnection,
  waitForSyncIdle,
} from '../../sync/syncManager';
import {
  normalizeProviderPreset,
  pathStyleForProviderPreset,
  validateProviderConfig,
  validateSyncPrefix,
} from '../../sync/providerPresets';
import { useI18n } from '../../i18n/context';
import { SUPPORTED_LOCALES } from '../../i18n/locales';
import { X, Lock, Plug, Sun, Moon, Monitor, UploadCloud, DownloadCloud, AlertTriangle, Globe, ChevronDown, User, Cloud, HardDrive, Layers, Refresh, Upload, Download } from '../Icons/Icons';
import { listAllSkills, setSkillEnabled } from '../../agent/skills';
import { listAllTools, setToolEnabled } from '../../agent/tools';
import { createAgent, deleteAgent, updateAgentName, updateAgentConfig, listAgents } from '../../agents/agents';
import {
  getDefaultSessionTitlePrompt,
  normalizeAutoTitleConfig,
} from '../../models/sessionTitle';
import {
  normalizeShowHiddenFiles,
  SHOW_HIDDEN_FILES_CONFIG_PATH,
} from '../../config/fileVisibility';
import { enqueueStorageOperation } from './storageOperationQueue';
import { manifestModeChangeLocked } from './syncDestination';
import './Settings.css';

const AVATAR_SIZE = 256;

function providerPresetOrDefault(value) {
  try {
    return normalizeProviderPreset(value);
  } catch {
    // Keep Settings usable so an invalid imported configuration can be fixed.
    return 's3';
  }
}

function derivedAliyunEndpoint(region = 'cn-beijing') {
  return `https://s3.oss-${String(region || 'cn-beijing').trim() || 'cn-beijing'}.aliyuncs.com`;
}

function endpointForSyncForm(saved = {}, providerPreset = 's3') {
  const endpoint = String(saved.endpoint || '').trim();
  if (
    providerPreset === 'aliyun-oss'
    && !saved.bucketEndpoint
    && endpoint === derivedAliyunEndpoint(saved.region)
  ) return '';
  return endpoint;
}

function validatedSyncConfigForStorage(candidate) {
  const hasExplicitEndpoint = Boolean(String(candidate.endpoint || '').trim());
  const validated = validateProviderConfig(candidate);
  return hasExplicitEndpoint ? validated : { ...validated, endpoint: null };
}

function formatDataSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const size = value / (1024 ** exponent);
  const maximumFractionDigits = exponent === 0 ? 0 : size >= 100 ? 0 : size >= 10 ? 1 : 2;

  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(size)} ${units[exponent]}`;
}

function fileToAvatarDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file?.type?.startsWith('image/')) {
      reject(new Error('Invalid image file'));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read image'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Failed to load image'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = AVATAR_SIZE;
        canvas.height = AVATAR_SIZE;
        const ctx = canvas.getContext('2d');
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
        resolve(canvas.toDataURL('image/webp', 0.86));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

const Settings = ({
  show,
  onClose,
  llmConfig,
  llmProfiles = [],
  activeLlmProfileId,
  providers = [],
  providerConfigs = [],
  onConfigureProvider,
  onDeleteProvider,
  onConfigureLLM,
  onDeleteLLM,
  onFetchModels,
  theme,
  onThemeChange,
  agents,
  onAgentsChange,
  onE2bChange,
  onFactoryReset,
  userNickname,
  onUserNicknameChange,
  avatar,
  onAvatarChange,
  agentList = [],
  activeAgentId = null,
  selectedAgentUrl = null,
  onAgentListChange,
  onStorageRestored,
  onBeforeStorageSync,
  storageVersion = 0,
}) => {
  const { t, locale, localePref, changeLocale } = useI18n();
  const [settingsTab, setSettingsTab] = useState('llm');
  const [llmSettingsTab, setLlmSettingsTab] = useState('llms');
  const [settingsForm, setSettingsForm] = useState({
    id: null,
    name: '',
    providerId: '',
    model: '',
    contextWindow: '',
  });
  const [providerForm, setProviderForm] = useState({
    id: null,
    name: '',
    type: '',
    apiKey: '',
    baseUrl: '',
  });
  const [modelList, setModelList] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState(null);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [selectedModels, setSelectedModels] = useState([]);
  const [editingLlmId, setEditingLlmId] = useState(null);
  const [editingProviderId, setEditingProviderId] = useState(null);
  const [llmSettingsError, setLlmSettingsError] = useState(null);
  const modelComboRef = useRef(null);
  const modelRequestIdRef = useRef(0);
  const [newAgentUrl, setNewAgentUrl] = useState('');
  const [newAgentChecking, setNewAgentChecking] = useState(false);
  const [newAgentError, setNewAgentError] = useState(null);
  const [connectTokenInput, setConnectTokenInput] = useState('');
  const [connectingAgent, setConnectingAgent] = useState(null);
  const [connectError, setConnectError] = useState(null);
  const [dataExporting, setDataExporting] = useState(false);
  const [dataImporting, setDataImporting] = useState(false);
  const [dataMessage, setDataMessage] = useState(null);
  const [dataStorageStats, setDataStorageStats] = useState({
    loading: false,
    error: null,
    fileCount: 0,
    totalBytes: 0,
  });
  const [factoryResetting, setFactoryResetting] = useState(false);
  const dataOperationBusyRef = useRef(false);
  const zipInputRef = useRef(null);
  const [localNickname, setLocalNickname] = useState(userNickname || '');
  const [localAvatar, setLocalAvatar] = useState(avatar || '');
  const [avatarError, setAvatarError] = useState(null);
  const [autoTitleForm, setAutoTitleForm] = useState({
    enabled: true,
    llmProfileId: null,
    promptTemplate: '',
  });
  const [showHiddenFilesForm, setShowHiddenFilesForm] = useState(false);
  const avatarInputRef = useRef(null);
  const [agentAddMode, setAgentAddMode] = useState('server'); // 'server' | 'e2b'
  const [e2bApiKeyInput, setE2bApiKeyInput] = useState('');
  const [e2bEnabling, setE2bEnabling] = useState(false);
  const [e2bLocalError, setE2bLocalError] = useState(null);
  const [skillsList, setSkillsList] = useState([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [toolsList, setToolsList] = useState([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [agentsTabList, setAgentsTabList] = useState([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState(null);
  const [editingAgentName, setEditingAgentName] = useState('');
  const [syncForm, setSyncForm] = useState({
    enabled: false,
    providerPreset: 's3',
    endpoint: '',
    region: 'us-east-1',
    bucket: '',
    prefix: 'cherry-agent',
    accessKeyId: '',
    secretAccessKey: '',
    sessionToken: '',
    clearSessionToken: false,
    forcePathStyle: false,
    bucketEndpoint: false,
    autoOnStart: false,
    autoIntervalMinutes: '',
    maxConcurrentRequests: '4',
    manifestMode: 'conditional',
  });
  const [syncBusy, setSyncBusy] = useState(null);
  const [syncMessage, setSyncMessage] = useState(null);
  const [storagePersistence, setStoragePersistence] = useState(null);
  const [storagePersistenceBusy, setStoragePersistenceBusy] = useState(false);

  useEffect(() => {
    setAgentsTabList(agentList);
  }, [agentList]);

  // Load agents when tab changes to agents
  useEffect(() => {
    if (settingsTab === 'agents') {
      setAgentsLoading(true);
      listAgents()
        .then((list) => setAgentsTabList(list))
        .catch((err) => console.error('Failed to load agents:', err))
        .finally(() => setAgentsLoading(false));
    }
  }, [settingsTab]);

  const handleCreateAgent = async () => {
    await createAgent();
    const updated = await listAgents();
    setAgentsTabList(updated);
    onAgentListChange?.(updated);
  };

  const handleDeleteAgent = async (id) => {
    if (agentsTabList.length <= 1) return;
    await deleteAgent(id);
    const updated = await listAgents();
    setAgentsTabList(updated);
    onAgentListChange?.(updated);
  };

  const handleStartEditAgent = (agent) => {
    setEditingAgentId(agent.id);
    setEditingAgentName(agent.name);
  };

  const handleSaveAgentName = async (id) => {
    if (!editingAgentName.trim()) return;
    await updateAgentName(id, editingAgentName.trim());
    setEditingAgentId(null);
    setEditingAgentName('');
    const updated = await listAgents();
    setAgentsTabList(updated);
    onAgentListChange?.(updated);
  };

  const handleAgentDefaultChange = async (id, patch) => {
    await updateAgentConfig(id, patch);
    const updated = await listAgents();
    setAgentsTabList(updated);
    onAgentListChange?.(updated);
  };

  // Load skills when tab changes to skills
  useEffect(() => {
    if (settingsTab === 'skills') {
      setSkillsLoading(true);
      listAllSkills(true, activeAgentId, { agentUrl: selectedAgentUrl })
        .then((skills) => setSkillsList(skills))
        .catch((err) => console.error('Failed to load skills:', err))
        .finally(() => setSkillsLoading(false));
    }
  }, [settingsTab, activeAgentId, selectedAgentUrl]);

  const handleSkillToggle = async (skillName, enabled) => {
    await setSkillEnabled(skillName, enabled);
    setSkillsList((prev) => prev.map((s) => (s.name === skillName ? { ...s, enabled } : s)));
  };

  const handleBulkToggle = async (enabled) => {
    for (const skill of skillsList) {
      await setSkillEnabled(skill.name, enabled);
    }
    setSkillsList((prev) => prev.map((s) => ({ ...s, enabled })));
  };

  // Load tools when tab changes to tools
  useEffect(() => {
    if (settingsTab === 'tools') {
      setToolsLoading(true);
      try {
        setToolsList(listAllTools());
      } catch (err) {
        console.error('Failed to load tools:', err);
      } finally {
        setToolsLoading(false);
      }
    }
  }, [settingsTab]);

  useEffect(() => {
    if (!show || settingsTab !== 'data') return;

    let canceled = false;
    setDataStorageStats((prev) => ({ ...prev, loading: true, error: null }));

    getOpfsDataStats()
      .then((stats) => {
        if (canceled) return;
        setDataStorageStats({ ...stats, loading: false, error: null });
      })
      .catch((err) => {
        console.error('Failed to calculate OPFS data size:', err);
        if (canceled) return;
        setDataStorageStats((prev) => ({ ...prev, loading: false, error: err }));
      });

    return () => {
      canceled = true;
    };
  }, [show, settingsTab, storageVersion]);

  const handleToolToggle = async (toolName, enabled) => {
    await setToolEnabled(toolName, enabled);
    setToolsList((prev) => prev.map((tool) => (tool.name === toolName ? { ...tool, enabled } : tool)));
  };

  const handleBulkToolToggle = async (enabled) => {
    for (const tool of toolsList) {
      await setToolEnabled(tool.name, enabled);
    }
    setToolsList((prev) => prev.map((tool) => ({ ...tool, enabled })));
  };

  // Initialize form when opening
  useEffect(() => {
    if (!show) return;
    setLocalNickname(userNickname || '');
    setLocalAvatar(avatar || '');
    setAvatarError(null);
    setAutoTitleForm(normalizeAutoTitleConfig(config.get('general.autoTitle')));
    setShowHiddenFilesForm(normalizeShowHiddenFiles(config.get(SHOW_HIDDEN_FILES_CONFIG_PATH)));
    const savedSync = config.get('sync') || {};
    const providerPreset = providerPresetOrDefault(savedSync.providerPreset);
    setSyncForm({
      enabled: Boolean(savedSync.enabled),
      providerPreset,
      endpoint: endpointForSyncForm(savedSync, providerPreset),
      region: savedSync.region || (providerPreset === 'aliyun-oss' ? 'cn-beijing' : 'us-east-1'),
      bucket: savedSync.bucket || '',
      prefix: savedSync.prefix || 'cherry-agent',
      accessKeyId: savedSync.accessKeyId || '',
      secretAccessKey: '',
      sessionToken: '',
      clearSessionToken: false,
      forcePathStyle: pathStyleForProviderPreset(
        providerPreset,
        savedSync.forcePathStyle
      ),
      bucketEndpoint: Boolean(savedSync.bucketEndpoint),
      autoOnStart: Boolean(savedSync.autoOnStart),
      autoIntervalMinutes: savedSync.autoIntervalMinutes != null ? String(savedSync.autoIntervalMinutes) : '',
      maxConcurrentRequests: savedSync.maxConcurrentRequests != null ? String(savedSync.maxConcurrentRequests) : '4',
      manifestMode: providerPreset === 'aliyun-oss'
        ? 'sharded'
        : (savedSync.manifestMode || 'conditional'),
    });
    setSyncMessage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  useEffect(() => {
    if (!show || settingsTab !== 'sync') return undefined;
    let canceled = false;
    setStoragePersistence(null);
    getStoragePersistenceStatus()
      .then((status) => {
        if (!canceled) setStoragePersistence(status);
      });
    return () => { canceled = true; };
  }, [show, settingsTab]);

  const handleAvatarUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setAvatarError(null);
      setLocalAvatar(await fileToAvatarDataUrl(file));
    } catch (err) {
      setAvatarError(err.message || t('generalSettings.avatarUploadFailed'));
    } finally {
      e.target.value = '';
    }
  };

  // Initialize form when opening
  useEffect(() => {
    if (!show) return;
    const selected = llmProfiles.find((p) => p.id === activeLlmProfileId) || llmConfig;
    if (selected) {
      setEditingLlmId(selected.id || null);
      setSettingsForm({
        id: selected.id || null,
        name: selected.name || '',
        providerId: selected.providerId || '',
        model: selected.model || '',
        contextWindow: selected.contextWindow ? String(selected.contextWindow) : '',
      });
      setSelectedModels(selected.model ? [selected.model] : []);
    }
    const selectedProviderConfig = providerConfigs.find((item) => item.id === selected?.providerId)
      || providerConfigs[0]
      || null;
    setEditingProviderId(selectedProviderConfig?.id || null);
    setProviderForm({
      id: selectedProviderConfig?.id || null,
      name: selectedProviderConfig?.name || '',
      type: selectedProviderConfig?.type || '',
      apiKey: '',
      baseUrl: selectedProviderConfig?.baseUrl || '',
    });
    setModelList([]);
    setModelsError(null);
    setLlmSettingsError(null);
    if (selected?.providerId) fetchModels(selected.providerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  // Close settings panel on Escape key
  useEffect(() => {
    if (!show) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [show, onClose]);

  // Close model dropdown on outside click
  useEffect(() => {
    if (!modelDropdownOpen) return;
    const handleClick = (e) => {
      if (modelComboRef.current && !modelComboRef.current.contains(e.target)) {
        setModelDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [modelDropdownOpen]);

  const fetchModels = async (providerId) => {
    const requestId = ++modelRequestIdRef.current;
    if (!providerId) {
      setModelList([]);
      return;
    }
    setModelsLoading(true);
    setModelsError(null);
    try {
      const models = await onFetchModels(providerId);
      if (requestId !== modelRequestIdRef.current) return;
      setModelList(models || []);
    } catch (err) {
      if (requestId !== modelRequestIdRef.current) return;
      setModelsError(err.message);
      setModelList([]);
    } finally {
      if (requestId === modelRequestIdRef.current) setModelsLoading(false);
    }
  };

  const selectedProviderConfig = providerConfigs.find((item) => item.id === settingsForm.providerId) || null;
  const selectedProvider = providers.find((item) => item.id === selectedProviderConfig?.type) || null;
  const editingProvider = providerConfigs.find((item) => item.id === editingProviderId) || null;
  const editingProviderType = providers.find((item) => item.id === providerForm.type) || null;
  const editingProviderKeySaved = Boolean(editingProvider?.hasApiKey && editingProvider.type === providerForm.type);
  const selectedLlmProfile = llmProfiles.find((p) => p.id === editingLlmId) || null;
  const editingProviderUsageCount = llmProfiles.filter((profile) => profile.providerId === editingProviderId).length;
  const autoTitleProfiles = llmProfiles.filter((profile) => profile.configured);
  const effectiveAutoTitleProfileId = autoTitleProfiles.some((profile) => profile.id === autoTitleForm.llmProfileId)
    ? autoTitleForm.llmProfileId
    : null;

  const handleSaveGeneral = async () => {
    await config.merge('general', {
      autoTitle: {
        enabled: autoTitleForm.enabled,
        llmProfileId: effectiveAutoTitleProfileId,
        promptTemplate: autoTitleForm.promptTemplate.trim(),
      },
      showHiddenFiles: showHiddenFilesForm,
    });
    await onUserNicknameChange?.(localNickname);
    await onAvatarChange?.(localAvatar);
    onClose();
  };

  const handleAddAgent = async () => {
    const url = newAgentUrl.trim().replace(/\/+$/, '');
    if (!url) return;
    if (agents.some((a) => a.url === url)) {
      setNewAgentError(t('sandboxSettings.alreadyAdded'));
      return;
    }
    setNewAgentChecking(true);
    setNewAgentError(null);
    try {
      const info = await checkAgentAvailable(url);
      if (!info.available) {
        setNewAgentError(t('sandboxSettings.connectFailed'));
        return;
      }
      let name;
      try {
        const u = new URL(url);
        name = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
          ? `Local (${u.port || '80'})` : u.hostname;
      } catch {
        name = url;
      }

      if (info.needsAuth) {
        const newAgent = { url, name, status: 'needsAuth' };
        onAgentsChange([...agents, newAgent]);
        setNewAgentUrl('');
        setConnectingAgent(url);
        setConnectTokenInput('');
        setConnectError(null);
      } else {
        const newAgent = { url, name, status: 'connected' };
        onAgentsChange([...agents, newAgent]);
        setNewAgentUrl('');
      }
    } finally {
      setNewAgentChecking(false);
    }
  };

  const handleConnectWithToken = async (url) => {
    const token = connectTokenInput.trim();
    if (!token) return;
    setConnectError(null);
    try {
      await connectAgent(token, url);
      onAgentsChange(agents.map((a) =>
        a.url === url ? { ...a, status: 'connected' } : a
      ));
      setConnectingAgent(null);
      setConnectTokenInput('');
    } catch (err) {
      setConnectError(err.message);
    }
  };

  const handleRemoveAgent = (url) => {
    onAgentsChange(agents.filter((a) => a.url !== url));
  };

  const handleEnableE2b = async () => {
    if (!e2bApiKeyInput.trim() || !onE2bChange) return;
    setE2bEnabling(true);
    setE2bLocalError(null);
    try {
      await onE2bChange(e2bApiKeyInput.trim());
      setE2bApiKeyInput('');
    } catch (err) {
      setE2bLocalError(err.message);
    } finally {
      setE2bEnabling(false);
    }
  };

  const handleLlmProviderChange = (e) => {
    const providerId = e.target.value;
    setSettingsForm((form) => ({ ...form, providerId, model: '' }));
    setSelectedModels([]);
    setModelList([]);
    setModelsError(null);
    if (providerId) fetchModels(providerId);
  };

  const handleEditProvider = (providerId) => {
    const providerConfig = providerConfigs.find((item) => item.id === providerId);
    if (!providerConfig) return;
    setEditingProviderId(providerConfig.id);
    setProviderForm({
      id: providerConfig.id,
      name: providerConfig.name || '',
      type: providerConfig.type || '',
      apiKey: '',
      baseUrl: providerConfig.baseUrl || '',
    });
    setLlmSettingsError(null);
  };

  const handleNewProvider = () => {
    setEditingProviderId(null);
    setProviderForm({ id: null, name: '', type: '', apiKey: '', baseUrl: '' });
    setLlmSettingsError(null);
  };

  const handleSaveProvider = async () => {
    if (!providerForm.type) return;
    setLlmSettingsError(null);
    try {
      const saved = await onConfigureProvider({
        id: editingProviderId || null,
        name: providerForm.name.trim() || undefined,
        type: providerForm.type,
        ...(providerForm.apiKey && { apiKey: providerForm.apiKey }),
        baseUrl: providerForm.baseUrl.trim() || null,
      });
      setEditingProviderId(saved.id);
      setProviderForm({
        id: saved.id,
        name: saved.name || '',
        type: saved.type || providerForm.type,
        apiKey: '',
        baseUrl: saved.baseUrl || '',
      });
    } catch (err) {
      setLlmSettingsError(err.message);
    }
  };

  const handleDeleteProvider = async () => {
    if (!editingProviderId || editingProviderUsageCount > 0) return;
    setLlmSettingsError(null);
    try {
      await onDeleteProvider?.(editingProviderId);
      const next = providerConfigs.find((item) => item.id !== editingProviderId);
      if (next) handleEditProvider(next.id);
      else handleNewProvider();
    } catch (err) {
      setLlmSettingsError(err.message);
    }
  };

  const handleSaveSettings = async () => {
    if (!settingsForm.providerId) return;
    const manualModel = settingsForm.model.trim();
    const modelIds = selectedModels.length > 0
      ? selectedModels
      : (manualModel ? [manualModel] : []);
    if (modelIds.length === 0) return;
    const createMultiple = modelIds.length > 1;
    const trimmedName = settingsForm.name.trim();
    const contextWindowValue = Number(settingsForm.contextWindow);
    const contextWindow = Number.isFinite(contextWindowValue) && contextWindowValue > 0
      ? Math.floor(contextWindowValue)
      : undefined;
    const selectedProviderName = selectedProviderConfig?.name || '';
    const currentProviderName = selectedLlmProfile?.providerName || selectedProviderName;
    const currentAutoName = selectedLlmProfile?.model
      ? `${currentProviderName} / ${selectedLlmProfile.model}`
      : currentProviderName;
    const baseName = trimmedName && trimmedName !== currentAutoName ? trimmedName : '';

    setLlmSettingsError(null);
    try {
      for (const [index, modelId] of modelIds.entries()) {
        await onConfigureLLM({
          id: createMultiple
            ? (index === 0 && editingLlmId ? editingLlmId : null)
            : (editingLlmId || null),
          name: baseName
            ? (createMultiple ? `${baseName} / ${modelId}` : baseName)
            : undefined,
          providerId: settingsForm.providerId,
          model: modelId,
          contextWindow: contextWindow || null,
        });
      }
      onClose();
    } catch (err) {
      setLlmSettingsError(err.message);
    }
  };

  const toggleSelectedModel = (modelId) => {
    if (editingLlmId) {
      setSelectedModels([modelId]);
      setSettingsForm((form) => ({ ...form, model: modelId }));
      return;
    }
    setSelectedModels((prev) => {
      const next = prev.includes(modelId)
        ? prev.filter((id) => id !== modelId)
        : [...prev, modelId];
      setSettingsForm((f) => ({ ...f, model: next.join(', ') }));
      return next;
    });
  };

  const handleEditLlmProfile = (profileId) => {
    const profile = llmProfiles.find((p) => p.id === profileId);
    if (!profile) return;
    setEditingLlmId(profile.id);
    setSettingsForm({
      id: profile.id,
      name: profile.name || '',
      providerId: profile.providerId || '',
      model: profile.model || '',
      contextWindow: profile.contextWindow ? String(profile.contextWindow) : '',
    });
    setSelectedModels(profile.model ? [profile.model] : []);
    setModelList([]);
    setModelsError(null);
    setLlmSettingsError(null);
    if (profile.providerId) fetchModels(profile.providerId);
  };

  const handleNewLlmProfile = (preferredProviderId = null) => {
    const requestedProviderId = typeof preferredProviderId === 'string' ? preferredProviderId : null;
    const providerId = requestedProviderId || settingsForm.providerId || editingProviderId || providerConfigs[0]?.id || '';
    setEditingLlmId(null);
    setSettingsForm({
      id: null,
      name: '',
      providerId,
      model: '',
      contextWindow: '',
    });
    setSelectedModels([]);
    setModelList([]);
    setModelsError(null);
    setLlmSettingsError(null);
    if (providerId) fetchModels(providerId);
  };

  const handleDeleteLlmProfile = async () => {
    if (!editingLlmId) return;
    setLlmSettingsError(null);
    try {
      await onDeleteLLM?.(editingLlmId);
      const next = llmProfiles.find((p) => p.id !== editingLlmId);
      if (next) handleEditLlmProfile(next.id);
      else handleNewLlmProfile();
    } catch (err) {
      setLlmSettingsError(err.message);
    }
  };

  const manifestModeChangeLockedFor = (candidate) => {
    const saved = config.get('sync') || {};
    return manifestModeChangeLocked(saved, candidate);
  };

  const syncConfigFromForm = () => {
    const saved = config.get('sync') || {};
    const intervalText = String(syncForm.autoIntervalMinutes).trim();
    const interval = Number(intervalText);
    const concurrencyText = String(syncForm.maxConcurrentRequests).trim();
    const concurrency = Number(concurrencyText);
    const providerPreset = normalizeProviderPreset(syncForm.providerPreset);
    const next = {
      ...saved,
      enabled: Boolean(syncForm.enabled),
      providerPreset,
      endpoint: syncForm.endpoint.trim() || null,
      region: syncForm.region.trim() || 'us-east-1',
      bucket: syncForm.bucket.trim(),
      prefix: validateSyncPrefix(
        syncForm.prefix.trim() || 'cherry-agent',
        providerPreset
      ),
      accessKeyId: syncForm.accessKeyId.trim(),
      secretAccessKey: syncForm.secretAccessKey || saved.secretAccessKey || '',
      sessionToken: syncForm.clearSessionToken
        ? ''
        : (syncForm.sessionToken || saved.sessionToken || ''),
      forcePathStyle: Boolean(syncForm.forcePathStyle),
      bucketEndpoint: Boolean(syncForm.bucketEndpoint),
      autoOnStart: Boolean(syncForm.autoOnStart),
      autoIntervalMinutes: intervalText && Number.isFinite(interval) && interval >= 0 ? Math.floor(interval) : null,
      maxConcurrentRequests: concurrencyText && Number.isFinite(concurrency) && concurrency >= 1
        ? Math.min(8, Math.floor(concurrency))
        : 4,
      manifestMode: providerPreset === 'aliyun-oss'
        ? 'sharded'
        : (syncForm.manifestMode || 'conditional'),
    };
    if (manifestModeChangeLockedFor(next)) {
      throw new Error(t('syncSettings.manifestModeChangeBlocked'));
    }
    return next;
  };

  const runWithStorageBarrier = (operation) => enqueueStorageOperation(async () => {
    const resumeAutoSync = suspendAutoSync();
    let releaseSessionBarrier;
    try {
      await waitForSyncIdle();
      releaseSessionBarrier = await onBeforeStorageSync?.();
      return await operation();
    } finally {
      releaseSessionBarrier?.();
      resumeAutoSync();
    }
  });

  const requestStorageProtection = async () => {
    setStoragePersistenceBusy(true);
    try {
      const status = await requestPersistentStorage();
      setStoragePersistence(status);
      return status;
    } finally {
      setStoragePersistenceBusy(false);
    }
  };

  const handleSaveSync = async () => {
    setSyncMessage(null);
    try {
      let next = syncConfigFromForm();
      if (next.enabled) next = validatedSyncConfigForStorage(next);
      if (next.enabled) await requestStorageProtection();
      await enqueueStorageOperation(() => config.set('sync', next));
      setSyncForm((form) => ({
        ...form,
        secretAccessKey: '',
        sessionToken: '',
        clearSessionToken: false,
      }));
      setSyncMessage({ type: 'success', text: t('syncSettings.saveSuccess') });
    } catch (err) {
      setSyncMessage({ type: 'error', text: t('syncSettings.actionFailed', { error: err.message }) });
    }
  };

  const runSyncAction = async (action, fn) => {
    setSyncBusy(action);
    setSyncMessage(null);
    try {
      const next = validatedSyncConfigForStorage(syncConfigFromForm());
      await requestStorageProtection();
      const result = await runWithStorageBarrier(async () => {
        try {
          await config.set('sync', next);
          // The config mutation re-arms the normal auto-sync debounce. This
          // explicit action already defines its direction (including Test/Pull),
          // so do not follow it with an implicit full sync.
          cancelPendingAutoSync();
          const actionResult = await fn(next);
          if (syncResultChangedLocal(actionResult)) await onStorageRestored?.();
          return actionResult;
        } finally {
          // Pull/imported OPFS writes and refresh-time config notifications can
          // re-arm the hook after the first cancellation. Directional manual
          // actions must never be followed by an implicit full push.
          cancelPendingAutoSync();
        }
      });
      setSyncMessage({ type: 'success', text: t(`syncSettings.${action}Success`, { summary: JSON.stringify(result) }) });
    } catch (err) {
      setSyncMessage({ type: 'error', text: t('syncSettings.actionFailed', { error: err.message }) });
    } finally {
      setSyncBusy(null);
    }
  };

  if (!show) return null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <button className="settings-close-btn" onClick={onClose}>
          <X width={18} height={18} />
        </button>
        <div className="settings-sidebar">
          <div className="settings-sidebar-header">
            <h3>{t('settings.title')}</h3>
          </div>
          <nav className="settings-nav">
            <button
              className={`settings-nav-item ${settingsTab === 'llm' ? 'active' : ''}`}
              onClick={() => setSettingsTab('llm')}
            >
              <Lock width={16} height={16} />
              {t('settings.llm')}
            </button>
            <button
              className={`settings-nav-item ${settingsTab === 'general' ? 'active' : ''}`}
              onClick={() => setSettingsTab('general')}
            >
              <User width={16} height={16} />
              {t('settings.general')}
            </button>
            <button
              className={`settings-nav-item ${settingsTab === 'sandboxes' ? 'active' : ''}`}
              onClick={() => setSettingsTab('sandboxes')}
            >
              <Plug width={16} height={16} />
              {t('settings.sandboxes')}
              {agents.filter((a) => a.status === 'connected').length > 0 && (
                <span className="settings-nav-count">{agents.filter((a) => a.status === 'connected').length}</span>
              )}
            </button>
            <button
              className={`settings-nav-item ${settingsTab === 'appearance' ? 'active' : ''}`}
              onClick={() => setSettingsTab('appearance')}
            >
              <Sun width={16} height={16} />
              {t('settings.appearance')}
            </button>
            <button
              className={`settings-nav-item ${settingsTab === 'data' ? 'active' : ''}`}
              onClick={() => { setSettingsTab('data'); setDataMessage(null); }}
            >
              <UploadCloud width={16} height={16} />
              {t('settings.data')}
            </button>
            <button
              className={`settings-nav-item ${settingsTab === 'sync' ? 'active' : ''}`}
              onClick={() => { setSettingsTab('sync'); setSyncMessage(null); }}
            >
              <Cloud width={16} height={16} />
              {t('settings.sync')}
            </button>
            <button
              className={`settings-nav-item ${settingsTab === 'language' ? 'active' : ''}`}
              onClick={() => setSettingsTab('language')}
            >
              <Globe width={16} height={16} />
              {t('settings.language')}
            </button>
            <button
              className={`settings-nav-item ${settingsTab === 'agents' ? 'active' : ''}`}
              onClick={() => setSettingsTab('agents')}
            >
              <User width={16} height={16} />
              {t('settings.agents')}
              {agentsTabList.length > 0 && (
                <span className="settings-nav-count">{agentsTabList.length}</span>
              )}
            </button>
            <button
              className={`settings-nav-item ${settingsTab === 'skills' ? 'active' : ''}`}
              onClick={() => setSettingsTab('skills')}
            >
              <Layers width={16} height={16} />
              {t('settings.skills')}
            </button>
            <button
              className={`settings-nav-item ${settingsTab === 'tools' ? 'active' : ''}`}
              onClick={() => setSettingsTab('tools')}
            >
              <Plug width={16} height={16} />
              {t('settings.tools')}
            </button>
          </nav>
        </div>
        <div className="settings-content">
          {settingsTab === 'llm' && (
            <div className="settings-section">
              <h3>{t('llmSettings.title')}</h3>
              <p className="settings-desc">{t('llmSettings.desc')}</p>
              <div className="llm-settings-tabs">
                <button
                  type="button"
                  className={llmSettingsTab === 'llms' ? 'active' : ''}
                  onClick={() => { setLlmSettingsTab('llms'); setLlmSettingsError(null); }}
                >
                  {t('llmSettings.llmTab')}
                  <span>{llmProfiles.length}</span>
                </button>
                <button
                  type="button"
                  className={llmSettingsTab === 'providers' ? 'active' : ''}
                  onClick={() => { setLlmSettingsTab('providers'); setLlmSettingsError(null); }}
                >
                  {t('llmSettings.providersTab')}
                  <span>{providerConfigs.length}</span>
                </button>
              </div>

              {llmSettingsError && <p className="settings-error">{llmSettingsError}</p>}

              {llmSettingsTab === 'llms' && (
                <>
                  {llmProfiles.length > 0 && (
                    <>
                      <label>{t('llmSettings.llmList')}</label>
                      <select value={editingLlmId || ''} onChange={(e) => handleEditLlmProfile(e.target.value)}>
                        {llmProfiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name || `${profile.providerName || profile.provider} / ${profile.model}`}
                          </option>
                        ))}
                      </select>
                    </>
                  )}

                  <div className="settings-inline-actions">
                    <button type="button" className="settings-secondary" onClick={handleNewLlmProfile} disabled={providerConfigs.length === 0}>
                      {t('llmSettings.addLlm')}
                    </button>
                    {editingLlmId && (
                      <button type="button" className="settings-secondary danger" onClick={handleDeleteLlmProfile}>
                        {t('llmSettings.deleteLlm')}
                      </button>
                    )}
                  </div>

                  {providerConfigs.length === 0 ? (
                    <div className="llm-empty-state">
                      <p>{t('llmSettings.providerFirst')}</p>
                      <button type="button" className="settings-secondary" onClick={() => { setLlmSettingsTab('providers'); handleNewProvider(); }}>
                        {t('llmSettings.addProvider')}
                      </button>
                    </div>
                  ) : (
                    <>
                      <label>{t('llmSettings.llmName')}</label>
                      <input
                        type="text"
                        placeholder={t('llmSettings.llmNamePlaceholder')}
                        value={settingsForm.name}
                        onChange={(e) => setSettingsForm((form) => ({ ...form, name: e.target.value }))}
                      />

                      <label>{t('llmSettings.provider')}</label>
                      <select value={settingsForm.providerId} onChange={handleLlmProviderChange}>
                        <option value="">{t('llmSettings.selectConfiguredProvider')}</option>
                        {providerConfigs.map((providerConfig) => (
                          <option key={providerConfig.id} value={providerConfig.id}>
                            {providerConfig.name} · {providers.find((item) => item.id === providerConfig.type)?.name || providerConfig.type}
                          </option>
                        ))}
                      </select>

                      <label>
                        {t('llmSettings.model')}
                        {modelsLoading && <span className="models-loading-tag">{t('llmSettings.modelsLoading')}</span>}
                      </label>
                      {modelsError && <p className="settings-error">{t('llmSettings.modelsError', { error: modelsError })}</p>}
                      <div className="model-select-row">
                        <div className="model-combo" ref={modelComboRef}>
                          <input
                            type="text"
                            className="model-combo-input"
                            value={settingsForm.model}
                            placeholder={selectedProvider?.defaultModel || t('llmSettings.modelPlaceholder')}
                            onChange={(e) => {
                              setSettingsForm((form) => ({ ...form, model: e.target.value }));
                              setSelectedModels([]);
                              setModelDropdownOpen(true);
                            }}
                            onFocus={() => setModelDropdownOpen(true)}
                            disabled={!selectedProviderConfig || modelsLoading}
                          />
                          <button
                            type="button"
                            className="model-combo-toggle"
                            tabIndex={-1}
                            onClick={() => setModelDropdownOpen((open) => !open)}
                            disabled={!selectedProviderConfig || modelsLoading}
                          >
                            <ChevronDown width={10} height={10} />
                          </button>
                          {modelDropdownOpen && (() => {
                            const allModels = modelList.length > 0 ? modelList : (selectedProvider?.fallbackModels || []);
                            const filter = selectedModels.length > 0 ? '' : settingsForm.model.toLowerCase();
                            const filtered = filter
                              ? allModels.filter((model) => model.id.toLowerCase().includes(filter) || model.name.toLowerCase().includes(filter))
                              : allModels;
                            return filtered.length > 0 ? (
                              <ul className="model-combo-dropdown">
                                {filtered.map((model) => (
                                  <li
                                    key={model.id}
                                    className={`model-combo-option${selectedModels.includes(model.id) || model.id === settingsForm.model ? ' selected' : ''}`}
                                    onMouseDown={(e) => { e.preventDefault(); toggleSelectedModel(model.id); }}
                                  >
                                    <input type="checkbox" tabIndex={-1} readOnly checked={selectedModels.includes(model.id)} />
                                    <span>{model.name}</span>
                                  </li>
                                ))}
                              </ul>
                            ) : null;
                          })()}
                        </div>
                      </div>
                      <p className="settings-hint">{t('llmSettings.modelsHint')}</p>

                      <label>{t('llmSettings.contextWindow')}</label>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        inputMode="numeric"
                        placeholder={t('llmSettings.contextWindowPlaceholder')}
                        value={settingsForm.contextWindow}
                        onChange={(e) => setSettingsForm((form) => ({ ...form, contextWindow: e.target.value }))}
                      />
                      <p className="settings-hint">{t('llmSettings.contextWindowHint')}</p>
                    </>
                  )}
                </>
              )}

              {llmSettingsTab === 'providers' && (
                <>
                  {providerConfigs.length > 0 && (
                    <>
                      <label>{t('llmSettings.providerList')}</label>
                      <select value={editingProviderId || ''} onChange={(e) => handleEditProvider(e.target.value)}>
                        {providerConfigs.map((providerConfig) => (
                          <option key={providerConfig.id} value={providerConfig.id}>{providerConfig.name}</option>
                        ))}
                      </select>
                    </>
                  )}

                  <div className="settings-inline-actions">
                    <button type="button" className="settings-secondary" onClick={handleNewProvider}>
                      {t('llmSettings.addProvider')}
                    </button>
                    {editingProviderId && (
                      <button
                        type="button"
                        className="settings-secondary danger"
                        onClick={handleDeleteProvider}
                        disabled={editingProviderUsageCount > 0}
                        title={editingProviderUsageCount > 0 ? t('llmSettings.providerInUse') : undefined}
                      >
                        {t('llmSettings.deleteProvider')}
                      </button>
                    )}
                    {editingProviderId && (
                      <button type="button" className="settings-secondary" onClick={() => { setLlmSettingsTab('llms'); handleNewLlmProfile(editingProviderId); }}>
                        {t('llmSettings.addLlm')}
                      </button>
                    )}
                  </div>
                  {editingProviderId && (
                    <p className="settings-hint">{t('llmSettings.providerUsageCount', { count: editingProviderUsageCount })}</p>
                  )}

                  <label>{t('llmSettings.providerName')}</label>
                  <input
                    type="text"
                    placeholder={t('llmSettings.providerNamePlaceholder')}
                    value={providerForm.name}
                    onChange={(e) => setProviderForm((form) => ({ ...form, name: e.target.value }))}
                  />

                  <label>{t('llmSettings.providerType')}</label>
                  <select
                    value={providerForm.type}
                    onChange={(e) => setProviderForm((form) => ({ ...form, type: e.target.value, baseUrl: '' }))}
                  >
                    <option value="">{t('llmSettings.selectProvider')}</option>
                    {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                  </select>

                  <label>{t('llmSettings.apiKey')}</label>
                  <input
                    type="password"
                    placeholder={editingProviderKeySaved ? t('llmSettings.apiKeyMask') : t('llmSettings.enterApiKey')}
                    value={providerForm.apiKey}
                    onChange={(e) => setProviderForm((form) => ({ ...form, apiKey: e.target.value }))}
                  />
                  {editingProviderKeySaved && !providerForm.apiKey && <p className="settings-hint">{t('llmSettings.apiKeySaved')}</p>}

                  {providerForm.type && (
                    <>
                      <label>
                        {t('llmSettings.baseUrl')}
                        {editingProviderType?.requiresBaseUrl
                          ? <span className="required-tag">*</span>
                          : <span className="optional-tag">{t('llmSettings.optional')}</span>}
                      </label>
                      <input
                        type="text"
                        placeholder={editingProviderType?.defaultBaseUrl || t('llmSettings.customEndpoint')}
                        value={providerForm.baseUrl}
                        onChange={(e) => setProviderForm((form) => ({ ...form, baseUrl: e.target.value }))}
                      />
                      <p className="settings-hint">
                        {editingProviderType?.requiresBaseUrl ? t('llmSettings.baseUrlRequiredHint') : t('llmSettings.baseUrlHint')}
                      </p>
                    </>
                  )}
                </>
              )}

              <div className="settings-actions">
                <button className="settings-cancel" onClick={onClose}>{t('settings.cancel')}</button>
                {llmSettingsTab === 'llms' ? (
                  <button
                    className="settings-save"
                    onClick={handleSaveSettings}
                    disabled={!settingsForm.providerId || (!settingsForm.model.trim() && selectedModels.length === 0)}
                  >
                    {t('llmSettings.saveLlm')}
                  </button>
                ) : (
                  <button
                    className="settings-save"
                    onClick={handleSaveProvider}
                    disabled={!providerForm.type || (editingProviderType?.requiresBaseUrl && !providerForm.baseUrl.trim())}
                  >
                    {t('llmSettings.saveProvider')}
                  </button>
                )}
              </div>
            </div>
          )}
          {settingsTab === 'general' && (
            <div className="settings-section">
              <h3>{t('generalSettings.title')}</h3>
              <p className="settings-desc">{t('generalSettings.desc')}</p>

              <label>{t('generalSettings.nickname')}</label>
              <input
                type="text"
                placeholder={t('generalSettings.nicknamePlaceholder')}
                value={localNickname}
                onChange={(e) => setLocalNickname(e.target.value)}
              />
              <p className="settings-hint">{t('generalSettings.nicknameHint')}</p>

              <label>{t('generalSettings.avatar')}</label>
              <div className="avatar-setting-row">
                <div className="avatar-preview">
                  {localAvatar ? (
                    <img src={localAvatar} alt="" onError={() => setAvatarError(t('generalSettings.avatarLoadFailed'))} />
                  ) : (
                    <span>{Array.from(t('message.assistant'))[0]?.toUpperCase() || 'V'}</span>
                  )}
                </div>
                <div className="avatar-actions">
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/*"
                    className="avatar-file-input"
                    onChange={handleAvatarUpload}
                  />
                  <button className="settings-secondary" onClick={() => avatarInputRef.current?.click()}>
                    <UploadCloud width={16} height={16} />
                    {t('generalSettings.avatarUpload')}
                  </button>
                  {localAvatar && (
                    <button className="settings-secondary" onClick={() => setLocalAvatar('')}>
                      <X width={16} height={16} />
                      {t('generalSettings.avatarRemove')}
                    </button>
                  )}
                </div>
              </div>
              <p className="settings-hint">{t('generalSettings.avatarHint')}</p>
              {avatarError && <p className="settings-error">{avatarError}</p>}

              <label className="settings-checkbox-row">
                <input
                  type="checkbox"
                  checked={showHiddenFilesForm}
                  onChange={(e) => setShowHiddenFilesForm(e.target.checked)}
                />
                <span>{t('generalSettings.showHiddenFiles')}</span>
              </label>
              <p className="settings-hint">{t('generalSettings.showHiddenFilesHint')}</p>

              <label className="settings-checkbox-row">
                <input
                  type="checkbox"
                  checked={autoTitleForm.enabled}
                  onChange={(e) => setAutoTitleForm((form) => ({ ...form, enabled: e.target.checked }))}
                />
                <span>{t('generalSettings.autoTitle')}</span>
              </label>
              <p className="settings-hint">{t('generalSettings.autoTitleHint')}</p>

              <label>{t('generalSettings.autoTitleModel')}</label>
              <select
                value={effectiveAutoTitleProfileId || ''}
                disabled={!autoTitleForm.enabled || autoTitleProfiles.length === 0}
                onChange={(e) => setAutoTitleForm((form) => ({
                  ...form,
                  llmProfileId: e.target.value || null,
                }))}
              >
                <option value="">
                  {autoTitleProfiles.length > 0
                    ? t('generalSettings.autoTitleFirstModel', { model: autoTitleProfiles[0].name })
                    : t('generalSettings.autoTitleNoModel')}
                </option>
                {autoTitleProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.name}</option>
                ))}
              </select>
              <p className="settings-hint">{t('generalSettings.autoTitleModelHint')}</p>

              <label>{t('generalSettings.autoTitlePrompt')}</label>
              <textarea
                className="settings-prompt-textarea"
                rows={7}
                value={autoTitleForm.promptTemplate}
                disabled={!autoTitleForm.enabled}
                placeholder={getDefaultSessionTitlePrompt(locale)}
                onChange={(e) => setAutoTitleForm((form) => ({
                  ...form,
                  promptTemplate: e.target.value,
                }))}
              />
              <p className="settings-hint">{t('generalSettings.autoTitlePromptHint')}</p>

              <div className="settings-actions">
                <button className="settings-cancel" onClick={onClose}>{t('settings.cancel')}</button>
                <button
                  className="settings-save"
                  onClick={handleSaveGeneral}
                >
                  {t('settings.save')}
                </button>
              </div>
            </div>
          )}
          {settingsTab === 'sandboxes' && (
            <div className="settings-section">
              <h3>{t('sandboxSettings.title')}</h3>
              <p className="settings-desc">{t('sandboxSettings.desc')}</p>

              <div className="sandboxes-list">
                {agents.length === 0 && (
                  <div className="sandboxes-empty">{t('sandboxSettings.empty')}</div>
                )}
                {agents.map((agent) => (
                  <div key={agent.url} className={`sandbox-item ${agent.status}${agent.isE2b ? ' e2b' : ''}`}>
                    <div className="sandbox-item-info">
                      <span className={`sandbox-status-dot ${agent.status}${agent.isE2b ? ' e2b' : ''}`} />
                      <div className="sandbox-item-details">
                        <span className="sandbox-item-name">{agent.name}</span>
                        <span className="sandbox-item-url">{agent.isE2b ? (agent.sandboxId || t('sandboxSettings.e2bNotStarted')) : agent.url}</span>
                      </div>
                    </div>
                    {agent.isE2b && agent.status === 'connected' && (
                      <button
                        className="sandbox-remove-btn"
                        onClick={async () => {
                          // Disable E2B: clear key and cleanup
                          await onE2bChange('');
                        }}
                        title={t('sandboxSettings.removeSandbox')}
                      >
                        <X width={14} height={14} />
                      </button>
                    )}
                    {!agent.isE2b && (
                      <button className="sandbox-remove-btn" onClick={() => handleRemoveAgent(agent.url)} title={t('sandboxSettings.removeSandbox')}>
                        <X width={14} height={14} />
                      </button>
                    )}
                    {agent.status === 'needsAuth' && connectingAgent !== agent.url && (
                      <button
                        className="sandbox-connect-btn"
                        onClick={() => { setConnectingAgent(agent.url); setConnectTokenInput(''); setConnectError(null); }}
                      >
                        {t('sandboxSettings.authenticate')}
                      </button>
                    )}
                    {connectingAgent === agent.url && (
                      <div className="sandbox-token-row">
                        <input
                          type="text"
                          placeholder={t('sandboxSettings.enterToken')}
                          value={connectTokenInput}
                          onChange={(e) => { setConnectTokenInput(e.target.value); setConnectError(null); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleConnectWithToken(agent.url); }}
                          autoFocus
                        />
                        <button onClick={() => handleConnectWithToken(agent.url)} disabled={!connectTokenInput.trim()}>
                          {t('sandboxSettings.submit')}
                        </button>
                        <button className="sandbox-token-cancel" onClick={() => setConnectingAgent(null)}>{t('sandboxSettings.cancel')}</button>
                        {connectError && <p className="settings-error">{connectError}</p>}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <label>{t('sandboxSettings.addSandbox')}</label>
              <div className="sandbox-mode-selector">
                <button
                  className={`sandbox-mode-btn ${agentAddMode === 'server' ? 'active' : ''}`}
                  onClick={() => setAgentAddMode('server')}
                >
                  <Plug width={14} height={14} />
                  {t('sandboxSettings.modeServer')}
                </button>
                <button
                  className={`sandbox-mode-btn ${agentAddMode === 'e2b' ? 'active' : ''}`}
                  onClick={() => setAgentAddMode('e2b')}
                >
                  <Cloud width={14} height={14} />
                  {t('sandboxSettings.modeE2b')}
                </button>
              </div>

              {agentAddMode === 'server' && (
                <>
                  <div className="sandbox-add-row">
                    <input
                      type="text"
                      placeholder={t('sandboxSettings.hostPlaceholder')}
                      value={newAgentUrl}
                      onChange={(e) => { setNewAgentUrl(e.target.value); setNewAgentError(null); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAddAgent(); }}
                    />
                    <button
                      className="sandbox-add-btn"
                      onClick={handleAddAgent}
                      disabled={newAgentChecking || !newAgentUrl.trim()}
                    >
                      {newAgentChecking ? t('sandboxSettings.checking') : t('sandboxSettings.connect')}
                    </button>
                  </div>
                  {newAgentError && <p className="settings-error">{newAgentError}</p>}
                  <p className="settings-hint">{t('sandboxSettings.hint')}</p>
                </>
              )}

              {agentAddMode === 'e2b' && (
                <>
                  <div className="e2b-add-row">
                    <input
                      type="password"
                      placeholder={t('e2bSettings.apiKeyPlaceholder')}
                      value={e2bApiKeyInput}
                      onChange={(e) => { setE2bApiKeyInput(e.target.value); setE2bLocalError(null); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleEnableE2b(); }}
                    />
                    <button
                      className="e2b-add-btn"
                      disabled={e2bEnabling || !e2bApiKeyInput.trim()}
                      onClick={handleEnableE2b}
                    >
                      {e2bEnabling ? t('e2bSettings.starting') : t('e2bSettings.enable')}
                    </button>
                  </div>
                  {e2bLocalError && <p className="settings-error">{e2bLocalError}</p>}
                  <p className="settings-hint">{t('e2bSettings.hint')}</p>
                </>
              )}
            </div>
          )}
          {settingsTab === 'data' && (
            <div className="settings-section">
              <h3>{t('dataSettings.title')}</h3>
              <p className="settings-desc">{t('dataSettings.desc')}</p>

              {dataMessage && (
                <p className={`settings-${dataMessage.type === 'error' ? 'error' : 'success'}`}>{dataMessage.text}</p>
              )}

              <div className="data-storage-card">
                <div className="data-action-icon">
                  <HardDrive width={24} height={24} />
                </div>
                <div className="data-action-info">
                  <span className="data-action-title">{t('dataSettings.storageTitle')}</span>
                  <span className="data-action-desc">{t('dataSettings.storageDesc')}</span>
                </div>
                <div className="data-storage-metric" aria-live="polite">
                  <span className="data-storage-size">
                    {dataStorageStats.loading
                      ? '...'
                      : dataStorageStats.error
                        ? '--'
                        : formatDataSize(dataStorageStats.totalBytes)}
                  </span>
                  <span className="data-storage-detail">
                    {dataStorageStats.loading
                      ? t('dataSettings.storageLoading')
                      : dataStorageStats.error
                        ? t('dataSettings.storageError')
                        : t('dataSettings.storageFiles', { count: dataStorageStats.fileCount })}
                  </span>
                </div>
              </div>

              <div className="data-actions">
                <div className="data-action-card">
                  <div className="data-action-icon">
                    <UploadCloud width={24} height={24} />
                  </div>
                  <div className="data-action-info">
                    <span className="data-action-title">{t('dataSettings.exportTitle')}</span>
                    <span className="data-action-desc">{t('dataSettings.exportDesc')}</span>
                  </div>
                  <button
                    className="data-action-btn"
                    disabled={dataExporting || dataImporting || factoryResetting}
                    onClick={async () => {
                      if (dataOperationBusyRef.current) return;
                      dataOperationBusyRef.current = true;
                      setDataExporting(true);
                      setDataMessage(null);
                      try {
                        const blob = await runWithStorageBarrier(() => exportToZip());
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `cherry-agent-backup-${new Date().toISOString().slice(0, 10)}.zip`;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(url);
                        setDataMessage({ type: 'success', text: t('dataSettings.exportSuccess') });
                      } catch (err) {
                        setDataMessage({ type: 'error', text: t('dataSettings.exportFailed', { error: err.message }) });
                      } finally {
                        setDataExporting(false);
                        dataOperationBusyRef.current = false;
                      }
                    }}
                  >
                    {dataExporting ? t('dataSettings.exporting') : t('dataSettings.export')}
                  </button>
                </div>

                <div className="data-action-card">
                  <div className="data-action-icon">
                    <DownloadCloud width={24} height={24} />
                  </div>
                  <div className="data-action-info">
                    <span className="data-action-title">{t('dataSettings.importTitle')}</span>
                    <span className="data-action-desc">{t('dataSettings.importDesc')}</span>
                  </div>
                  <input
                    ref={zipInputRef}
                    type="file"
                    accept=".zip"
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (dataOperationBusyRef.current) {
                        e.target.value = '';
                        return;
                      }
                      dataOperationBusyRef.current = true;
                      setDataImporting(true);
                      setDataMessage(null);
                      try {
                        await runWithStorageBarrier(async () => {
                          try {
                            cancelPendingAutoSync();
                            let importError = null;
                            try {
                              await importFromZip(file);
                            } catch (error) {
                              importError = error;
                            }
                            try {
                              await onStorageRestored?.();
                            } catch (refreshError) {
                              if (!importError) throw refreshError;
                              console.warn('Storage refresh after partial import failed:', refreshError);
                            }
                            if (importError) throw importError;
                          } finally {
                            cancelPendingAutoSync();
                          }
                        });
                        setDataMessage({ type: 'success', text: t('dataSettings.importSuccess') });
                      } catch (err) {
                        setDataMessage({ type: 'error', text: t('dataSettings.importFailed', { error: err.message }) });
                      } finally {
                        setDataImporting(false);
                        dataOperationBusyRef.current = false;
                        if (zipInputRef.current) zipInputRef.current.value = '';
                      }
                    }}
                  />
                  <button
                    className="data-action-btn"
                    disabled={dataExporting || dataImporting || factoryResetting}
                    onClick={() => zipInputRef.current?.click()}
                  >
                    {dataImporting ? t('dataSettings.importing') : t('dataSettings.import')}
                  </button>
                </div>

                <div className="data-action-card danger">
                  <div className="data-action-icon danger">
                    <AlertTriangle width={24} height={24} />
                  </div>
                  <div className="data-action-info">
                    <span className="data-action-title danger">{t('dataSettings.factoryResetTitle')}</span>
                    <span className="data-action-desc">{t('dataSettings.factoryResetDesc')}</span>
                  </div>
                  <button
                    className="data-action-btn danger"
                    disabled={dataExporting || dataImporting || factoryResetting}
                    onClick={async () => {
                      if (dataOperationBusyRef.current) return;
                      if (!window.confirm(t('dataSettings.factoryResetConfirm'))) return;
                      dataOperationBusyRef.current = true;
                      setFactoryResetting(true);
                      setDataMessage(null);
                      try {
                        await enqueueStorageOperation(() => onFactoryReset());
                        setDataMessage({ type: 'success', text: t('dataSettings.factoryResetSuccess') });
                      } catch (err) {
                        setDataMessage({ type: 'error', text: t('dataSettings.factoryResetFailed', { error: err.message }) });
                      } finally {
                        setFactoryResetting(false);
                        dataOperationBusyRef.current = false;
                      }
                    }}
                  >
                    {factoryResetting ? t('dataSettings.factoryResetting') : t('dataSettings.factoryReset')}
                  </button>
                </div>
              </div>
            </div>
          )}
          {settingsTab === 'sync' && (
            <div className="settings-section">
              <h3>{t('syncSettings.title')}</h3>
              <p className="settings-desc">{t('syncSettings.desc')}</p>

              {syncMessage && (
                <p className={`settings-${syncMessage.type === 'error' ? 'error' : 'success'}`}>{syncMessage.text}</p>
              )}

              <div className="sync-warning">
                <AlertTriangle width={16} height={16} />
                <span>{t('syncSettings.warning')}</span>
              </div>

              <div className={`sync-storage-protection sync-storage-protection-${storagePersistence || 'checking'}`}>
                {storagePersistence === STORAGE_PERSISTENCE_STATUS.PERSISTENT
                  ? <HardDrive width={18} height={18} />
                  : <AlertTriangle width={18} height={18} />}
                <div className="sync-storage-protection-copy">
                  <span className="sync-storage-protection-title">
                    {t('syncSettings.storageProtectionTitle')}
                  </span>
                  <span>
                    {storagePersistence === STORAGE_PERSISTENCE_STATUS.PERSISTENT
                      ? t('syncSettings.storageProtectionGranted')
                      : storagePersistence === STORAGE_PERSISTENCE_STATUS.BEST_EFFORT
                        ? t('syncSettings.storageProtectionBestEffort')
                        : storagePersistence === STORAGE_PERSISTENCE_STATUS.UNSUPPORTED
                          ? t('syncSettings.storageProtectionUnsupported')
                          : storagePersistence === STORAGE_PERSISTENCE_STATUS.UNKNOWN
                            ? t('syncSettings.storageProtectionUnknown')
                            : t('syncSettings.storageProtectionChecking')}
                  </span>
                </div>
                {[
                  STORAGE_PERSISTENCE_STATUS.BEST_EFFORT,
                  STORAGE_PERSISTENCE_STATUS.UNKNOWN,
                ].includes(storagePersistence) && (
                  <button
                    className="settings-secondary"
                    type="button"
                    disabled={storagePersistenceBusy}
                    onClick={requestStorageProtection}
                  >
                    {storagePersistenceBusy
                      ? t('syncSettings.storageProtectionRequesting')
                      : t('syncSettings.storageProtectionRequest')}
                  </button>
                )}
              </div>

              <label className="settings-checkbox-row">
                <input
                  type="checkbox"
                  checked={syncForm.enabled}
                  onChange={(e) => setSyncForm((f) => ({ ...f, enabled: e.target.checked }))}
                />
                <span>{t('syncSettings.enabled')}</span>
              </label>

              <label>{t('syncSettings.provider')}</label>
              <select
                value={syncForm.providerPreset}
                onChange={(e) => {
                  const preset = e.target.value;
                  setSyncForm((f) => ({
                    ...f,
                    providerPreset: preset,
                    region: preset === 'aliyun-oss' && (!f.region || f.region === 'us-east-1')
                      ? 'cn-beijing'
                      : f.region,
                    forcePathStyle: pathStyleForProviderPreset(preset, f.forcePathStyle),
                    bucketEndpoint: (preset === 'aliyun-oss' || preset === 'custom')
                      ? f.bucketEndpoint
                      : false,
                    manifestMode: preset === 'aliyun-oss' ? 'sharded' : f.manifestMode,
                  }));
                }}
              >
                <option value="s3">{t('syncSettings.providerS3')}</option>
                <option value="aliyun-oss">{t('syncSettings.providerOss')}</option>
                <option value="minio">{t('syncSettings.providerMinio')}</option>
                <option value="custom">{t('syncSettings.providerCustom')}</option>
              </select>

              <div className="settings-two-col">
                <label>
                  {t('syncSettings.endpoint')}
                  <input
                    type="text"
                    placeholder={t('syncSettings.endpointPlaceholder')}
                    value={syncForm.endpoint}
                    onChange={(e) => setSyncForm((f) => ({ ...f, endpoint: e.target.value }))}
                  />
                </label>
                <label>
                  {t('syncSettings.region')}
                  <input
                    type="text"
                    placeholder="us-east-1"
                    value={syncForm.region}
                    onChange={(e) => setSyncForm((f) => ({ ...f, region: e.target.value }))}
                  />
                </label>
              </div>

              <label>{t('syncSettings.bucket')}</label>
              <input
                type="text"
                placeholder={t('syncSettings.bucketPlaceholder')}
                value={syncForm.bucket}
                onChange={(e) => setSyncForm((f) => ({ ...f, bucket: e.target.value }))}
              />

              <label>{t('syncSettings.prefix')}</label>
              <input
                type="text"
                placeholder="cherry-agent"
                value={syncForm.prefix}
                onChange={(e) => setSyncForm((f) => ({ ...f, prefix: e.target.value }))}
              />

              <div className="settings-two-col">
                <label>
                  {t('syncSettings.accessKeyId')}
                  <input
                    type="text"
                    value={syncForm.accessKeyId}
                    onChange={(e) => setSyncForm((f) => ({ ...f, accessKeyId: e.target.value }))}
                  />
                </label>
                <label>
                  {t('syncSettings.secretAccessKey')}
                  <input
                    type="password"
                    placeholder={config.get('sync.secretAccessKey') ? t('syncSettings.secretSaved') : ''}
                    value={syncForm.secretAccessKey}
                    onChange={(e) => setSyncForm((f) => ({ ...f, secretAccessKey: e.target.value }))}
                  />
                </label>
              </div>

              <label>
                {t('syncSettings.sessionToken')}
                <input
                  type="password"
                  placeholder={config.get('sync.sessionToken') ? t('syncSettings.tokenSaved') : t('syncSettings.sessionTokenPlaceholder')}
                  value={syncForm.sessionToken}
                  disabled={syncForm.clearSessionToken}
                  onChange={(e) => setSyncForm((f) => ({
                    ...f,
                    sessionToken: e.target.value,
                    clearSessionToken: false,
                  }))}
                />
              </label>
              {config.get('sync.sessionToken') && (
                <label className="settings-checkbox-row">
                  <input
                    type="checkbox"
                    checked={syncForm.clearSessionToken}
                    onChange={(e) => setSyncForm((f) => ({
                      ...f,
                      clearSessionToken: e.target.checked,
                      ...(e.target.checked ? { sessionToken: '' } : {}),
                    }))}
                  />
                  <span>{t('syncSettings.clearSessionToken')}</span>
                </label>
              )}

              <label className="settings-checkbox-row">
                <input
                  type="checkbox"
                  checked={syncForm.forcePathStyle}
                  disabled={syncForm.providerPreset !== 'custom' || syncForm.bucketEndpoint}
                  onChange={(e) => setSyncForm((f) => ({
                    ...f,
                    forcePathStyle: e.target.checked,
                    ...(e.target.checked ? { bucketEndpoint: false } : {}),
                  }))}
                />
                <span>{t('syncSettings.forcePathStyle')}</span>
              </label>

              <label className="settings-checkbox-row">
                <input
                  type="checkbox"
                  checked={syncForm.bucketEndpoint}
                  disabled={!['aliyun-oss', 'custom'].includes(syncForm.providerPreset)}
                  onChange={(e) => setSyncForm((f) => ({
                    ...f,
                    bucketEndpoint: e.target.checked,
                    ...(e.target.checked ? { forcePathStyle: false } : {}),
                  }))}
                />
                <span>{t('syncSettings.bucketEndpoint')}</span>
              </label>
              <p className="settings-hint">{t('syncSettings.bucketEndpointHint')}</p>

              <div className="settings-two-col">
                <label className="settings-checkbox-row inline">
                  <input
                    type="checkbox"
                    checked={syncForm.autoOnStart}
                    onChange={(e) => setSyncForm((f) => ({ ...f, autoOnStart: e.target.checked }))}
                  />
                  <span>{t('syncSettings.autoOnStart')}</span>
                </label>
                <label>
                  {t('syncSettings.autoInterval')}
                  <input
                    type="number"
                    min="0"
                    step="1"
                    placeholder={t('syncSettings.autoIntervalPlaceholder')}
                    value={syncForm.autoIntervalMinutes}
                    onChange={(e) => setSyncForm((f) => ({ ...f, autoIntervalMinutes: e.target.value }))}
                  />
                </label>
              </div>

              <label>
                {t('syncSettings.maxConcurrentRequests')}
                <input
                  type="number"
                  min="1"
                  max="8"
                  step="1"
                  value={syncForm.maxConcurrentRequests}
                  onChange={(e) => setSyncForm((f) => ({ ...f, maxConcurrentRequests: e.target.value }))}
                />
              </label>

              <label>{t('syncSettings.manifestMode')}</label>
              <select
                value={syncForm.providerPreset === 'aliyun-oss' ? 'sharded' : syncForm.manifestMode}
                disabled={syncForm.providerPreset === 'aliyun-oss'}
                onChange={(e) => setSyncForm((f) => ({ ...f, manifestMode: e.target.value }))}
              >
                <option
                  value="conditional"
                  disabled={manifestModeChangeLockedFor({ ...syncForm, manifestMode: 'conditional' })}
                >
                  {t('syncSettings.manifestConditional')}
                </option>
                <option
                  value="sharded"
                  disabled={manifestModeChangeLockedFor({ ...syncForm, manifestMode: 'sharded' })}
                >
                  {t('syncSettings.manifestSharded')}
                </option>
              </select>
              <p className="settings-hint">{t('syncSettings.manifestModeHint')}</p>

              <div className="sync-actions">
                <button className="settings-secondary" disabled={Boolean(syncBusy)} onClick={() => runSyncAction('test', testSyncConnection)}>
                  <Plug width={16} height={16} />
                  {syncBusy === 'test' ? t('syncSettings.working') : t('syncSettings.test')}
                </button>
                <button className="settings-secondary" disabled={Boolean(syncBusy)} onClick={() => runSyncAction('pull', pullSync)}>
                  <Download width={16} height={16} />
                  {syncBusy === 'pull' ? t('syncSettings.working') : t('syncSettings.pull')}
                </button>
                <button className="settings-secondary" disabled={Boolean(syncBusy)} onClick={() => runSyncAction('push', pushSync)}>
                  <Upload width={16} height={16} />
                  {syncBusy === 'push' ? t('syncSettings.working') : t('syncSettings.push')}
                </button>
                <button className="settings-secondary" disabled={Boolean(syncBusy)} onClick={() => runSyncAction('sync', syncNow)}>
                  <Refresh width={16} height={16} />
                  {syncBusy === 'sync' ? t('syncSettings.working') : t('syncSettings.syncNow')}
                </button>
              </div>

              <div className="settings-actions">
                <button className="settings-cancel" onClick={onClose}>{t('settings.cancel')}</button>
                <button className="settings-save" onClick={handleSaveSync}>{t('settings.save')}</button>
              </div>
            </div>
          )}
          {settingsTab === 'appearance' && (
            <div className="settings-section">
              <h3>{t('appearanceSettings.title')}</h3>
              <p className="settings-desc">{t('appearanceSettings.desc')}</p>

              <label>{t('appearanceSettings.theme')}</label>
              <div className="theme-options">
                {[
                  { value: 'light', label: t('appearanceSettings.light'), icon: (
                    <Sun width={20} height={20} />
                  )},
                  { value: 'dark', label: t('appearanceSettings.dark'), icon: (
                    <Moon width={20} height={20} />
                  )},
                  { value: 'system', label: t('appearanceSettings.system'), icon: (
                    <Monitor width={20} height={20} />
                  )},
                ].map((opt) => (
                  <button
                    key={opt.value}
                    className={`theme-option ${theme === opt.value ? 'active' : ''}`}
                    onClick={() => onThemeChange(opt.value)}
                  >
                    {opt.icon}
                    <span>{opt.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {settingsTab === 'language' && (
            <div className="settings-section">
              <h3>{t('languageSettings.title')}</h3>
              <p className="settings-desc">{t('languageSettings.desc')}</p>

              <label>{t('languageSettings.label')}</label>
              <div className="theme-options">
                {SUPPORTED_LOCALES.map((loc) => (
                  <button
                    key={loc.id}
                    className={`theme-option ${localePref === loc.id ? 'active' : ''}`}
                    onClick={() => changeLocale(loc.id)}
                  >
                    <span>{loc.id === 'auto' ? t('languageSettings.auto') : loc.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {settingsTab === 'agents' && (
            <div className="settings-section">
              <h3>{t('agentSettings.title')}</h3>
              <p className="settings-desc">{t('agentSettings.desc')}</p>

              {agentsLoading && (
                <div className="skills-loading">{t('filemanage.loading')}</div>
              )}

              {!agentsLoading && agentsTabList.length === 0 && (
                <div className="sandboxes-empty">{t('agentSettings.empty')}</div>
              )}

              {!agentsLoading && agentsTabList.length > 0 && (
                <>
                  <div className="agents-actions">
                    <button
                      className="agent-add-btn"
                      onClick={handleCreateAgent}
                    >
                      {t('agentSettings.addAgent')}
                    </button>
                  </div>

                  <div className="agents-list">
                    {agentsTabList.map((agent) => (
                      <div key={agent.id} className="agent-item">
                        <div className="agent-info">
                          {editingAgentId === agent.id ? (
                            <div className="agent-edit-row">
                              <input
                                type="text"
                                value={editingAgentName}
                                onChange={(e) => setEditingAgentName(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleSaveAgentName(agent.id);
                                  if (e.key === 'Escape') setEditingAgentId(null);
                                }}
                                autoFocus
                                className="agent-name-input"
                              />
                              <button className="agent-save-btn" onClick={() => handleSaveAgentName(agent.id)}>
                                {t('settings.save')}
                              </button>
                              <button className="agent-cancel-btn" onClick={() => setEditingAgentId(null)}>
                                {t('sandboxSettings.cancel')}
                              </button>
                            </div>
                          ) : (
                            <div className="agent-name" onClick={() => handleStartEditAgent(agent)}>
                              {agent.name}
                            </div>
                          )}
                          <div className="agent-meta">
                            {t('agentSettings.created')} {new Date(agent.createdAt).toLocaleDateString()}
                          </div>
                          <div className="agent-id-label">{agent.id}</div>
                          <div className="agent-defaults">
                            <label>
                              {t('agentSettings.runtime')}
                              <select
                                value={agent.runtimeMode || 'browser'}
                                onChange={(e) => handleAgentDefaultChange(agent.id, { runtimeMode: e.target.value })}
                              >
                                <option value="browser">{t('agentSettings.browserRuntime')}</option>
                                <option value="sandbox">{t('agentSettings.sandboxRuntime')}</option>
                              </select>
                            </label>
                            <label>
                              {t('agentSettings.defaultLlm')}
                              <select
                                value={agent.llmProfileId || ''}
                                onChange={(e) => handleAgentDefaultChange(agent.id, { llmProfileId: e.target.value || null })}
                              >
                                <option value="">{t('agentSettings.firstConfiguredLlm')}</option>
                                {llmProfiles.map((profile) => (
                                  <option key={profile.id} value={profile.id}>
                                    {profile.name || `${profile.provider} / ${profile.model}`}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              {t('agentSettings.sandbox')}
                              <select
                                value={agent.sandboxUrl || ''}
                                onChange={(e) => handleAgentDefaultChange(agent.id, { sandboxUrl: e.target.value || null })}
                              >
                                <option value="">{t('agentSettings.noSandbox')}</option>
                                {agents.map((sandbox) => (
                                  <option
                                    key={sandbox.url}
                                    value={sandbox.url}
                                    disabled={agent.runtimeMode === 'sandbox' && sandbox.isE2b}
                                  >
                                    {sandbox.name}{sandbox.isE2b && agent.runtimeMode === 'sandbox' ? ` (${t('agentSettings.commandOnly')})` : sandbox.status !== 'connected' ? ` (${sandbox.status})` : ''}
                                  </option>
                                ))}
                              </select>
                            </label>
                            {agent.runtimeMode === 'sandbox' && !agent.sandboxUrl && (
                              <span className="settings-error">{t('agentSettings.runtimeNeedsSandbox')}</span>
                            )}
                          </div>
                        </div>
                        {agentsTabList.length > 1 && (
                          <button
                            className="agent-remove-btn"
                            onClick={() => handleDeleteAgent(agent.id)}
                            title={t('agentSettings.removeAgent')}
                          >
                            <X width={14} height={14} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          {settingsTab === 'skills' && (
            <div className="settings-section">
              <h3>{t('skillSettings.title')}</h3>
              <p className="settings-desc">{t('skillSettings.desc')}</p>

              {skillsLoading && (
                <div className="skills-loading">{t('filemanage.loading')}</div>
              )}

              {!skillsLoading && skillsList.length === 0 && (
                <div className="sandboxes-empty">{t('skillSettings.empty')}</div>
              )}

              {!skillsLoading && skillsList.length > 0 && (
                <>
                  <div className="skills-bulk-actions">
                    <button
                      className="skills-bulk-btn"
                      onClick={() => handleBulkToggle(true)}
                    >
                      {t('skillSettings.enableAll')}
                    </button>
                    <button
                      className="skills-bulk-btn"
                      onClick={() => handleBulkToggle(false)}
                    >
                      {t('skillSettings.disableAll')}
                    </button>
                  </div>

                  <div className="skills-list">
                    {skillsList.map((skill) => (
                      <div key={skill.name} className={`skill-item ${skill.enabled ? 'enabled' : 'disabled'}`}>
                        <div className="skill-info">
                          <div className="skill-name">{skill.name}</div>
                          <div className="skill-desc">{skill.description}</div>
                          <div className="skill-version">{t('skillSettings.version')}: {skill.version}</div>
                        </div>
                        <label className="skill-toggle">
                          <input
                            type="checkbox"
                            checked={skill.enabled}
                            onChange={(e) => handleSkillToggle(skill.name, e.target.checked)}
                          />
                          <span className="skill-toggle-slider"></span>
                        </label>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          {settingsTab === 'tools' && (
            <div className="settings-section">
              <h3>{t('toolSettings.title')}</h3>
              <p className="settings-desc">{t('toolSettings.desc')}</p>

              {toolsLoading && (
                <div className="skills-loading">{t('filemanage.loading')}</div>
              )}

              {!toolsLoading && toolsList.length === 0 && (
                <div className="sandboxes-empty">{t('toolSettings.empty')}</div>
              )}

              {!toolsLoading && toolsList.length > 0 && (
                <>
                  <div className="skills-bulk-actions">
                    <button
                      className="skills-bulk-btn"
                      onClick={() => handleBulkToolToggle(true)}
                    >
                      {t('toolSettings.enableAll')}
                    </button>
                    <button
                      className="skills-bulk-btn"
                      onClick={() => handleBulkToolToggle(false)}
                    >
                      {t('toolSettings.disableAll')}
                    </button>
                  </div>

                  <div className="skills-list">
                    {toolsList.map((tool) => (
                      <div key={tool.name} className={`skill-item ${tool.enabled ? 'enabled' : 'disabled'}`}>
                        <div className="skill-info">
                          <div className="skill-name">{tool.name}</div>
                          <div className="skill-desc">{tool.description}</div>
                        </div>
                        <label className="skill-toggle">
                          <input
                            type="checkbox"
                            checked={tool.enabled}
                            onChange={(e) => handleToolToggle(tool.name, e.target.checked)}
                          />
                          <span className="skill-toggle-slider"></span>
                        </label>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Settings;
