import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSessionTitleRequest,
  cleanGeneratedSessionTitle,
  normalizeAutoTitleConfig,
  selectAutoTitleProfileId,
} from './sessionTitle.js';

test('auto title is enabled by default and has no fixed profile', () => {
  assert.deepEqual(normalizeAutoTitleConfig(), { enabled: true, llmProfileId: null });
  assert.deepEqual(normalizeAutoTitleConfig({ enabled: false, llmProfileId: 'cheap' }), {
    enabled: false,
    llmProfileId: 'cheap',
  });
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

test('generated titles are reduced to plain concise text', () => {
  assert.equal(cleanGeneratedSessionTitle('```text\n标题：配置错误排查。\n```'), '配置错误排查');
  assert.equal(cleanGeneratedSessionTitle('{"title":"Fast model selection"}'), 'Fast model selection');
  assert.equal(cleanGeneratedSessionTitle(''), null);
});
