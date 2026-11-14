import { appError } from './errors.js';

const COMMANDS = new Set([
    'doctor', 'ingest', 'bind', 'start', 'list', 'get',
    'reference:list', 'reference:import', 'reference:scan', 'reference:download', 'download:doctor',
    'paths', 'deliver', 'compare',
    'check', 'captions', 'normalize', 'studio', 'timeline',
    'media:doctor', 'media:prepare', 'media:image', 'media:video', 'media:speech', 'media:transcribe', 'media:land',
    'video:new', 'video:fork', 'video:list', 'video:render', 'video:import', 'video:add', 'video:pack', 'video:unpack', 'video:remix', 'video:generate',
    'template:script',
    'agent:config', 'agent:doctor', 'agent:plan', 'agent:run',
    'agent:status', 'agent:logs', 'agent:cancel',
    'repro:config', 'repro:doctor', 'repro:list', 'repro:init', 'repro:teacher',
    'repro:extract', 'repro:instantiate', 'repro:trial', 'repro:run', 'repro:retry', 'repro:resume',
    'repro:check', 'repro:review', 'repro:judge', 'repro:publish', 'repro:status',
    'repro:validate', 'repro:export', 'repro:import', 'repro:migrate', 'repro:benchmark',
    'repro:logs', 'repro:cancel',
    'repro:cycle',
    'repro:render', 'repro:repair', 'repro:recover', 'repro:continue',
    'repro:method-freeze', 'repro:asset-freeze', 'repro:method-migrate', 'repro:method-revise', 'repro:generate', 'repro:replay',
    'harness:init', 'harness:teacher', 'harness:extract', 'harness:trial',
    'harness:retry', 'harness:check', 'harness:review', 'harness:judge', 'harness:publish', 'harness:status',
]);
const BOOLEANS = new Set(['force', 'json', 'checkLogin', 'dryRun', 'baseline', 'evidence', 'run', 'step', 'stop', 'status', 'skipInstall', 'recursive', 'import']);
const REPEATABLE = new Set(['input', 'skill', 'image', 'require', 'select']);
const CONFIG_KEYS = {
    config: 'configPath',
    workspace: 'workspace',
    assetRoot: 'assetRoot',
    quality: 'quality',
    sourceProvider: 'sourceProvider',
    sourceUrl: 'sourceUrl',
    sourceManifest: 'sourceManifest',
    downloadProvider: 'downloadProvider',
    downloadExecutable: 'downloadExecutable',
    downloadDir: 'downloadDir',
    downloadTimeoutMs: 'downloadTimeoutMs',
    pollIntervalMs: 'pollIntervalMs',
    waitTimeoutMs: 'waitTimeoutMs',
};

function camel(flag) {
    return flag.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function parseArgv(argv) {
    let command;
    const positionals = [];
    const flags = {};
    const config = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--help' || token === '-h') return { help: true };
        if (!token.startsWith('--')) {
            if (!command) {
                command = token;
                if (!COMMANDS.has(command)) throw appError('INVALID_INPUT', `Unknown command: ${command}`);
            } else {
                positionals.push(token);
            }
            continue;
        }
        const match = /^--([^=]+)(?:=(.*))?$/.exec(token);
        const key = camel(match[1]);
        let value = match[2];
        if (BOOLEANS.has(key)) {
            if (value === undefined && ['true', 'false'].includes(argv[index + 1])) value = argv[++index];
            if (value !== undefined && !['true', 'false'].includes(value)) {
                throw appError('INVALID_INPUT', `--${match[1]} expects true or false`);
            }
            const bool = value === undefined || value === 'true';
            flags[key] = bool;
            if (CONFIG_KEYS[key]) config[CONFIG_KEYS[key]] = bool;
            continue;
        }
        if (value === undefined) {
            if (argv[index + 1] === undefined || argv[index + 1].startsWith('--')) {
                throw appError('INVALID_INPUT', `--${match[1]} requires a value`);
            }
            value = argv[++index];
        }
        if (key === 'feedback' && command === 'repro:method-revise') (flags[key] ??= []).push(...value.split(',').map(id => id.trim()).filter(Boolean));
        else if (REPEATABLE.has(key)) (flags[key] ??= []).push(value);
        else flags[key] = value;
        if (CONFIG_KEYS[key]) config[CONFIG_KEYS[key]] = value;
    }
    return { command, positionals, flags, config, help: false };
}

