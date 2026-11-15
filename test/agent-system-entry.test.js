import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { metadataProcess } from '../node_modules/js-agent-runtime/dist/metadata.js';

test('系统 Claude 包装入口在版本检查时保留安装 HOME，同时隔离 Claude 配置', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-entry-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, 'user');
    const state = path.join(root, 'metadata');
    await fs.mkdir(home);
    await fs.mkdir(state);
    const entry = path.join(root, 'claude');
    await fs.writeFile(entry, '#!/bin/sh\nexec "$HOME/current-claude" "$@"\n', { mode: 0o755 });
    const current = path.join(home, 'current-claude');
    const execution = {
        adapter: { id: 'claude-code' }, stateDir: path.join(root, 'run'),
        request: { target: { backend: { auth: 'claude-config' } } },
        process: { executable: entry, env: { HOME: home, USERPROFILE: home, NODE_OPTIONS: 'unwanted' } },
    };
    for (const version of ['2.1.321', '2.1.322']) {
        await fs.writeFile(current, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
        const command = metadataProcess(execution, state, 'version');
        assert.equal(command.env.CLAUDE_CONFIG_DIR, path.join(state, 'claude-version'));
        assert.equal(command.env.NODE_OPTIONS, undefined);
        const result = await promisify(execFile)(command.executable, command.args, { cwd: state, env: command.env });
        assert.equal(result.stdout.trim(), version);
    }
    execution.request.target.backend.auth = 'api-key';
    assert.equal(metadataProcess(execution, state, 'version').env.HOME, state);
    execution.request.target.backend.auth = 'claude-subscription';
    assert.equal(metadataProcess(execution, state, 'version').env.HOME, state);
});
