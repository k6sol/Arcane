import test from 'node:test';
import assert from 'node:assert/strict';
import { codexContextWindow, composerContextLeft, composerEffortLevel, pyxSpritePixels, startComposerChrome } from '../../apps/desktop/src/task-usage-ui.js';
import type { TaskUsageView } from '../../apps/desktop/src/task-usage.js';
import { claudeSubagentView } from '../../apps/desktop/src/claude-chat.js';

test('closed model chip: effort becomes 1-3 pips; unknown efforts show none', () => {
  assert.deepEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'High', 'x-high'].map(composerEffortLevel), [1, 1, 2, 3, 3, 3, 3, 3]);
  assert.deepEqual(['', 'auto', null, undefined].map(composerEffortLevel), [0, 0, 0, 0]);
});

test('context ring: whole percent left of a reported window only; nothing is estimated without one', () => {
  assert.equal(composerContextLeft({ usedTokens: 124000, windowTokens: 200000 }), 38);
  assert.equal(composerContextLeft({ usedTokens: 182000, windowTokens: 200000 }), 9);
  assert.equal(composerContextLeft({ usedTokens: 250000, windowTokens: 200000 }), 0);
  for (const value of [null, undefined, { usedTokens: 10, windowTokens: 0 }, { usedTokens: -1, windowTokens: 10 }, { usedTokens: Number.NaN, windowTokens: 10 }]) assert.equal(composerContextLeft(value), null);
  const view = (lastRequest: { totalTokens: number } | null, modelContextWindow: number | null) => ({ lastRequest, modelContextWindow }) as unknown as TaskUsageView;
  assert.deepEqual(codexContextWindow(view({ totalTokens: 52000 }, 272000)), { usedTokens: 52000, windowTokens: 272000 });
  assert.equal(codexContextWindow(view({ totalTokens: 52000 }, null)), null);
  assert.equal(codexContextWindow(view(null, 272000)), null);
  assert.equal(codexContextWindow(null), null);
});

test('Pyx sprite: 24x24 ShardPet frames in the five-colour palette; idle and working swap frames, done holds one', () => {
  const palette = new Set(['#14040A', '#8E0F22', '#E5323F', '#FF6B78', '#FFFFFF']);
  const key = (mood: 'idle' | 'listening' | 'working' | 'done', frame: 1 | 2) => JSON.stringify(pyxSpritePixels(mood, frame));
  for (const mood of ['idle', 'listening', 'working', 'done'] as const) for (const frame of [1, 2] as const) {
    const pixels = pyxSpritePixels(mood, frame);
    assert.ok(pixels.length > 60, mood);
    for (const p of pixels) { assert.ok(p.x >= 0 && p.w >= 1 && p.x + p.w <= 24 && p.y >= 0 && p.y < 24, mood + ' in bounds'); assert.ok(palette.has(p.fill), p.fill); }
  }
  assert.notEqual(key('idle', 1), key('idle', 2));
  assert.notEqual(key('working', 1), key('working', 2));
  assert.equal(key('done', 1), key('done', 2));
  assert.notEqual(key('listening', 1), key('idle', 1));
});

test('Claude sub-agents are listed by agent type and short task, never by their prompt', () => {
  assert.deepEqual(claudeSubagentView({ name: 'Agent', status: 'started', input: JSON.stringify({ description: 'Mapping cave mouths', subagent_type: 'terrain-scout', prompt: '[900 characters]' }) }),
    { name: 'terrain-scout', task: 'Mapping cave mouths', state: 'started' });
  assert.deepEqual(claudeSubagentView({ name: 'Task', status: 'finished', input: JSON.stringify({ description: '  Check   models ', subagent_type: 'general-purpose' }) }),
    { name: 'Agent', task: 'Check models', state: 'finished' });
  assert.deepEqual(claudeSubagentView({ name: 'Agent', status: 'failed' }), { name: 'Agent', task: '', state: 'failed' });
});

test('composer chrome stays inert without the shared composer', () => {
  const chrome = startComposerChrome({ getElementById: () => null } as unknown as Document);
  assert.equal(chrome.mood(), 'idle');
  chrome.refresh(); chrome.stop(); chrome.resume();
});
