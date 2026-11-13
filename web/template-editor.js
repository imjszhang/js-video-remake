import { mountCaptionEditor } from './caption-editor.js';
import { mountVoiceEditor } from './voice-editor.js';
import { templatePlaybackVideo, groupTemplatePackages, templateVersionLabel } from './workspace.js';

const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};
const clone = value => JSON.parse(JSON.stringify(value));
const drafts = new Map();
const selections = new Map();
const generationResults = new Map();
const editorSteps = new Map();
let current = null;
let generation = 0;
const labels = { presenter: '人物录像', voice: '口播声音', music: '背景音乐', captions: '中英字幕', texts: '画面文字' };
const identityLabels = { name: '名字', badge: '人物角标', handle: '账号名', repo: '仓库名', githubUrl: '开源地址', role: '身份', tagline: '英文标语' };
const actionLabels = { prepare: '准备录制稿', check: '检查素材', preview: '生成静态截图', compose: '合成可播放视频', fork: '复制为新版本继续编辑', generate: '让 Agent 生成新模板', voice: '生成口播声音', export: '导出 .video 模板' };
const active = context => current === context && context.generation === generation;
const isRunning = job => job?.status === 'running';

function selectVersion(slug, video) {
    selections.set(slug, video);
    try { sessionStorage.setItem(`template-editor-version:${slug}`, video); } catch { /* Optional browser persistence. */ }
}
function selectedVersion(slug) {
    if (selections.has(slug)) return selections.get(slug);
    try { return sessionStorage.getItem(`template-editor-version:${slug}`); } catch { return null; }
}

async function request(url, options = {}) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    let data;
    try { data = await response.json(); } catch { throw new Error('服务暂时没有响应，请稍后重试。'); }
    if (!response.ok) throw Object.assign(new Error(data.error || '操作失败，请重试。'), { report: data.report });
    return data;
}
function mutate(context, suffix, data, method = 'POST') {
    return request(`${context.base}/${suffix}`, {
        method, headers: { 'Content-Type': 'application/json', 'X-Remake-Action': 'template' }, body: JSON.stringify(data),
    });
}
function remember(context) {
    if (!context.data) return;
    drafts.set(context.key, { inputs: clone(context.inputs), dirty: context.dirty, generationTitle: context.generationTitle, generationPrompt: context.generationPrompt, generationSubtitleScript: context.generationSubtitleScript, agentTarget: context.agentTarget, providerTarget: context.providerTarget, agentModel: context.agentModel, generationMode: context.generationMode, captionDraft: context.captionDraft });
    try {
        sessionStorage.setItem(`template-agent-draft:${context.key}`, JSON.stringify({ title: context.generationTitle, prompt: context.generationPrompt, subtitleScript: context.generationSubtitleScript, target: context.agentTarget, providerTarget: context.providerTarget, model: context.agentModel, mode: context.generationMode }));
    } catch { /* The editor remains usable when browser storage is unavailable. */ }
}
function dirty(context) {
    context.dirty = true;
    remember(context);
    context.saved.textContent = '有未保存的修改';
    context.voiceEditor?.update();
}
function updateControls(context) {
    const busy = context.pending || isRunning(context.job);
    context.captionEditor?.update();
    context.voiceEditor?.update();
    context.form.disabled = busy || Boolean(context.data.frozen);
    for (const [action, button] of Object.entries(context.actions)) {
        button.disabled = busy || (context.data.frozen && !['fork', 'generate', 'export'].includes(action)) || (action === 'generate' && (!context.data.agent?.available || context.data.agent?.targets?.find(target => target.name === context.agentTarget)?.available === false));
    }
    context.save.disabled = busy || Boolean(context.data.frozen);
    if (context.agentForm) context.agentForm.disabled = busy;
    if (context.agentCancel) {
        context.agentCancel.hidden = !isRunning(context.job) || context.job.action !== 'generate';
        context.agentCancel.disabled = context.cancelling;
    }
    context.cancel.hidden = !isRunning(context.job);
    context.cancel.disabled = context.cancelling;
    context.container.setAttribute('aria-busy', String(busy));
}
function showReport(context, report) {
    context.report.replaceChildren();
    if (!report) return;
    for (const [key, heading] of [['errors', '需要修正'], ['warnings', '请留意'], ['info', '检查结果']]) {
        const items = report[key];
        if (!Array.isArray(items) || !items.length) continue;
        const details = element('details', `editor-report-${key}`);
        details.open = key === 'errors';
        details.append(element('summary', '', `${heading} · ${items.length}`));
        const list = element('ul');
        for (const text of items) list.append(element('li', '', typeof text === 'string' ? text : JSON.stringify(text)));
        details.append(list); context.report.append(details);
    }
    if (report.ok) context.report.prepend(element('p', 'editor-check-ok', '素材检查通过，可以继续预览或合成。'));
}
function jobMessage(job, context) {
    if (!job) return '';
    if (job.status === 'failed') {
        const message = typeof job.error === 'string' ? job.error : job.error?.message || '操作失败，请查看检查结果后重试。';
        if (message.includes('Executable metadata check failed')) {
            const target = context?.data.agent?.targets?.find(item => item.name === job.target);
            return target?.unavailableReason || 'Agent 启动程序检查失败，尚未调用模型。请检查 Harness 是否已安装及执行路径是否有效。';
        }
        return message;
    }
    if (job.status === 'cancelled') return '操作已取消，可以调整要求或素材后重试。';
    if (job.status === 'succeeded') {
        if (job.action === 'generate') {
            const pkg = context?.project.templatePackages?.find(item => item.name === job.result?.video);
            const label = pkg ? templateVersionLabel(pkg) : job.result?.title || job.title || '新模板';
            return `已生成「${label}」，静态截图已就绪。可在对应模板中查看。`;
        }
        return job.action === 'compose' ? '合成完成，视频已加入放映室。' : `${actionLabels[job.action] || '操作'}完成。`;
    }
    return job.message || `正在${actionLabels[job.action] || '处理'}…`;
}
function showConsole(context, job) {
    const panel = context.consolePanel;
    if (!panel) return;
    panel.hidden = job?.action !== 'generate';
    if (panel.hidden) return;
    if (context.consoleJobId !== job.id) {
        context.consoleJobId = job.id;
        panel.open = isRunning(job);
    }
    const labels = { running: '运行中', succeeded: '已完成', failed: '失败', cancelled: '已取消' };
    context.consoleSummary.textContent = `Agent 运行记录 · ${labels[job.status] || job.status}`;
    if (context.consoleScript) {
        context.consoleScript.hidden = !job.subtitleScript;
        if (context.consoleScriptText.textContent !== (job.subtitleScript || '')) context.consoleScriptText.textContent = job.subtitleScript || '';
    }
    const output = context.consoleOutput;
    const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
    const lines = job.logs || [];
    const signature = `${job.id}:${job.logSequence}:${job.status}`;
    if (context.consoleSignature === signature) return;
    context.consoleSignature = signature;
    output.replaceChildren();
    if (job.logsRecovered) output.append(element('div', 'console-note', '以下记录从已保存的 Agent 日志恢复，可能只包含末尾部分。'));
    if (job.logsTruncated) output.append(element('div', 'console-note', '仅保留最近的运行记录，较早内容已省略。'));
    if (!lines.length) output.append(element('div', 'console-note', '这次任务启动于运行面板上线前，未记录实时输出。下一次生成将显示详细记录。'));
    for (const line of lines) {
        const row = element('div', 'console-line');
        row.dataset.kind = line.kind;
        const time = new Date(line.time).toLocaleTimeString('zh-CN', { hour12: false });
        row.append(element('span', 'console-time', time), element('span', '', line.text));
        output.append(row);
    }
    if (isRunning(job)) output.append(element('div', 'console-note', '等待后续输出…（每 1.5 秒更新，Agent 可能暂时没有新输出）'));
    if (follow) output.scrollTop = output.scrollHeight;
}

