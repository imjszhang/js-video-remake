import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { runProjectAgent } from '../src/repro/runner.js';
import { filesystemProfile, enrichDeepseekPatch, prepareExecutionEnvironment, resolveInstalledBrowser, resolveMediaToolReads } from '../src/repro/execution-environment.js';

const exec = promisify(execFile);
test('media library discovery follows symlinks and transitive rpaths without exposing sibling files', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'media-libraries-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin'), lib = path.join(root, 'lib'), links = path.join(root, 'links');
    for (const dir of [bin, lib, links]) await fs.mkdir(dir);
    const executable = path.join(bin, 'ffmpeg'), codec = path.join(lib, 'codec.dylib'), shared = path.join(lib, 'shared.dylib');
    for (const file of [executable, codec, shared, path.join(lib, 'private.txt')]) await fs.writeFile(file, 'fixture', { mode: 0o700 });
    await fs.symlink(executable, path.join(links, 'ffmpeg'));
    await fs.symlink(executable, path.join(links, 'ffprobe'));
    const command = (kind, field, value) => `Load command 0\n cmd ${kind}\n ${field} ${value} (offset 12)\n`;
    const outputs = new Map([
        [executable, command('LC_RPATH', 'path', '@executable_path/../lib') + command('LC_LOAD_DYLIB', 'name', '@rpath/codec.dylib')],
        [codec, command('LC_LOAD_DYLIB', 'name', '@rpath/shared.dylib') + command('LC_LOAD_WEAK_DYLIB', 'name', '@rpath/optional.dylib')],
        [shared, command('LC_LOAD_DYLIB', 'name', '@loader_path/codec.dylib') + command('LC_LOAD_DYLIB', 'name', '/usr/lib/libSystem.B.dylib')],
    ]);
    const invoke = async (tool, args) => {
        assert.equal(tool, '/usr/bin/otool'); assert.equal(args[0], '-l');
        assert.ok(outputs.has(args[1])); return { stdout: outputs.get(args[1]) };
    };
    const readRoots = await resolveMediaToolReads({ searchPath: links, invoke });
    assert.deepEqual(readRoots.sort(), [executable, codec, shared].sort());
    assert.ok(!readRoots.includes(lib), 'does not grant the library directory');
    if (process.platform === 'darwin') {
        const profile = path.join(root, 'profile.sb');
        await fs.writeFile(profile, filesystemProfile({ readRoots: ['/System', '/usr', '/bin', '/dev', ...readRoots], writeRoots: ['/dev/null', '/dev/tty'] }));
        assert.equal((await exec('/usr/bin/sandbox-exec', ['-f', profile, '/bin/cat', shared])).stdout, 'fixture');
        await assert.rejects(exec('/usr/bin/sandbox-exec', ['-f', profile, '/bin/cat', path.join(lib, 'private.txt')]), /Operation not permitted|Permission denied/);
        await assert.rejects(exec('/usr/bin/sandbox-exec', ['-f', profile, '/bin/sh', '-c', 'printf changed > "$1"', 'sh', shared]), /Operation not permitted|Permission denied/);
    }
    outputs.set(codec, command('LC_LOAD_DYLIB', 'name', '@rpath/missing.dylib'));
    await assert.rejects(resolveMediaToolReads({ searchPath: links, invoke }), /Cannot resolve media tool library/);
});

test('Flash image metadata is explicit without changing the selected backend or another model', () => {
    const patches = [{ id: 'llm-deepseek', config: { baseURL: 'https://example.invalid', models: [{ id: 'deepseek-flash' }] } }];
    const result = enrichDeepseekPatch(patches, 'deepseek-flash');
    assert.deepEqual(result[0].config.models, [{ id: 'deepseek-flash', inputModalities: ['text', 'image'] }]);
    assert.equal(result[0].config.baseURL, patches[0].config.baseURL);
    assert.deepEqual(patches[0].config.models, [{ id: 'deepseek-flash' }]);
    assert.equal(enrichDeepseekPatch(patches, 'other-model'), patches);
    assert.throws(() => enrichDeepseekPatch([], 'deepseek-flash'), /catalog/);
});

