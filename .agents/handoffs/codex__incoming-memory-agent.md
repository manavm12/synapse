# Handoff: incoming message memory agent

- Branch: `codex/incoming-memory-agent`
- Human owner: `Manav Mehta`
- Active agent: `Codex`
- Base reviewed: `da0363a2a1768b47875c58759134ae24421534bf`
- Last checkpoint: `uncommitted`
- Status: `ready-for-review`

## Goal

Implement model-directed memory navigation and recipient prompt enrichment in the existing messaging path, with compact tests and no restored experiment fixtures.

## File ownership

- New message-memory server module, worker entry, and migration.
- Existing retrieval service/source reader/output schema, shared inference adapter, and boolean support in the core JSON validator.
- Receiver HTTP/database adapter, native routing and local prompt persistence.
- Focused tests and retrieval documentation; this handoff.
- Inspected all active remote workstreams: remaining organizer branches own rollout documentation only; messaging/Windows implementation branches are merged. No overlap.

## Decisions and invariants

- Recipient scope comes from stored message and current authenticated installation.
- Model selects bounded read actions and evidence IDs; code verifies evidence.
- Inference runs outside HTTP requests and database transactions; sender acknowledgement is independent.
- Preserve message identity, ordering, native attempt fencing and retry prompts.

## Completed

- Implemented bounded model-selected search/topic/read/source actions using the existing retrieval service and shared Responses adapter.
- Added message-specific authenticated context scheduling and a separate inference worker, with recipient-derived scope and one durable attempt per message.
- Added verified context to both native routes and atomically froze prompts with native attempts (SQLite 5).
- Compact tests cover real core graph navigation, source offsets, scope isolation, deadlines, stale generation, duplicate requests, revocation, and real PostgreSQL/native-double delivery. No experiment fixtures restored.

## Verification

- Clean Linux/container `npm run check` with disposable PostgreSQL: 314 passed, zero failed/skipped; coverage 96.18% lines, 87.44% branches, 94.55% functions.
- `npm run audit`: zero vulnerabilities; plugin validation and production Docker build passed. Disabled worker startup passed locally and in the image.
- Shared Responses adapter tested with strict retrieval JSON and trusted instructions using mocked HTTP. Model and native desktop calls are test doubles; no new API spending or production changes.
- Check logs are local `/tmp/synapse-incoming-memory-verified.log`; source build image `synapse-incoming-memory:check`.

## Remaining work

1. Review the focused draft PR and pass CI.
2. Production rollout is separate: deploy migration/backend, configure the isolated context worker, refresh receivers, and perform a controlled live two-account test.

## Risks or blockers

- Production activation and live two-account acceptance will require deployed migration, worker configuration and refreshed receiver.
