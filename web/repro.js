const $ = id => document.getElementById(id);
const roleLabels = { teacher: '高阶制作', extractor: '方法提炼', executor: '低阶执行', reviewer: '独立评审' };
const statuses = { prepared: '等待启动', running: '执行中', rendering: '渲染中', passed: '验收通过', 'external-review': '等待外部评审', 'needs-revision': '需要修订', cancelled: '已取消', interrupted: '执行中断', blocked: '环境阻塞', 'budget-exhausted': '预算耗尽', failed: '失败', completed: '完成', invalid: '记录无效', candidate: '候选配方', released: '已发布' };
let workflow, listing, mode = 'teacher', activeJob, selectedRun, selectedDetail, pollTimer, lastFinishedJob, lastStageSignature;
const stageStatuses = { pending: '等待前置阶段', ready: '可以开始', running: '执行中', checking: '检查材料', submitted: '已提交材料', 'awaiting-self-check': '等待执行者检查预览', 'evidence-complete': '材料检查完成', 'needs-revision': '需要修订', stale: '上游已变化，需重查', blocked: '暂时阻塞', complete: '阶段记录完成', completed: '阶段记录完成', passed: '阶段记录完成', failed: '检查失败', skipped: '不适用' };
const actionLabels = { run: '继续当前阶段', render: '重试渲染', check: '检查当前材料', judge: '开始最终双评审', repair: '让执行模型修复', retry: '重新从空工程开始', recover: '整理中断记录', resume: '恢复检查点', cancel: '停止当前执行' };

