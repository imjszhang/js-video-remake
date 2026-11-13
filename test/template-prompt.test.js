import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPromptScript, promptText, promptSrt, promptJson, promptCards, renderPromptScript } from '../src/template-prompt.js';

const rows = [
    { index: 0, start: 0, end: 2, zh: '第一句', en: 'First line' },
    { index: 1, start: 2, end: 4, zh: '第二句 {{name}}', en: 'Second line' },
    { index: 2, start: 10, end: 12, zh: '第三句', en: '' },
];
const fields = { name: { default: '你的名字' } };

test('prompt text drops timecodes, inserts long pauses and skips empty lines', () => {
    const script = buildPromptScript({ rows, identity: { name: '小林' }, fields, duration: 20, language: 'zh' });
    assert.equal(script.count, 3);
    assert.equal(script.skipped, 0);
    assert.equal(script.pauses, 1);
    assert.equal(promptText(script), '第一句\n第二句 小林\n……（停顿 6.0 秒）……\n第三句\n');
    assert.equal(script.lines[1].charsPerSecond, 3);
});

test('english prompt skips empty english rows and keeps the timeline gaps', () => {
    const script = buildPromptScript({ rows, identity: { name: 'Lin' }, fields, duration: 20, language: 'en' });
    assert.equal(script.count, 2);
    assert.equal(script.skipped, 1);
    // The empty English row is skipped and nothing follows, so no trailing pause is emitted.
    assert.equal(promptText(script), 'First line\nSecond line\n');
});

test('unfilled identity placeholders are refused with the sentence number', () => {
    assert.throws(() => buildPromptScript({ rows, identity: {}, duration: 20 }), /第 2 句.*\{\{name\}\}/);
    assert.throws(() => buildPromptScript({ rows, identity: { name: '  ' }, duration: 20 }), /第 2 句/);
    assert.throws(() => buildPromptScript({ rows, identity: { name: '你的名字' }, fields, duration: 20 }), /仍是模板默认值「你的名字」/);
    const kept = buildPromptScript({ rows, identity: { name: '你的名字' }, fields, duration: 20, allowPlaceholders: true });
    assert.match(promptText(kept), /第二句 你的名字/);
});

test('srt keeps fixed caption windows and skips silent lines', () => {
    const script = buildPromptScript({ rows, identity: { name: '小林' }, fields, duration: 20 });
    assert.equal(promptSrt(script), [
        '1', '00:00:00,000 --> 00:00:02,000', '第一句', '',
        '2', '00:00:02,000 --> 00:00:04,000', '第二句 小林', '',
        '3', '00:00:10,000 --> 00:00:12,000', '第三句', '',
    ].join('\n'));
});

test('json and cards are stable documents', () => {
    const script = buildPromptScript({ rows, identity: { name: '小林' }, fields, duration: 20 });
    const parsed = JSON.parse(promptJson(script, { slug: 'demo', video: 'demo-v1' }));
    assert.equal(parsed.format, 'video-prompt@1');
    assert.equal(parsed.lines.length, 3);
    assert.deepEqual(parsed.lines[1], { index: 1, start: 2, end: 4, text: '第二句 小林', charsPerSecond: 3 });
    const cards = promptCards(script, { title: '演示' });
    assert.match(cards, /<title>演示<\/title>/);
    assert.match(cards, /停顿 6\.0 秒/);
    assert.match(cards, /第二句 小林/);
    assert.equal(renderPromptScript(script, 'txt'), promptText(script));
    assert.throws(() => renderPromptScript(script, 'pdf'), /txt、srt、json 或 cards/);
});

test('input validation rejects bad languages, formats and overlapping rows', () => {
    assert.throws(() => buildPromptScript({ rows, identity: { name: 'x' }, duration: 20, language: 'fr' }), /中文或英文/);
    assert.throws(() => buildPromptScript({ rows: [], duration: 20 }), /没有可导出的字幕/);
    assert.throws(() => buildPromptScript({ rows: [{ start: 2, end: 1, zh: 'x' }], duration: 20 }), /时间窗无效/);
    assert.throws(() => buildPromptScript({ rows: [{ start: 0, end: 1, zh: '' }], duration: 20 }), /没有可朗读/);
});
