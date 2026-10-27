import './ReasoningSelect.css';
import Select from '../Select/Select';
import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n/context';
import config from '../../config/config';
import { resolveReasoningLevels } from '../../models/reasoning';

export default function ReasoningSelect({ profile, onChange, defaultSetting = false }) {
  const { t } = useI18n();
  const [capability, setCapability] = useState(null);
  const [defaultEffort, setDefaultEffort] = useState(() => config.get('reasoning.defaultEffort') || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const provider = profile?.provider;
  const model = profile?.model;
  useEffect(() => {
    if (!provider || !model) return;
    let cancelled = false;
    resolveReasoningLevels(provider, model).then((levels) => {
      if (!cancelled) setCapability({ provider, model, levels });
    });
    return () => { cancelled = true; };
  }, [provider, model]);
  const levels = capability?.provider === provider && capability?.model === model && capability?.levels ? capability.levels : [];
  if (!levels.length) return null;
  const configuredValue = defaultSetting ? defaultEffort : profile?.reasoningEffort || '';
  const value = levels.includes(configuredValue) ? configuredValue : '';
  const title = t(defaultSetting ? 'llmSettings.defaultReasoningEffort' : 'llmSettings.reasoningEffort');
  const valueLabel = value ? t(`llmSettings.reasoning_${value}`)
    : t(defaultSetting ? 'llmSettings.reasoningAuto' : 'llmSettings.reasoningInherit');
  const handleChange = async (nextValue) => {
    setSaving(true);
    setError('');
    try {
      if (defaultSetting) {
        await config.set('reasoning.defaultEffort', nextValue || null);
        setDefaultEffort(nextValue);
      } else await onChange?.({ id: profile.id, reasoningEffort: nextValue || null });
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };
  if (defaultSetting) {
    return <div className="reasoning-selector reasoning-selector-default">
      <span className="reasoning-selector-title">{title}</span>
      <Select ariaLabel={title} title={`${title}: ${valueLabel}`} disabled={saving} value={value} onChange={handleChange}>
        <option value="">{t('llmSettings.reasoningAuto')}</option>
        {levels.map((level) => <option key={level} value={level}>{t(`llmSettings.reasoning_${level}`)}</option>)}
      </Select>
      {error && <span role="alert">{error}</span>}
    </div>;
  }
  return <Select
    className="reasoning-selector-toolbar"
    ariaLabel={title}
    title={`${title}: ${valueLabel}`}
    disabled={saving}
    value={value}
    onChange={handleChange}
    renderValue={() => (
      <span className="reasoning-selector-label">
        <span className="reasoning-selector-title">{title}</span>
        <span className="reasoning-selector-value">{valueLabel}</span>
      </span>
    )}
  >
    <option value="">{t('llmSettings.reasoningInherit')}</option>
    {levels.map((level) => <option key={level} value={level}>{t(`llmSettings.reasoning_${level}`)}</option>)}
  </Select>;
}
