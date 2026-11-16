// The film engine: a code video package that draws each frame from film time alone and
// renders through a local Chrome, instead of HyperFrames. The runtime is copied into the
// package, so a finished package needs only Node.js, FFmpeg and a local Chrome.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILM_ENGINE, FILM_RUNTIME_DIR, FILM_RUNTIME_VERSION } from './constants.js';

export { FILM_ENGINE, FILM_RUNTIME_VERSION };

const RUNTIME = FILM_RUNTIME_DIR;
const THREE = fileURLToPath(new URL('../../resources/repro-toolkit/three-r186', import.meta.url));
const RUNTIME_FILES = ['tools/render.mjs', 'tools/check.mjs', 'tools/preview.mjs', 'tools/build.mjs', 'runtime/film.js', 'runtime/wav.js', 'runtime/preview.js'];
const THREE_FILES = ['three.module.js', 'three.core.js', 'LICENSE.txt'];

async function sha256(file) {
    const hash = createHash('sha256');
    hash.update(await fs.readFile(file));
    return hash.digest('hex');
}

/** Files the scaffold copies in, each with the hash the package's video.json records. */
export async function runtimeManifest() {
    const files = {};
    for (const relative of RUNTIME_FILES) files[relative] = await sha256(path.join(RUNTIME, relative));
    for (const relative of THREE_FILES) files[`vendor/three/${relative}`] = await sha256(path.join(THREE, relative));
    return { version: FILM_RUNTIME_VERSION, files };
}

export function filmPackageJson({ name, output }) {
    return {
        name, version: '1.0.0', private: true, type: 'module', engines: { node: '>=22.15.0' },
        scripts: {
            check: 'node tools/check.mjs && node tools/render.mjs --check',
            dev: 'node tools/preview.mjs',
            build: 'node tools/build.mjs',
            render: `node tools/render.mjs --out ${output}`,
        },
    };
}

export function filmVideoManifest({ id, version, title, frame, output, source }) {
    return {
        schema: 'video-package@1', engine: FILM_ENGINE, id, version, title,
        frame, entry: 'index.html', output,
        commands: { install: 'npm ci', check: 'npm run check', render: 'npm run render' },
        inputs: {}, source,
    };
}

function filmReadme({ name, title, frame, output }) {
    return `# ${title}

独立的代码视频包，使用 film 引擎（实验性）：每一帧只由影片时间决定，渲染走本机 Chrome 和 FFmpeg，不依赖 HyperFrames。${frame.width}×${frame.height}，${frame.fps} fps，${frame.frames} 帧。

\`\`\`bash
npm run check       # 静态检查，并抽样核对同一帧单独渲染与顺序渲染一致
npm run dev         # 本地预览，拖动时间轴
npm run render      # 输出 ${output}
npm run build       # 输出 ${output.replace(/\.mp4$/, '.html')}，双击就能在浏览器里播放
\`\`\`

入口是 \`index.html\`。节拍、片长和画幅只写在 \`film.json\`，页面用 \`loadFilm()\` 读取，不要在页面里另写一套时长。素材放在 \`assets/\`，用相对路径引用。画面里不要用 \`Date.now\`、\`requestAnimationFrame\` 当时钟，也不要用 \`Math.random\`；随机数用 \`runtime/film.js\` 里带种子的生成器。

需要本机安装 Chrome（或用 \`FILM_CHROME\` 指定）和 FFmpeg。包名 \`${name}\` 以 \`-vN\` 结尾。成片交付审阅后不再修改本包，改动请复制出新版本。
`;
}

function filmAgents() {
    return `# 代码视频包（film 引擎）

本目录是独立的 film 工程。只修改本目录内的文件，不引用本目录以外的路径（不写 \`../\`，不写绝对路径）。

- \`film.json\` 是冻结的节拍表：\`duration\`、\`fps\`、\`width\`、\`height\` 和 \`beats\`。入口页面读它，不要在页面里另写一套时长。
- 页面加载后设置 \`window.__film = { duration, fps, width, height, ready, frame, exportWav }\`。\`frame(t)\` 只依赖 \`t\`，同一时间每次画出同一帧。
- 声音用 \`OfflineAudioContext\` 在 \`exportWav()\` 里一次合成，不要在 \`frame\` 里播放。
- 改完运行 \`npm run check\`。它拒绝真实时钟和 \`Math.random\`，并抽几帧核对单独渲染与顺序渲染的结果一致。
- 渲染：\`npm run render\`。预览：\`npm run dev\`。
`;
}

