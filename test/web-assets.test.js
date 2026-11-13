import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEB_ASSETS } from '../src/web-server.js';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const served = new Set([...WEB_ASSETS.values()].map(([file]) => file));
const routeFor = file => [...WEB_ASSETS].find(([, [name]]) => name === file)?.[0];

/** 静态资源按白名单提供；漏登记的模块在浏览器里是 404，页面整体不可用。 */
test('every module imported by a served script is itself served', async () => {
    const scripts = [...served].filter(file => file.endsWith('.js'));
    assert.ok(scripts.includes('app.js'));
    for (const file of scripts) {
        const source = await fs.readFile(path.join(webRoot, file), 'utf8');
        for (const [, specifier] of source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
            assert.match(specifier, /^\.\/[a-z-]+\.js$/, `${file} imports ${specifier}; only sibling modules are allowed`);
            const target = specifier.slice(2);
            assert.ok(served.has(target), `${file} imports ${specifier}, which the server does not serve`);
            assert.equal(routeFor(target), `/${target}`, `${target} must be served at the path the import resolves to`);
        }
    }
});

test('every script and stylesheet referenced by a served page is served and exists', async () => {
    const pages = [...served].filter(file => file.endsWith('.html'));
    assert.deepEqual(pages.sort(), ['index.html', 'references.html', 'repro.html']);
    for (const page of pages) {
        const html = await fs.readFile(path.join(webRoot, page), 'utf8');
        const references = [...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="\.\/([^"#?]+\.(?:js|css))"/g)].map(match => match[1]);
        assert.ok(references.length, `${page} references no local assets`);
        for (const reference of references) assert.ok(served.has(reference), `${page} references ${reference}, which the server does not serve`);
    }
    for (const file of served) await fs.access(path.join(webRoot, file));
});

test('no web source file is left outside the served manifest', async () => {
    const onDisk = (await fs.readdir(webRoot)).filter(file => /\.(js|css|html)$/.test(file));
    assert.deepEqual(onDisk.filter(file => !served.has(file)), []);
});
