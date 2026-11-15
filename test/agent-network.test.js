import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { allowCodexProjectMcp, codexHttpProxy } from '../src/codex-launch.js';

test('codex launch rewrites only the untrusted project trust level', () => {
    const workspace = '/tmp/video remake';
    const args = [
        'exec',
        `-c`,
        `projects.${JSON.stringify(workspace)}.trust_level="untrusted"`,
        '-c',
        'approval_policy="never"',
    ];
    const exclude = 'shell_environment_policy.exclude=["*KEY*","*TOKEN*","*SECRET*","*PASSWORD*","CODEX_HOME","*PROXY*","*proxy*"]';
    assert.deepEqual(allowCodexProjectMcp([...args, '-c', exclude], 'http://127.0.0.1:8081/'), [
        'exec',
        '-c',
        `projects.${JSON.stringify(workspace)}.trust_level="trusted"`,
        '-c',
        'approval_policy="never"',
        '-c',
        'shell_environment_policy.exclude=["*KEY*","*TOKEN*","*SECRET*","*PASSWORD*","CODEX_HOME"]',
        '-c',
        `shell_environment_policy.set=${JSON.stringify({
            HTTP_PROXY: 'http://127.0.0.1:8081/', HTTPS_PROXY: 'http://127.0.0.1:8081/', ALL_PROXY: 'http://127.0.0.1:8081/',
            http_proxy: 'http://127.0.0.1:8081/', https_proxy: 'http://127.0.0.1:8081/', all_proxy: 'http://127.0.0.1:8081/',
            NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
        })}`,
    ]);
});

test('codex http proxy reads only credential-free http proxy urls', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-proxy-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'config.toml'), [
        'HTTP_PROXY = "socks5://127.0.0.1:1080"',
        'HTTPS_PROXY = "http://user:pass@127.0.0.1:8081"',
        'https_proxy = "http://127.0.0.1:8081"',
    ].join('\n'));
    assert.equal(codexHttpProxy(root), 'http://127.0.0.1:8081/');
});
