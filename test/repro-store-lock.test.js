import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { storage, withLock } from '../src/repro/store.js';

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repro-lock-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'project'); await fs.mkdir(workspace);
    const config = { workspace, env: { VIDEO_REMAKE_AGENT_HOME: path.join(root, 'state') } };
    const lock = path.join(storage(config), 'locks', 'shared.json');
    await fs.mkdir(path.dirname(lock), { recursive: true });
    return { config, lock };
}

test('stale lock recovery is serialized before reading ownership and cannot steal a fresh lock', async t => {
    const { config, lock } = await fixture(t);
    // A pid outside the host's current range is demonstrably dead.
    await fs.writeFile(lock, JSON.stringify({ pid: 2147483647, token: 'stale', hostname: os.hostname() }));
    let pauseRead, enteredRead, releaseOperation, enteredOperation;
    const reading = new Promise(resolve => { enteredRead = resolve; });
    const proceedRead = new Promise(resolve => { pauseRead = resolve; });
    const operating = new Promise(resolve => { enteredOperation = resolve; });
    const proceedOperation = new Promise(resolve => { releaseOperation = resolve; });
    const originalRead = fs.readFile;
    let reads = 0;
    fs.readFile = async (...args) => {
        if (args[0] === lock && ++reads === 1) { enteredRead(); await proceedRead; }
        return originalRead(...args);
    };
    t.after(() => { fs.readFile = originalRead; pauseRead(); releaseOperation(); });
    let active = 0, maxActive = 0;
    const first = withLock(config, 'shared', async () => { active++; maxActive = Math.max(maxActive, active); enteredOperation(); await proceedOperation; active--; });
    await reading;
    await assert.rejects(withLock(config, 'shared', async () => { active++; maxActive = Math.max(maxActive, active); active--; }), { code: 'REPRO_BUSY' });
    pauseRead(); await operating;
    await assert.rejects(withLock(config, 'shared', async () => { throw new Error('Must not enter'); }), { code: 'REPRO_BUSY' });
    releaseOperation(); await first;
    assert.equal(maxActive, 1);
    await assert.rejects(fs.access(lock), { code: 'ENOENT' });
    await assert.rejects(fs.access(`${lock}.recovery`), { code: 'ENOENT' });
});

test('foreign-host ownership and malformed records fail closed while failed operations release only their own lock', async t => {
    const { config, lock } = await fixture(t);
    await fs.writeFile(lock, JSON.stringify({ pid: 2147483647, hostname: 'different-host', token: 'foreign' }));
    await assert.rejects(withLock(config, 'shared', async () => {}), { code: 'REPRO_BUSY' });
    await fs.writeFile(lock, 'invalid');
    await assert.rejects(withLock(config, 'shared', async () => {}), { code: 'REPRO_BUSY' });
    await fs.rm(lock);
    await assert.rejects(withLock(config, 'shared', async () => { throw new Error('operation failed'); }), /operation failed/);
    await assert.rejects(fs.access(lock), { code: 'ENOENT' });
});