function showJob(context, job) {
    context.job = job;
    showConsole(context, job);
    context.status.textContent = jobMessage(job, context);
    context.status.dataset.status = job?.status || '';
    if (context.agentStatus && context.agentStatus !== context.status) {
        context.agentStatus.textContent = job?.action === 'generate' ? jobMessage(job, context) : '';
        context.agentStatus.dataset.status = job?.action === 'generate' ? job.status : '';
    }
    if (context.agentResult) renderGenerationResult(context, job);
    const report = job?.report || job?.result?.report || (job?.result?.errors ? job.result : null);
    const otherVersion = job?.action === 'generate' && job.result?.video && job.result.video !== context.video;
    if (report && !otherVersion) showReport(context, report);
    updateControls(context);
}
async function refreshData(context) {
    const data = await request(`${context.base}/editor`);
    if (!active(context)) return;
    context.data = data;
    if (!context.dirty) {
        context.inputs = clone(data.inputs);
    }
    remember(context);
    render(context);
}
async function poll(context, id) {
    if (!active(context)) return;
    try {
        const job = await request(`${context.base}/jobs/${encodeURIComponent(id)}`);
        if (!active(context)) return;
        showJob(context, job);
        if (isRunning(job)) {
            context.timer = setTimeout(() => poll(context, id), 1500);
            return;
        }
        if (job.status === 'succeeded') {
            if (job.action === 'generate' && job.result?.video) {
                generationResults.set(`${context.project.slug}/${job.result.video}`, { ...job.result, prompt: job.prompt || context.generationPrompt, subtitleScript: job.subtitleScript ?? context.generationSubtitleScript, target: job.target || context.agentTarget, title: job.title || job.result.title });
            }
            if (['fork', 'generate'].includes(job.action) && job.result?.video) {
                selectVersion(context.project.slug, job.result.video);
                editorSteps.set(context.project.slug, job.action === 'generate' ? 'output' : 'materials');
            }
            if (['fork', 'generate', 'compose', 'export'].includes(job.action)) {
                if (job.action !== 'export') drafts.delete(context.key);
                await context.onLibraryChanged?.();
                if (!active(context)) return;
            }
            await refreshData(context);
            if (active(context)) showJob(context, job);
        }
    } catch (error) {
        if (!active(context)) return;
        context.status.textContent = `暂时无法更新进度：${error.message} 正在重试…`;
        context.timer = setTimeout(() => poll(context, id), 3000);
    }
}
async function save(context) {
    if (context.data.frozen) return;
    if (context.captionDraft?.dirty) {
        await context.captionEditor.save();
        return;
    }
    const result = await mutate(context, 'inputs', { inputs: context.inputs }, 'PUT');
    context.inputs = clone(result.inputs || context.inputs);
    context.dirty = false;
    remember(context);
    if (active(context)) context.saved.textContent = '素材设置已保存';
    context.voiceEditor?.reload();
}
async function startAction(context, action) {
    if (context.pending || isRunning(context.job)) return;
    const payload = { action };
    if (action === 'generate') {
        payload.mode = context.generationMode || 'derive';
        payload.title = payload.mode === 'revise' ? context.data.lineage.title : context.generationTitle?.trim();
        payload.prompt = context.generationPrompt?.trim();
        payload.subtitleScript = context.generationSubtitleScript || '';
        payload.target = context.agentTarget;
        payload.providerTarget = context.providerTarget;
        payload.model = context.agentModel;
        if (!payload.title || !payload.prompt) {
            const message = !payload.title ? '请为新模板填写一个名称。' : '请描述希望 Agent 如何修改当前模板。';
            context.status.textContent = message; context.agentStatus.textContent = message;
            return;
        }
    }
    if (action === 'preview' && context.at.value.trim()) {
        const parts = context.at.value.trim().split(/[,，\s]+/);
        const at = parts.map(Number);
        const duration = context.data.frame.frames / context.data.frame.fps;
        if (at.length > 12 || at.some(time => !Number.isFinite(time) || time < 0 || time >= duration)) {
            context.status.textContent = `预览时间需在 0 到 ${duration.toFixed(2)} 秒之间，最多填写 12 个，用逗号隔开。`;
            return;
        }
        payload.at = at;
    }
    context.pending = true; updateControls(context);
    context.status.textContent = '正在提交…';
    if (action === 'generate') context.agentStatus.textContent = '正在提交生成任务…';
    try {
        if (!context.data.frozen && action !== 'generate') await save(context);
        if (action === 'voice') {
            payload.voice = context.speechSelection?.voice;
            payload.language = context.speechSelection?.language || 'zh';
            payload.revision = context.captionDraft?.data?.revision;
        }
        const job = await mutate(context, 'jobs', payload);
        if (!active(context)) return;
        context.pending = false;
        showJob(context, job);
        await poll(context, job.id);
    } catch (error) {
        if (!active(context)) return;
        context.status.textContent = error.message;
        if (action === 'generate') context.agentStatus.textContent = error.message;
        showReport(context, error.report);
    } finally {
        context.pending = false;
        if (active(context)) updateControls(context);
    }
}
function field(label, control, note) {
    const wrapper = element('label', 'editor-field');
    wrapper.append(element('span', '', label), control);
    if (note) wrapper.append(element('small', '', note));
    return wrapper;
}
function inputText(value = '') {
    const input = element('input'); input.type = 'text'; input.value = value ?? ''; return input;
}
function storedAgentDraft(key) {
    try {
        const value = JSON.parse(sessionStorage.getItem(`template-agent-draft:${key}`));
        if (!value || typeof value !== 'object') return {};
        return {
            title: typeof value.title === 'string' ? value.title.slice(0, 160) : '',
            prompt: typeof value.prompt === 'string' ? value.prompt.slice(0, 12000) : '',
            subtitleScript: typeof value.subtitleScript === 'string' ? value.subtitleScript.slice(0, 30000) : '',
            target: typeof value.target === 'string' ? value.target : '',
            providerTarget: typeof value.providerTarget === 'string' ? value.providerTarget : '',
            model: typeof value.model === 'string' ? value.model.slice(0, 160) : '',
            mode: value.mode === 'revise' ? 'revise' : 'derive',
        };
    } catch { return {}; }
}
async function cancelJob(context) {
    if (!isRunning(context.job) || context.cancelling) return;
    context.cancelling = true; updateControls(context);
    try {
        const job = await mutate(context, `jobs/${encodeURIComponent(context.job.id)}/cancel`, {});
        if (active(context)) showJob(context, job);
    } catch (error) {
        if (active(context)) {
            context.status.textContent = error.message;
            if (context.agentStatus) context.agentStatus.textContent = error.message;
        }
    } finally { context.cancelling = false; if (active(context)) updateControls(context); }
}
function renderGenerationResult(context, job) {
    const container = context.agentResult;
    container.replaceChildren();
    const result = job?.action === 'generate' && job.status === 'succeeded' && job.result?.video === context.video
        ? { ...job.result, prompt: job.prompt, subtitleScript: job.subtitleScript, target: job.target, title: job.title || job.result?.title }
        : context.data.generation || generationResults.get(context.key);
    if (!result) return;
    const details = element('details', 'editor-generation-details');
    details.append(element('summary', '', '查看本版本的改造记录'));
    details.append(element('p', 'editor-check-ok', '系统复核通过：已完成构建、画面检查和静态截图。'));
    if (result.summary) details.append(element('p', 'editor-agent-summary', typeof result.summary === 'string' ? result.summary : JSON.stringify(result.summary)));
    if (result.prompt) {
        details.append(element('h5', '', '生成要求'), element('p', 'editor-agent-prompt-record', result.prompt));
    }
    if (result.subtitleScript) details.append(element('h5', '', '提供的新字幕原稿'), element('p', 'editor-agent-prompt-record', result.subtitleScript));
    if (result.provider) {
        details.append(element('p', '', `Harness：${result.harness || '未记录'} · Provider：${result.provider}`));
        details.append(element('p', '', `当时配置模型：${result.configuredModel || '未显式指定'} · 本次返回模型：${result.actualModel || '服务未返回模型标识'}`));
    } else if (result.agentLabel) details.append(element('p', '', `Agent Harness / 模型：${result.agentLabel}`));
    else if (result.target) {
        const configured = context.data.agent?.targets?.find(target => target.name === result.target);
        details.append(element('p', '', configured ? `Agent Harness / 模型（当前配置）：${configured.label}` : 'Agent Harness / 模型：历史记录未保存'));
    }
    if (result.agentRunId) details.append(element('p', 'editor-agent-run-id', `运行记录：${result.agentRunId}`));
    container.append(details);
}

