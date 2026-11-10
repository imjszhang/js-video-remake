import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgv } from '../src/args.js';
import { printHuman } from '../src/format.js';
import { runMain } from './helpers.js';

test('rejects an unknown command', () => {
    assert.throws(() => parseArgv(['explode']), (error) => error.code === 'INVALID_INPUT');
});

test('rejects the removed hypit command', () => {
    assert.throws(() => parseArgv(['hypit', '--', 'plan', 'runs/a.svrun']), (error) => error.code === 'INVALID_INPUT');
    assert.equal(parseArgv(['--help']).help, true);
    assert.equal(parseArgv(['doctor', '--help']).help, true);
});

test('parses comparison inputs, labels, audio, and timing without swallowing the slug', () => {
    const parsed = parseArgv([
        '--json', 'compare', 'demo-announcement',
        '--top', 'productions/demo-announcement/drafts/preview-h3-swap-v5.mp4',
        '--bottom=productions/demo-announcement/drafts/preview.mp4',
        '--top-label', 'JS 合成版 v5', '--bottom-label', '原版预览',
        '--audio', 'bottom', '--top-start', '1.25', '--bottom-start=2', '--duration', '12',
    ]);
    assert.equal(parsed.command, 'compare');
    assert.deepEqual(parsed.positionals, ['demo-announcement']);
    assert.deepEqual(parsed.flags, {
        json: true,
        top: 'productions/demo-announcement/drafts/preview-h3-swap-v5.mp4',
        bottom: 'productions/demo-announcement/drafts/preview.mp4',
        topLabel: 'JS 合成版 v5',
        bottomLabel: '原版预览',
        audio: 'bottom',
        topStart: '1.25',
        bottomStart: '2',
        duration: '12',
    });
    assert.deepEqual(parsed.config, {});
});

test('allows comparison baseline reuse but rejects a missing flag value', () => {
    const parsed = parseArgv(['compare', 'demo', '--top', 'drafts/new.mp4']);
    assert.equal(parsed.flags.bottom, undefined);
    assert.throws(() => parseArgv(['compare', 'demo', '--top', '--audio', 'none']),
        (error) => error.code === 'INVALID_INPUT' && error.message.includes('--top requires a value'));
});

test('human comparison output identifies both sources, audio, and latest output', () => {
    const lines = [];
    printHuman({ ok: true, data: {
        command: 'compare', slug: 'demo', version: 'v2', file: '/ws/comparisons/v2/comparison.mp4',
        manifest: {
            inputs: {
                top: { path: '/ws/new.mp4', label: '新版' },
                bottom: { path: '/ws/original.mp4', label: '原版' },
            },
            render: { audio: 'top' },
        },
    } }, (line) => lines.push(line));
    assert.match(lines.join('\n'), /上方: 新版  \/ws\/new.mp4/);
    assert.match(lines.join('\n'), /下方: 原版  \/ws\/original.mp4/);
    assert.match(lines.join('\n'), /音轨: 上方/);
    assert.match(lines.join('\n'), /文件: \/ws\/comparisons\/v2\/comparison.mp4/);

    const entry = [];
    printHuman({ ok: true, data: {
        command: 'get', kind: 'production',
        production: {
            slug: 'demo', status: 'commissioned', referenceIds: ['ref'], dir: 'productions/demo',
            comparison: { version: 'v2', dir: 'productions/demo/drafts/comparisons/v2', file: 'comparison.mp4' },
        },
    } }, (line) => entry.push(line));
    assert.match(entry.join('\n'), /对比: v2  productions\/demo\/drafts\/comparisons\/v2\/comparison.mp4/);
});

test('main prints help and missing-arg errors', async () => {
    const help = await runMain(['--help'], {});
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage: remake/);

    const ingest = await runMain(['ingest', '--json'], {});
    assert.equal(ingest.code, 1);
    assert.match(ingest.stdout, /ingest requires exactly one URL/);

    const start = await runMain(['start', 'youtube-abcdefghijk', '--json'], {});
    assert.equal(start.code, 1);
    assert.match(start.stdout, /--as/);

    const deliver = await runMain(['deliver', '--json'], {});
    assert.equal(deliver.code, 1);
    assert.match(deliver.stdout, /deliver requires a production slug/);

    const compare = await runMain(['compare', '--json'], {});
    assert.equal(compare.code, 1);
    assert.match(compare.stdout, /compare requires a production slug/);

    const compareTop = await runMain(['compare', 'demo', '--json'], {});
    assert.equal(compareTop.code, 1);
    assert.match(compareTop.stdout, /compare requires --top/);
});
