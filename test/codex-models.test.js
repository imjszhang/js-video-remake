import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { discoverCodexModels } from '../src/codex-models.js';

test('Codex discovery initializes, checks account, paginates and excludes hidden models', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-models-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'agent-runtime.json'), JSON.stringify({ schemaVersion: 1, targets: [{ name: 'test', enabled: true, harness: { adapter: 'codex', executable: process.execPath, permission: 'read-only' }, backend: { auth: 'chatgpt', model: 'old' } }] }));
    const script = path.join(root, 'fake.cjs');
    await fs.writeFile(script, `const rl=require('readline').createInterface({input:process.stdin});let initialized=false;rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialized'){initialized=true;return;}let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};if(m.method==='model/list'){if(!initialized)process.exit(2);result=m.params.cursor?{data:[{model:'second',displayName:'Second'}],nextCursor:null}:{data:[{model:'first',isDefault:true},{model:'hidden',hidden:true},{model:'bad model'}],nextCursor:'next'};}console.log(JSON.stringify({id:m.id,result}));});`);
    const config = { workspace: root, env: { VIDEO_REMAKE_AGENT_HOME: path.join(os.tmpdir(), 'codex-model-test-state') } };
    const result = await discoverCodexModels(config, 'test', { spawn: (exe, args, options) => {
        assert.ok(args.includes('app-server'));
        return spawn(process.execPath, [script], options);
    } });
    assert.deepEqual(result.models.map(item => item.id), ['first', 'second']);
    await assert.rejects(discoverCodexModels(config, 'test', { timeoutMs: 30, spawn: () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']) }), { code: 'AGENT_MODELS_FAILED' });
});