test('filesystem profile quotes paths and explicitly declares network outside its guarantee', () => {
    const profile = filesystemProfile({ readRoots: ['/System', '/workspace/a"b'], writeRoots: ['/workspace'], lockedPaths: ['/workspace/task'] });
    assert.match(profile, /\(deny file-read-data/);
    assert.match(profile, /\(allow network\*\)/);
    assert.match(profile, /\(deny file-write\* \(subpath "\/workspace\/task"\)\)/);
    assert.ok(profile.includes(JSON.stringify('/workspace/a"b')));
});

test('unsupported native platforms fail closed rather than inventing an enforced boundary', async () => {
    await assert.rejects(prepareExecutionEnvironment({ mode: 'restricted-filesystem', target: { harness: { adapter: 'deepseek-harness' } } }, { platform: 'linux' }), /requires macOS/);
    const target = { harness: { adapter: 'test' } };
    assert.equal((await prepareExecutionEnvironment({ target })).record.readIsolation, 'unverified');
});

test('native filesystem probe denies external reads, symlink escapes and writes while DSH metadata still runs', { skip: process.platform !== 'darwin' }, async t => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remake-environment-test-')));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const workspace = path.join(directory, 'project');
    const stateDir = path.join(directory, 'runtime');
    const environmentRoot = path.join(directory, 'environment');
    await fs.mkdir(workspace);
    await fs.mkdir(stateDir);
    await fs.mkdir(path.join(workspace, 'task'));
    await fs.writeFile(path.join(workspace, 'task/spec.json'), 'frozen');
    const ownerWorkspace = await fs.realpath(new URL('..', import.meta.url));
    const target = { name: 'deepseek-flash', harness: { adapter: 'deepseek-harness', executable: path.join(ownerWorkspace, 'node_modules/.bin/dsh'), permission: 'workspace-write', contextMode: 'project' },
        backend: { auth: 'api-key', model: 'deepseek-flash', provider: 'deepseek', protocol: 'anthropic-messages', baseURL: 'https://api.deepseek.com/anthropic', apiKeyEnv: 'DEEPSEEK_API_KEY' } };
    const result = await prepareExecutionEnvironment({ target, workspace, ownerWorkspace, stateDir, environmentRoot, lockedPaths: ['task'], mode: 'restricted-filesystem' });
    assert.equal(result.record.probe.verified, true);
    assert.equal(result.record.probe.networkRestricted, false);
    assert.equal(result.record.readIsolation, 'enforced');
    assert.equal(result.target.backend.model, target.backend.model);
    assert.deepEqual(await fs.readdir(workspace), ['task'], 'probe must leave no trial source changes');
    const profile = path.join(environmentRoot, 'filesystem.sb');
    const code = `try{require('fs').writeFileSync(${JSON.stringify(path.join(workspace, 'task/spec.json'))},'changed');process.exit(2)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;console.log('locked')}`;
    assert.equal((await exec('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, '-e', code])).stdout.trim(), 'locked');
    const version = await exec(result.target.harness.executable, ['--version'], { cwd: workspace, timeout: 10000, env: { ...process.env, HOME: stateDir, DSH_HOME: path.join(stateDir, 'dsh') } });
    assert.match(version.stdout, /0\.2\.1-rc\.2/);
    const profileArgs = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--tmpfs', '/tmp', '--bind', workspace, workspace, '--'];
    const marker = path.join(workspace, 'must-not-execute');
    await assert.rejects(exec(process.execPath, [path.join(environmentRoot, 'inherited-runner.mjs'), ...profileArgs, '/usr/bin/touch', marker]), /outer filesystem boundary was not inherited/);
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
    if (result.record.browserExecutable) {
        const scratch = path.join(stateDir, 'tmp');
        await fs.mkdir(scratch, { recursive: true });
        const screenshot = path.join(workspace, 'browser-probe.png');
        await exec('/usr/bin/sandbox-exec', ['-f', profile, result.record.browserExecutable, '--no-sandbox', '--headless', '--disable-gpu',
            `--user-data-dir=${path.join(stateDir, 'browser-profile')}`, '--window-size=160,120', `--screenshot=${screenshot}`, 'about:blank'],
        { cwd: workspace, timeout: 10000, maxBuffer: 128 * 1024, env: { ...process.env, HOME: stateDir, TMPDIR: scratch } });
        assert.equal((await fs.readFile(screenshot)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }
});

test('browser resolution only selects an already installed matching build', async t => {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'browser-discovery-')));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    for (const version of ['152.0.1', '153.0.0']) {
        const directory = path.join(home, '.cache/hyperframes/chrome/chrome-headless-shell', `mac_arm-${version}`, 'chrome-headless-shell-mac-arm64');
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, 'chrome-headless-shell'), 'test fixture');
    }
    assert.equal((await resolveInstalledBrowser({ home, preferredVersion: '152.0.1' })).version, '152.0.1');
    assert.equal(await resolveInstalledBrowser({ home, preferredVersion: '154.0.0' }), null);
});

