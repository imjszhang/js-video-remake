import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { appError } from '../errors.js';

export const SKILL_NAMES = ['reproduce', 'validate', 'repair'];
const hash = value => createHash('sha256').update(value).digest('hex');

function validMetadata(body, name) {
    const header = /^---\r?\n([\s\S]+?)\r?\n---(?:\r?\n|$)/.exec(body)?.[1];
    return header && new RegExp(`^name: ${name}$`, 'm').test(header)
        && /^description:\s*\S+/m.test(header);
}

export function skillScaffold() {
    return {
        reproduce: `---
name: reproduce
description: Adapt this reproduction project to new text and media inputs while preserving its reference-specific visual and timing rules.
---

Read task/brief.md, inputs/values.json and task/inputs.schema.json before editing. Use docs/workflow.md for the project-specific sequence, mappings and reference decisions. Preserve the requirements in task/acceptance.json; they are also checked independently outside this project.

Change the editable implementation in src/ and the declared assets. Keep paths relative and use local dependencies. Run npm run doctor, npm run render, then use the validate skill. Record missing capabilities or source material instead of substituting a teacher's rendered video. Do not introduce a dependency on the workspace that generated this project.
`,
        validate: `---
name: validate
description: Check a rendered reproduction against this project's input replacements, output contract and visible reference requirements.
---

Run npm run check and inspect its report. Compare actual rendered frames at the required moments and inspect audio when required. Read task/acceptance.json for the technical and visual criteria, and docs/workflow.md for the reference-specific evidence to collect.

Verify that each supplied input is represented in the output, including long text and optional media. Record the frame or audio evidence used for each observation. Mark an unobserved criterion as unobserved, not passed. This self-check helps repair the project; external acceptance remains authoritative.
`,
        repair: `---
name: repair
description: Diagnose and repair a failed render or acceptance check in this reproduction project using recorded evidence.
---

Read the failed check and its associated evidence first. Use docs/troubleshooting.md for project-specific causes and fixes. Distinguish missing dependencies or capabilities from incorrect content, layout, timing or audio.

Repair the implementation or input mapping without weakening the acceptance criteria. Re-render when output changes, rerun npm run check, and collect fresh evidence for the affected criteria. Keep the correction within the current task's attempt and time budget; report unresolved failures when that budget is exhausted.
`,
    };
}

async function safeEntries(root, prefix = '') {
    const files = [];
    for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw appError('REPRO_INVALID', `Skill 不接受符号链接: ${rel}`);
        if (entry.isDirectory()) files.push(...await safeEntries(root, rel));
        else if (entry.isFile()) files.push(rel);
        else throw appError('REPRO_INVALID', `Skill 文件类型不支持: ${rel}`);
    }
    return files.sort();
}

async function assertDirectory(root, rel) {
    let current = root;
    for (const segment of rel.split('/')) {
        current = path.join(current, segment);
        try {
            const stat = await fs.lstat(current);
            if (stat.isSymbolicLink() || !stat.isDirectory()) throw appError('REPRO_INVALID', `Skill 目录不安全: ${rel}`);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await fs.mkdir(current);
        }
    }
    return current;
}

// Canonical skills can include references/scripts/assets. Copies have identical
// bytes; no symlinks are needed when a template is moved to another machine.
export async function syncSkills(root) {
    const canonical = await assertDirectory(root, '.agents/skills');
    const destination = await assertDirectory(root, '.claude/skills');
    const inventory = [];
    for (const name of SKILL_NAMES) {
        const source = path.join(canonical, name);
        const stat = await fs.lstat(source);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw appError('REPRO_INVALID', `缺少标准 Skill: ${name}`);
        const body = await fs.readFile(path.join(source, 'SKILL.md'), 'utf8');
        if (!validMetadata(body, name)) {
            throw appError('REPRO_INVALID', `Skill 元数据无效: ${name}`);
        }
        const files = await safeEntries(source);
        const target = path.join(destination, name);
        try { if ((await fs.lstat(target)).isSymbolicLink()) throw appError('REPRO_INVALID', `Skill 目标不接受符号链接: ${name}`); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.rm(target, { recursive: true, force: true });
        for (const file of files) {
            const bytes = await fs.readFile(path.join(source, file));
            await fs.mkdir(path.dirname(path.join(target, file)), { recursive: true });
            await fs.writeFile(path.join(target, file), bytes);
            inventory.push({ path: `${name}/${file}`, sha256: hash(bytes) });
        }
    }
    const record = { schema: 'video-remake.skill-copies@1', canonical: '.agents/skills', copies: ['.claude/skills'], files: inventory };
    await fs.writeFile(path.join(root, '.agents/skill-copies.json'), `${JSON.stringify(record, null, 2)}\n`);
    return record;
}

export async function validateSkills(root) {
    const record = JSON.parse(await fs.readFile(path.join(root, '.agents/skill-copies.json'), 'utf8'));
    if (record.schema !== 'video-remake.skill-copies@1' || !Array.isArray(record.files)) throw appError('REPRO_INVALID', 'Skill 清单格式无效');
    const actual = [];
    for (const name of SKILL_NAMES) {
        for (const file of await safeEntries(path.join(root, '.agents/skills', name))) actual.push(`${name}/${file}`);
        const body = await fs.readFile(path.join(root, '.agents/skills', name, 'SKILL.md'), 'utf8');
        if (!validMetadata(body, name)) throw appError('REPRO_INVALID', `Skill 元数据无效: ${name}`);
    }
    if (JSON.stringify(actual.sort()) !== JSON.stringify(record.files.map(f => f.path).sort())) throw appError('REPRO_INVALID', 'Skill 清单已过期，请重新同步');
    const copied = await safeEntries(path.join(root, '.claude/skills'));
    if (JSON.stringify(copied) !== JSON.stringify(actual)) throw appError('REPRO_INVALID', 'Skill 副本目录包含缺失或额外文件');
    for (const file of record.files) {
        if (!actual.includes(file.path)) throw appError('REPRO_INVALID', 'Skill 清单包含无效路径');
        for (const base of ['.agents/skills', '.claude/skills']) {
            const bytes = await fs.readFile(path.join(root, base, file.path));
            if (hash(bytes) !== file.sha256) throw appError('REPRO_INVALID', `Skill 副本与来源不一致: ${base}/${file.path}`);
        }
    }
    return record;
}

// Ship the same tested sync implementation inside independent projects. Every
// referenced helper is included; generated code imports only Node built-ins.
export function portableSkillSyncScript() {
    return `import fs from 'node:fs/promises';\nimport path from 'node:path';\nimport { createHash } from 'node:crypto';\nimport { fileURLToPath } from 'node:url';\nconst root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));\nconst SKILL_NAMES = ${JSON.stringify(SKILL_NAMES)};\nconst hash = value => createHash('sha256').update(value).digest('hex');\nconst appError = (code, message) => Object.assign(new Error(message), {code});\n${validMetadata.toString()}\n${safeEntries.toString()}\n${assertDirectory.toString()}\n${syncSkills.toString()}\nconsole.log(JSON.stringify(await syncSkills(root), null, 2));\n`;
}
