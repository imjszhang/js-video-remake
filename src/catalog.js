import fs from 'node:fs/promises';
import path from 'node:path';
import { appError } from './errors.js';
import { emptyCatalog, normalizeCatalog } from './schema.js';

export async function readCatalog(catalogPath) {
    try {
        const raw = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
        return normalizeCatalog(raw);
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw appError('CATALOG_INVALID', `catalog.json 不存在: ${catalogPath}`);
        }
        if (error.code === 'CATALOG_INVALID') throw error;
        throw appError('CATALOG_INVALID', `无法读取 catalog.json: ${error.message}`);
    }
}

export async function writeCatalog(catalogPath, catalog) {
    const normalized = normalizeCatalog(catalog);
    await fs.mkdir(path.dirname(catalogPath), { recursive: true });
    await fs.writeFile(catalogPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    return normalized;
}

export async function loadOrCreateCatalog(catalogPath) {
    try {
        return await readCatalog(catalogPath);
    } catch (error) {
        if (error.code === 'CATALOG_INVALID' && String(error.message).includes('不存在')) {
            return writeCatalog(catalogPath, emptyCatalog());
        }
        throw error;
    }
}

export function findReference(catalog, id) {
    return catalog.references.find((item) => item.id === id || item.archiveVideoId === id) || null;
}

export function findProduction(catalog, slug) {
    return catalog.productions.find((item) => item.slug === slug) || null;
}

export function upsertReference(catalog, entry) {
    const index = catalog.references.findIndex((item) => item.id === entry.id);
    if (index === -1) catalog.references.push(entry);
    else catalog.references[index] = { ...catalog.references[index], ...entry };
    return catalog.references[index === -1 ? catalog.references.length - 1 : index];
}

export function upsertProduction(catalog, entry) {
    const index = catalog.productions.findIndex((item) => item.slug === entry.slug);
    if (index === -1) catalog.productions.push(entry);
    else catalog.productions[index] = { ...catalog.productions[index], ...entry };
    return catalog.productions[index === -1 ? catalog.productions.length - 1 : index];
}
