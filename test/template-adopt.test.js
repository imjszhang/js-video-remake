import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { HELP } from '../src/args.js';
import { resolveConfig } from '../src/config.js';
import { runTemplateAction } from '../src/videos.js';
import { createWebServer } from '../src/web-server.js';
import { downloadedVideo, run, runMain, tempWorkspace } from './helpers.js';
import { readZip } from '../src/zip.js';

const exec = promisify(execFile);

async function production(t) {
    const workspace = await tempWorkspace(t, { videos: { abcdefghijk: downloadedVideo() } });
    await run(['bind', 'abcdefghijk'], workspace.env);
    await run(['start', 'youtube-abcdefghijk', '--as', 'demo'], workspace.env);
    await run(['video:new', 'demo', '--skip-install', '--width', '1280', '--height', '720', '--fps', '30', '--duration', '2'], workspace.env);
    return { ...workspace, prod: path.join(workspace.directory, 'productions', 'demo'), pkg: path.join(workspace.directory, 'productions', 'demo', 'videos', 'code-v1') };
}

function wav(seconds, rate = 8000) {
    const data = Buffer.alloc(seconds * rate * 2);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

async function tool(dir, args) {
    return exec(process.execPath, args, { cwd: dir, encoding: 'utf8' });
}

test('help lists video:template', () => {
    assert.match(HELP, /video:template <slug>/);
});

test('video:template keeps the picture and makes voice and music replace the soundtrack', async (t) => {
    const w = await production(t);
    await assert.rejects(
        run(['video:template', 'demo', '--title', '名'.repeat(161), '--skip-install'], w.env),
        error => error.code === 'INVALID_INPUT',
    );
    const index = path.join(w.pkg, 'index.html');
    const originalManifest = await fs.readFile(path.join(w.pkg, 'video.json'), 'utf8');
    let html = await fs.readFile(index, 'utf8');
    html = html.replace('</body>', '<video id="talk" src="talk.mp4" data-has-audio="true" data-start="0"></video><audio id="bed" src="bed.mp3" data-volume="0.8"></audio></body>');
    await fs.writeFile(index, html);

    const printed = await runMain(['video:template', 'demo', '--skip-install', '--title', '收成测试'], w.env);
    assert.equal(printed.code, 0);
    assert.match(printed.stdout, /已把 code-v1 收成模板「收成测试」/);
    assert.match(printed.stdout, /video:pack demo --video template-/);
    assert.equal(await fs.readFile(index, 'utf8'), html);
    assert.equal(await fs.readFile(path.join(w.pkg, 'video.json'), 'utf8'), originalManifest);

    const adoptedName = (await fs.readdir(path.join(w.prod, 'videos'))).find(name => name.startsWith('template-'));
    const adopted = path.join(w.prod, 'videos', adoptedName);
    for (const file of ['tools/inputs.mjs', 'tools/build.mjs', 'tools/preview.mjs', 'tools/compose.mjs']) {
        await tool(adopted, ['--check', file]);
    }
    const manifest = JSON.parse(await fs.readFile(path.join(adopted, 'video.json'), 'utf8'));
    assert.equal(manifest.template.format, 'video-template@1');
    assert.equal(manifest.title, '收成测试');
    assert.deepEqual(Object.keys(manifest.template.inputs).sort(), ['music', 'voice']);
    assert.equal(manifest.template.lineage.kind, 'derived');
    assert.equal(manifest.template.lineage.origin.video, 'code-v1');
    assert.equal(await fs.readFile(path.join(adopted, 'src/film.html'), 'utf8'), html);

    await tool(adopted, ['tools/inputs.mjs', '--init']);
    const fresh = JSON.parse(await fs.readFile(path.join(adopted, 'inputs.json'), 'utf8'));
    assert.deepEqual(fresh, { voice: null, music: null });
    await tool(adopted, ['tools/build.mjs']);
    assert.equal(await fs.readFile(path.join(adopted, 'index.html'), 'utf8'), html);
    assert.match(await fs.readFile(path.join(adopted, 'SCRIPT.md'), 'utf8'), /成片 2 秒/);

    await fs.mkdir(path.join(adopted, 'inputs'), { recursive: true });
    await fs.writeFile(path.join(adopted, 'inputs.json'), `${JSON.stringify({ voice: 'inputs/voice.wav', music: null })}\n`);
    await tool(adopted, ['tools/build.mjs']);
    const replaced = await fs.readFile(path.join(adopted, 'index.html'), 'utf8');
    assert.match(replaced, /<video muted id="talk"/);
    assert.doesNotMatch(replaced, /data-has-audio="true"/);
    assert.match(replaced, /<audio data-volume="0" id="bed"|<audio id="bed"[^>]*data-volume="0"/);
    assert.match(replaced, /id="adopted-voice"[^>]*src="inputs\/voice\.wav"/);
    assert.equal(await fs.readFile(path.join(adopted, 'src/film.html'), 'utf8'), html);
    await tool(adopted, ['tools/build.mjs']);
    assert.equal(await fs.readFile(path.join(adopted, 'index.html'), 'utf8'), replaced);

    await fs.writeFile(path.join(adopted, 'inputs/voice.wav'), wav(1));
    let short;
    try { short = JSON.parse((await tool(adopted, ['tools/inputs.mjs', '--json'])).stdout); }
    catch (error) { short = JSON.parse(error.stdout); }
    if (short.warnings.some(item => item.includes('ffprobe'))) assert.equal(short.ok, true);
    else { assert.equal(short.ok, false); assert.match(short.errors.join('\n'), /短于成片/); }
    await fs.writeFile(path.join(adopted, 'inputs/voice.wav'), wav(2));
    const checked = JSON.parse((await tool(adopted, ['tools/inputs.mjs', '--json'])).stdout);
    assert.equal(checked.ok, true);
    await fs.writeFile(path.join(adopted, 'inputs.json'), '{"voice":"../secret.wav"}\n');
    await assert.rejects(tool(adopted, ['tools/inputs.mjs', '--json']), error => JSON.parse(error.stdout).ok === false);

    const packed = await run(['video:pack', 'demo', '--video', adoptedName], w.env);
    const names = readZip(await fs.readFile(path.join(w.directory, packed.data.output))).map(entry => entry.name);
    const folder = names[0].split('/')[0];
    assert.ok(names.some(name => name === `${folder}/src/film.html`));
    assert.ok(names.some(name => name === `${folder}/tools/build.mjs`));
    assert.ok(names.some(name => name === `${folder}/AUTHORING.md`));
    assert.equal(names.some(name => name.endsWith('/index.html')), false);
    assert.equal(names.some(name => name.includes('/inputs/')), true);
    assert.equal(names.filter(name => name.includes('/inputs/')).every(name => name.endsWith('/inputs/README.md')), true);

    const listed = await run(['video:list', 'demo'], w.env);
    assert.deepEqual(listed.data.videos.map(video => [video.name, video.template]), [['code-v1', false], [adoptedName, true]]);
    await assert.rejects(
        run(['video:template', 'demo', '--video', adoptedName, '--skip-install'], w.env),
        error => error.code === 'VIDEO_INVALID' && /已经是模板/.test(error.message),
    );
});

test('an existing build script stays ahead of the soundtrack step', async (t) => {
    const w = await production(t);
    await fs.writeFile(path.join(w.pkg, 'film.mjs'), "import fs from 'node:fs';\nfs.writeFileSync('index.html', '<!doctype html><html><body><video id=\"talk\" data-has-audio=\"true\" src=\"talk.mp4\"></video><p>from-film-build</p></body></html>\\n');\n");
    const pkgJson = JSON.parse(await fs.readFile(path.join(w.pkg, 'package.json'), 'utf8'));
    pkgJson.scripts.build = 'node film.mjs';
    await fs.writeFile(path.join(w.pkg, 'package.json'), JSON.stringify(pkgJson));
    const created = await run(['video:template', 'demo', '--skip-install', '--title', '沿用构建'], w.env);
    assert.equal(created.data.preservedBuild, true);
    const adopted = path.join(w.directory, created.data.dir);
    const scripts = JSON.parse(await fs.readFile(path.join(adopted, 'package.json'), 'utf8')).scripts;
    assert.equal(scripts['film:build'], 'node film.mjs');
    assert.equal(scripts.build, 'node tools/build.mjs');
    assert.equal(JSON.parse(await fs.readFile(path.join(w.pkg, 'package.json'), 'utf8')).scripts.build, 'node film.mjs');
    await fs.writeFile(path.join(adopted, 'inputs.json'), '{"voice":"inputs/voice.wav","music":null}\n');
    await tool(adopted, ['tools/build.mjs']);
    const html = await fs.readFile(path.join(adopted, 'index.html'), 'utf8');
    assert.match(html, /from-film-build/);
    assert.match(html, /<video muted id="talk"/);
    assert.match(html, /id="adopted-voice"/);
});

test('the workbench adopts a remake package without installing or running it', async (t) => {
    const w = await production(t);
    const server = createWebServer({ root: w.directory });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8');
    assert.match(page, /id="adopt-panel"/);
    assert.match(page, /收成模板/);
    const denied = await fetch(`${base}/api/projects/demo/packages/code-v1/template`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Remake-Action': 'adopt', 'Sec-Fetch-Site': 'cross-site' }, body: '{"title":"拒绝"}',
    });
    assert.equal(denied.status, 403);
    const missing = await fetch(`${base}/api/projects/demo/packages/missing-v1/template`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Remake-Action': 'adopt' }, body: '{"title":"没有"}',
    });
    assert.equal(missing.status, 404);
    const response = await fetch(`${base}/api/projects/demo/packages/code-v1/template`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Remake-Action': 'adopt' }, body: '{"title":"网页模板"}',
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.command, 'video:template');
    assert.equal(result.installed, null);
    assert.equal(await fs.access(path.join(w.directory, result.dir, 'node_modules')).then(() => true, () => false), false);
    const projects = await (await fetch(`${base}/api/projects`)).json();
    const project = projects.projects.find(item => item.slug === 'demo');
    assert.deepEqual(project.codePackages.map(item => item.name), ['code-v1']);
    assert.equal(project.codePackages[0].engine, 'hyperframes');
    assert.deepEqual(project.templatePackages.map(item => item.name), [result.video]);
    const editor = await (await fetch(`${base}/api/projects/demo/templates/${result.video}/editor`)).json();
    assert.deepEqual(Object.keys(editor.schema).sort(), ['music', 'voice']);
    assert.equal(editor.inputs.voice, null);
    assert.match(editor.summary, /口播和音乐/);
    const again = await fetch(`${base}/api/projects/demo/packages/${result.video}/template`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Remake-Action': 'adopt' }, body: '{"title":"重复"}',
    });
    assert.equal(again.status, 400);
    assert.match((await again.json()).error, /已经是模板/);
});