test('restricted native DSH reads images and runs native shell/media tools on the same mock model', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remake-native-environment-')));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const workspace = path.join(directory, 'project');
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), 'Read the supplied instruction; this is a metadata integration test.');
    await fs.writeFile(path.join(workspace, 'probe.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    let requests = 0, uploads = 0, imageSent = false, shellObserved = false, shellResponse = null;
    const server = http.createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        if (req.url.endsWith('/files')) {
            uploads++; res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { type: 'not_found_error', message: 'Local test has no Files API; use inline fallback.' } })); return;
        }
        const body = JSON.parse(raw);
        requests++;
        const hasImage = value => value && typeof value === 'object' && (value.type === 'image' || Object.values(value).some(hasImage));
        imageSent ||= hasImage(body.messages);
        if (requests === 3) { shellResponse = body.messages.at(-1); shellObserved = JSON.stringify(shellResponse).includes('NATIVE_SHELL_FILE_OK') && JSON.stringify(shellResponse).includes('ffmpeg version'); }
        assert.equal(body.model, 'deepseek-flash');
        const event = (type, value) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (requests <= 2) {
            const toolName = requests === 1 ? 'read_image' : 'bash';
            const toolInput = requests === 1 ? { file_path: 'probe.png' } : {
                command: `node -e 'const fs=require("fs");fs.writeFileSync("native-probe.txt","NATIVE_SHELL_FILE_OK");console.log(fs.readFileSync("native-probe.txt","utf8"));for(const [label,operation] of [["OUTSIDE_READ",()=>fs.readFileSync(${JSON.stringify(path.join(ownerWorkspace, 'README.md'))})],["OUTSIDE_WRITE",()=>fs.writeFileSync("../must-not-write","bad")],["LOCKED_WRITE",()=>fs.writeFileSync("AGENTS.md","bad")]]){try{operation();process.exit(2)}catch(e){if(!["EPERM","EACCES"].includes(e.code))throw e;console.log(label+"_DENIED")}}' && ffmpeg -version | head -1`,
                description: 'Verify isolated shell file and media access', timeout: 10000,
            };
            res.end([
                event('message_start', { message: { id: 'test-image-tool', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
                event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `native-tool-${requests}`, name: toolName, input: {} } }),
                event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) } }),
                event('content_block_stop', { index: 0 }),
                event('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }),
                event('message_stop', {}),
            ].join('')); return;
        }
        res.end([
            event('message_start', { message: { id: 'test-message', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
            event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
            event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Native launch verified.' } }),
            event('content_block_stop', { index: 0 }),
            event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
            event('message_stop', {}),
        ].join(''));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const ownerWorkspace = await fs.realpath(new URL('..', import.meta.url));
    const target = { name: 'native-fixture', enabled: true,
        harness: { adapter: 'deepseek-harness', executable: path.join(ownerWorkspace, 'node_modules/.bin/dsh'), permission: 'workspace-write', contextMode: 'project' },
        backend: { auth: 'api-key', model: 'deepseek-flash', provider: 'mock', protocol: 'anthropic-messages', baseURL: `http://127.0.0.1:${server.address().port}`, apiKeyEnv: 'FIXTURE_API_KEY' } };
    const configFile = path.join(directory, 'agent-runtime.json');
    await fs.writeFile(configFile, JSON.stringify({ schemaVersion: 1, timeoutMs: 20000, targets: [target] }));
    const config = { workspace: ownerWorkspace, env: { VIDEO_REMAKE_AGENT_HOME: path.join(directory, 'logs'), FIXTURE_API_KEY: 'local-fake-key', PATH: process.env.PATH } };
    const result = await runProjectAgent(config, { workspace, agentConfig: configFile, workflow: { roles: { executor: target.name } },
        role: 'executor', instruction: 'Read probe.png with read_image, verify native shell/media tools by writing native-probe.txt, then reply briefly.',
        executionEnvironment: { mode: 'restricted-filesystem', lockedPaths: ['AGENTS.md'] } });
    assert.equal(result.status, 'completed');
    assert.equal(result.requestedModel, 'deepseek-flash');
    assert.equal(result.harness.adapter, 'deepseek-harness');
    assert.equal(result.executionEnvironment.probe.verified, true);
    assert.equal(result.executionEnvironment.imageCapability.status, 'native-configured; provider transport unverified');
    assert.equal(requests, 3);
    assert.equal(shellObserved, true, 'native bash can write/read project files and invoke ffmpeg: ' + JSON.stringify(shellResponse));
    for (const marker of ['OUTSIDE_READ_DENIED', 'OUTSIDE_WRITE_DENIED', 'LOCKED_WRITE_DENIED']) assert.ok(JSON.stringify(shellResponse).includes(marker), marker);
    assert.equal(await fs.readFile(path.join(workspace, 'native-probe.txt'), 'utf8'), 'NATIVE_SHELL_FILE_OK');
    assert.ok(uploads >= 1, 'native attachment attempted Files upload');
    assert.equal(imageSent, true, 'same native model request includes actual image content');
});