function filmHtml({ width, height }, output) {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>film</title>
  <style>html, body { margin: 0; background: #000; } canvas { display: block; }</style>
</head>
<body>
<canvas id="view"></canvas>
<script type="module">
import { loadFilm, installFilm } from './runtime/film.js';

const film = await loadFilm();
const canvas = document.getElementById('view');
canvas.width = ${width};
canvas.height = ${height};

function frame(t) {
  const context = canvas.getContext('2d');
  context.fillStyle = '#0b1020';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#e23d3d';
  context.font = '64px sans-serif';
  context.fillText(t.toFixed(2), 80, canvas.height / 2);
}

installFilm({ film, frame });
</script>
<script type="module" src="./runtime/preview.js"></script>
${fileHint(output.replace(/\.mp4$/, '.html'))}
</body>
</html>
`;
}

// A classic script still runs from file://, where the browser blocks the module
// scripts above. A page opened from disk cannot fetch to see whether the build
// exists, but a classic <script src> still loads, so the build writes a marker
// script next to the built file. If the marker loads, jump to the build; if not,
// tell the reader how to make one.
export function fileHint(built) {
    const marker = built.replace(/\.html$/, '.ready.js');
    return `<script>
if (location.protocol === 'file:' && !globalThis.__FILM_STANDALONE__) {
  const probe = document.createElement('script');
  probe.src = '${marker}';
  probe.onload = () => location.replace('${built}');
  probe.onerror = () => {
    const note = document.createElement('p');
    note.style.cssText = 'position:fixed;inset:auto 0 0 0;margin:0;padding:14px 18px;background:#e23d3d;color:#fff;font:15px/1.5 sans-serif;z-index:10';
    note.innerHTML = '还没有可直接打开的版本。请在包目录运行 <code>npm run build</code>，之后双击 index.html 会自动播放。';
    document.body.append(note);
  };
  document.head.append(probe);
}
</script>`;
}

/** Write the film runtime, three.js and the starter page into an empty package directory. */
export async function scaffoldFilmPackage(dir, { name, title, frame, output, source }) {
    await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
    for (const relative of RUNTIME_FILES) {
        await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
        await fs.copyFile(path.join(RUNTIME, relative), path.join(dir, relative));
    }
    for (const relative of THREE_FILES) {
        await fs.mkdir(path.dirname(path.join(dir, 'vendor/three', relative)), { recursive: true });
        await fs.copyFile(path.join(THREE, relative), path.join(dir, 'vendor/three', relative));
    }
    const runtime = await runtimeManifest();
    const film = { duration: frame.frames / frame.fps, fps: frame.fps, width: frame.width, height: frame.height, beats: [{ name: 'start', at: 0 }] };
    const manifest = filmVideoManifest({ id: title, version: null, title, frame, output, source });
    const files = {
        'package.json': filmPackageJson({ name, output }),
        'film.json': film,
    };
    for (const [file, value] of Object.entries(files)) await fs.writeFile(path.join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
    await fs.writeFile(path.join(dir, 'index.html'), filmHtml(frame, output));
    await fs.writeFile(path.join(dir, 'README.md'), filmReadme({ name, title, frame, output }));
    await fs.writeFile(path.join(dir, 'AGENTS.md'), filmAgents());
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), '@AGENTS.md\n');
    await fs.writeFile(path.join(dir, '.gitignore'), 'renders/\n');
    return { manifest, runtime };
}

export function isFilm(manifest) {
    return manifest?.engine === FILM_ENGINE;
}

/**
 * A film package has no npm dependencies, so it is installed once its runtime files
 * match the hashes recorded in video.json at scaffold time. film.json holds only the
 * beat sheet, which the author edits; the integrity record stays out of it.
 */
export async function filmInstalled(dir) {
    try {
        const manifest = JSON.parse(await fs.readFile(path.join(dir, 'video.json'), 'utf8'));
        const declared = manifest.runtime?.files || {};
        for (const [relative, hash] of Object.entries(declared)) {
            if (await sha256(path.join(dir, relative)) !== hash) return false;
        }
        return Object.keys(declared).length > 0;
    } catch {
        return false;
    }
}