function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function notice(message, error = false) { $('notice').textContent = message; $('notice').className = `notice${error ? ' error' : ''}`; $('notice').hidden = false; }
async function api(url, options = {}) {
    const response = await fetch(`./api/repro${url}`, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `请求失败 (${response.status})`);
    return value;
}
const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body) });
function parsed(id) { try { return JSON.parse($(id).value); } catch { throw new Error(`${id === 'spec' ? '复刻规格' : '本次输入'}不是有效的 JSON。`); } }
function showResult(value) { $('result').textContent = JSON.stringify(value, null, 2); }
function button(label, handler, className = 'secondary') { const el = node('button', label, className); el.type = 'button'; el.addEventListener('click', () => handler().catch(error => notice(error.message, true))); return el; }
function setMode(value) {
    mode = value;
    for (const key of ['teacher', 'method']) { $(`mode-${key}`).classList.toggle('active', key === mode); $(`mode-${key}`).setAttribute('aria-pressed', String(key === mode)); }
    $('production-field').hidden = mode !== 'teacher'; $('spec-field').hidden = false; $('method-fields').hidden = mode !== 'method';
    $('production').required = mode === 'teacher'; $('method').required = mode === 'method'; $('new-slug').required = mode === 'method'; $('reference').required = mode === 'method';
    $('create-button').textContent = mode === 'teacher' ? '初始化教师制作' : '从空工程创建制作';
}
function fillSelect(select, items, placeholder, current = select.value) {
    select.replaceChildren(new Option(placeholder, ''));
    for (const [value, label] of items) select.add(new Option(label, value));
    if ([...select.options].some(option => option.value === current)) select.value = current;
}
function runModeLabel(run) {
    if (run.generationMode === 'method-generation' || run.method) return '从空工程生成';
    if (run.generationMode === 'project-replay' || run.template) return '历史工程回放';
    return run.kind === 'baseline' ? '空工程基线' : '教师制作';
}
function stagedRun(run) { return run.schema === 'video-remake.reproduction-run@3' || Boolean(run.stageState); }
function renderRunActions(run) {
    const area = $('detail-actions'); area.replaceChildren(); $('action-reasons').replaceChildren();
    const staged = stagedRun(run);
    const allowed = Array.isArray(run.allowedActions) ? run.allowedActions.map(action => typeof action === 'string' ? action : action.action) : staged ? [] : Object.keys(actionLabels).filter(action => action !== 'cancel' || run.activeAgentRunId || run.activeRender || run.activeOperation);
    for (const [action, label] of Object.entries(actionLabels)) {
        if (!allowed.includes(action)) continue;
        area.append(button(!staged && action === 'run' ? '启动执行' : label, () => action === 'cancel' ? cancelRun(run.production) : launch(action, run.production, action === 'check' ? { evidence: true } : {})));
        if (staged && action === 'run') area.append(button('只执行下一阶段', () => launch('run', run.production, { step: true })));
    }
    for (const [action, reason] of Object.entries(run.blockedReasons || {})) {
        if (allowed.includes(action) || !actionLabels[action]) continue;
        $('action-reasons').append(node('p', `${actionLabels[action]}：${Array.isArray(reason) ? reason.join('；') : reason}`));
    }
    if (staged && !allowed.length && !Object.keys(run.blockedReasons || {}).length) $('action-reasons').append(node('p', '当前没有可执行操作。阶段操作由工作流检查结果决定。'));
}
function appendStageMedia(container, item) {
    const block = node('div', undefined, 'stage-media-item');
    if (item.type?.startsWith('image/')) { const image = node('img'); image.src = `./${item.url}`; image.alt = item.label; image.loading = 'lazy'; block.append(image); }
    else if (item.type?.startsWith('video/') || item.type?.startsWith('audio/')) { const media = node(item.type.startsWith('video/') ? 'video' : 'audio'); media.src = `./${item.url}`; media.controls = true; media.preload = 'none'; block.append(media); }
    else return;
    block.append(node('p', item.label || item.id, 'small muted'));
    if (item.submissionId) block.append(node('p', `提交 ${item.submissionId}${item.submissionStatus === 'stale' ? ` · 已失效${item.staleReason ? `：${item.staleReason}` : ''}` : ''}`, item.submissionStatus === 'stale' ? 'small stage-warning' : 'small muted'));
    if (item.sampleTimeSec !== null && item.sampleTimeSec !== undefined && item.timeSec !== item.sampleTimeSec) block.append(node('p', `计划 ${item.sampleTimeSec}s · 实际取帧 seek ${item.timeSec ?? '未知'}s · 帧时间戳 ${item.framePtsSec ?? '未测得'}`, 'small muted'));
    container.append(block);
}
function showStages(run, evidence = []) {
    const navigation = $('stage-navigation'), cards = $('stage-cards'); navigation.replaceChildren(); cards.replaceChildren();
    const stages = Array.isArray(run.stageState?.stages) ? run.stageState.stages : [];
    $('stage-progress').textContent = stages.length ? `${stages.filter(stage => ['evidence-complete', 'complete', 'completed', 'passed'].includes(stage.status)).length}/${stages.length} 项阶段记录` : '历史流程';
    $('stage-note').textContent = stages.length ? '阶段记录区分宿主材料检查和执行者自检；它们不等于最终视觉验收。上游变化会使相关记录失效。' : '此运行没有阶段证据；历史记录保持原样，不补造阶段通过状态。';
    if (run.protocolCompatibility?.matches === false) $('stage-note').textContent = run.protocolCompatibility.message;
    const current = typeof run.stageState?.currentStage === 'object' ? run.stageState.currentStage?.id : run.stageState?.currentStage;
    const stageOrder = ['freeze', 'analysis', 'prototypes', 'shots', 'integration', 'submission', 'review'];
    const allowed = (run.allowedActions || []).map(action => typeof action === 'string' ? action : action.action);
    const busy = activeJob || run.activeOperation || run.activeAgentRunId || run.activeRender || ['running', 'rendering'].includes(run.status)
        || ['preparing', 'running'].includes(run.activeAgent?.status);
    const canRepair = id => !busy && allowed.includes('repair') && ['analysis', 'prototypes', 'shots', 'integration'].includes(id)
        && stageOrder.slice(0, stageOrder.indexOf(id)).every(required => ['complete', 'evidence-complete', 'stale'].includes(stages.find(stage => (stage.id || stage.stageId) === required)?.status));
    for (const stage of stages) {
        const id = stage.id || stage.stageId;
        const card = node('article', undefined, `stage-card${stage.status === 'stale' || stage.stale ? ' stale' : ''}`); card.id = `stage-${id}`;
        const head = node('div', undefined, 'section-title'); head.append(node('h3', `${stage.title || stage.label || id}${stage.shotId ? ` · ${stage.shotId}` : ''}`), node('span', stageStatuses[stage.status] || stage.status || '未开始', 'pill')); card.append(head);
        if (id === current) card.append(node('p', '当前阶段', 'small stage-current'));
        if (stage.staleReason || stage.invalidationReason) card.append(node('p', String(stage.staleReason || stage.invalidationReason), 'stage-warning'));
        if (stage.goal || stage.description) card.append(node('p', stage.goal || stage.description, 'small muted'));
        const submission = [...(run.stageSubmissions || [])].reverse().find(item => (item.stageId || item.stage) === id && (!stage.shotId || item.shotId === stage.shotId));
        const checks = stage.hostChecks || submission?.hostChecks || [];
        const checkList = node('ul', undefined, 'stage-checks');
        for (const check of checks) checkList.append(node('li', `${check.passed === true ? '材料检查通过' : check.passed === false ? '材料检查未通过' : '待检查'} · ${check.message || check.id}`));
        if (!checks.length) checkList.append(node('li', '宿主材料检查：尚无记录'));
        card.append(checkList);
        const self = stage.selfCheck || submission?.selfCheck;
        const selfLabel = self?.checks?.length ? self.checks.some(check => check.status !== 'pass') || self.unresolved?.length ? '自报仍有问题或未充分观察项' : '自报无未解决问题' : self ? self.status || '已提交' : '尚未提交';
        card.append(node('p', `执行者自检：${selfLabel}（不替代最终质量评审）`, 'small'));
        if (self?.notes) card.append(node('p', typeof self.notes === 'string' ? self.notes : JSON.stringify(self.notes), 'small muted'));
        if (self?.checks?.length) {
            const observations = node('details'), observationsList = node('ul', undefined, 'stage-checks'); observations.append(node('summary', '执行者观察记录'));
            for (const check of self.checks) observationsList.append(node('li', `${check.shotId || ''} · ${check.id} · ${{ pass: '自报通过', fail: '自报有问题', unobserved: '未充分观察' }[check.status] || check.status}：${check.notes || '无说明'}`));
            observations.append(observationsList); card.append(observations);
        }
        if (stage.requiredArtifacts?.length) card.append(node('p', `应交材料：${stage.requiredArtifacts.map(value => typeof value === 'string' ? value : value.label || value.id || value.path).join('、')}`, 'small muted'));
        const media = node('div', undefined, 'stage-media');
        for (const item of evidence.filter(item => item.stageId === id && (!stage.shotId || !item.shotId || item.shotId === stage.shotId))) appendStageMedia(media, item);
        card.append(media);
        card.append(button('查看本阶段证据', async () => { const detail = await api(`/runs/${encodeURIComponent(run.production)}/stages/${encodeURIComponent(id)}`); media.replaceChildren(); for (const item of detail.evidence || []) appendStageMedia(media, item); if (!media.children.length) media.append(node('p', '尚无可读取的冻结媒体证据。', 'small muted')); }));
        if (canRepair(id)) card.append(button(id === 'analysis' ? '修订参考分析' : '修复本阶段', () => launch('repair', run.production, { stage: id, step: true })));
        if (id === 'shots' && run.shotPlan?.shots?.length) {
            const shots = node('div', undefined, 'shot-cards');
            for (const shot of run.shotPlan.shots) {
                const shotCard = node('div', undefined, 'shot-card');
                const record = [...(run.stageSubmissions || [])].reverse().find(item => (item.stageId || item.stage) === 'shots' && (item.shotId === shot.id || item.shotIds?.includes(shot.id)));
                shotCard.append(node('strong', `${shot.title || shot.id} · ${shot.startSec}–${shot.endSec}s`));
                shotCard.append(node('p', [shot.subject, shot.action].filter(Boolean).join(' · '), 'small muted'));
                if (shot.cameraIntent) shotCard.append(node('p', `镜头意图：${shot.cameraIntent}`, 'small muted'));
                shotCard.append(node('p', record ? record.stale || record.status === 'stale' || stage.status === 'stale' ? '证据已失效，需重查' : '已有宿主证据记录；视觉质量待最终评审' : '尚无宿主提交记录', 'small'));
                const shotMedia = node('div', undefined, 'stage-media');
                shotCard.append(button('查看镜头证据', async () => { const detail = await api(`/runs/${encodeURIComponent(run.production)}/stages/shots`); shotMedia.replaceChildren(); for (const item of detail.evidence || []) if (item.shotId === shot.id || item.shotIds?.includes(shot.id)) appendStageMedia(shotMedia, item); if (!shotMedia.children.length) shotMedia.append(node('p', '尚无该镜头的冻结证据。', 'small muted')); }));
                if (canRepair('shots') && (stage.status === 'stale' || stage.status === 'needs-revision')) shotCard.append(button('修复此镜头', () => launch('repair', run.production, { stage: 'shots', shot: shot.id, step: true })));
                shotCard.append(shotMedia); shots.append(shotCard);
            }
            card.append(shots);
        }
        navigation.append(button(stage.title || stage.label || id, async () => { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, id === current ? '' : 'secondary'));
        cards.append(card);
    }
}
function showRunSummary(run) {
    const summary = $('detail-summary'); summary.replaceChildren();
    const maker = run.activeAgent || [...(run.stageExecutions || [])].reverse().find(execution => execution.agent)?.agent
        || [...(run.attempts || [])].reverse().flatMap(attempt => [...(attempt.agents || [])].reverse())[0];
    const harness = typeof maker?.harness === 'string' ? maker.harness : maker?.harness?.adapter || maker?.harness?.name;
    const audit = run.generationAudit || {};
    const isolationEvidence = audit.isolation || run.isolation || run.generation?.isolation || {};
    const facts = [
        ['制作方式', runModeLabel(run)],
        ['执行流程', stagedRun(run) ? '分阶段制作' : '整片流程（未记录阶段证据）'],
        ['执行模型', maker ? `${maker.requestedModel || '未记录'}（实际返回：${maker.observedModel || '未知'}）` : '尚未执行'],
        ['执行环境', harness || '尚未记录'],
        ['外部协助', run.assisted ? '有，不能记作独立生成通过' : '未记录外部协助'],
        ['生成检查', audit.status || (audit.processVerified === true || audit.passed === true ? '过程审计通过' : audit.passed === false ? '未通过' : '尚未完成')],
        ['读取隔离', isolationEvidence.readIsolation === 'enforced' && isolationEvidence.filesystemProbeVerified === true ? '本地文件读取与写入边界已验证' : '未验证；新目录不代表无法读取其他工程'],
        ['网络隔离', isolationEvidence.probeVerified === true && isolationEvidence.probe?.networkRestricted === true ? '已验证' : '未验证；不代表完整独立认证'],
    ];
    if (stagedRun(run)) facts.push(['阶段调用 / 整片提交', `${run.stageExecutions?.length || 0} / ${run.finalSubmissions?.length || 0}`]);
    if (run.protocolCompatibility?.matches === false) facts.push(['历史记录', run.protocolCompatibility.message]);
    const list = node('dl');
    for (const [label, value] of facts) list.append(node('dt', label), node('dd', value));
    summary.append(list);
    const reviewArea = $('review-summary'); reviewArea.replaceChildren();
    const votes = run.reviewSource?.votes || [];
    const checks = run.spec?.acceptance?.review || [];
    if (!checks.length) return;
    reviewArea.append(node('h3', '质量评审'));
    const table = node('table'), heading = node('tr');
    for (const label of ['标准', '评审一', '评审二', '合并结果']) heading.append(node('th', label));
    const thead = node('thead'); thead.append(heading); table.append(thead);
    const body = node('tbody');
    const label = status => ({ pass: '通过', fail: '未通过', unobserved: '未充分观察' }[status] || '尚未完成');
    for (const criterion of checks) {
        const row = node('tr'); row.append(node('td', criterion.description || criterion.id));
        for (const vote of [votes[0], votes[1]]) row.append(node('td', label(vote?.review?.checks?.find(check => check.id === criterion.id)?.status)));
        row.append(node('td', label(run.review?.checks?.find(check => check.id === criterion.id)?.status))); body.append(row);
    }
    table.append(body); reviewArea.append(table);
    reviewArea.append(node('p', '两份有效评审逐项通过才满足双评审要求；独立生成资格还需检查制作来源与隔离。', 'small muted'));
    if (run.reviewSource?.samples === 1 || run.reviewSource?.kind === 'human') reviewArea.append(node('p', '此历史记录为单次或人工评审，不计作双评审通过。', 'small muted'));
}
async function loadConfiguration() {
    const value = await api('/config'); workflow = value.workflow;
    $('roles').replaceChildren();
    for (const [role, label] of Object.entries(roleLabels)) {
        const wrapper = node('label', label), select = node('select'); select.id = `role-${role}`; select.required = role !== 'extractor';
        select.add(new Option(role === 'extractor' ? '跟随高阶制作' : '选择已启用目标', ''));
        for (const target of value.targets) {
            const option = new Option(`${target.name} · ${target.harness} · ${target.model || '原生默认模型'}`, target.name);
            option.disabled = !target.enabled || target.permission === 'bypass';
            if (option.disabled) option.textContent += '（不可用于复刻）';
            select.add(option);
        }
        const configured = workflow.roles[role] || '';
        if (configured && !value.targets.some(target => target.name === configured)) {
            const missing = new Option(`${configured}（配置目标不存在）`, configured); missing.disabled = true; select.add(missing);
        }
        select.value = configured;
        const validateSelection = () => {
            const selected = value.targets.find(target => target.name === select.value);
            const invalid = Boolean(select.value && (!selected || !selected.enabled || selected.permission === 'bypass'));
            select.setCustomValidity(invalid ? '当前目标不可用于复刻，请选择已启用且具有适当权限的目标。' : '');
            select.setAttribute('aria-invalid', String(invalid));
        };
        select.addEventListener('change', validateSelection); validateSelection();
        wrapper.append(select); $('roles').append(wrapper);
    }
    $('execution-flow').value = workflow.schemaVersion === 2 ? 'staged' : 'legacy';
    $('stage-settings').hidden = workflow.schemaVersion !== 2;
    $('feedback-mode').value = workflow.execution?.feedbackMode || 'independent';
    $('max-stage-revisions').value = workflow.execution?.maxStageRevisions ?? 2;
    $('max-preview-jobs').value = workflow.execution?.maxPreviewJobs ?? 48;
    $('reviewer-minutes').value = (workflow.execution?.reviewerTimeoutMs ?? 600000) / 60000;
    $('max-attempts').value = workflow.execution?.maxFinalSubmissions ?? workflow.policy.maxAttempts; $('max-calls').value = workflow.policy.maxCalls; $('max-minutes').value = Math.ceil(workflow.policy.maxDurationMs / 60000);
    $('render-provider').value = workflow.policy.renderProvider || 'local';
    $('review-samples').value = workflow.policy.reviewSamples || 1;
    $('review-samples').disabled = workflow.schemaVersion === 2;
    $('max-attempts').max = workflow.schemaVersion === 2 ? '5' : '20';
    $('workflow-form').querySelector('button[type="submit"]').disabled = value.writable === false;
    $('config-note').textContent = [value.targetError || '模型认证由现有 Agent 配置管理。此页面不读取或填写密钥。', value.writable === false ? '当前使用外部工作流配置，请通过 CLI 修改。' : ''].filter(Boolean).join(' ');
}
async function refresh() {
    listing = await api('');
    fillSelect($('production'), listing.productions.filter(p => !listing.runs.some(r => r.production === p.slug)).map(p => [p.slug, p.slug]), '选择尚未初始化的制作');
    fillSelect($('method'), (listing.methods || []).filter(t => t.valid !== false && t.status !== 'invalid').map(t => [t.id, t.manifest?.title ? `${t.id} · ${t.manifest.title}` : t.id]), '选择方法配方');
    fillSelect($('reference'), (listing.references || []).map(ref => [ref.id, ref.title || ref.id]), '选择参考视频');
    $('run-count').textContent = listing.runs.length; $('template-count').textContent = listing.templates.length; $('method-count').textContent = (listing.methods || []).length;
    $('runs').replaceChildren();
    for (const run of listing.runs) {
        const row = node('div', undefined, 'run'), info = node('div', undefined, 'run-info');
        info.append(node('strong', run.production), node('p', `${runModeLabel(run)}${(run.method?.id || run.template?.id) ? ` · ${run.method?.id || run.template.id}` : ''} · ${stagedRun(run) ? `${run.stageExecutions?.length || 0} 次阶段调用 · ${run.finalSubmissions?.length || 0} 次整片提交` : `${run.attempts?.length || 0} 次整片尝试`}`));
        row.append(info, node('span', statuses[run.status] || run.status, `status ${run.status}`), button('查看 / 执行', () => showRun(run.production))); $('runs').append(row);
    }
    if (!listing.runs.length) $('runs').append(node('p', '还没有复刻任务。选择已有制作并填写规格开始。', 'muted'));
    $('methods').replaceChildren();
    for (const method of listing.methods || []) {
        const row = node('div', undefined, 'template'), info = node('div', undefined, 'run-info');
        info.append(node('strong', method.manifest?.title ? `${method.id} · ${method.manifest.title}` : method.id), node('p', method.error || `${statuses[method.status] || method.status || '候选配方'} · ${method.manifest?.assetPacks?.length || 0} 个通用素材包`));
        if (method.manifest?.description) info.append(node('p', method.manifest.description));
        row.append(info);
        if (method.valid !== false && method.status !== 'invalid') row.append(button('从空工程使用', async () => { setMode('method'); $('method').value = method.id; $('create-form').scrollIntoView({ behavior: 'smooth', block: 'center' }); }));
        $('methods').append(row);
    }
    if (!(listing.methods || []).length) $('methods').append(node('p', '尚无方法配方。可从教师制作提炼，或冻结经过检查的方法目录。', 'muted'));
    $('templates').replaceChildren();
    for (const template of listing.templates) {
        const row = node('div', undefined, 'template'), info = node('div', undefined, 'run-info');
        info.append(node('strong', template.id), node('p', template.error || `${statuses[template.status] || template.status} · ${template.treeHash?.slice(0, 12) || ''}`));
        row.append(info, node('span', '历史工程回放', 'pill')); $('templates').append(row);
    }
    if (!listing.templates.length) $('templates').append(node('p', '没有历史工程模板。', 'muted'));
    if (listing.activeJob) {
        const job = listing.jobs.find(item => item.id === listing.activeJob); if (job) trackJob(job);
    }
}
function trackJob(job) {
    activeJob = job.id; $('active-job').hidden = false; $('job-title').textContent = `${job.action} · ${job.subject || '执行环境'}`;
    $('job-detail').textContent = `后台任务已启动 · ${new Date(job.startedAt).toLocaleTimeString()}`;
    clearTimeout(pollTimer); pollTimer = setTimeout(pollJob, 1000);
}
async function launch(action, subject, options = {}) {
    const job = await post('/jobs', { action, subject, options }); trackJob(job); notice('任务已在后台启动，完成后会更新结果。');
}
async function cancelRun(subject) {
    if (activeJob) {
        const job = await api(`/jobs/${activeJob}`);
        if (job.status === 'running' && job.subject === subject) {
            await post(`/jobs/${activeJob}/cancel`, {});
            notice('已请求取消，正在等待执行器停止。');
            return;
        }
    }
    await launch('cancel', subject);
    notice('已请求停止当前执行，正在等待运行记录更新。');
}
async function pollJob() {
    if (!activeJob) return;
    try {
        const job = await api(`/jobs/${activeJob}`);
        if (job.status === 'running') {
            $('job-detail').textContent = `执行中 · 已运行 ${Math.floor((Date.now() - Date.parse(job.startedAt)) / 1000)} 秒`;
            if (selectedRun && job.subject === selectedRun) {
                const detail = await api(`/runs/${encodeURIComponent(selectedRun)}?summary=1`);
                const active = detail.run.activeAgent;
                const signature = JSON.stringify([detail.run.stageState, detail.run.allowedActions, detail.run.blockedReasons, detail.run.stageSubmissions?.length,
                    active?.runId, active?.requestedModel, active?.observedModel, active?.harness]);
                if (signature !== lastStageSignature) { lastStageSignature = signature; showRunSummary(detail.run); renderRunActions(detail.run); showStages(detail.run); }
            }
            pollTimer = setTimeout(pollJob, 1800); return;
        }
        showResult(job.result || job.error); $('active-job').hidden = true; activeJob = null;
        if (lastFinishedJob !== job.id) { lastFinishedJob = job.id; notice(job.status === 'completed' ? job.result?.command === 'repro:method-revise' ? `已创建 ${job.result.target.id} 方法草稿，仍需内容审查和新试跑验证。草稿路径见操作结果。` : '操作完成。' : job.error?.message || '任务已取消。', job.status === 'failed'); }
        await refresh(); if (selectedRun) await showRun(selectedRun, false);
    } catch (error) { notice(error.message, true); activeJob = null; $('active-job').hidden = true; }
}
async function showRun(slug, scroll = true) {
    const detail = await api(`/runs/${encodeURIComponent(slug)}`); selectedRun = slug; selectedDetail = detail; lastStageSignature = null;
    $('detail').hidden = false; $('detail-title').textContent = slug; $('detail-json').textContent = JSON.stringify(detail.run, null, 2);
    showRunSummary(detail.run);
    renderRunActions(detail.run); showStages(detail.run, detail.stageEvidence || []);
    $('comparison').replaceChildren();
    for (const media of detail.media) { const block = node('div', undefined, 'media-block'), video = node('video'); video.src = `./${media.url}`; video.controls = true; video.preload = 'metadata'; video.playsInline = true; video.setAttribute('aria-label', media.label); block.append(node('p', media.label), video); $('comparison').append(block); }
    $('evidence').replaceChildren();
    for (const item of detail.evidence) {
        const container = node('div');
        if (item.type.startsWith('image/')) { const link = node('a'); link.href = `./${item.url}`; link.target = '_blank'; link.rel = 'noopener'; const img = node('img'); img.src = link.href; img.alt = item.label; img.loading = 'lazy'; link.append(img, node('span', item.label)); container.append(link); }
        else { const audio = node('audio'); audio.controls = true; audio.preload = 'none'; audio.src = `./${item.url}`; container.append(node('span', item.label), audio); }
        $('evidence').append(container);
    }
    const protocolChanged = detail.run.protocolCompatibility?.matches === false;
    $('extract-form').hidden = protocolChanged || detail.run.kind !== 'teacher'; $('publish-area').hidden = protocolChanged || !detail.run.method?.id;
    $('revise-form').hidden = !detail.run.method?.id;
    if (detail.run.method?.id) {
        const [name, version] = detail.run.method.id.split('@'); $('revise-name').value = name; $('revise-version').value = Number(version) + 1;
        const feedback = $('revise-feedback'); feedback.replaceChildren();
        for (const candidate of listing?.runs || []) {
            if (candidate.method?.id !== detail.run.method.id || candidate.method?.treeHash !== detail.run.method.treeHash || candidate.methodApplied !== true || candidate.activeAgentRunId || candidate.activeRender || candidate.activeOperation) continue;
            const option = new Option(`${candidate.production} · ${statuses[candidate.status] || candidate.status}`, candidate.production); option.selected = candidate.production === slug; feedback.add(option);
        }
    }
    $('publish').disabled = detail.run.status !== 'passed' || detail.run.qualification?.strictIndependent !== true || detail.run.reviewSource?.samples !== 2;
    $('publish').title = $('publish').disabled ? '需双评审通过、无外部协助且读取隔离已验证。当前实验记录仍会保留。' : '发布本次验证范围';
    $('publish').onclick = () => launch('publish', detail.run.method.id, { production: slug }).catch(error => notice(error.message, true));
    $('logs').textContent = '展开后加载最近日志。'; $('logs-box').open = false;
    if (scroll) $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('workflow-form').addEventListener('submit', event => { event.preventDefault(); (async () => {
    const roles = Object.fromEntries(Object.keys(roleLabels).map(role => [role, $(`role-${role}`).value]).filter(([, value]) => value));
    const staged = $('execution-flow').value === 'staged';
    const updated = { ...workflow, schemaVersion: staged ? 2 : 1, roles, policy: { ...workflow.policy, maxAttempts: Number($('max-attempts').value), maxCalls: Number($('max-calls').value), maxDurationMs: Number($('max-minutes').value) * 60000, renderProvider: $('render-provider').value, reviewSamples: staged ? 2 : Number($('review-samples').value) } };
    if (staged) updated.execution = { ...workflow.execution, protocol: 'video-remake.staged-execution@1', feedbackMode: $('feedback-mode').value, maxStageRevisions: Number($('max-stage-revisions').value), maxFinalSubmissions: Number($('max-attempts').value), maxPreviewJobs: Number($('max-preview-jobs').value), reviewerTimeoutMs: Number($('reviewer-minutes').value) * 60000, reserveOverheadMs: workflow.execution?.reserveOverheadMs ?? 120000 };
    else delete updated.execution;
    await post('/config', updated); await loadConfiguration(); notice('默认工作流已保存，将用于之后创建的任务。');
})().catch(error => notice(error.message, true)); });
$('create-form').addEventListener('submit', event => { event.preventDefault(); (async () => {
    const inputValues = parsed('inputs');
    if (mode === 'teacher') await launch('init', $('production').value, { specValue: parsed('spec'), inputValues });
    else await launch('generate', $('method').value, { as: $('new-slug').value, specValue: parsed('spec'), inputValues, ref: $('reference').value });
})().catch(error => notice(error.message, true)); });
$('extract-form').addEventListener('submit', event => { event.preventDefault(); launch('extract', selectedRun, { name: $('extract-name').value, version: Number($('extract-version').value) }).catch(error => notice(error.message, true)); });
$('revise-form').addEventListener('submit', event => { event.preventDefault(); if (!selectedDetail?.run.method?.id) return; launch('method-revise', selectedDetail.run.method.id, { name: $('revise-name').value, version: Number($('revise-version').value), feedback: [...$('revise-feedback').selectedOptions].map(option => option.value) }).catch(error => notice(error.message, true)); });
$('execution-flow').addEventListener('change', () => { const staged = $('execution-flow').value === 'staged'; $('stage-settings').hidden = !staged; $('review-samples').disabled = staged; $('max-attempts').max = staged ? '5' : '20'; if (staged) $('review-samples').value = '2'; });
$('doctor').addEventListener('click', () => launch('doctor', '', { checkLogin: true }).catch(error => notice(error.message, true)));
$('cancel-job').addEventListener('click', () => activeJob && post(`/jobs/${activeJob}/cancel`, {}).then(() => notice('已请求取消，正在等待执行器停止。')).catch(error => notice(error.message, true)));
$('mode-teacher').addEventListener('click', () => setMode('teacher')); $('mode-method').addEventListener('click', () => setMode('method'));
$('close-detail').addEventListener('click', () => { $('detail').hidden = true; selectedRun = null; });
$('refresh').addEventListener('click', () => refresh().catch(error => notice(error.message, true)));
$('logs-box').addEventListener('toggle', () => { if ($('logs-box').open && selectedRun) api(`/runs/${encodeURIComponent(selectedRun)}/logs`).then(value => { $('logs').textContent = typeof value.text === 'string' ? value.text : JSON.stringify(value, null, 2); }).catch(error => { $('logs').textContent = error.message; }); });
$('spec').value = JSON.stringify({ schema: 'video-remake.reproduction@2', title: '对标复刻', objective: '按对标完成复刻并替换标题', preserve: ['镜头顺序和转场节奏'], replace: ['标题'], inputs: { title: { type: 'text', required: true } }, acceptance: { media: { file: 'outputs/final.mp4', width: 1080, height: 1920, durationSec: 15, toleranceSec: 0.5, audio: 'optional' }, requiredFiles: ['src/index.html'], review: [{ id: 'layout', description: '主要布局和视觉层级与对标一致' }, { id: 'replacement', description: '新标题清晰可见，没有残留旧内容' }] }, maxAttempts: 3 }, null, 2);
Promise.all([loadConfiguration(), refresh()]).catch(error => notice(error.message, true));
