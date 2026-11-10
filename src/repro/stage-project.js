import fs from 'node:fs/promises';
import path from 'node:path';
import { syncSkills, safeProjectFile } from './project.js';
import { jsonHash, fileHash } from './store.js';

export const PLAN_FILE = 'planning/shot-plan.json';
export const STAGE_GUIDE = `# Staged independent video production

The host owns stage state, budgets and acceptance. You submit editable work and observations; you cannot approve a stage or final quality yourself. Follow the current stage and output path in the invocation. Keep the frozen task, method, assets, dependencies and tools unchanged. Use the reproduce, validate and repair Skills for their respective stages.

## Analysis
Read actual reference media and the host reference evidence. Write ANALYSIS.md, TIMELINE.md and planning/shot-plan.json. The plan is your observation and design, not a replacement for task/acceptance.json. Cover the complete duration, separate observed facts from inferences, cite supplied evidence IDs, and retain uncertain details. A plan may be explicitly revised; doing so invalidates downstream evidence.

Shot plan shape:
{ "schema":"video-remake.shot-plan@1", "durationSec":<task duration>, "shots":[{
 "id":"shot-01", "startSec":0, "endSec":<end>, "title":"Observed shot",
 "subject":"focal subject", "action":"physical action and phases", "cameraIntent":"observed framing and camera movement",
 "composition":"relative proportions, visible surfaces, depth layers, crop and occlusion",
 "observations":[{"timeSec":0,"evidenceId":"<supplied reference evidence ID>","claim":"what is visible","certainty":"observed"}],
 "sampleTimesSec":[0,<middle>,<end>], "riskTags":["character-interaction","complex-motion"], "dependencies":[], "uncertainties":[]
 }] }
Every shot needs at least one observation. For a supplied frame, timeSec is its actual timeSec/seek time and the claim describes that frame. For a short shot between supplied frame samples, inspect the frozen full video (or extract your own observation frames) and cite its supplied <reference-id>:video evidence ID with the inspected timeSec. Never omit an observation merely because there is no fixed frame sample. Unseen details stay uncertain; source video identity proves provenance, not visual observation.

The dependencies field contains only IDs of earlier shots in this plan, representing cross-shot production dependencies. It is never an asset list, file path, component name or package identifier. The first shot uses []; a shot with no cross-shot dependency also uses []. Record asset choices in ANALYSIS.md instead. All times are numeric seconds. Keep exactly the JSON keys shown above, and use observed, inferred or uncertain for certainty.

Use risk tags only when appropriate to the actual reference. Do not replace physical actions with labels or generic themes. The host adds mandatory sample times; your plan cannot remove public acceptance anchors.

## Prototypes and shots
Implement the selected critical shots first, then complete the remaining shots in the current group. Generate your own scene assembly, object dimensions, poses, framing and camera paths. Reuse approved generic assets and libraries. A rendered silhouette or broad topic is not evidence that the reference action is reproduced. Maintain one consistent world scale. Keep the root composition at the full task duration so the host can sample absolute times; unfinished regions may remain blank during prototypes. This does not make the full video ready.

A successful code submission is followed by host-rendered paired evidence and a separate self-check invocation. You may run your own previews, but only host evidence is registered as stage evidence. Never render reference frames, reference video or the overview as output pixels. Record local media preparation; the host never runs arbitrary project preparation commands.

## Evidence self-check
Read every supplied pair and the continuous samples for movement. Write the requested self-check JSON under .work/stage-reports/. During a self-check invocation do not edit source, planning, notes, assets or final outputs. If a fix is needed, report it; the next repair invocation performs it. Unobserved checks stay unobserved. A self-check is a claim, never independent quality approval.

Check character orientation and physical contact; subject size and crop; intentional versus accidental occlusion; visible text; the start/middle/end of camera movement; event ordering and timing. Compare actual sampling times and offsets, not just frame indices. Neither a manifest nor a frame timestamp proves visual observation. General bounding boxes supplied by you are annotations, not trusted host measurements.

## Integration and final submission
Complete all shots, transitions, caption timing and authorized audio. Compare adjoining shots and caption boundaries. Keep English and reference wording when required; source transcription is a clue, not truth. Set reproduction.json status to ready only when the full editable implementation is ready. Record unresolved problems honestly in RENDER.md. The host checks current evidence, renders the full candidate, audits provenance, and then obtains two independent full reviews.

## Repair
Use the failed stage evidence or final review observations to diagnose your own implementation. Repair only the current permitted stage. Shared source changes invalidate earlier evidence; the host will request fresh previews and self-checks rather than silently reusing old approval. Do not weaken the task or copy teacher/previous-run implementations. If the host reports missing tools or budget exhaustion, report the blocker rather than changing global settings, escalating permissions or calling another model.
`;

/** Install a generic, versioned process overlay before the blank-generation baseline. */
export async function installStageOverlay(workspace, { protocol, execution, methodApplied = true } = {}) {
    const files = {
        'docs/stages.md': STAGE_GUIDE,
        'STAGE-CONTRACT.json': `${JSON.stringify({ schema: 'video-remake.stage-contract@1', protocol, execution, planFile: PLAN_FILE,
            selfCheckDirectory: '.work/stage-reports', hostEvidenceDirectory: '.work/stage-evidence', methodApplied }, null, 2)}\n`,
        'AGENTS.md': '# Independent staged video production\n\nRead STAGE-CONTRACT.json, docs/stages.md, task/spec.json, task/acceptance.json and inputs/values.json. The invocation selects the current stage. Read the corresponding canonical Skill in .agents/skills/. If method/ exists, follow its methods and constraints; it provides guidance, not a completed scene. Generate your own implementation. The host controls advancement and final acceptance. Do not read teacher projects, historical trials or other model services. Keep all frozen inputs and tools unchanged.\n',
        'CLAUDE.md': '@AGENTS.md\n',
    };
    const descriptions = {
        reproduce: ['Generate the current stage of a video reproduction from an empty project using reference evidence and an optional method recipe.', 'Read docs/stages.md and the current invocation. For analysis submit a cited shot plan. For production implement only the requested stage or shot group. If method/.agents/skills/reproduce/SKILL.md exists, read it for method-specific guidance. Return after submitting the requested files; the host captures evidence and schedules self-checks.'],
        validate: ['Inspect host-provided paired video evidence and submit a structured self-check without changing the implementation.', 'Read docs/stages.md and the host evidence index supplied in the invocation. Inspect paired images and motion samples. Submit observed, unobserved and unresolved findings with evidence IDs. This invocation is read-only except for its requested report file. Do not label your judgment as independent quality approval.'],
        repair: ['Repair the current failed production stage using its evidence and preserve frozen inputs and the original generation baseline.', 'Read docs/stages.md, the failure report and any method/.agents/skills/repair/SKILL.md. Diagnose and change your own implementation within the requested stage. Record unresolved issues. Shared changes require renewed host evidence; never weaken acceptance or modify host records.'],
    };
    for (const [name, [description, body]] of Object.entries(descriptions)) files[`.agents/skills/${name}/SKILL.md`] = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
    for (const [rel, text] of Object.entries(files)) {
        const target = await safeProjectFile(workspace, rel, { create: true });
        await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, text);
    }
    await syncSkills(workspace);
    const lockedFiles = {};
    for (const rel of [...Object.keys(files), '.agents/skill-copies.json', ...Object.keys(descriptions).map(name => `.claude/skills/${name}/SKILL.md`)]) lockedFiles[rel] = await fileHash(await safeProjectFile(workspace, rel));
    return { lockedFiles, overlayHash: jsonHash(files) };
}
