import { createHash } from 'node:crypto';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const version = value => Number.isSafeInteger(value) && value > 0;
const pointer = (lineage, video) => ({ id: lineage.id, title: lineage.title, version: lineage.version, video });
const validPointer = value => value === null || (value && ID.test(value.id) && version(value.version) && typeof value.title === 'string' && typeof value.video === 'string');

/** Explicit metadata is portable; legacy relations are interpreted without rewriting frozen packages. */
export function describeTemplateLineages(packages) {
    const templates = packages.filter(pkg => pkg.manifest?.template?.format === 'video-template@1');
    const byName = new Map(templates.map(pkg => [pkg.name, pkg]));
    const result = new Map();
    const visiting = new Set();
    const infer = pkg => {
        if (result.has(pkg.name)) return result.get(pkg.name);
        const manifest = pkg.manifest;
        const saved = manifest.template.lineage;
        if (saved && ID.test(saved.id) && version(saved.version) && ['source', 'derived'].includes(saved.kind)
            && typeof saved.title === 'string' && validPointer(saved.origin ?? null) && validPointer(saved.parent ?? null)) {
            const lineage = { id: saved.id, title: saved.title, version: saved.version, kind: saved.kind, origin: saved.origin ?? null, parent: saved.parent ?? null };
            result.set(pkg.name, lineage);
            return lineage;
        }
        const sourceId = ID.test(manifest.id) ? manifest.id : pkg.name.replace(/-v\d+$/, '');
        const source = { id: sourceId, title: manifest.title || sourceId, version: version(manifest.version) ? manifest.version : 1, kind: 'source', origin: null, parent: null };
        // Cyclic or missing old references cannot establish a lineage.
        if (visiting.has(pkg.name)) return source;
        visiting.add(pkg.name);
        const ancestor = byName.get(manifest.source?.forkedFrom?.video);
        let lineage = source;
        if (ancestor && ancestor !== pkg) {
            const parent = infer(ancestor);
            const sameTemplate = parent.kind === 'derived' && parent.title === source.title;
            const id = sameTemplate ? parent.id : `template-${createHash('sha256').update(pkg.name).update('\0').update(source.title).digest('hex').slice(0, 12)}`;
            lineage = {
                id, title: source.title, version: sameTemplate ? parent.version + 1 : 1, kind: 'derived',
                origin: sameTemplate ? parent.origin : pointer(parent, ancestor.name),
                parent: pointer(parent, ancestor.name),
            };
        }
        visiting.delete(pkg.name);
        result.set(pkg.name, lineage);
        return lineage;
    };
    for (const pkg of templates) infer(pkg);
    return result;
}

export function templateLineagePointer(pkg) {
    return pointer(pkg.lineage, pkg.name);
}
