import { isDeepStrictEqual } from "node:util";
import { CORE_VERSION } from "./contracts.mjs";
import { applyTransaction, validateLedger } from "./ledger.mjs";
import { deriveTopicProjection } from "./projection.mjs";
import { normalizeSourceEnvelope } from "./source.mjs";

export {
  CORE_VERSION,
  extractionSchema,
  reconciliationSchema,
} from "./contracts.mjs";
export {
  currentClaims,
  emptyLedger,
  evidenceContextFor,
  validateExtraction,
  validateLedger,
} from "./ledger.mjs";
export { deriveTopicProjection, PROJECTION_VERSION } from "./projection.mjs";
export { normalizeSourceEnvelope, segmentsFor } from "./source.mjs";

const additions = (before, after, key) => after[key].slice(before[key].length);

export function prepareMemoryChangeSet({
  ledger,
  envelope,
  expectedIdentity,
  extraction,
  reconciliation,
  recordedAt,
}) {
  validateLedger(ledger);
  const source = normalizeSourceEnvelope(envelope, expectedIdentity);
  const nextLedger = applyTransaction(
    ledger,
    source,
    extraction,
    reconciliation,
    recordedAt,
  );
  return {
    coreVersion: CORE_VERSION,
    ownerId: source.ownerId,
    projectId: source.projectId,
    revisionId: source.revisionId,
    expectedLedgerVersion: ledger.version,
    nextLedgerVersion: nextLedger.version,
    proposal: structuredClone({ extraction, reconciliation, recordedAt }),
    source,
    append: {
      sources: additions(ledger, nextLedger, "sources"),
      claims: additions(ledger, nextLedger, "claims"),
      relations: additions(ledger, nextLedger, "relations"),
      coverage: additions(ledger, nextLedger, "coverage"),
    },
    projection: deriveTopicProjection(nextLedger),
  };
}

export function applyMemoryChangeSet(ledger, changeSet) {
  validateLedger(ledger);
  if (changeSet.coreVersion !== CORE_VERSION)
    throw new Error("Unsupported core change set");
  if (
    changeSet.ownerId !== ledger.ownerId ||
    changeSet.projectId !== ledger.projectId
  )
    throw new Error("Change set identity does not match ledger");
  if (
    changeSet.expectedLedgerVersion !== ledger.version ||
    changeSet.nextLedgerVersion !== ledger.version + 1
  )
    throw new Error("Change set ledger version is stale");
  if (
    changeSet.source.revisionId !== changeSet.revisionId ||
    changeSet.append.sources.length !== 1 ||
    changeSet.append.sources[0].revisionId !== changeSet.revisionId
  )
    throw new Error("Change set source identity is inconsistent");
  const normalizedSource = normalizeSourceEnvelope(changeSet.source, {
    ownerId: ledger.ownerId,
    projectId: ledger.projectId,
  });
  if (
    normalizedSource.contentHash !== changeSet.source.contentHash ||
    normalizedSource.contentHash !== changeSet.append.sources[0].contentHash
  )
    throw new Error("Change set source bytes do not match its content hash");
  const expectedSourceRecord = {
    revisionId: normalizedSource.revisionId,
    nodeId: normalizedSource.nodeId,
    sessionId: normalizedSource.sessionId,
    revision: normalizedSource.revision,
    captureId: normalizedSource.captureId,
    capturedAt: normalizedSource.capturedAt,
    contentHash: normalizedSource.contentHash,
  };
  if (
    JSON.stringify(changeSet.append.sources[0]) !==
    JSON.stringify(expectedSourceRecord)
  )
    throw new Error("Change set source metadata is inconsistent");
  for (const key of ["claims", "relations", "coverage"])
    if (
      changeSet.append[key].some(
        (entry) => entry.sourceId !== changeSet.revisionId,
      )
    )
      throw new Error(`Change set ${key} contains a different source revision`);
  if (!changeSet.proposal)
    throw new Error("Change set proposal is required for replay");
  const expected = prepareMemoryChangeSet({
    ledger,
    envelope: normalizedSource,
    expectedIdentity: { ownerId: ledger.ownerId, projectId: ledger.projectId },
    extraction: changeSet.proposal.extraction,
    reconciliation: changeSet.proposal.reconciliation,
    recordedAt: changeSet.proposal.recordedAt,
  });
  if (!isDeepStrictEqual(changeSet.append, expected.append))
    throw new Error(
      "Change set entries do not match source-backed proposal replay",
    );
  const next = structuredClone(ledger);
  next.sources.push(...structuredClone(changeSet.append.sources));
  next.claims.push(...structuredClone(changeSet.append.claims));
  next.relations.push(...structuredClone(changeSet.append.relations));
  next.coverage.push(...structuredClone(changeSet.append.coverage));
  next.version = changeSet.nextLedgerVersion;
  validateLedger(next);
  if (
    JSON.stringify(deriveTopicProjection(next)) !==
    JSON.stringify(changeSet.projection)
  )
    throw new Error("Change set projection does not replay deterministically");
  return next;
}
