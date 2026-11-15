import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverClaudeModels } from '../src/claude-models.js';

test('Claude initialization resolves aliases and excludes disabled models without sending user messages', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-models-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'agent-runtime.json'), JSON.stringify({ schemaVersion: 1, targets: [{ name: 'claude', enabled: true, harness: { adapter: 'claude-code', executable: process.execPath, permission: 'workspace-write' }, backend: { auth: 'claude-config', model: 'configured' } }] }));
    const script = path.join(root, 'fake.cjs');
    await fs.writeFile(script, `require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.type!=='control_request'||m.request.subtype!=='initialize')process.exit(2);console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:[{value:'fable',resolvedModel:'claude-fable-5-2'},{value:'blocked',disabled:true},{value:'bad model'}]}}}));});`);
    const result = await discoverClaudeModels({ workspace: root, env: { VIDEO_REMAKE_AGENT_HOME: path.join(os.tmpdir(), 'claude-models-state') } }, 'claude', { spawn: (exe, args, options) => {
        assert.ok(args.includes('--strict-mcp-config'));
        assert.equal(args[args.indexOf('--tools') + 1], '');
        return spawn(process.execPath, [script], options);
    } });
    assert.deepEqual(result.models.map(item => item.id), ['claude-fable-5-2']);
});
