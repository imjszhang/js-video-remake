import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readZip, writeZip } from '../src/zip.js';

const archive = (entries = [{ name: 'top/a.txt', data: 'hello'.repeat(100) }]) => writeZip(entries);
const central = (zip) => zip.readUInt32LE(zip.length - 6);
const mutate = (change, entries) => {
    const zip = archive(entries);
    change(zip, central(zip));
    return zip;
};

test('reader rejects unsafe names, Unicode/case collisions and file-directory collisions', () => {
    for (const name of ['C:/a', 'top//a', 'top/./a', 'top/a\0', 'top/a.', 'top/a ']) {
        assert.throws(() => readZip(archive([{ name, data: 'x' }])), /不安全/);
    }
    const zip = archive([{ name: 'top/a', data: 'x' }]);
    zip.write('top\\a', 30);
    zip.write('top\\a', central(zip) + 46);
    assert.throws(() => readZip(zip), /不安全/);
    for (const pair of [['top/A', 'top/a'], ['top/é', 'top/e\u0301'], ['top/a', 'top/a/b']]) {
        assert.throws(() => readZip(archive(pair.map(name => ({ name, data: 'x' })))), /冲突/);
    }
});

test('reader bounds declared file count and sizes before decompression', () => {
    assert.throws(() => readZip(archive(), { maxEntries: 0 }), /数量超过/);
    assert.throws(() => readZip(archive(), { maxEntryBytes: 50 }), /大小超过/);
    assert.throws(() => readZip(archive([{ name: 'a', data: 'x'.repeat(60) }, { name: 'b', data: 'y'.repeat(60) }]), { maxUncompressedBytes: 100 }), /大小超过/);
    assert.throws(() => readZip(mutate((zip, at) => {
        zip.writeUInt32LE(1, at + 24);
        zip.writeUInt32LE(1, 22);
    })), /超过声明大小/);
});

test('reader rejects truncated, multi-volume, encrypted and ZIP64 archives', () => {
    for (let length = 0; length < archive().length; length++) assert.throws(() => readZip(archive().subarray(0, length)));
    assert.throws(() => readZip(mutate(zip => zip.writeUInt16LE(1, zip.length - 18))), /多卷/);
    assert.throws(() => readZip(mutate((zip, at) => zip.writeUInt16LE(0x801, at + 8))), /加密/);
    assert.throws(() => readZip(mutate((zip, at) => zip.writeUInt32LE(0xffffffff, at + 24))), /ZIP64/);
    assert.throws(() => readZip(mutate((zip, at) => zip.writeUInt32LE(0xffffff00, at + 42))), /边界/);
});

test('reader checks local and central metadata and rejects links or special files', () => {
    assert.throws(() => readZip(mutate(zip => zip.write('bad', 30))), /文件名与目录不一致/);
    assert.throws(() => readZip(mutate(zip => zip.writeUInt16LE(0, 8))), /本地头与目录不一致/);
    assert.throws(() => readZip(mutate(zip => zip.writeUInt32LE(0, 22))), /本地大小/);
    for (const mode of [0o120777, 0o020600, 0o010600]) {
        assert.throws(() => readZip(mutate((zip, at) => zip.writeUInt32LE((mode << 16) >>> 0, at + 38))), /特殊文件/);
    }
    const dir = mutate((zip, at) => zip.writeUInt32LE((0o040755 << 16) >>> 0, at + 38), [{ name: 'top/', data: '' }]);
    assert.equal(readZip(dir)[0].isDirectory, true);
});
