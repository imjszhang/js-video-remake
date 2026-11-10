#!/usr/bin/env bash
set -euo pipefail
: "${REPRO_REFERENCE_ID:?请设置已绑定的参考视频 ID}"
cd "$(dirname "$0")/../.."
export VIDEO_REMAKE_AGENT_CONFIG="${VIDEO_REMAKE_AGENT_CONFIG:-$PWD/examples/reproduction-smoke/agent-runtime.json}"
export VIDEO_REMAKE_REPRO_WORKFLOW="${VIDEO_REMAKE_REPRO_WORKFLOW:-$PWD/examples/reproduction-smoke/workflow.json}"
smoke_name="${REPRO_TEST_NAME:-dashboard-smoke-$(date +%Y%m%d-%H%M%S)}"
teacher="${smoke_name}-teacher"
student="${smoke_name}-student"
active_production=""
report_failure() {
    failure_code=$?
    trap - ERR
    if [[ -n "$active_production" ]]; then
        node cli/remake.js repro:status "$active_production" --json || true
    fi
    printf '%s\n' '流程已停止。根据状态选择 repro:render、repro:repair、repro:recover 或 repro:retry；说明见 examples/reproduction-smoke/README.md。' >&2
    exit "$failure_code"
}
trap report_failure ERR
node cli/remake.js repro:doctor --check-login
node cli/remake.js start "${REPRO_REFERENCE_ID}" --as "$teacher"
active_production="$teacher"
node cli/remake.js repro:init "$teacher" --spec examples/reproduction-smoke/spec.json --inputs examples/reproduction-smoke/teacher-inputs.json
# Staged run: the host renders stage previews and the final film at submission; no separate render step.
node cli/remake.js repro:teacher "$teacher"
node cli/remake.js repro:check "$teacher" --evidence
node cli/remake.js repro:judge "$teacher"
node cli/remake.js repro:extract "$teacher" --name "$smoke_name" --version 1
node cli/remake.js repro:generate "${smoke_name}@1" --as "$student" --ref "${REPRO_REFERENCE_ID}" --spec examples/reproduction-smoke/spec.json --inputs examples/reproduction-smoke/student-inputs.json
active_production="$student"
node cli/remake.js repro:run "$student"
node cli/remake.js repro:check "$student" --evidence
node cli/remake.js repro:judge "$student"
# Native Harness process audit does not prove read isolation; preserve the result without auto-certifying it.
node cli/remake.js repro:status "$student" --json
