import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
// Versioned before execution; never adjusted to obtain a passing verdict.
export async function reviewProtocolFingerprint() {
    const hash = createHash('sha256');
    for (const file of ['review-protocol.js', 'judge.js']) hash.update(await fs.readFile(new URL(file, import.meta.url)));
    return hash.digest('hex');
}
export const REVIEW_PROTOCOL = Object.freeze({
    version: 'paired-evidence-v3',
    rules: [
        '每项显式声明 observationStatus 和实际观察的 modalities；文字中的否定发现（如未观察到字幕重复）不是缺少观察。未观察项保持 unobserved。',
        '先按冻结标准逐项列出观察，再判断；不能把整体像原片作为逐项通过的替代。',
        'visual-fidelity 分别检查人物/道具比例、主体在画幅中的位置和遮挡、透视、材质与色调。区分可辨认的忠实表现与像素级相同；不得临时把脸型完全相同设为新门槛，也不得忽略标准明确要求的构图差异。失败须列出相同seek、原片与成片的具体差异及其对应的标准条款。通过须说明为什么观察到的差异未违反该条款。',
        'motion-timing 分别检查切换、镜头路径、物体动作、进度与反馈事件。大段落同步不等于镜头运动通过。每个失败必须用前/中/后三个以上相同seek样本或实测PTS序列说明；不得只用单张静帧推断运动。',
        'english-captions 检查实际字幕与原片/声音，不把机器转写当真值。尤其检查零时长词、重复前缀和结尾；正常真实重复词不得仅因重复而删除。',
        '固定使用证据清单的全部采样点，并补查所引用失败的局部连续阶段。不得因某次抽样不同而偷偷改变标准；没有足够证据的条款保持unobserved。',
        '你不知道其他评审的判断。不要猜测前次结果，不使用制作模型身份或制作方式作为质量证据。',
    ],
});

/** Conservative consensus: every vote must pass; disagreement never becomes a pass. */
export function combineReviews(reviews) {
    if (!Array.isArray(reviews) || reviews.length < 2) throw new Error('Consensus requires at least two reviews.');
    const first = reviews[0];
    for (const review of reviews) {
        if (review.schema !== first.schema || review.protocolVersion !== first.protocolVersion || review.artifactSha256 !== first.artifactSha256 || review.evidenceManifestSha256 !== first.evidenceManifestSha256
            || JSON.stringify(review.checks.map(c => c.id)) !== JSON.stringify(first.checks.map(c => c.id))) {
            throw new Error('Consensus inputs must share artifact, evidence and criteria.');
        }
    }
    const disagreements = [];
    const checks = first.checks.map((check, i) => {
        const votes = reviews.map(r => r.checks[i]);
        const statuses = [...new Set(votes.map(v => v.status))];
        if (statuses.length > 1) disagreements.push(check.id);
        const status = votes.every(v => v.status === 'pass') ? 'pass' : votes.some(v => v.status === 'fail') ? 'fail' : 'unobserved';
        return { id: check.id, status, passed: status === 'pass',
            ...(first.schema === 'video-remake.reproduction-review@2' ? {
                observationStatus: status === 'unobserved' ? 'unobserved' : 'observed',
                modalities: status === 'fail' ? [...new Set(votes.filter(v => v.status === 'fail').flatMap(v => v.modalities || []))]
                    : (check.modalities || []).filter(modality => votes.every(v => (v.modalities || []).includes(modality))),
            } : {}),
            notes: `${statuses.length > 1 ? '评审存在分歧，禁止据此通过。\n' : ''}${votes.map((v, n) => `[独立评审${n + 1}: ${v.status}] ${v.notes}`).join('\n')}`,
            evidenceIds: [...new Set(votes.flatMap(v => v.evidenceIds))] };
    });
    return { review: { schema: first.schema, ...(first.protocolVersion ? { protocolVersion: first.protocolVersion } : {}), reviewer: 'model:consensus', artifactSha256: first.artifactSha256,
        evidenceManifestSha256: first.evidenceManifestSha256, checks, passed: checks.every(c => c.passed) }, disagreements };
}
