# Handoff: production organizer activation

- Branch: `codex/organizer-rollout-verified`
- Human owner: `Manav Mehta`
- Active agent: `Codex`
- Base reviewed: `5caaf78736f5ce15939a9e51abbfc99304642540`
- Last checkpoint: `5caaf78736f5ce15939a9e51abbfc99304642540` (merged PR16)
- Status: `active`

## Goal

Complete the authorized production organizer rollout, verify durable retrieval and
reconciliation, drain historical captures, and enable continuous processing.

## File ownership

- `docs/cloud-memory-operations.md`
- `docs/memory-organizer-activation-plan.md`
- This branch-specific handoff.
- Any further runtime fix requires updating this ownership after checking active branches.

## Completed

- PR16 merged as the base above. Required CI, database, and secrets checks passed.
  Automated review was still pending, with no comments or submitted reviews at merge.
- Live no-write diagnostic passed extraction (22 claims) and independent review.
- Disabled Railway worker deployment `1f34d9cf-9df3-4513-b340-8d871b7485f7`
  succeeded; HTTP readiness stayed healthy.
- Started exact-revision canary deployment `f5739d4e-e4f1-4d6a-aaa8-c70145071673`
  pinned to PR16, one attempt, restart NEVER. The future service command was
  restored to `npm run worker`; the service-level enable flag remains false.
- Latest read-only database snapshot: 19 pending jobs, ledger generation zero;
  original job had two attempts before this canary.
- Re-read the updated Windows workstream handoff; no file overlap with this scope.

## Decisions and invariants

- User approved continuing until the organizer works, including deploy/merge.
- Keep gpt-5-nano, mandatory review, verified TLS, dedicated DB role, queue attempt
  history, source evidence, owner/project fencing, and atomic commits.
- Never log credentials or raw model proposals, reset queues, or change RLS.
- Worker settings: 32000 output tokens, 180-second requests, two calls per stage.
- No unrelated migrations or HTTP service configuration changes.

## Verification

- PR16 full local check with fresh PostgreSQL: passed, zero skipped; audit clean.
- Docker build and disabled startup: passed.
- Live canary outcome and retrieval verification pending.

## Remaining work

1. Inspect exact canary outcome and committed source/audit/projection via SQL and MCP.
2. Exercise reconciliation with a small bounded production batch, investigate failures.
3. Drain remaining history, enable continuous mode, verify fresh queued captures.
4. Record final production state and push a documentation checkpoint/PR.

## Risks or blockers

- Production has not yet been proven to commit a graph result.
- Prior extraction validation failed intermittently; new enum constraints passed locally.
- Keep continuous processing disabled until bounded verification succeeds.
