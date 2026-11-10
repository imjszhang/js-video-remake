import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeTemplateLineages } from '../src/template-lineage.js';

function pkg(name, title, parent = null) {
    return { name, manifest: { id: 'example', version: Number(name.match(/-v(\d+)$/)[1]), title, template: { format: 'video-template@1' }, source: { forkedFrom: parent ? { video: parent } : null } } };
}

test('legacy imported v7 and separately derived v8/v9/v10 form independent template histories', () => {
    const packages = [pkg('example-v7', '原作'), pkg('example-v8', '森林绿', 'example-v7'), pkg('example-v9', '极简', 'example-v7'), pkg('example-v10', '冷蓝', 'example-v7')];
    const result = describeTemplateLineages(packages);
    assert.equal(result.get('example-v7').kind, 'source');
    assert.equal(result.get('example-v7').version, 7);
    const children = ['example-v8', 'example-v9', 'example-v10'].map(name => result.get(name));
    assert.equal(new Set(children.map(item => item.id)).size, 3);
    for (const child of children) {
        assert.equal(child.version, 1);
        assert.equal(child.kind, 'derived');
        assert.equal(child.origin.version, 7);
        assert.equal(child.origin.id, 'example');
    }
    assert.deepEqual(describeTemplateLineages([...packages].reverse()), result, 'classification is independent of directory order');
});

test('legacy same-template revision shares its family and records the exact parent', () => {
    const result = describeTemplateLineages([pkg('example-v7', '原作'), pkg('example-v8', '森林绿', 'example-v7'), pkg('example-v9', '森林绿', 'example-v8')]);
    assert.equal(result.get('example-v9').id, result.get('example-v8').id);
    assert.equal(result.get('example-v9').version, 2);
    assert.equal(result.get('example-v9').parent.video, 'example-v8');
    assert.equal(result.get('example-v9').parent.version, 1);
});
