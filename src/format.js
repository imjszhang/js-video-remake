import { errorInfo } from './errors.js';

export function ok(data) {
    return { ok: true, data };
}

export function fail(error) {
    const result = { ok: false, error: errorInfo(error) };
    if (error?.data) result.data = error.data;
    return result;
}

export function printHuman(result, write = (line) => process.stdout.write(`${line}\n`)) {
    if (result.data?.command?.startsWith('repro:')) {
        const data = result.data;
        if (!result.ok) write(`错误 [${result.error.code}]: ${result.error.message}`);
        if (data.run) {
            write(`复现: ${data.run.production}  ${data.run.kind}  ${data.run.status}`);
            const mode = data.run.generationMode === 'method-generation' || data.run.method ? '从空工程生成' : data.run.template ? '历史工程回放' : '教师制作 / 空工程基线';
            write(`制作方式: ${mode}`);
            if (data.run.method?.id) write(`方法配方: ${data.run.method.id}`);
            if (data.run.assisted) write('外部协助: 有；不能作为独立生成通过。');
            if (data.run.generationAudit) {
                const isolation = data.run.generationAudit.isolation || data.run.isolation || {};
                write(`生成检查: ${data.run.generationAudit.status || (data.run.generationAudit.passed ? '过程审计通过' : '未通过')}；读取隔离: ${isolation.readIsolation === 'enforced' && isolation.filesystemProbeVerified === true ? '已验证' : '未验证'}；网络隔离: ${isolation.probeVerified === true && isolation.probe?.networkRestricted === true ? '已验证' : '未验证'}`);
            }
            if (data.run.stageState || data.run.schema === 'video-remake.reproduction-run@3') {
                write(`阶段调用: ${data.run.stageExecutions?.length || 0}；阶段提交: ${data.run.stageSubmissions?.length || 0}；整片提交: ${data.run.finalSubmissions?.length || 0}`);
                write(`当前阶段: ${typeof data.run.stageState?.currentStage === 'object' ? data.run.stageState.currentStage?.id || '未开始' : data.run.stageState?.currentStage || '未开始'}`);
                for (const stage of Array.isArray(data.run.stageState?.stages) ? data.run.stageState.stages : []) {
                    write(`阶段 ${stage.title || stage.id}${stage.shotId ? ` / ${stage.shotId}` : ''}: ${stage.status || 'pending'}${stage.staleReason ? ` — ${stage.staleReason}` : ''}`);
                    for (const check of stage.hostChecks || []) write(`  材料检查${check.passed === true ? '通过' : check.passed === false ? '未通过' : '待定'}: ${check.message || check.id}`);
                    if (stage.selfCheck) write(`  执行者自检: ${stage.selfCheck.status || '已提交'}（不替代最终质量评审）`);
                }
                if (data.run.allowedActions?.length) write(`可执行: ${data.run.allowedActions.map(action => typeof action === 'string' ? action : action.action).join(', ')}`);
                for (const [action, reason] of Object.entries(data.run.blockedReasons || {})) write(`暂不可执行 ${action}: ${Array.isArray(reason) ? reason.join('；') : reason}`);
            } else write(`整片尝试: ${data.run.attempts?.length || 0}（历史流程未记录阶段证据）`);
            if (data.run.workspace) write(`工作目录: ${data.run.workspace}`);
            if (data.run.technical) {
                for (const check of data.run.technical.checks) write(`${check.passed ? '通过' : '失败'}: ${check.id} — ${check.message}`);
                if (data.run.technical.artifact) write(`成片 SHA256: ${data.run.technical.artifact.sha256}`);
            }
            if (data.run.status === 'external-review' || data.run.status === 'review-ready') write(data.run.method ? '提交检查通过；使用 repro:judge 完成两份独立质量评审。' : '技术检查通过；使用 repro:judge 或 repro:review 完成独立验收。');
            if (data.run.activeAgent) write(`当前 Agent: ${data.run.activeAgent.status}；已运行 ${Math.round(data.run.activeAgent.elapsedMs / 1000)} 秒；工具调用 ${data.run.activeAgent.toolCalls ?? '未知'}`);
            if (data.run.budget) write(`模型调用: ${data.run.budget.calls}；累计耗时: ${Math.round(data.run.budget.elapsedMs / 1000)} 秒`);
        } else if (data.command === 'repro:method-revise' && data.draft) {
            write(`方法修订草稿: ${data.source.id} → ${data.target.id}`);
            write(`反馈运行: ${data.feedback.map(item => item.production).join(', ')}`);
            write(`草稿目录: ${data.draft.path}`);
            write(`研发记录: ${data.recordPath}`);
            write('内容审查尚未完成；审查后使用 repro:method-freeze 冻结，再从空工程验证。当前草稿不代表质量提升。');
        } else if (data.release) write(`验证记录已发布: ${data.release.method || data.release.template}（执行模型: ${data.release.validationScope.requestedModel || '未知'}）`);
        else if (data.method && data.path) write(`方法配方: ${typeof data.method === 'string' ? data.method : data.method.id}\n路径: ${data.path}`);
        else if (data.template && data.path) write(`模板: ${data.template}\n路径: ${data.path}`);
        else if (data.text !== undefined) write(data.text || '暂无日志。');
        else write(JSON.stringify(data, null, 2));
        if (data.warning) write(data.warning);
        return;
    }
    if (result.data?.command?.startsWith('agent:')) {
        const data = result.data;
        if (!result.ok) write(`错误 [${result.error.code}]: ${result.error.message}`);
        if (data.run) {
            const run = data.run;
            write(`Agent: ${run.id}  ${run.status}  ${run.target}`);
            write(`记录: ${run.runDir}`);
            if (run.execution?.text) write(run.execution.text);
        } else if (data.runs) {
            if (!data.runs.length) write('尚无 Agent 运行记录。');
            for (const run of data.runs) write(`${run.id}  ${run.status}  ${run.target}${run.production ? `  ${run.production}` : ''}`);
        } else if (data.command === 'agent:logs') {
            write(data.text || '暂无日志。');
        } else if (data.command === 'agent:cancel') {
            write(`${data.id}: ${data.status}`);
        } else if (data.readiness) {
            write(`目标: ${data.target}${data.enabled ? '' : '（已禁用）'}`);
            for (const check of data.readiness.checks) write(`${check.status}: ${check.name} — ${check.message}`);
        } else if (data.plan) {
            write(`目标: ${data.plan.target.name}${data.plan.enabled ? '' : '（已禁用）'}`);
            write(`工作区: ${data.plan.workspace}`);
            write(`权限: ${data.plan.target.harness.permission}`);
            write(`计划: ${data.plan.execution.planHash}`);
            write(`任务: ${data.plan.instruction}`);
            for (const input of data.plan.inputs) write(`输入: ${input.path}  ${input.sha256}`);
            write('完整 prompt 和执行参数可用 --json 查看；此命令未执行任务。');
        } else write(JSON.stringify(data, null, 2));
        return;
    }
    if (!result.ok && !['doctor', 'media:doctor', 'download:doctor'].includes(result.data?.command)) {
        write(`错误 [${result.error.code}]: ${result.error.message}`);
        return;
    }
    const data = result.data;
    if (!result.ok && data?.command === 'doctor') {
        write(`错误 [${result.error.code}]: ${result.error.message}`);
    }
    if (data?.command === 'doctor') {
        write(`Node ${data.node.version}${data.node.ok ? '' : '（需要 >= 22.15.0）'}`);
        write(`工作台: ${data.workspace.path}${data.workspace.ok ? '' : '（不完整）'}`);
        write(`台账: ${data.catalog.path}${data.catalog.ok ? '' : '（无效）'}`);
        write(`asset-root: ${data.assetRoot.path}${data.assetRoot.readable ? '（可读）' : data.assetRoot.required === false ? '（本地文件引用不需要）' : '（不可读）'}`);
        write(`素材数据源: ${data.source.provider} ${data.source.location}（${data.source.available ? '可用' : '不可用'}）`);
        if (data.source.hint) write(data.source.hint);
        for (const name of ['ffmpeg', 'ffprobe', 'hyperframes']) {
            const tool = data.tools?.[name];
            if (!tool) continue;
            const detail = tool.version ? ` ${tool.version}` : '';
            write(`${name}:${detail} ${tool.available ? tool.path : '未找到（警告）'}`);
        }
        for (const warning of data.warnings || []) write(`警告: ${warning}`);
        return;
    }
    if (data?.command === 'download:doctor') {
        if (!result.ok) write(`错误 [${result.error.code}]: ${result.error.message}`);
        write(`下载工具: ${data.provider}（${data.ready ? '就绪' : '未就绪'}）`);
        if (data.version) write(`版本: ${data.version}`);
        if (data.hint) write(data.hint);
        return;
    }
    if (data?.command === 'reference:download') {
        write(`已下载并登记: ${data.file}`);
        for (const item of data.references) write(`  ${item.id}`);
        write('使用 start <参考 ID> --as <制作名> 建项。');
        return;
    }
    if (data?.command === 'reference:scan') {
        write(`扫描到 ${data.candidates.length} 个视频: ${data.directory}`);
        for (const item of data.candidates) {
            write(`  ${item.relativePath}  ${(item.bytes / 1048576).toFixed(1)} MB  ${item.referenceIds.length ? '已登记: ' + item.referenceIds.join(', ') : '未登记'}`);
        }
        if (data.skipped.length) write(`跳过 ${data.skipped.length} 项（详细原因用 --json 查看）。`);
        if (data.imported.length) {
            write(`已导入 ${data.imported.length} 条参考：`);
            for (const item of data.imported) write(`  ${item.id}`);
        } else if (data.importRequested) write('没有新参考需要导入，已登记或重复的文件已跳过。');
        else write('未新增参考。确认候选后，可加 --import 导入；用 --select 相对路径 选择条目。');
        return;
    }
    if (data?.command === 'reference:import') {
        write(`已导入 ${data.references.length} 条本地参考（原片留在原位置）：`);
        for (const item of data.references) write(`  ${item.id}`);
        write('使用 reference:list 查看清单，再用 start <参考 ID> --as <制作名> 建项。');
        return;
    }
    if (data?.command === 'reference:list') {
        if (!data.references.length) write('本地参考清单为空，请用 reference:import 导入视频文件或 manifest。');
        for (const item of data.references) {
            write(`${item.id}  ${item.title}  ${item.available ? '可复刻' : '原片不可用'}`);
            write(`  关联制作: ${item.productions.join(', ') || '暂无'}`);
            if (item.availabilityError) write(`  ${item.availabilityError}`);
        }
        return;
    }
    if (data?.command === 'ingest' || data?.command === 'bind') {
        write(`已绑定: ${data.reference.id}`);
        write(`成片: ${data.source.videoPath}`);
        if (data.warning) write(`警告: ${data.warning}`);
        return;
    }
    if (data?.command === 'start') {
        write(`已创建制作: ${data.production.slug}`);
        write(`参考: ${data.production.referenceIds.join(', ')}`);
        write(`目录: ${data.production.dir}`);
        return;
    }
    if (data?.command === 'list') {
        if (!data.references.length && !data.productions.length) {
            write('台账为空。');
            return;
        }
        if (data.references.length) {
            write('参考:');
            for (const item of data.references) {
                write(`  ${item.id}  ${item.status.padEnd(13)}  ${item.title || item.archiveVideoId}  ${item.available ? '可复刻' : '原片不可用'}  制作: ${(item.productions || []).join(', ') || '暂无'}`);
            }
        }
        if (data.productions.length) {
            write('制作:');
            for (const item of data.productions) {
                write(`  ${item.slug}  ${item.status.padEnd(13)}  ${item.referenceIds.join(',')}`);
            }
        }
        return;
    }
    if (data?.command === 'get') {
        if (data.kind === 'reference') {
            write(`${data.reference.id}  ${data.reference.status}`);
            write(data.source.title || data.reference.archiveVideoId);
            write(`成片: ${data.source.videoPath}`);
            return;
        }
        write(`${data.production.slug}  ${data.production.status}`);
        write(`参考: ${data.production.referenceIds.join(', ')}`);
        write(`目录: ${data.production.dir}`);
        if (data.production.deliverable) write(`交付: ${data.production.deliverable.dir}`);
        if (data.production.comparison) {
            const comparison = data.production.comparison;
            write(`对比: ${comparison.version}  ${comparison.dir}/${comparison.file}`);
        }
        return;
    }
    if (data?.command === 'paths') {
        write(`workspace: ${data.workspace}`);
        write(`asset-root: ${data.assetRoot}`);
        if (data.download) write(`下载工具: ${data.download.provider}；下载目录: ${data.download.directory}`);
        if (data.tools?.hyperframes) write(`hyperframes: ${data.tools.hyperframes.expected}`);
        for (const [task, provider] of Object.entries(data.media || {})) write(`media.${task}: ${provider}`);
        return;
    }
    if (data?.command === 'deliver') {
        write(`已交付: ${data.slug} ${data.version}`);
        write(`文件: ${data.file}`);
        return;
    }
    if (data?.command === 'compare') {
        write(`已生成竖屏对比: ${data.slug} ${data.version}`);
        write(`上方: ${data.manifest.inputs.top.label}  ${data.manifest.inputs.top.path}`);
        write(`下方: ${data.manifest.inputs.bottom.label}  ${data.manifest.inputs.bottom.path}`);
        write(`音轨: ${{ top: '上方', bottom: '下方', none: '静音' }[data.manifest.render.audio]}`);
        write(`文件: ${data.file}`);
        return;
    }
    if (data?.command === 'check') {
        write(`检查通过: ${data.slug}${data.video ? ` / ${data.video}` : ''}`);
        write(`帧率: ${data.fps}`);
        if (data.warnings?.length) write(`警告: ${data.warnings.length}`);
        return;
    }
    if (data?.command === 'captions') {
        write(`已生成字幕: ${data.slug} ${data.cues} 条`);
        write(`片段: ${data.files.html}`);
        return;
    }
    if (data?.command === 'normalize') {
        write(data.status === 'skipped' ? `未转码: ${data.id}` : `已规范化: ${data.assetId}`);
        write(data.reason || `复制进代码视频包: ${data.next}`);
        return;
    }
    if (data?.command === 'media:doctor') {
        if (!result.ok) write(`错误 [${result.error.code}]: ${result.error.message}`);
        const names = { image: '出图', video: '出片', transcribe: '转写' };
        for (const [task, item] of Object.entries(data.media)) {
            const version = item.version ? ` ${item.version}` : '';
            write(`${names[task] || task}: ${item.provider}${version}（${item.ready ? '就绪' : '未就绪'}${item.agentOnly ? '，由 Agent 按指南调用' : ''}）`);
            if (item.hint) write(`  ${item.hint}`);
            write(`  能力: ${(item.capabilities ?? []).join('、')}`);
            write(`  指南: ${item.guide}`);
        }
        return;
    }
    if (data?.command === 'media:prepare') {
        write(`已检查素材需求: ${data.task} → ${data.provider}`);
        write(`执行方式: ${data.execution === 'agent' ? '由 Agent 按指南调用工具' : '由现有素材命令调用'}`);
        write(`所需能力: ${data.request.require.join('、')}`);
        write(`指南: ${data.guide}`);
        write('仅检查了需求与本地输入；尚未探活或生成，生成仍需用户授权。');
        return;
    }
    if (data?.command === 'media:image' || data?.command === 'media:video') {
        write(`已生成: ${data.path}`);
        write(`provider: ${data.provider}`);
        if (data.taskId) write(`任务 ID: ${data.taskId}`);
        return;
    }
    if (data?.command === 'media:transcribe') {
        write(`已转写: ${data.path}`);
        write(`下一步: ${data.next}`);
        return;
    }
    if (data?.command === 'media:land') {
        write(`landed ${data.id} → ${data.path}`);
        write(`复制进代码视频包: ${data.next}`);
        return;
    }
    if (data?.command === 'video:new' || data?.command === 'video:fork') {
        write(data.command === 'video:fork' ? `已复制 ${data.from} → ${data.video}: ${data.dir}` : `已创建代码视频包: ${data.dir}`);
        write(data.installed ? `依赖: 已运行 npm ${data.installed}` : `依赖: 未安装，运行 cd ${data.dir} && npm install`);
        return;
    }
    if (data?.command === 'video:list') {
        if (!data.videos.length) { write(`${data.slug} 还没有代码视频包。`); return; }
        for (const video of data.videos) {
            const state = [video.installed ? '已安装' : '未安装', video.rendered ? '已渲染' : '未渲染', video.imported ? '已导入（冻结）' : '未导入'].join('，');
            const label = video.lineage ? `${video.lineage.title} · ${video.lineage.kind === 'source' ? '原版 ' : ''}v${video.lineage.version}` : `${video.name} v${video.version ?? '?'}`;
            write(`${label}  [${video.name}]${video.lineage?.origin ? `  ← ${video.lineage.origin.title} v${video.lineage.origin.version}` : ''}  ${state}`);
        }
        return;
    }
    if (data?.command === 'video:render') {
        write(`已渲染: ${data.output}（${Math.round(data.elapsedMs / 1000)} 秒）`);
        write(`下一步: ${data.next}`);
        return;
    }
    if (data?.command === 'video:import') {
        write(`已导入草稿: ${data.draft}${data.reimport ? '（覆盖同一源文件的旧导入）' : ''}`);
        if (!data.renderVerified) write('警告: 未经 video:render 验证，按 --force 导入。');
        write(`源文件 SHA-256: ${data.treeHash}`);
        return;
    }
    if (data?.command === 'video:generate') {
        write(`Agent 已生成新模板「${data.title}」: ${data.dir}`);
        if (data.summary) write(data.summary);
        write(`构建、检查和预览已完成。导出: remake video:pack ${data.slug} --video ${data.video}`);
        return;
    }
    if (data?.command === 'video:remix') {
        write(`已创建新模板「${data.title}」: ${data.dir}`);
        write('已恢复模板默认输入，原版及原成片保留。');
        write(`可在网页预览、合成，或运行 remake video:pack ${data.slug} --video ${data.video} 导出 .video。`);
        return;
    }
    if (data?.command === 'video:unpack') {
        write(`已导入模板并创建制作 ${data.slug}: ${data.dir}（${data.files} 个文件）`);
        write('放映室已可查看项目；准备素材并渲染后才能播放。');
        write(`下一步进入 ${data.dir}，运行 npm ci、npm run inputs -- --init、npm run build，按 SCRIPT.md 录制。`);
        write(`素材检查通过后，在工作区运行 remake video:render ${data.slug}，再运行 remake video:import ${data.slug} 登记成片。`);
        return;
    }
    if (data?.command === 'video:pack') {
        write(`已打包: ${data.output}（${(data.bytes / 1048576).toFixed(1)} MB，${data.files} 个文件，跳过 ${data.excluded} 项）`);
        write(`解压后进入 ${data.folder}/，按 README.md 或 .agents/skills/video-template/SKILL.md 使用。`);
        if (data.registered) write('已登记到 catalog.json，放映室的项目页可以下载。');
        return;
    }
    if (data?.command === 'video:add') {
        write(`${data.status === 'unchanged' ? '已在包内' : '已复制'}: ${data.path}`);
        write(data.html);
        return;
    }
    if (data?.command === 'template:script') {
        // Without --out the draft itself is the output, so it can be piped or redirected.
        if (data.text !== undefined && data.text !== null) {
            for (const line of data.text.replace(/\n$/, '').split('\n')) write(line);
            return;
        }
        write(`已导出提词稿: ${data.out}`);
        write(`${data.language === 'en' ? '英文' : '中文'} · ${data.count} 句${data.skipped ? ` · 跳过空句 ${data.skipped}` : ''}${data.pauses ? ` · ${data.pauses} 处停顿` : ''}`);
        return;
    }
    if (data?.command === 'studio' || data?.command === 'timeline') {
        write(data.output || `${data.command}: ${data.slug}`);
        return;
    }
    write(JSON.stringify(data, null, 2));
}
