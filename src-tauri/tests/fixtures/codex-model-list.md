Recorded locally on 2026-10-20 with codex-cli 0.163.0, using a short-lived
`codex app-server`: `initialize`, `initialized`, then `model/list` with
`{ "includeHidden": true, "limit": 100 }`. One page, 11 models, `nextCursor: null`.
The JSON is the complete response result, without the JSON-RPC envelope.
No inference turn was started.

Protocol confirmed locally with `codex app-server generate-ts --out <temp dir>`:
`v2/ModelListParams.ts` has optional `cursor`, `limit`, and `includeHidden`;
`v2/ModelListResponse.ts` has `data: Model[]` and `nextCursor: string | null`.
`Model` supplies `id`, `displayName`, `isDefault`, `hidden`, and
`supportedReasoningEfforts: { reasoningEffort, description }[]`.

Local `claude --help` exposes no model-list command, so Orbit uses the aliases
`opus`, `sonnet`, and `haiku` for Claude.