function updateAgentAvailability(context) {
    const target = context.data.agent?.targets?.find(item => item.name === context.agentTarget);
    const profile = context.data.agent?.providers?.find(item => item.id === context.providerTarget);
    const provider = profile?.managed ? { provider: profile.label, providerUrl: profile.providerUrl, configuredModel: profile.models[0] } : context.data.agent?.targets?.find(item => item.name === context.providerTarget) || target;
    renderAgentDetails(context, provider ? { ...provider, harness: target?.harness, configuredModel: context.agentModel === 'configured' ? provider.configuredModel : context.agentModel || provider.configuredModel, configurationSource: '本次选择（不修改本机默认配置）' } : target);
    context.agentAvailability.hidden = target?.available !== false;
    context.agentAvailability.textContent = target?.available === false ? target.unavailableReason || '此 Harness 暂不可用，请检查安装或选择其他执行配置。' : '';
}

function renderAgentDetails(context, target) {
    if (!context.agentDetails) return;
    context.agentDetails.replaceChildren();
    if (!target) return;
    const list = element('dl', 'editor-agent-detail-grid');
    for (const [label, value] of [
        ['Harness', target.harness || '未记录'],
        ['Provider', target.provider || '未记录'],
        ...(target.providerUrl ? [['接口', target.providerUrl]] : []),
        ['配置模型', target.configuredModel || '未显式指定，由 Harness 默认选择'],
        ['最近返回模型', target.actualModel || '暂无成功调用记录'],
        ['配置来源', target.configurationSource || '项目执行配置'],
    ]) {
        const row = element('div'); row.append(element('dt', '', label), element('dd', '', value)); list.append(row);
    }
    context.agentDetails.append(list);
    if (target.actualModel) {
        const date = new Date(target.actualModelAt);
        const when = Number.isNaN(date.getTime()) ? '' : `（${date.toLocaleString('zh-CN')}）`;
        context.agentDetails.append(element('p', 'editor-hint', `最近返回模型来自上次成功调用${when}，是服务返回的模型标识；不代表下一次一定使用相同模型或 Provider。`));
    } else context.agentDetails.append(element('p', 'editor-hint', '配置模型不等于已验证的实际模型；成功调用后会显示服务返回的模型标识。'));
}