async function sha(file) {
    return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

test('video:template turns a film package into a template and keeps its renderer', async (t) => {
    const w = await production(t);
    await run(['video:new', 'demo', '--as', 'film-v1', '--engine', 'film', '--skip-install', '--width', '1280', '--height', '720', '--fps', '30', '--duration', '2'], w.env);
    const source = path.join(w.prod, 'videos/film-v1');
    const renderer = await sha(path.join(source, 'tools/render.mjs'));
    const runtime = await sha(path.join(source, 'runtime/film.js'));
    const created = await run(['video:template', 'demo', '--video', 'film-v1', '--skip-install', '--title', 'film 模板'], w.env);
    assert.equal(created.data.engine, 'film@1');
    assert.equal(created.data.preservedBuild, false);
    const adopted = path.join(w.directory, created.data.dir);
    assert.equal(await sha(path.join(adopted, 'tools/render.mjs')), renderer);
    assert.equal(await sha(path.join(adopted, 'runtime/film.js')), runtime);
    assert.equal(await sha(path.join(source, 'tools/render.mjs')), renderer);
    for (const file of ['tools/inputs.mjs', 'tools/template-build.mjs', 'tools/template-render.mjs', 'tools/compose.mjs']) {
        await tool(adopted, ['--check', file]);
    }
    const scripts = JSON.parse(await fs.readFile(path.join(adopted, 'package.json'), 'utf8')).scripts;
    assert.equal(scripts.build, 'node tools/template-build.mjs');
    assert.equal(scripts.player, 'node tools/build.mjs');
    const manifest = JSON.parse(await fs.readFile(path.join(adopted, 'video.json'), 'utf8'));
    assert.equal(scripts.render, `node tools/template-render.mjs --out ${manifest.output}`);
    assert.match(scripts.check, /tools\/check\.mjs/);
    assert.equal(manifest.engine, 'film@1');
    assert.equal(manifest.template.format, 'video-template@1');
    assert.deepEqual(Object.keys(manifest.template.inputs).sort(), ['music', 'voice']);

    await tool(adopted, ['tools/template-build.mjs']);
    assert.match(await fs.readFile(path.join(adopted, 'SCRIPT.md'), 'utf8'), /成片 2 秒/);
    assert.equal(await fs.access(path.join(adopted, '.film-audio/soundtrack.wav')).then(() => true, () => false), false);
    await fs.mkdir(path.join(adopted, 'inputs'), { recursive: true });
    await fs.writeFile(path.join(adopted, 'inputs/voice.wav'), wav(2));
    await fs.writeFile(path.join(adopted, 'inputs.json'), '{"voice":"inputs/voice.wav","music":null}\n');
    await tool(adopted, ['tools/template-build.mjs']);
    const soundtrack = await fs.readFile(path.join(adopted, '.film-audio/soundtrack.wav'));
    assert.equal(soundtrack.subarray(0, 4).toString(), 'RIFF');
    assert.match(await fs.readFile(path.join(adopted, 'SCRIPT.md'), 'utf8'), /inputs\/voice\.wav/);
    assert.equal(await fs.readFile(path.join(adopted, 'index.html'), 'utf8'), await fs.readFile(path.join(source, 'index.html'), 'utf8'));

    const calls = [];
    const preview = await runTemplateAction(resolveConfig({ workspace: w.directory }), { slug: 'demo', name: created.data.video, action: 'preview' }, {
        runCommand: async (executable, args) => {
            calls.push({ executable, args });
            if (args.includes('--png-dir')) {
                await fs.mkdir(path.join(adopted, '.work/preview'), { recursive: true });
                await fs.writeFile(path.join(adopted, '.work/preview/f00003.png'), Buffer.from([1, 2, 3]));
            }
            if (args.includes('--json')) return { exitCode: 0, stdout: '{"ok":true,"errors":[],"warnings":[],"info":[]}', stderr: '' };
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    });
    assert.equal(preview.previewFiles.includes('f00003.png'), true);
    const stills = calls.find(call => call.args.includes('--png-dir'));
    assert.equal(stills.args[0], 'tools/render.mjs');
    assert.ok(stills.args.includes('--frames'));
    await assert.rejects(
        runTemplateAction(resolveConfig({ workspace: w.directory }), { slug: 'demo', name: created.data.video, action: 'generate', title: '改画面', prompt: '换成别的' }, { runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }),
        error => error.code === 'VIDEO_INVALID' && /改造画面/.test(error.message),
    );

    const packed = await run(['video:pack', 'demo', '--video', created.data.video, '--force'], w.env);
    const names = readZip(await fs.readFile(path.join(w.directory, packed.data.output))).map(entry => entry.name);
    assert.ok(names.some(name => name.endsWith('/tools/render.mjs')));
    assert.ok(names.some(name => name.endsWith('/tools/template-render.mjs')));
    assert.equal(names.some(name => name.includes('/.film-audio/')), false);
});

test('several remake packages require --video', async (t) => {
    const w = await production(t);
    await run(['video:new', 'demo', '--as', 'alt-v1', '--skip-install'], w.env);
    await assert.rejects(run(['video:template', 'demo', '--skip-install'], w.env), error => error.code === 'INVALID_INPUT' && /code-v1/.test(error.message) && /alt-v1/.test(error.message));
});
