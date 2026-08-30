import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSessionTitleRequest,
  cleanGeneratedSessionTitle,
  getDefaultSessionTitlePrompt,
  normalizeAutoTitleConfig,
  selectAutoTitleProfileId,
} from './sessionTitle.js';

test('auto title is enabled by default and has no fixed profile or custom prompt', () => {
  assert.deepEqual(normalizeAutoTitleConfig(), {
    enabled: true,
    llmProfileId: null,
    promptTemplate: '',
  });
  assert.deepEqual(normalizeAutoTitleConfig({
    enabled: false,
    llmProfileId: 'cheap',
    promptTemplate: 'Use a terse title.',
  }), {
    enabled: false,
    llmProfileId: 'cheap',
    promptTemplate: 'Use a terse title.',
  });
  assert.equal(normalizeAutoTitleConfig({ promptTemplate: '  \n' }).promptTemplate, '');
});

test('auto title profile uses a valid preference or the first configured profile', () => {
  const profiles = [
    { id: 'missing-key', configured: false },
    { id: 'first', configured: true },
    { id: 'cheap', configured: true },
  ];
  assert.equal(selectAutoTitleProfileId(profiles, 'cheap'), 'cheap');
  assert.equal(selectAutoTitleProfileId(profiles, 'deleted'), 'first');
  assert.equal(selectAutoTitleProfileId([{ id: 'missing-key', configured: false }]), null);
});

test('title request asks for the selected language and includes both sides of the conversation', () => {
  const request = buildSessionTitleRequest([
    { role: 'user', content: '帮我分析日志' },
    { role: 'assistant', content: '问题来自无效配置。' },
  ], 'zh-CN');
  assert.match(request.systemPrompt, /Simplified Chinese/);
  assert.match(request.systemPrompt, /at most one relevant emoji/);
  assert.match(request.messages[0].content, /帮我分析日志/);
  assert.match(request.messages[0].content, /问题来自无效配置/);
});

test('title request uses a custom prompt and falls back to the localized system template when empty', () => {
  assert.equal(
    buildSessionTitleRequest([], 'ja', 'Use exactly three words.').systemPrompt,
    'Use exactly three words.'
  );
  assert.equal(
    buildSessionTitleRequest([], 'ja', '  \n').systemPrompt,
    getDefaultSessionTitlePrompt('ja')
  );
  assert.match(getDefaultSessionTitlePrompt('ja'), /Japanese/);
});

test('generated titles are reduced to plain concise text', () => {
  assert.equal(cleanGeneratedSessionTitle('```text\n标题：配置错误排查。\n```'), '配置错误排查');
  assert.equal(cleanGeneratedSessionTitle('{"title":"Fast model selection"}'), 'Fast model selection');
  assert.equal(cleanGeneratedSessionTitle(''), null);
});