function renderProviderManager(context, parent) {
    const panel = element('details', 'editor-provider-manager');
    panel.append(element('summary', '', 'Provider 设置 · 新增与编辑'));
    panel.append(element('p', 'editor-hint', '配置一次，创建模板时直接选择。'));
    const picker = element('select'); picker.setAttribute('aria-label', '编辑 Provider');
    const fresh = element('option', '', '新增 Provider'); fresh.value = ''; picker.append(fresh);
    for (const item of context.data.agent?.providers || []) {
        const option = element('option', '', item.label); option.value = item.id; picker.append(option);
    }
    const name = inputText(''); name.maxLength = 80;
    const address = inputText(''); address.placeholder = 'https://api.example.com/v1';
    const protocol = element('select'); protocol.setAttribute('aria-label', '接口协议');
    for (const [value, label] of [['anthropic-messages', 'Anthropic Messages · Claude Code / DeepSeek Harness'], ['responses', 'OpenAI Responses · Codex CLI'], ['chat-completions', 'OpenAI Chat Completions · OpenCode']]) {
        const option = element('option', '', label); option.value = value; protocol.append(option);
    }
    const key = inputText(''); key.type = 'password'; key.autocomplete = 'new-password'; key.maxLength = 8192;
    const models = element('textarea'); models.rows = 4; models.placeholder = '点击“获取模型列表”自动填写，也可每行手填一个模型 ID';
    const hint = element('p', 'editor-hint');
    const status = element('p', 'editor-hint'); status.setAttribute('role', 'status');
    const save = element('button', 'editor-secondary', '保存 Provider'); save.type = 'button';
    const selectProfile = () => {
        const item = context.data.agent?.providers?.find(item => item.id === picker.value);
        name.value = item?.label || ''; address.value = item?.baseURL || '';
        protocol.value = item?.protocol || 'anthropic-messages'; key.value = '';
        models.value = (item?.models || []).filter(value => value !== 'configured').join('\n');
        key.placeholder = item?.hasApiKey ? '已保存密钥；留空保持不变' : '填写 API Key';
        hint.textContent = item && !item.managed ? '此连接来自已有配置。保存后建立项目内覆盖，不修改 Harness 本机设置；首次保存请填写 API Key。' : '密钥只保存在本机，不回显。留空保留原密钥；修改接口地址或协议时须重新填写。保存不会发起模型请求。';
        status.textContent = '';
    };
    picker.addEventListener('change', selectProfile);
    for (const control of [address, protocol, key]) control.addEventListener('input', () => { status.textContent = ''; });
    save.addEventListener('click', async () => {
        context.pending = true; updateControls(context); status.textContent = '正在保存…';
        try {
            const result = await mutate(context, 'providers', { id: picker.value || undefined, label: name.value, baseURL: address.value.trim(), protocol: protocol.value, apiKey: key.value || undefined, models: models.value.split(/[\n,，]+/).map(value => value.trim()).filter(Boolean) }, 'PUT');
            key.value = '';
            if (!active(context)) return;
            context.providerTarget = result.id; context.agentModel = result.models[0];
            const data = await request(`${context.base}/editor`);
            if (!active(context)) return;
            context.data = data;
            const selected = data.agent.providers.find(item => item.id === result.id);
            if (!selected.compatibleTargets.includes(context.agentTarget)) context.agentTarget = selected.compatibleTargets[0] || context.agentTarget;
            remember(context); render(context);
            context.status.textContent = selected.compatibleTargets.length ? 'Provider 已保存，可以选择并使用。' : 'Provider 已保存，当前尚未配置兼容此协议的 Harness。';
        } catch (error) { key.value = ''; if (active(context)) status.textContent = error.message; }
        finally { context.pending = false; if (active(context)) updateControls(context); }
    });
    const probeActions = element('div', 'editor-upload-controls');
    for (const [action, label] of [['test', '测试连接'], ['models', '获取模型列表']]) {
        const button = element('button', 'editor-secondary', label); button.type = 'button';
        button.addEventListener('click', async () => {
            context.pending = true; updateControls(context);
            status.textContent = action === 'models' ? '正在获取模型列表…' : '正在测试连接…';
            try {
                const result = await mutate(context, `providers/${action}`, { id: picker.value || undefined, baseURL: address.value.trim(), protocol: protocol.value, apiKey: key.value || undefined });
                if (!active(context)) return;
                if (action === 'models') models.value = result.models.join('\n');
                status.textContent = action === 'models' ? `已填入 ${result.models.length} 个模型${result.partial ? '（仅显示前 50 个或当前分页）' : ''}，可编辑后点击“保存 Provider”。` : `${result.message} 耗时 ${result.elapsedMs} 毫秒。`;
            } catch (error) { if (active(context)) status.textContent = error.message; }
            finally { context.pending = false; if (active(context)) updateControls(context); }
        });
        probeActions.append(button);
    }
    selectProfile();
    const connection = element('div', 'provider-settings-group');
    connection.append(element('h5', '', '1. 连接信息'));
    const identity = element('div', 'agent-form-grid'); identity.append(field('编辑连接', picker), field('Provider 名称', name));
    connection.append(identity, field('接口地址', address), field('接口协议', protocol), field('API Key', key));
    const verification = element('div', 'provider-settings-group');
    verification.append(element('h5', '', '2. 验证与模型'), element('p', 'editor-hint', '先测试连接，再获取模型。也可以手动填写模型 ID。'), probeActions, status, field('可选模型', models));
    const footer = element('div', 'provider-settings-footer'); footer.append(hint, save);
    panel.append(connection, verification, footer);
    parent.append(panel);
}

