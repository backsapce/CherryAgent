import { useState } from 'react';
import { Cloud } from './Icons';
import { modelLogoUrl } from '../../models/modelLogos';
import './ModelProviderIcon.css';

/**
 * Provider/model logo hotlinked from models.dev
 * (https://models.dev/logos/{provider}.svg). Logos are monochrome SVGs and
 * follow the active theme via a CSS invert filter on dark themes.
 *
 * Falls back to the generic Cloud icon when no logo id can be resolved for
 * the provider/model pair (e.g. bare custom-openai endpoints) or when the
 * hotlink fails (offline/blocked). Unknown-but-plausible ids keep the
 * hotlink: models.dev then serves its own generic logo.
 */
export default function ModelProviderIcon({
  providerId,
  modelId,
  size = 14,
  className = '',
  title,
}) {
  const url = modelLogoUrl(providerId, modelId);
  const [failedUrl, setFailedUrl] = useState(null);
  const failed = !url || failedUrl === url;

  if (failed) {
    return (
      <Cloud
        width={size}
        height={size}
        className={`model-provider-icon model-provider-icon-default${className ? ` ${className}` : ''}`}
        aria-hidden="true"
      />
    );
  }

  return (
    <img
      src={url}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      title={title}
      decoding="async"
      className={`model-provider-icon${className ? ` ${className}` : ''}`}
      onError={() => setFailedUrl(url)}
    />
  );
}
