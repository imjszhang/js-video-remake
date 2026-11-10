import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readZip, writeZip } from '../src/zip.js';

test('writeZip round-trips stored and deflated entries with UTF-8 names', () => {
    const entries = [
        { name: 'pkg/video.json', data: Buffer.from(JSON.stringify({ a: 1, text: '模板'.repeat(200) })) },
        { name: 'pkg/assets/noise.bin', data: Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251)) },
        { name: 'pkg/字幕/说明.md', data: Buffer.from('# 说明\n') },
        { name: 'pkg/empty.txt', data: Buffer.alloc(0) },
    ];
    const back = readZip(writeZip(entries));
    assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
    for (const [i, e] of back.entries()) assert.ok(e.data.equals(entries[i].data), e.name);
});

test('writeZip refuses unsafe or duplicate names, readZip detects corruption', () => {
    assert.throws(() => writeZip([{ name: '../evil', data: Buffer.from('x') }]), /不安全/);
    assert.throws(() => writeZip([{ name: '/abs', data: Buffer.from('x') }]), /不安全/);
    assert.throws(() => writeZip([{ name: 'a', data: Buffer.from('x') }, { name: 'a', data: Buffer.from('y') }]), /重复/);
    const zip = writeZip([{ name: 'a.txt', data: Buffer.from('hello hello hello hello hello') }]);
    const bad = Buffer.from(zip);
    bad[40] ^= 0xff;
    assert.throws(() => readZip(bad));
    assert.throws(() => readZip(Buffer.from('not a zip')), /不是 zip/);
});

test('system unzip accepts the archive', async (t) => {
    if (spawnSync('unzip', ['-v']).status !== 0) { t.skip('unzip not installed'); return; }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'a.video');
    await fs.writeFile(file, writeZip([{ name: 'top/a.txt', data: Buffer.from('abc'.repeat(100)) }, { name: 'top/中文.md', data: Buffer.from('x') }]));
    const r = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /No errors detected/);
});