function renderAgent(context, container) {
    const configuration = context.data.agent;
    const section = element('section', 'editor-agent-section');
    section.append(element('h4', '', '用提示词改造模板'));
    section.append(element('p', 'editor-hint', '写下修改要求，Agent 会创建新版本并检查画面。'));
    const controls = element('fieldset', 'editor-agent-controls'); context.agentForm = controls;
    controls.append(element('legend', 'sr-only', '新模板生成要求'));
    const mode = element('select'); mode.setAttribute('aria-label', '生成方式');
    const derive = element('option', '', '创建独立的新模板 · 从 v1 开始'); derive.value = 'derive'; mode.append(derive);
    if (context.data.lineage?.kind === 'derived') {
        const nextVersion = Math.max(...context.project.templatePackages.filter(pkg => pkg.lineage?.id === context.data.lineage.id).map(pkg => pkg.lineage.version)) + 1;
        const revise = element('option', '', `迭代当前模板 · 生成 v${nextVersion}`); revise.value = 'revise'; mode.append(revise);
    }
    mode.value = context.generationMode || 'derive';
    mode.addEventListener('change', () => { context.generationMode = mode.value; remember(context); render(context); context.container.querySelector('[aria-label="生成方式"]').focus(); });
    const brief = element('div', 'agent-brief-card');
    const naming = element('div', 'agent-form-grid');
    naming.append(field('生成方式', mode));
    const revising = context.generationMode === 'revise';
    const title = inputText(revising ? context.data.lineage.title : context.generationTitle); title.maxLength = 160;
    title.readOnly = revising;
    title.addEventListener('input', () => { context.generationTitle = title.value; remember(context); });
    const prompt = element('textarea', 'editor-agent-prompt'); prompt.rows = 6; prompt.maxLength = 12000;
    prompt.value = context.generationPrompt || '';
    prompt.placeholder = '例如：保留内容结构，改成简洁的发布会风格。增加留白，减少装饰，把开场改成大标题逐步出现，转场更舒缓。';
    prompt.addEventListener('input', () => { context.generationPrompt = prompt.value; remember(context); });
    naming.append(field(revising ? '当前模板名称' : '新模板名称', title));
    const subtitleDetails = element('details', 'agent-new-subtitles');
    subtitleDetails.open = Boolean(context.generationSubtitleScript);
    subtitleDetails.append(element('summary', '', '新字幕原稿（可选）'));
    const subtitleScript = element('textarea', 'editor-agent-subtitle-script'); subtitleScript.rows = 7; subtitleScript.maxLength = 30000;
    subtitleScript.value = context.generationSubtitleScript || '';
    subtitleScript.placeholder = '直接粘贴新的口播文案或中英字幕。不需要 JSON，也不必保持原字幕条数。';
    subtitleScript.addEventListener('input', () => { context.generationSubtitleScript = subtitleScript.value; remember(context); });
    subtitleDetails.append(field('提供新的字幕原稿', subtitleScript, '最多 30000 字，可粘贴中文、英文或双语长文。Agent 会重新分句并调整默认字幕与相关画面；默认保留总时长，需改变时请在修改要求中说明。'));
    brief.append(field('希望如何修改模板？', prompt, '说明要保留什么、改变什么。'), subtitleDetails, naming);
    controls.append(brief);
    const execution = element('div', 'agent-execution-card');
    execution.append(element('h5', '', '执行设置'));
    const selection = element('div', 'agent-selection-grid');
    execution.append(selection);
    controls.append(execution);
    const targets = configuration?.targets || [];
    if (!configuration?.providers) {
        const legacy = element('select'); legacy.setAttribute('aria-label', 'Agent Harness / Provider / 模型');
        for (const item of targets) { const option = element('option', '', item.label); option.value = item.name; option.disabled = item.available === false; legacy.append(option); }
        legacy.value = context.agentTarget;
        legacy.addEventListener('change', () => { context.agentTarget = legacy.value; remember(context); updateAgentAvailability(context); updateControls(context); });
        selection.append(field('当前执行配置', legacy), element('p', 'editor-hint', '独立搭配功能等待本地服务更新。当前任务不受影响。'));
    } else {
        const harnesses = [...new Map(targets.map(item => [item.harness, item])).values()];
        // Preserve the selected execution target when several profiles share a Harness.
        const selectedTarget = targets.find(item => item.name === context.agentTarget);
        const harness = element('select'); harness.setAttribute('aria-label', 'Agent Harness');
        for (const item of harnesses) {
            const representative = selectedTarget?.harness === item.harness ? selectedTarget : item;
            const option = element('option', '', `${item.harness}${representative.available === false ? '（不可用）' : ''}`);
            option.value = representative.name; option.disabled = representative.available === false; harness.append(option);
        }
        harness.value = context.agentTarget;
        const providers = configuration?.providers || [];
        let selectedProvider = providers.find(item => item.id === context.providerTarget || item.names.includes(context.providerTarget));
        if (!selectedProvider?.compatibleTargets.includes(context.agentTarget)) {
            selectedProvider = providers.find(item => item.names.includes(context.agentTarget) && item.compatibleTargets.includes(context.agentTarget)) || providers.find(item => item.compatibleTargets.includes(context.agentTarget));
            context.agentModel = selectedProvider?.models[0] || '';
        }
        context.providerTarget = selectedProvider?.id;
        if (!context.agentModel) context.agentModel = selectedProvider?.models[0] || '';
        const provider = element('select'); provider.setAttribute('aria-label', 'Provider');
        for (const item of providers) {
            const compatible = item.compatibleTargets.includes(context.agentTarget);
            const option = element('option', '', `${item.label}${compatible ? '' : '（接口不兼容）'}`);
            option.value = item.id; option.disabled = !compatible; provider.append(option);
        }
        provider.value = context.providerTarget || '';
        harness.addEventListener('change', () => { context.agentTarget = harness.value; render(context); remember(context); });
        provider.addEventListener('change', () => { context.providerTarget = provider.value; context.agentModel = providers.find(item => item.id === provider.value)?.models[0] || ''; render(context); remember(context); });
        const model = inputText(context.agentModel); model.maxLength = 160;
        model.setAttribute('aria-label', '模型 ID'); model.setAttribute('list', 'template-agent-models');
        const suggestions = element('datalist'); suggestions.id = 'template-agent-models';
        for (const value of selectedProvider?.models || []) {
            const option = element('option', '', value === 'configured' ? '使用本机默认模型' : value); option.value = value; suggestions.append(option);
        }
        model.addEventListener('input', () => { context.agentModel = model.value.trim(); remember(context); updateAgentAvailability(context); });
        selection.append(field('Agent Harness', harness), field('Provider', provider), field('模型 ID', model), suggestions);
        execution.append(element('p', 'editor-hint', '模型可选择或输入。Provider 仅可选择兼容搭配；configured 使用本机默认模型。'));
    }
    const detailPanel = element('details', 'agent-connection-details');
    detailPanel.append(element('summary', '', '查看接口与实际模型'));
    context.agentDetails = element('div', 'editor-agent-details'); detailPanel.append(context.agentDetails); execution.append(detailPanel);
    context.agentAvailability = element('p', 'editor-agent-unavailable'); context.agentAvailability.setAttribute('role', 'status'); controls.append(context.agentAvailability);
    updateAgentAvailability(context);
    const create = element('button', 'download-link', revising ? '让 Agent 生成下一版本' : '让 Agent 创建新模板'); create.type = 'button'; context.actions.generate = create;
    create.addEventListener('click', () => startAction(context, 'generate'));
    const primary = element('div', 'agent-primary-action');
    primary.append(element('p', 'editor-hint', revising ? '在当前模板中新增版本，保留已有版本。' : '创建独立模板，从 v1 开始，保留来源。'), create);
    controls.append(primary);
    renderProviderManager(context, controls);
    section.append(controls);
    if (!configuration?.available) {
        const notice = element('div', 'editor-agent-unavailable');
        notice.append(element('p', '', configuration?.targets?.length ? '已配置的 Harness 当前均不可用，请检查安装和执行路径后刷新。你的修改要求会保留。' : '尚未配置可用的 Agent。请先在本项目的 Agent 配置中启用一个执行目标，再刷新页面。你的修改要求可以先保存在这里。'));
        if (configuration?.error) {
            const details = element('details'); details.append(element('summary', '', '查看配置提示'), element('p', '', configuration.error)); notice.append(details);
        }
        section.append(notice);
    }

    context.agentStatus = context.status;
    context.agentCancel = null;
    const result = element('div', 'editor-agent-result'); context.agentResult = result; section.append(result);
    container.append(section);
}
function mediaRow(context, kind) {
    const section = element('div', 'editor-asset');
    section.append(element('h4', '', labels[kind]));
    const defaults = {
        presenter: '与全片等长；人物窗口出现时播放对应时刻。未提供时显示人物占位框。',
        voice: '按录制稿的时间说话。可以选择录音或同一条人物录像；未提供时只有音乐。',
        music: '不短于全片，留空使用模板内置配乐。',
        captions: '上传替换字幕 JSON，保持原有条数与时间，只修改中英文文字。',
        texts: '上传替换画面文字 JSON，保留原有键名；改完先预览，检查文字排版。',
    };
    section.append(element('p', '', defaults[kind]));
    const currentFile = element('span', 'editor-file-name');
    const getPath = () => kind === 'presenter' ? context.inputs.presenter?.src : context.inputs[kind];
    const setPath = value => {
        if (kind === 'presenter') context.inputs.presenter = { ...(context.inputs.presenter || {}), src: value };
        else context.inputs[kind] = value;
        currentFile.textContent = value ? value.split('/').pop() : '使用模板默认';
        clear.disabled = !value;
        dirty(context);
    };
    currentFile.textContent = getPath()?.split('/').pop() || '使用模板默认';
    const upload = element('input'); upload.type = 'file'; upload.setAttribute('aria-label', `上传${labels[kind]}`);
    upload.accept = ['captions', 'texts'].includes(kind) ? '.json,application/json' : kind === 'presenter' ? 'video/*' : 'audio/*,video/*';
    const clear = element('button', 'editor-secondary', '恢复默认'); clear.type = 'button'; clear.disabled = !getPath();
    clear.addEventListener('click', () => setPath(null));
    const uploadStatus = element('span', 'editor-upload-status'); uploadStatus.setAttribute('role', 'status');
    upload.addEventListener('change', async () => {
        const file = upload.files[0]; if (!file) return;
        context.pending = true; updateControls(context); uploadStatus.textContent = '正在上传…';
        try {
            const params = new URLSearchParams({ kind, filename: file.name });
            const result = await request(`${context.base}/assets?${params}`, {
                method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Remake-Action': 'template' }, body: file,
            });
            if (!active(context)) return;
            setPath(result.path);
            uploadStatus.textContent = '已上传，保存设置后生效';
        } catch (error) {
            if (active(context)) uploadStatus.textContent = error.message;
        } finally {
            context.pending = false;
            if (active(context)) { upload.value = ''; updateControls(context); }
        }
    });
    const controls = element('div', 'editor-upload-controls'); controls.append(upload, clear);
    section.append(currentFile, controls, uploadStatus);
    if (kind === 'presenter') {
        const adjustments = element('div', 'editor-grid');
        const start = inputText(context.inputs.presenter?.mediaStart ?? 0); start.type = 'number'; start.min = '0'; start.step = '0.01';
        start.addEventListener('input', () => {
            context.inputs.presenter = { ...(context.inputs.presenter || {}), mediaStart: Number(start.value) };
            dirty(context);
        });
        const position = inputText(context.inputs.presenter?.objectPosition || '50% 30%');
        position.addEventListener('input', () => {
            context.inputs.presenter = { ...(context.inputs.presenter || {}), objectPosition: position.value };
            dirty(context);
        });
        adjustments.append(field('跳过录像开头（秒）', start, '只调整人物画面，口播音轨需自行对齐。'), field('人物取景位置', position, '例如 50% 30%，调整人物在窗口中的位置。'));
        const reuse = element('button', 'editor-secondary', '将人物录像同时用作口播声音'); reuse.type = 'button';
        reuse.addEventListener('click', () => {
            if (!context.inputs.presenter?.src) { uploadStatus.textContent = '请先上传人物录像。'; return; }
            context.inputs.voice = context.inputs.presenter.src;
            dirty(context); render(context);
        });
        section.append(adjustments, reuse);
    }
    return section;
}
function switchStep(context, step) {
    context.step = step;
    editorSteps.set(context.project.slug, step);
    for (const [name, panel] of Object.entries(context.panels)) panel.hidden = name !== step;
    for (const [name, button] of Object.entries(context.stepButtons)) {
        button.classList.toggle('active', name === step);
        button.setAttribute('aria-pressed', String(name === step));
    }
}
function actionButton(context, action, primary = false) {
    const button = element('button', primary ? 'download-link' : 'editor-secondary', actionLabels[action]);
    button.type = 'button';
    button.addEventListener('click', () => startAction(context, action));
    context.actions[action] = button;
    return button;
}
function render(context) {
    if (!active(context)) return;
    const data = context.data;
    const container = context.container; container.replaceChildren();
    const header = element('div', 'editor-heading');
    // 模板名称已在项目头和下方的选择器里出现，这里只留给读屏用的标题。
    const heading = element('h3', 'sr-only', data.title || '模板工作台');
    const groups = groupTemplatePackages(context.project.templatePackages);
    const group = groups.find(item => item.versions.some(pkg => pkg.name === context.video));
    const choose = name => {
        remember(context); selectVersion(context.project.slug, name);
        mountTemplateEditor(context.project, { onLibraryChanged: context.onLibraryChanged, onPlayVersion: context.onPlayVersion, onVersionChanged: context.onVersionChanged, force: true });
    };
    const family = element('select'); family.setAttribute('aria-label', '选择模板');
    for (const item of groups) {
        const option = element('option', '', `${item.kind === 'source' ? '来源 · ' : ''}${item.title}`); option.value = item.id; family.append(option);
    }
    family.value = group.id;
    family.addEventListener('change', () => choose(groups.find(item => item.id === family.value).versions.at(-1).name));
    const select = element('select'); select.setAttribute('aria-label', '选择要编辑的模板版本');
    for (const pkg of group.versions) {
        const option = element('option', '', `${pkg.lineage?.kind === 'source' ? '原版 ' : ''}v${pkg.lineage?.version || 1}`); option.value = pkg.name; select.append(option);
    }
    select.value = context.video;
    select.addEventListener('change', () => choose(select.value));
    const selectors = element('div', 'editor-template-selectors');
    selectors.append(field('模板', family), field('版本', select));
    header.append(heading, selectors);
    container.append(header);
    const seconds = data.frame.frames / data.frame.fps;
    const facts = element('p', 'editor-facts');
    facts.append(element('span', 'editor-summary', `${data.frame.width} × ${data.frame.height} · ${seconds.toFixed(2)} 秒 · ${data.frame.fps} 帧/秒`));
    const lineage = data.lineage;
    if (lineage) {
        const source = lineage.origin;
        const provenance = source ? `基于「${source.title}」v${source.version} 创建` : `来源模板 · 保留原版 v${lineage.version}`;
        facts.append(element('span', 'editor-lineage', provenance));
        if (lineage.parent && lineage.parent.id === lineage.id) facts.append(element('span', 'editor-lineage-parent', `由本模板 v${lineage.parent.version} 迭代而来`));
    }
    container.append(facts);
    const playable = Boolean(templatePlaybackVideo(context.project, context.video));
    const versionState = element('div', `editor-version-state ${playable ? 'is-playable' : 'is-pending'}`);
    const stateCopy = element('div');
    stateCopy.append(element('strong', '', playable ? '此版本已有可播放视频' : '此版本尚未合成视频'));
    stateCopy.append(element('p', '', playable ? '成片放映中可以查看这个版本的完整视频。' : '当前是可编辑的模板。静态截图用于检查画面，合成后才能连续播放。'));
    versionState.append(stateCopy);
    if (playable && context.onPlayVersion) {
        const play = element('button', 'editor-secondary', '播放此版本成片'); play.type = 'button';
        play.addEventListener('click', () => context.onPlayVersion(context.video)); versionState.append(play);
    }
    container.append(versionState);
    context.actions = {};
    const navigation = element('nav', 'editor-step-nav'); navigation.setAttribute('aria-label', '模板制作步骤');
    context.panels = {}; context.stepButtons = {};
    for (const [name, label, number] of [['agent', '改造模板', '01'], ['materials', '填写素材', '02'], ['output', '预览与导出', '03']]) {
        const button = element('button', 'editor-step-button'); button.type = 'button';
        button.append(element('span', 'editor-step-number', number), element('span', '', label));
        button.setAttribute('aria-controls', `editor-panel-${name}`);
        button.addEventListener('click', () => switchStep(context, name));
        context.stepButtons[name] = button; navigation.append(button);
        const panel = element('section', 'editor-step-panel'); panel.id = `editor-panel-${name}`;
        panel.setAttribute('aria-label', label); context.panels[name] = panel;
    }
    const statusRow = element('div', 'editor-job editor-global-job');
    const status = element('p', 'editor-job-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); context.status = status;
    const cancel = element('button', 'editor-secondary', '取消当前操作'); cancel.type = 'button'; context.cancel = cancel;
    cancel.addEventListener('click', () => cancelJob(context));
    statusRow.append(status, cancel); container.append(statusRow);
    const consolePanel = element('details', 'agent-console');
    context.consolePanel = consolePanel;
    context.consoleJobId = null; context.consoleSignature = null;
    context.consoleSummary = element('summary', '', 'Agent 运行记录');
    context.consoleOutput = element('div', 'console-output');
    context.consoleOutput.tabIndex = 0;
    context.consoleOutput.setAttribute('aria-label', 'Agent 运行输出');
    context.consoleScript = element('details', 'console-subtitle-script');
    context.consoleScriptText = element('p');
    context.consoleScript.append(element('summary', '', '查看本次新字幕原稿'), context.consoleScriptText);
    consolePanel.append(context.consoleSummary,
        element('p', 'console-note', '任务在服务端异步执行，刷新或关闭网页不会取消；关闭或重启本地服务会中断。此面板只读。'),
        context.consoleScript, context.consoleOutput);
    container.append(consolePanel);
    context.report = element('div', 'editor-report'); container.append(context.report);
    // 步骤导航紧贴它切换的面板；版本状态、任务进度和检查结果属于整个版本，放在导航之上。
    container.append(navigation);
    renderAgent(context, context.panels.agent);
    const materials = context.panels.materials;
    materials.append(element('h4', '', '准备这版视频要用的内容'), element('p', 'editor-hint', '填写个人信息、修改字幕，再直接生成口播。人物录像和背景音乐按需添加。'));
    if (data.frozen) {
        materials.append(element('p', 'editor-frozen', '这个版本已合成为草稿，素材已锁定。复制一个新版本后可继续编辑。'), actionButton(context, 'fork'));
    }
    const form = element('fieldset', 'editor-fields'); context.form = form;
    form.append(element('legend', 'sr-only', '素材与个人信息'));
    const identity = element('div', 'editor-grid');
    if (data.schema?.identity) context.inputs.identity ||= {};
    for (const [key, spec] of Object.entries(data.schema?.identity?.fields || {})) {
        const input = inputText(context.inputs.identity[key] ?? spec.default ?? '');
        input.maxLength = 1000;
        input.addEventListener('input', () => { context.inputs.identity[key] = input.value; dirty(context); });
        identity.append(field(identityLabels[key] || key, input, spec.note));
    }
    if (identity.children.length) form.append(identity);
    const media = element('div', 'editor-media-grid');
    for (const key of ['presenter', 'music']) if (data.schema?.[key]) media.append(mediaRow(context, key));
    form.append(media);
    const textFields = element('details', 'editor-text-settings');
    textFields.append(element('summary', '', '替换画面文字（可选）'));
    for (const key of ['texts']) if (data.schema?.[key]) textFields.append(mediaRow(context, key));
    if (textFields.children.length > 1) form.append(textFields);
    materials.append(form);
    const toolbar = element('div', 'editor-actions');
    const saveButton = element('button', 'editor-secondary', '保存素材设置'); saveButton.type = 'button'; context.save = saveButton;
    const saved = element('span', 'editor-save-state', context.dirty ? '有未保存的修改' : '当前设置已保存'); context.saved = saved;
    saveButton.addEventListener('click', async () => {
        context.pending = true; updateControls(context);
        try { await save(context); }
        catch (error) { if (active(context)) context.status.textContent = error.message; }
        finally { context.pending = false; if (active(context)) updateControls(context); }
    });
    toolbar.append(saveButton, saved);
    if (!data.frozen) toolbar.append(actionButton(context, 'prepare'), actionButton(context, 'check'));
    materials.append(toolbar);
    context.captionEditor = null;
    if (data.schema?.captions) {
        context.captionEditor = mountCaptionEditor(materials, context, {
            request, mutate,
            onChange: () => dirty(context),
            onSaved: inputs => {
                context.inputs = clone(inputs); context.data.inputs = clone(inputs); context.dirty = false;
                context.data.previewFiles = []; remember(context);
                context.voiceEditor?.reload();
                if (active(context)) { context.saved.textContent = '素材与字幕已保存'; context.previews?.replaceChildren(element('p', 'editor-hint', '字幕已更新，请重新生成静态截图。')); }
            },
            onSave: async () => {
                if (context.pending || isRunning(context.job)) return;
                context.pending = true; updateControls(context);
                try { await save(context); }
                catch (error) { if (active(context)) context.status.textContent = error.message; }
                finally { context.pending = false; if (active(context)) updateControls(context); }
            },
            onPreview: row => {
                if (context.pending || isRunning(context.job)) return;
                context.at.value = String(Number(((row.start + row.end) / 2).toFixed(3)));
                switchStep(context, 'output'); startAction(context, 'preview');
            },
            fallback: mediaRow(context, 'captions'),
        });
    }

    context.voiceEditor = data.schema?.voice ? mountVoiceEditor(materials, context, {
        request, onGenerate: () => startAction(context, 'voice'), fallback: mediaRow(context, 'voice'),
    }) : null;
    const script = element('details', 'editor-script');
    script.append(element('summary', '', data.script ? '查看录制稿与时间安排' : '录制稿尚未生成'));
    script.append(element('pre', '', data.script || '点击“准备录制稿”，然后按每句话的时间窗录制人物录像和口播。'));
    materials.append(script);
    const next = element('button', 'editor-secondary', '下一步：预览与导出'); next.type = 'button';
    next.addEventListener('click', () => switchStep(context, 'output')); materials.append(next);
    const output = context.panels.output;
    output.append(element('h4', '', '检查画面，选择交付方式'), element('p', 'editor-hint', '截图用于检查单帧；视频用于连续播放；模板包用于继续创作或分享。'));
    const cards = element('div', 'editor-output-grid');
    const snapshotCard = element('section', 'editor-output-card');
    snapshotCard.append(element('h5', '', '静态截图'), element('p', 'editor-hint', '选几个时间点检查画面、文字与排版。'));
    const at = inputText(context.at?.value || ''); at.placeholder = '例如 5, 42, 168'; at.maxLength = 300; context.at = at;
    at.disabled = data.frozen;
    snapshotCard.append(field('截图时间（秒，选填）', at, '留空自动选取代表画面。'));
    if (!data.frozen) snapshotCard.append(actionButton(context, 'preview'));
    else snapshotCard.append(element('p', 'editor-hint', '已合成版本可查看下方现有截图。'));
    const composeCard = element('section', 'editor-output-card editor-output-primary');
    composeCard.append(element('h5', '', '可播放视频'), element('p', 'editor-hint', playable ? '这个版本已合成，可以在成片放映中播放和下载。' : '将当前素材和模板合成为完整视频，完成后加入成片放映。'));
    if (!data.frozen) composeCard.append(actionButton(context, 'compose', true));
    else if (playable && context.onPlayVersion) {
        const play = element('button', 'download-link', '播放此版本成片'); play.type = 'button';
        play.addEventListener('click', () => context.onPlayVersion(context.video)); composeCard.append(play);
    }
    const exportCard = element('section', 'editor-output-card');
    exportCard.append(element('h5', '', '.video 模板包'), element('p', 'editor-hint', '导出可复用模板，供以后填入新素材。模板包本身不能直接播放。'), actionButton(context, 'export'));
    const exported = (context.project.templates || []).find(item => item.video === context.video);
    if (exported && /^media\/[a-f0-9]{32}$/.test(exported.url)) {
        const download = element('a', 'editor-export-download', '下载当前 .video 模板');
        download.href = `./${exported.url}?download=1`; download.download = exported.name || '';
        exportCard.append(download);
    }
    cards.append(snapshotCard, composeCard, exportCard); output.append(cards);
    if (!data.installed) output.append(element('p', 'editor-hint', '首次准备、截图或合成需要一些时间，请保持页面打开。'));
    const previews = element('div', 'editor-previews'); context.previews = previews;
    const images = (data.previewFiles || []).filter(name => /\.(png|jpe?g|webp)$/i.test(name));
    previews.append(element('h4', '', '当前模板的静态截图'));
    if (images.length) {
        const gallery = element('div', 'editor-preview-grid');
        for (const name of images) {
            const link = element('a'); link.href = `${context.base}/preview/${encodeURIComponent(name)}?v=${Date.now()}`; link.target = '_blank'; link.rel = 'noopener';
            const image = element('img'); image.src = link.href; image.alt = `模板静态截图 ${name}`; image.loading = 'lazy';
            link.append(image); gallery.append(link);
        }
        previews.append(gallery);
    } else previews.append(element('p', 'editor-hint', '还没有静态截图。点击“生成静态截图”检查这版模板的画面。'));
    output.append(previews);
    container.append(...Object.values(context.panels));
    switchStep(context, context.step || editorSteps.get(context.project.slug) || (data.generation ? 'output' : 'agent'));
    showJob(context, context.job || data.job);
}

export async function mountTemplateEditor(project, { onLibraryChanged, onPlayVersion, onVersionChanged, force = false } = {}) {
    const container = document.querySelector('#template-editor');
    if (!container) return;
    const packages = project?.templatePackages || [];
    if (!packages.length) {
        generation++;
        if (current) { remember(current); clearTimeout(current.timer); }
        current = null; container.hidden = true; container.replaceChildren(); return;
    }
    const preferred = selectedVersion(project.slug);
    const video = packages.some(pkg => pkg.name === preferred) ? preferred : packages.at(-1).name;
    selectVersion(project.slug, video);
    const key = `${project.slug}/${video}`;
    if (!force && current?.key === key) { current.project = project; current.onLibraryChanged = onLibraryChanged; current.onPlayVersion = onPlayVersion; current.onVersionChanged = onVersionChanged; return; }
    if (current) { remember(current); clearTimeout(current.timer); }
    generation++;
    const context = {
        generation, key, video, project, onLibraryChanged, onPlayVersion, onVersionChanged, container, dirty: false, pending: false, cancelling: false,
        base: `./api/projects/${encodeURIComponent(project.slug)}/templates/${encodeURIComponent(video)}`,
    };
    current = context; container.hidden = false;
    onVersionChanged?.(video);
    container.replaceChildren(element('p', 'editor-hint', '正在读取模板素材设置…'));
    try {
        const data = await request(`${context.base}/editor`);
        if (!active(context)) return;
        context.data = data;
        const remembered = drafts.get(key);
        context.inputs = clone(remembered?.dirty && !data.frozen ? remembered.inputs : data.inputs);
        context.dirty = Boolean(remembered?.dirty && !data.frozen);
        context.captionDraft = remembered?.captionDraft;
        if (data.frozen && context.captionDraft?.dirty) context.captionDraft = null;
        const stored = storedAgentDraft(key);
        const runningGeneration = isRunning(data.job) && data.job.action === 'generate' ? data.job : null;
        context.generationMode = data.lineage?.kind === 'derived' ? runningGeneration?.mode || remembered?.generationMode || stored.mode || 'derive' : 'derive';
        context.generationTitle = runningGeneration?.title || remembered?.generationTitle || stored.title || `${data.title} · 新模板`;
        context.generationPrompt = runningGeneration?.prompt || remembered?.generationPrompt || stored.prompt || '';
        context.generationSubtitleScript = runningGeneration?.subtitleScript ?? remembered?.generationSubtitleScript ?? stored.subtitleScript ?? '';
        const preferredTarget = runningGeneration?.target || remembered?.agentTarget || stored.target || data.agent?.defaultTarget;
        context.agentTarget = data.agent?.targets?.some(target => target.name === preferredTarget) ? preferredTarget : data.agent?.targets?.[0]?.name;
        context.providerTarget = runningGeneration?.providerTarget || remembered?.providerTarget || stored.providerTarget || context.agentTarget;
        context.agentModel = runningGeneration?.model || remembered?.agentModel || stored.model || '';
        context.job = data.job;
        render(context);
        if (isRunning(context.job)) poll(context, context.job.id);
    } catch (error) {
        if (!active(context)) return;
        container.replaceChildren(element('p', 'editor-hint', `无法读取模板设置：${error.message}`));
        const retry = element('button', 'editor-secondary', '重新读取'); retry.type = 'button';
        retry.addEventListener('click', () => mountTemplateEditor(project, { onLibraryChanged, onPlayVersion, onVersionChanged, force: true }));
        container.append(retry);
    }
}

window.addEventListener('beforeunload', event => {
    if (current?.captionDraft?.dirty) { event.preventDefault(); event.returnValue = ''; }
});
