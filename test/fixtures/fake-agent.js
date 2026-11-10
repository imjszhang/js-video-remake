#!/usr/bin/env node

// Copied to fake-agent-<mode>.mjs by tests so the runtime's environment filtering
// cannot accidentally change fixture behavior.
import path from 'node:path';

if (process.argv.includes('--version')) {
    process.stdout.write('codex-cli fixture-1.0.0\n');
    process.exit(0);
}

const mode = path.basename(process.argv[1], '.mjs').replace('fake-agent-', '');
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

emit({ type: 'thread.started', thread_id: 'fixture-thread' });
if (mode === 'slow') {
    setInterval(() => {}, 1000);
} else {
    const credential = process.env.JS_AGENT_RUNTIME_API_KEY || 'missing-fixture-credential';
    process.stderr.write(`fixture diagnostic: ${credential}\n`);
    emit({
        type: 'item.completed',
        item: { type: 'agent_message', text: `fixture completed: ${prompt.trim()} credential: ${credential}` },
    });
    if (mode === 'failed') {
        emit({ type: 'turn.failed', error: { message: 'fixture reported failure' } });
    } else if (mode !== 'incomplete') {
        emit({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4, cached_input_tokens: 2 } });
    }
    if (mode === 'nonzero') process.exitCode = 7;
}
