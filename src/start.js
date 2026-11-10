import fs from 'node:fs/promises';
import path from 'node:path';
import { findProduction, findReference, loadOrCreateCatalog, readCatalog, upsertProduction, writeCatalog } from './catalog.js';
import { readReferenceCatalog, listReferences } from './references.js';
import { appError } from './errors.js';
import { assertSlug } from './schema.js';

const SUBDIRS = ['assets', 'drafts', 'videos'];

function briefText(slug, reference) {
    return `# ${slug}

目标：（填写这次复刻要换谁、换什么、时长/画幅、预算）

参考：\`${reference.dir}/\`
成片指针见该目录 \`SOURCE.json\`，不要复制原片。

画面：（画幅、帧率、时长）
工程：代码视频包放在 \`videos/<名字>-vN/\`，每个版本一个独立的 HyperFrames 工程。素材用 \`remake media:land\` 落地到 \`assets/\`，再用 \`remake video:add\` 复制进包。

\`\`\`
remake video:new ${slug} --width 1080 --height 1920 --fps 30 --duration 10
remake check ${slug}
remake video:render ${slug}
remake video:import ${slug}
remake compare ${slug} --top <新版.mp4> --bottom <基准.mp4>
\`\`\`
`;
}

function treatmentText() {
    return `# Treatment

（导演对 Brief 的回答：新片子如何成立。制作前填写。）
`;
}

function progressText(reference) {
    return `# Progress

当前问题：刚创建制作，尚未开始理解参考。
下一步：阅读 \`${reference.dir}/SOURCE.json\`，写 ANALYSIS / TIMELINE。
`;
}

export async function openProduction(config, slug) {
    const name = assertSlug(slug);
    const catalog = await readCatalog(config.catalogPath);
    const production = findProduction(catalog, name);
    if (!production) throw appError('NOT_FOUND', `未找到制作项目: ${name}`);
    return { production, dir: path.join(config.workspace, production.dir) };
}

export async function startProduction(config, { refId, slug, width, height, fps, duration }) {
    const name = assertSlug(slug);
    if ([width, height, fps, duration].some((value) => value !== undefined)) {
        throw appError('INVALID_INPUT', '画幅、帧率和时长现在属于代码视频包：start 之后运行 remake video:new <slug> --width --height --fps --duration。');
    }
    const catalog = await loadOrCreateCatalog(config.catalogPath);
    const reference = findReference(catalog, refId);
    if (!reference) throw appError('NOT_FOUND', `没有这条参考: ${refId}`);
    if (findProduction(catalog, name)) {
        throw appError('ALREADY_EXISTS', `制作 slug 已存在: ${name}`);
    }
    const dir = path.join('productions', name);
    const abs = path.join(config.workspace, dir);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    try { await fs.mkdir(abs); }
    catch (error) {
        if (error.code === 'EEXIST') throw appError('ALREADY_EXISTS', `制作目录已经存在，不能覆盖: ${dir}`);
        throw error;
    }
    for (const sub of SUBDIRS) await fs.mkdir(path.join(abs, sub), { recursive: true });
    await fs.writeFile(path.join(abs, 'BRIEF.md'), briefText(name, reference), 'utf8');
    await fs.writeFile(path.join(abs, 'TREATMENT.md'), treatmentText(), 'utf8');
    await fs.writeFile(path.join(abs, 'PROGRESS.md'), progressText(reference), 'utf8');
    const entry = upsertProduction(catalog, {
        slug: name,
        dir,
        referenceIds: [reference.id],
        status: 'commissioned',
        deliverable: null,
    });
    await writeCatalog(config.catalogPath, catalog);
    return { command: 'start', production: entry };
}

export async function listCatalog(config) {
    const catalog = await readReferenceCatalog(config);
    const { references } = await listReferences(config);
    return {
        command: 'list',
        references,
        productions: catalog.productions,
    };
}

export async function getEntry(config, id) {
    const catalog = await readReferenceCatalog(config);
    const reference = findReference(catalog, id);
    if (reference) {
        const { readSource } = await import('./bind.js');
        return {
            command: 'get',
            kind: 'reference',
            reference,
            source: await readSource(config.workspace, reference),
        };
    }
    const production = findProduction(catalog, id);
    if (production) {
        return { command: 'get', kind: 'production', production };
    }
    throw appError('NOT_FOUND', `没有这条参考或制作: ${id}`);
}