export const HELP = `Usage: remake <command> [arguments]

Commands:
  repro:config               Show role-to-target mappings and budgets
  repro:doctor               Probe configured Harnesses (no model request)
  repro:list                 List method recipes, runs and historical replay templates
  repro:init <production>    Freeze task (--spec FILE [--inputs FILE] [--baseline])
  repro:teacher <production> Create the teacher project using its configured role
  repro:extract <production> Extract a method recipe (--name NAME --version N)
  repro:method-freeze <dir>   Freeze a reviewed method directory (--name NAME --version N)
  repro:method-revise <id>    Draft a new method revision from recorded feedback (--feedback SLUG, repeatable)
  repro:asset-freeze <dir>    Freeze an approved generic asset pack (--name NAME --version N)
  repro:generate <name@N>    Create a blank project (--as SLUG --spec FILE --inputs FILE --ref ID [--run])
  repro:instantiate <name@N> Alias for method generation (requires task specification)
  repro:trial <name@N>       Generate and execute using a method recipe
  repro:replay <name@N>      Explicit historical project replay (--as SLUG --inputs FILE [--run])
  repro:run <production>     Execute the project with its configured role
  repro:retry <production>   Start a fresh bounded attempt, preserving prior work
  repro:resume <production>  Resume an unchanged interrupted checkpoint
  repro:recover <production> Reconcile an execution whose owner process exited
  repro:repair <production>  Repair current source after failed acceptance
  repro:continue <production> Start an explicitly authorized new repair batch, preserving criteria and prior usage
  repro:render <production> Render completed source with the managed local provider
  repro:check <production>   External checks [--evidence]
  repro:judge <production>   Independent evidence-based model review
  repro:review <production>  Record evidence-linked human review (--review FILE)
  repro:publish <name@N>     Register verified method scope (--production SLUG)
  repro:status <production>  Show stages, budget, evidence and project path
  repro:logs <production>    Read model logs [--stream stdout|stderr|events]
  repro:cancel <production>  Cancel the active model execution
  repro:validate <directory> Check standalone project contract
  repro:export <name@N>      Export a method recipe or historical project (--to DIRECTORY)
  repro:import <directory>   Import an unverified method recipe (old project import is removed)
  repro:method-migrate <id>  Inspect old project contents for method migration [--dry-run]
  repro:benchmark <file>     Compare generation experiments; replay results remain separate

Reproduction options:
  --workflow FILE           Role/policy configuration (reproduction-workflow.json)
  --spec FILE               Frozen reproduction specification
  --inputs FILE             Replacement input values
  --references FILE         Local reference bindings for a task
  --ref ID                  Reference video bound in the workspace catalog
  --name NAME --version N   Immutable method identity (separate from old templates)
  --feedback SLUG           Failed trial used to improve a new method version
  --stage ID                Scope a stage operation (never skips prerequisites)
  --shot ID                 Scope a shot within the selected stage
  --until STAGE             Run through this stage, subject to its checks
  --step                    Execute only the next eligible stage operation
  --run                     Start execution after creating the project
  --to DIRECTORY            Export/migration destination (must not exist)
  --cases FILE              Held-out test input paths for the automatic loop

  reference:list              查看本地参考清单、原片可用状态与关联制作
  reference:import <file>     引用本地原片 [--id ID --title TITLE]（不复制）
  reference:import --manifest FILE
                              批量导入本地清单 [--asset-root DIR]
  reference:scan <dir>        只读扫描视频 [--recursive]；加 --import 登记，可用 --select 相对路径 多选
  reference:download <url>    使用独立下载适配器下载并登记参考 [--quality 720|1080]
  download:doctor             离线检查下载工具，不请求视频站点
  doctor                      检查本地清单、所选数据源与工具
  ingest <url>                Queue via source API, poll, then bind
  bind <video_id>             Bind an already-downloaded archive entry
  start <ref_id> --as <slug>  Create a production (Brief, assets, drafts, videos/)
  list                        List references and productions
  get <id|slug>               Show one reference or production
  paths                       Print workspace, asset-root, and local tools
  deliver <slug> --from <file>
                              Copy an accepted file into deliverables
  compare <slug> --top <file> [--bottom <file>]
                              Render a 9:16 comparison; bottom is required the first time
  check <slug>                Frame-boundary, asset, and HyperFrames check of a code video package [--video NAME]
  captions <slug> --from <transcript.json>
                              Build an integer-frame caption track in the package [--video NAME --max-chars N --fps N]
  normalize <slug> --id <asset>
                              Turn a still into BT.709 video, or keep/flatten alpha [--alpha keep|flatten --duration SEC --fps N]
  studio <slug>               Open HyperFrames Studio for a package [--video NAME] [--stop | --status]
  timeline <slug>             Print a package timeline [--video NAME] [--json]
  video:new <slug>            Create a standalone code video package videos/<name>-vN
                              [--as NAME (default code-vN) --width N --height N --fps N --duration SEC --skip-install]
  video:fork <slug>           Copy a package to the next version [--video FROM --as NAME --skip-install]
  video:list <slug>           List code video packages and their draft status
  video:render <slug>         Build (if defined) and render a package with its own HyperFrames [--video NAME]
  video:import <slug>         Copy a verified render into drafts/<name>/ and the catalog [--video NAME --force]
  video:add <slug> --id ASSET Copy a ledger asset into a package [--video NAME --force]
  video:pack <slug>           Pack a template package into deliverables/<slug>/templates/<id>-vN.video [--video NAME --out FILE.video --force]
  video:unpack <FILE.video>   导入外部模板并新建制作 [--as SLUG]；不执行安装或脚本
  video:remix <slug>         另存为新模板 --title 名称 [--video 包名 --style 样式.json]；清除个人输入
  video:generate <slug>      Agent 生成新模板 --title 名称 --prompt 修改要求 [--video 包名 --target Agent --mode derive|revise]
  template:script <slug>     导出提词稿 [--video 包名 --lang zh|en --format txt|srt|json|cards --out FILE]
  media:doctor                Show configured image/video/speech/transcribe providers and probe them [--task NAME]
  media:prepare --task NAME --request FILE
                              本地检查素材需求、能力与输入文件，输出工具交接信息；不生成、不探活
  media:image --intent TEXT   Generate a still with the configured image provider
                              [--image FILE (repeatable) --size WxH --image-quality Q --out FILE]
  media:video --request FILE [--out FILE]
                              按配置生成视频片段；--task-id ID 代替 --request 继续查询已有任务
  media:speech --text TEXT    Synthesize speech with the configured provider
                              [--reference WAV --reference-text TEXT --language L --voice NAME --out FILE.wav]
  media:transcribe <slug> --from <audio>
                              Transcribe with the configured provider into assets/<id>.transcript.json [--id ID --language L --force]
  media:land <slug> --kind image|video|audio --from FILE --intent TEXT --provider NAME
                              Copy a generated file into the production assets and ledger [--id ID]
  agent:config               Inspect local agent targets (no credentials)
  agent:doctor               Check the selected agent CLI; optional --check-login
  agent:plan                 Preview the task and execution plan without running
  agent:run                  Execute --instruction or --instruction-file
  agent:status [run-id]       List runs or inspect one run
  agent:logs <run-id>         Read saved logs (--stream stdout|stderr|events)
  agent:cancel <run-id>       Request cancellation of an active run

Agent options:
  --agent-config FILE        Local agent configuration (default: agent-runtime.json)
  --target NAME              Select a configured target
  --instruction TEXT         Task to execute in this project
  --instruction-file FILE    Task text in a workspace-relative UTF-8 file
  --production SLUG          Include this production's brief and reference notes
  --input FILE               Include a text input; repeatable
  --skill FILE               Include an explicit skill entrypoint; repeatable
  --timeout-ms N             Execution deadline (1000–86400000 ms)
  --check-login              Probe native CLI login status (doctor only)
  --stream NAME              Log stream (default: stdout)
  --lines N                  Tail 1–10000 log lines (default: 100)

Options:
  --quality 720|1080|audio
  --force
  --as SLUG
  --from FILE
  --top FILE                  Comparison: upper video (required)
  --bottom FILE               Comparison: lower video; omit to reuse the fixed baseline
  --top-label TEXT
  --bottom-label TEXT
  --audio top|bottom|none      Comparison audio source (default: top)
  --top-start SECONDS          Upper video start (default: 0)
  --bottom-start SECONDS       Lower video start (default: 0)
  --duration SECONDS           Comparison length, caption/normalize duration, or new timeline length
  --width N --height N        New package frame (default 1080x1920)
  --fps N                     Frame rate for a new package, captions, or normalize
  --id ASSET                  Ledger id to normalize or add to a package
  --subtitle-script 文本     video:generate：提供新字幕原稿（最多 30000 字）
  --mode derive|revise        video:generate：新建独立模板（默认）或更新当前模板版本
  --video NAME                Code video package under videos/ (required when there are several)
  --out FILE                  media:image / media:video / media:speech 输出，或 video:pack 的 .video 文件
  --lang zh|en                template:script 提词稿语言（默认 zh）
  --format txt|srt|json|cards template:script 输出格式（默认 txt；不加 --out 时写到标准输出）
  --skip-install              video:new / video:fork: do not run npm in the package
  --alpha keep|flatten        Alpha still or video: ProRes 4444, or composite on black
  --max-chars N               Caption cue length (default 16)
  --task image|video|speech|transcribe
                              media:doctor 检查范围；media:prepare 的素材任务类型
  --text TEXT                media:speech 要合成的台词
  --reference FILE           media:speech 的参考 WAV
  --reference-text TEXT      media:speech 参考音频对应的台词
  --voice NAME               media:speech 的系统音色
  --request FILE             media:prepare / media:video 的素材需求 JSON；内部相对路径按工作区解析
  --require CAPABILITY       media:image / media:video / media:speech / media:transcribe 的额外能力要求，可重复
  --stop --status             Studio preview lifecycle
  --workspace DIR
  --source-provider local|gateway-video|manifest (default: local)
  --source-url URL
  --source-manifest FILE
  --download-provider yt-dlp
  --download-executable FILE
  --download-dir DIR
  --download-timeout-ms N
  --poll-interval-ms N
  --wait-timeout-ms N
  --asset-root DIR
  --config FILE
  --json
`;
