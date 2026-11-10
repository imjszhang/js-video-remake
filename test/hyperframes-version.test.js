import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

async function* manifests(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || ['node_modules', 'assets', 'drafts', 'dist'].includes(entry.name)) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* manifests(file);
        else if (entry.name === 'package.json') yield file;
    }
}

test('every HyperFrames project is a self-contained code video package or reproduction project pinning the shared version', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
    const version = pkg.dependencies.hyperframes;
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.equal(lock.packages['node_modules/hyperframes'].version, version);
    for await (const file of manifests(path.join(root, 'productions'))) {
        const project = JSON.parse(await fs.readFile(file, 'utf8'));
        const standalone = await fs.readFile(path.join(path.dirname(file), 'reproduction.json'), 'utf8').then(JSON.parse).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        const videoPackage = await fs.readFile(path.join(path.dirname(file), 'video.json'), 'utf8').then(JSON.parse).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        if (videoPackage?.schema === 'video-package@1') {
            assert.equal(project.dependencies?.hyperframes, version, `${file}: video packages pin the shared exact version`);
            const ownLock = JSON.parse(await fs.readFile(path.join(path.dirname(file), 'package-lock.json'), 'utf8'));
            assert.equal(ownLock.packages['node_modules/hyperframes'].version, version, `${file}: video package lock`);
            for (const [name, command] of Object.entries(project.scripts || {})) {
                assert.doesNotMatch(command, /\.\.\/|cli\/hyperframes\.js|hyperframes@/, `${file} ${name}: video packages stay self-contained`);
            }
            continue;
        }
        if (standalone?.schema === 'video-remake.reproduction-project@1') {
            assert.equal(project.dependencies?.hyperframes, version, `${file}: portable projects retain the shared exact version`);
            const ownLock = JSON.parse(await fs.readFile(path.join(path.dirname(file), 'package-lock.json'), 'utf8'));
            assert.equal(ownLock.packages['node_modules/hyperframes'].version, version);
            assert.equal(ownLock.packages[''].dependencies.hyperframes, version);
            for (const command of Object.values(project.scripts || {})) assert.doesNotMatch(command, /\.\.\/.*cli\/hyperframes\.js|hyperframes@latest/);
            continue;
        }
        // Anything else must not use HyperFrames: there is no shared root wrapper any more.
        const usesHyperframes = ['dependencies', 'devDependencies', 'optionalDependencies'].some((section) => project[section]?.hyperframes)
            || Object.values(project.scripts ?? {}).some((command) => /(?:^|\s)hyperframes(?:@|\s|$)|cli\/hyperframes\.js/.test(command));
        assert.equal(usesHyperframes, false, `${file}: HyperFrames projects must be code video packages (video.json) under productions/<slug>/videos/`);
    }
});
