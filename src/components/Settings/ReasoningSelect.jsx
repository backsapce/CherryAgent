import './ReasoningSelect.css';
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
  const levels = capability?.provider === provider && capability?.model === model ? capability.levels : [];
  if (!levels.length) return null;
  const configuredValue = defaultSetting ? defaultEffort : profile?.reasoningEffort || '';
  const value = levels.includes(configuredValue) ? configuredValue : '';
  const title = t(defaultSetting ? 'llmSettings.defaultReasoningEffort' : 'llmSettings.reasoningEffort');
  const valueLabel = value ? t(`llmSettings.reasoning_${value}`)
    : t(defaultSetting ? 'llmSettings.reasoningAuto' : 'llmSettings.reasoningInherit');
  return <label className={`reasoning-selector${defaultSetting ? ' reasoning-selector-default' : ' reasoning-selector-toolbar'}`}>
    <span className="reasoning-selector-title">{title}</span>
    {!defaultSetting && <span className="reasoning-selector-value" aria-hidden="true">{valueLabel}</span>}
    <select aria-label={title} title={`${title}: ${valueLabel}`} disabled={saving} value={value}
      onChange={async (event) => {
        const value = event.target.value;
        setSaving(true);
        setError('');
        try {
          if (defaultSetting) {
            await config.set('reasoning.defaultEffort', value || null);
            setDefaultEffort(value);
          } else await onChange?.({ id: profile.id, reasoningEffort: value || null });
        } catch (err) { setError(err.message); }
        finally { setSaving(false); }
      }}>
      <option value="">{t(defaultSetting ? 'llmSettings.reasoningAuto' : 'llmSettings.reasoningInherit')}</option>
      {levels.map((level) => <option key={level} value={level}>{t(`llmSettings.reasoning_${level}`)}</option>)}
    </select>
    {error && <span role="alert">{error}</span>}
  </label>;
}
