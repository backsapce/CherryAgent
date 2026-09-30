import { useState, useMemo, useCallback } from 'react';
import { I18nContext } from './context';
import { resolveLocale, createT } from './locales';

export function I18nProvider({ initialLocale = 'auto', onLocaleChange, children }) {
  const [localePref, setLocalePref] = useState(initialLocale || 'auto');
  const resolvedLocale = resolveLocale(localePref);
  const t = useMemo(() => createT(resolvedLocale), [resolvedLocale]);

  // Sync prop changes without useEffect
  if (initialLocale && initialLocale !== localePref) {
    setLocalePref(initialLocale);
  }

  const changeLocale = useCallback((pref) => {
    setLocalePref(pref);
    onLocaleChange?.(pref);
  }, [onLocaleChange]);

  const value = useMemo(() => ({
    t, locale: resolvedLocale, localePref, changeLocale,
  }), [t, resolvedLocale, localePref, changeLocale]);

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
}
