import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { reviseMethod, freezeMethodRevisionDraft } from '../src/repro/method-revision.js';
import { scaffoldMethodRecipe, freezeMethodRecipe, loadMethodRecipe } from '../src/repro/method-store.js';
import { validateWorkflow } from '../src/repro/config.js';
import { readJson, storage } from '../src/repro/store.js';

async function setup(t) {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'method-revision-')));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const workspace = path.join(directory, 'workspace'); await fs.mkdir(workspace);
    const config = { workspace, env: { VIDEO_REMAKE_AGENT_HOME: path.join(directory, 'state') } };
    const source = path.join(directory, 'source');
    await scaffoldMethodRecipe(source, { contentReview: { reviewer: 'fixture', notes: 'Method prose.', containsTargetImplementation: false } });
    const method = await freezeMethodRecipe(config, { directory: source, name: 'fixture', version: 1 });
    const runs = new Map(['first','second'].map(slug => [slug, { id: `r_${slug}`, production: slug, status: 'needs-revision', method: { id: method.id, treeHash: method.treeHash }, methodApplied: true,
        specHash: 'spec-hash', inputsHash: `inputs-${slug}`, references: [{ id: 'reference', source: { sha256: 'reference-hash', videoPath: '/Users/private/movie.mp4' } }],
        workspace: '/Users/private/trial-source', spec: { acceptance: { review: [{ id: 'framing', description: 'Framing matches.' }] } },
        reviewSource: { votes: [1,2].map(vote => ({ runId: `${slug}-review-${vote}`, review: { checks: [{ id: 'framing', status: 'fail', observationStatus: 'observed', notes: 'Printer obscured by foreground object.' }] } })) },
        stageSubmissions: [{ id:'stage-1',stageId:'shots',status:'stale',hostChecks:[{id:'media',passed:true,message:'Media complete.'}],selfCheck:{checks:[{id:'framing',status:'pass',notes:'Executor claims matching framing.'}]}}],
        attempts: [{ number: 1, error: { code: 'RENDER_TIMEOUT', message: 'See /Users/private/run/log.txt', data: { source: '<script>PRIVATE_SCENE</script>' } } }],
    }]));
    const calls = [];
    const deps = { loadRun: async(_config, slug) => structuredClone(runs.get(slug)), loadWorkflow: async() => validateWorkflow({schemaVersion:2,roles:{extractor:'high'}}),
        runProjectAgent: async(_config, options, hooks) => {
            calls.push(options); await hooks.onStart?.({ runId:'p_revision' });
            const request = await readJson(options.workspace,'context/REQUEST.json');
            const report = await readJson(options.workspace,request.feedback[0].report);
            await fs.appendFile(path.join(options.workspace,'method/methods/workflow.md'),'\nInspect foreground occlusion at start, middle and end of each camera move.\n');
            await fs.writeFile(path.join(options.workspace,'REVISION.json'),JSON.stringify({schema:'video-remake.method-revision-analysis@1',diagnoses:[{category:'uncertain',confidence:'medium',evidenceIds:[report.evidence[0].id],observation:'Independent reviewers reported occlusion.',hypothesis:'The checking procedure may miss intermediate camera positions.',methodFiles:['methods/workflow.md'],change:'Require intermediate visibility checks.',verification:'Run a new blank project with the same workflow and final double review.'}],unresolved:['Whether execution followed existing method.']}));
            return {runId:'p_revision',status:'completed',role:'extractor',requestedModel:'high',observedModel:'high',harness:{adapter:'fixture'},toolCalls:3,renderCalls:0,usage:{totalTokens:50},costUsd:0.1};
        }};
    return { directory,config,method,runs,calls,deps,options:{name:'fixture',version:2,feedback:['first','second']} };
}

