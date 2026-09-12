# Handoff: production organizer activation

- Branch: `codex/organizer-rollout-verified`
- Human owner: `Manav Mehta`
- Active agent: `Codex`
- Base reviewed: `bf48aeca50cf64c3c2737c89afafafeb714e6338`
- Last checkpoint: `72ba786` (merged tested PR19 into rollout branch)
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
- Original canary succeeded in 149 seconds: attempt three, one source, generation
  one, 13 notes. Authenticated topic, search, and note reads verified citations.
- Accepted audit: two extraction calls, one clean review, 10,209 input and 24,582
  output tokens on gpt-5-nano. Earlier failed/local calls are additional usage.
- Started three-attempt scoped batch `ad8836bd-b911-4b34-9a75-fbe44e8425af`;
  restored the future start command to disabled normal mode, restart NEVER.
- Re-read the updated Windows workstream handoff; no file overlap with this scope.
- Three-attempt batch finished with two successes, then stopped on `claim_refs`.
  Revision `44a45390-03f5-407f-8cee-6b2c91275918` remains pending with one attempt.
- PR19 fixes local claim-reference assignment; 250 tests, zero skips, audit and
  required CI passed. It merged as the current base above. Prior three sources
  remain unchanged: generation three, 79 claims, 56 notes, no missing jobs.
- Started exact-revision retry `2b4ad535-7910-4e97-98b9-f170db4e6a36`, one attempt
  and restart NEVER. Future service start command is restored to disabled normal mode.

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
- First live canary and authenticated note/evidence retrieval: passed.

## Remaining work

1. Inspect the active exact-revision retry, audit strategy and graph relationships.
2. Investigate failures without resetting queue attempts or weakening validation.
3. Drain remaining history, enable continuous mode, verify fresh queued captures.
4. Record final production state and push a documentation checkpoint/PR.

## Risks or blockers

- Production has committed the first source; reconciliation/backlog still unverified.
- Prior extraction validation failed intermittently; new enum constraints passed locally.
- Keep continuous processing disabled until bounded verification succeeds.
