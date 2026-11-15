import { execFileSync } from 'node:child_process';
import { harnessPackages, managedHarness } from '../src/agent-harnesses.js';

for (const adapter of Object.keys(harnessPackages)) {
    const harness = managedHarness(adapter);
    const actual = execFileSync(harness.executable, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim();
    if (!actual.includes(harness.version)) throw new Error(`${harness.package} 版本不符：${actual}`);
    console.log(`${harness.package}: ${harness.version}（${actual}）`);
}