test('method revision creates only a pending draft from report snapshots with separate budget and lineage',async t=>{
    const f=await setup(t);const before=structuredClone([...f.runs]);
    const result=await reviseMethod(f.config,f.method.id,f.options,f.deps);
    assert.equal(result.status,'draft');assert.equal(result.target.id,'fixture@2');assert.equal(result.source.treeHash,f.method.treeHash);
    assert.equal(result.feedback.length,2);assert.ok(result.feedback.every(item=>item.reportHash));assert.equal(result.budget.calls,1);assert.equal(result.budget.tokens,50);assert.equal(result.budget.renderCalls,0);
    assert.equal((await loadMethodRecipe(f.config,f.method.id)).treeHash,f.method.treeHash);assert.deepEqual([...f.runs],before);
    await assert.rejects(loadMethodRecipe(f.config,'fixture@2'),{code:'ENOENT'});
    const manifest=await readJson(result.draft.path,'recipe.json');assert.equal(manifest.contentReview.reviewer,'pending');
    await assert.rejects(freezeMethodRecipe(f.config,{directory:result.draft.path,name:'fixture',version:2}),/尚未完成/);
    const request=await readJson(f.calls[0].workspace,'context/REQUEST.json');
    const group=request.repeatedFailures.find(item=>item.criterionId==='framing');assert.equal(group.observedRunCount,2);assert.equal(group.reportCount,4);
    assert.equal(request.repeatedFailures.some(item=>item.origin==='executor-self-report'),false,'self-reported passing checks do not become final adverse evidence');
    const feedback=await readJson(f.calls[0].workspace,request.feedback[0].report);const encoded=JSON.stringify(feedback);
    assert.ok(!encoded.includes('PRIVATE_SCENE'));assert.ok(!encoded.includes('/Users/'));assert.ok(!encoded.includes('videoPath'));
    assert.ok(feedback.evidence.some(item=>item.origin==='execution-failure'));assert.ok(feedback.evidence.some(item=>item.origin==='executor-self-report'));
    assert.equal(f.calls[0].role,'extractor');assert.deepEqual(f.calls[0].capabilityRequirements,[]);assert.deepEqual(f.calls[0].files,['context/REQUEST.json']);
    assert.equal((await readJson(path.dirname(result.recordPath),'revision.json')).status,'draft');
});

test('invalid source, feedback, occupied target and timeout are rejected before model execution',async t=>{
    const f=await setup(t);
    for(const options of [{...f.options,version:1},{...f.options,name:'../bad'},{...f.options,feedback:[]},{...f.options,feedback:['first','first']},{...f.options,timeoutMs:0}])await assert.rejects(reviseMethod(f.config,f.method.id,options,f.deps));
    f.runs.get('first').method.treeHash='changed';await assert.rejects(reviseMethod(f.config,f.method.id,f.options,f.deps),/当前冻结方法/);f.runs.get('first').method.treeHash=f.method.treeHash;
    f.runs.get('first').activeAgentRunId='active';await assert.rejects(reviseMethod(f.config,f.method.id,f.options,f.deps),{code:'REPRO_BUSY'});delete f.runs.get('first').activeAgentRunId;
    await fs.mkdir(path.join(f.config.workspace,'reproductions/methods/fixture/v2'));
    await assert.rejects(reviseMethod(f.config,f.method.id,f.options,f.deps),{code:'REPRO_EXISTS'});assert.equal(f.calls.length,0);
});

test('context mutation and invented feedback attribution remain failed research records without freezing',async t=>{
    for(const mode of ['context','citation','implementation','assets']){
        const f=await setup(t);const original=f.deps.runProjectAgent;
        f.deps.runProjectAgent=async(...args)=>{const result=await original(...args);const workspace=args[1].workspace;
            if(mode==='context'){const file=path.join(workspace,'context/REQUEST.json');await fs.chmod(file,0o644);await fs.appendFile(file,' ');}
            if(mode==='citation'){const analysis=await readJson(workspace,'REVISION.json');analysis.diagnoses[0].evidenceIds=['invented'];await fs.writeFile(path.join(workspace,'REVISION.json'),JSON.stringify(analysis));}
            if(mode==='implementation')await fs.writeFile(path.join(workspace,'method/scene.js'),'target scene');
            if(mode==='assets'){const manifest=await readJson(workspace,'method/recipe.json');manifest.assetPacks=['another@1'];await fs.writeFile(path.join(workspace,'method/recipe.json'),JSON.stringify(manifest));}
            return result;};
        let caught;try{await reviseMethod(f.config,f.method.id,f.options,f.deps);}catch(error){caught=error;}assert.ok(caught,mode);
        const record=await readJson(path.dirname(caught.data.recordPath),'revision.json');assert.equal(record.status,'failed');assert.equal(record.budget.calls,1);
        await assert.rejects(loadMethodRecipe(f.config,'fixture@2'),{code:'ENOENT'});assert.equal((await loadMethodRecipe(f.config,f.method.id)).treeHash,f.method.treeHash);
    }
});

