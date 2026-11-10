import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendJobLog, eventLog } from '../src/template-job-log.js';

test('console exposes tools and retries but excludes raw protocol and reasoning', () => {
    assert.equal(eventLog({ type: 'raw', data: { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private' }] } } }), null);
    assert.equal(eventLog({ type: 'tool', data: { type: 'reasoning', text: 'private' } }), null);
    assert.match(eventLog({ type: 'tool', data: { name: 'Bash', input: { command: 'TOKEN=secret curl https://user:pass@example.com/a?key=hidden' } } }).text, /TOKEN=\[已隐藏\]/);
    assert.doesNotMatch(eventLog({ type: 'tool', data: { name: 'Read', input: { file_path: 'https://user:pass@example.com/a?key=hidden' } } }).text, /user|pass|hidden/);
    assert.match(eventLog({ type: 'raw', data: { type: 'system', subtype: 'api_retry', attempt: 2, error_status: 503, retry_delay_ms: 3000 } }).text, /503.*3 秒/);
});

test('console retains bounded, ordered output and marks truncation', () => {
    const job = {};
    for (let i = 0; i < 300; i++) appendJobLog(job, { kind: 'tool', text: `${i} ${'x'.repeat(3000)}` });
    assert.equal(job.logSequence, 300);
    assert.ok(job.logs.length <= 200);
    assert.ok(job.logs.reduce((sum, line) => sum + line.text.length, 0) <= 64000);
    assert.ok(job.logsTruncated);
    assert.equal(job.logs.at(-1).sequence, 300);
});
