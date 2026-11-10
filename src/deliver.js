import fs from 'node:fs/promises';
import path from 'node:path';
import { findProduction, loadOrCreateCatalog, upsertProduction, writeCatalog } from './catalog.js';
import { appError } from './errors.js';

export async function nextDeliverableVersion(slugDir) {
    let max = 0;
    try {
        const names = await fs.readdir(slugDir);
        for (const name of names) {
            const match = /^v(\d+)$/.exec(name);
            if (match) max = Math.max(max, Number(match[1]));
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    return max + 1;
}

export async function deliverProduction(config, { slug, from, build, output }) {
    if (build || output) {
        throw appError('INVALID_INPUT', 'deliver 不再接受 --build 或 --output，请使用 --from <file>。');
    }
    if (!from) throw appError('INVALID_INPUT', 'deliver 需要 --from <file>。');
    const catalog = await loadOrCreateCatalog(config.catalogPath);
    const production = findProduction(catalog, slug);
    if (!production) throw appError('NOT_FOUND', `没有这个制作: ${slug}`);

    const slugDir = path.join(config.workspace, 'deliverables', production.slug);
    const versionNumber = await nextDeliverableVersion(slugDir);
    const version = `v${versionNumber}`;
    const destDir = path.join(slugDir, version);
    await fs.mkdir(destDir, { recursive: true });

    const absFrom = path.resolve(config.workspace, from);
    try {
        await fs.access(absFrom);
    } catch {
        throw appError('NOT_FOUND', `交付源文件不存在: ${absFrom}`);
    }
    const fileName = `film${path.extname(absFrom) || '.mp4'}`;
    await fs.copyFile(absFrom, path.join(destDir, fileName));
    const source = { kind: 'file', from: absFrom };

    const manifest = {
        slug: production.slug,
        version,
        referenceIds: production.referenceIds,
        source,
        createdAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(destDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const entry = upsertProduction(catalog, {
        ...production,
        status: 'delivered',
        deliverable: {
            version,
            dir: path.join('deliverables', production.slug, version),
            file: fileName,
        },
    });
    await writeCatalog(config.catalogPath, catalog);
    return {
        command: 'deliver',
        slug: entry.slug,
        version,
        file: path.join(destDir, fileName),
        manifest,
        production: entry,
    };
}