test('interrupted revision persists accounting and the draft location without changing history',async t=>{
    const f=await setup(t);f.deps.runProjectAgent=async()=>{throw Object.assign(new Error('Timed out'),{code:'AGENT_TIMED_OUT',data:{reproAgent:{runId:'p_timed',status:'timed_out',toolCalls:2}}});};
    let caught;try{await reviseMethod(f.config,f.method.id,f.options,f.deps);}catch(error){caught=error;}
    assert.equal(caught.code,'AGENT_TIMED_OUT');const record=await readJson(path.dirname(caught.data.recordPath),'revision.json');
    assert.equal(record.status,'interrupted');assert.equal(record.budget.calls,1);assert.equal(record.budget.toolCalls,2);assert.equal(record.budget.costComplete,false);assert.equal(record.budget.usageComplete,false);
    assert.ok(caught.data.draftPath.startsWith(path.join(storage(f.config),'method-revisions')));assert.equal(f.runs.get('first').status,'needs-revision');
});

test('freezing a reviewed registered draft verifies its host record and preserves feedback lineage',async t=>{
    const f=await setup(t);const revision=await reviseMethod(f.config,f.method.id,f.options,f.deps);
    assert.equal(await freezeMethodRevisionDraft(f.config,f.method.root,{name:'ordinary',version:1},f.deps),null);
    await assert.rejects(freezeMethodRevisionDraft(f.config,revision.draft.path,{name:'fixture',version:2},f.deps),/尚未完成/);
    const manifest=await readJson(revision.draft.path,'recipe.json');manifest.contentReview={reviewer:'fixture-content-review',notes:'Reviewed the revised method prose independently.',containsTargetImplementation:false};
    await fs.writeFile(path.join(revision.draft.path,'recipe.json'),JSON.stringify(manifest));
    await assert.rejects(freezeMethodRevisionDraft(f.config,revision.draft.path,{name:'other',version:2},f.deps),/修订目标/);
    const frozen=await freezeMethodRevisionDraft(f.config,revision.draft.path,{name:'fixture',version:2},f.deps);
    assert.equal(frozen.id,'fixture@2');assert.equal(frozen.provenance.parentMethod.treeHash,f.method.treeHash);
    assert.equal(frozen.provenance.feedback.length,2);assert.equal(frozen.provenance.revision.id,revision.id);assert.equal(frozen.provenance.revision.extractor.runId,'p_revision');
    assert.deepEqual(frozen.provenance.developmentInputs,['inputs-first','inputs-second']);assert.equal(frozen.provenance.references[0].sha256,'reference-hash');
    assert.equal((await loadMethodRecipe(f.config,f.method.id)).treeHash,f.method.treeHash);
});

test('edited draft text cannot inherit the old revision analysis on freeze',async t=>{
    const f=await setup(t);const revision=await reviseMethod(f.config,f.method.id,f.options,f.deps);
    await fs.appendFile(path.join(revision.draft.path,'methods/workflow.md'),'\nUnattributed new method.');
    await assert.rejects(freezeMethodRevisionDraft(f.config,revision.draft.path,{name:'fixture',version:2},f.deps),/归因后被改写/);
    await assert.rejects(loadMethodRecipe(f.config,'fixture@2'),{code:'ENOENT'});
});
