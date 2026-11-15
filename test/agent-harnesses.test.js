import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { managedHarness } from '../src/agent-harnesses.js';

test('托管执行器拒绝缺失、漂移版本及非精确声明', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const manifest = path.join(root, 'package.json');
    await fs.writeFile(manifest, JSON.stringify({ dependencies: { '@anthropic-ai/claude-code': '2.1.321' } }));
    assert.throws(() => managedHarness('claude-code', root), /npm ci/);
    const pkg = path.join(root, 'node_modules/@anthropic-ai/claude-code');
    await fs.mkdir(pkg, { recursive: true });
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ version: '2.1.319' }));
    assert.throws(() => managedHarness('claude-code', root), /已安装 2.1.319/);
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ version: '2.1.321' }));
    await fs.mkdir(path.join(root, 'node_modules/.bin'));
    const bin = path.join(root, 'node_modules/.bin/claude');
    await fs.writeFile(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.equal(managedHarness('claude-code', root).executable, bin);
    await fs.writeFile(manifest, JSON.stringify({ dependencies: { '@anthropic-ai/claude-code': '^2.1.321' } }));
    assert.throws(() => managedHarness('claude-code', root), /npm ci/);
});
