/**
 * Settings persistence for LLM configuration.
 *
 * Thin adapter that delegates to the central config adapter.
 * LLM settings live under the `llm` key in config.yaml.
 */

import config from '../config/config.js';

/**
 * Load LLM settings from config.yaml → llm section.
 * @returns {Promise<Object|null>} Provider connections and LLM bindings, or null
 */
export async function loadSettings() {
  return config.get('llm') || null;
}

/**
 * Save LLM settings to config.yaml → llm section.
 * @param {Object} settings - Versioned LLM settings document
 */
export async function saveSettings(settings) {
  await config.set('llm', settings);
}
