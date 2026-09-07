import { extractionSchema, reconciliationSchema } from "./contracts.mjs";
import { validateSchema } from "./schema.mjs";
import { hash, segmentsFor, validateIdentity } from "./source.mjs";

export const emptyLedger = (identity) => {
  validateIdentity(identity, "Ledger identity");
  return {
    schemaVersion: 2,
    ownerId: identity.ownerId,
    projectId: identity.projectId,
    version: 0,
    sources: [],
    claims: [],
    relations: [],
    coverage: [],
  };
};

const nonempty = (value, label) => {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must not be empty`);
};
const normalized = (value) =>
  value.trim().toLowerCase().replaceAll(/\s+/g, " ");

export function currentClaims(ledger, { includeHistory = false } = {}) {
  const duplicates = new Map(
    ledger.relations
      .filter((relation) => relation.type === "equivalent")
      .map((relation) => [relation.from, relation.to]),
  );
  const retired = new Map(
    ledger.relations
      .filter((relation) => relation.type === "supersedes")
      .map((relation) => [relation.to, relation.from]),
  );
  const answered = new Map(
    ledger.relations
      .filter((relation) => relation.type === "resolves")
      .map((relation) => [relation.to, relation.from]),
  );
  const disputed = new Set(
    ledger.relations
      .filter((relation) => relation.type === "conflicts")
      .map((relation) => relation.from),
  );
  const canonical = (id) => {
    const seen = new Set();
    let cursor = id;
    while (duplicates.has(cursor) || retired.has(cursor)) {
      if (seen.has(cursor)) throw new Error("Claim retirement cycle");
      seen.add(cursor);
      cursor = duplicates.get(cursor) ?? retired.get(cursor);
    }
    return cursor;
  };
  return ledger.claims
    .map((claim) => ({
      ...claim,
      state: duplicates.has(claim.id)
        ? "equivalent"
        : retired.has(claim.id)
          ? "superseded"
          : answered.has(claim.id)
            ? "resolved"
            : disputed.has(claim.id)
              ? "disputed"
              : claim.status,
      canonicalId: canonical(claim.id),
      replacedBy: retired.get(claim.id) ?? null,
      answeredBy: answered.has(claim.id)
        ? canonical(answered.get(claim.id))
        : null,
    }))
    .filter(
      (claim) =>
        includeHistory ||
        !["equivalent", "superseded", "historical"].includes(claim.state),
    );
}

export function evidenceContextFor(ledger) {
  const entries = currentClaims(ledger).flatMap((claim) => claim.evidence);
  return [
    ...new Map(
      entries.map((entry) => [
        entry.segmentId,
        {
          id: entry.segmentId,
          section: "Earlier accepted evidence",
          text: entry.quote,
          start: entry.start,
          end: entry.end,
          documentId: entry.documentId,
        },
      ]),
    ).values(),
  ];
}

export function validateExtraction(source, extraction, ledger) {
  validateSchema(extraction, extractionSchema);
  const segments = segmentsFor(source);
  const currentIds = new Set(segments.map((segment) => segment.id));
  const known = new Map(
    [...segments, ...evidenceContextFor(ledger)].map((segment) => [
      segment.id,
      segment,
    ]),
  );
  const refs = new Set();
  const cited = new Set();
  for (const claim of extraction.claims) {
    if (!/^c[1-9]\d*$/.test(claim.ref) || refs.has(claim.ref))
      throw new Error("Claim refs must be unique c1, c2, etc");
    refs.add(claim.ref);
    for (const key of [
      "subject",
      "aspect",
      "scope",
      "title",
      "assertion",
      "topic",
    ])
      nonempty(claim[key], key);
    if (
      !claim.evidence.length ||
      new Set(claim.evidence).size !== claim.evidence.length
    )
      throw new Error("Each claim needs unique evidence segment IDs");
    for (const id of claim.evidence) {
      if (!known.has(id)) throw new Error(`Unknown evidence segment ${id}`);
      if (currentIds.has(id)) cited.add(id);
    }
    if (!claim.evidence.some((id) => currentIds.has(id)))
      throw new Error(
        "A new claim must cite its current source, not only previous context",
      );
  }
  const seen = new Set();
  for (const entry of extraction.coverage) {
    if (!currentIds.has(entry.segmentId) || seen.has(entry.segmentId))
      throw new Error("Unknown or duplicate coverage segment");
    seen.add(entry.segmentId);
    nonempty(entry.reason, "Coverage reason");
    if ((entry.disposition === "claims") !== cited.has(entry.segmentId))
      throw new Error("Coverage disposition disagrees with claim evidence");
  }
  if (seen.size !== currentIds.size)
    throw new Error("Every source segment requires a coverage disposition");
  return segments;
}

export function applyTransaction(
  current,
  source,
  extraction,
  plan,
  recordedAt,
) {
  validateLedger(current);
  if (
    current.ownerId !== source.ownerId ||
    current.projectId !== source.projectId
  )
    throw new Error("Source identity does not match ledger owner and project");
  if (
    current.sources.some(
      (entry) =>
        entry.revisionId === source.revisionId ||
        (entry.sessionId === source.sessionId &&
          entry.revision === source.revision),
    )
  )
    throw new Error("Source revision was already projected");
  nonempty(recordedAt, "recordedAt");
  if (!Number.isFinite(Date.parse(recordedAt)))
    throw new Error("recordedAt must be a timestamp");
  const segments = validateExtraction(source, extraction, current);
  validateSchema(plan, reconciliationSchema);
  const ledger = structuredClone(current);
  const old = new Map(ledger.claims.map((claim) => [claim.id, claim]));
  const liveStates = new Map(
    currentClaims(current).map((claim) => [claim.id, claim.state]),
  );
  const live = new Set(liveStates.keys());
  const finishedTargets = new Set(
    plan.actions
      .filter((action) => ["replaces", "resolves"].includes(action.action))
      .flatMap((action) => action.targets),
  );
  const knownSegments = new Map(
    [...segments, ...evidenceContextFor(current)].map((segment) => [
      segment.id,
      segment,
    ]),
  );
  const incoming = new Map();
  for (const claim of extraction.claims) {
    const id = `claim:${hash(`${source.revisionId}:${claim.ref}`).slice(0, 24)}`;
    if (old.has(id)) throw new Error("Source revision was already projected");
    incoming.set(claim.ref, {
      ...claim,
      id,
      subject: normalized(claim.subject),
      aspect: normalized(claim.aspect),
      scope: normalized(claim.scope),
      sourceId: source.revisionId,
      observedAt: source.capturedAt,
      recordedAt,
      evidence: claim.evidence.map((id) => {
        const segment = knownSegments.get(id);
        return {
          segmentId: id,
          documentId: segment.documentId,
          start: segment.start,
          end: segment.end,
          quote: segment.text,
        };
      }),
    });
  }
  const seen = new Set();
  const retiredHere = new Set();
  for (const action of plan.actions) {
    const claim = incoming.get(action.ref);
    if (!claim || seen.has(action.ref))
      throw new Error("Every action needs a unique incoming ref");
    seen.add(action.ref);
    nonempty(action.reason, "Action reason");
    if (action.action === "add" && action.targets.length)
      throw new Error("Add cannot target old claims");
    if (action.action !== "add" && !action.targets.length)
      throw new Error("Reconciliation action requires targets");
    if (
      ["equivalent", "replaced_by"].includes(action.action) &&
      action.targets.length !== 1
    )
      throw new Error("Equivalence/historical action needs one target");
    if (new Set(action.targets).size !== action.targets.length)
      throw new Error("Duplicate target");
    for (const targetId of action.targets) {
      const target = old.get(targetId);
      if (!target || !live.has(targetId))
        throw new Error(`Target must be an existing live claim: ${targetId}`);
      const clarifiesScope =
        (action.action === "replaces" && target.scope === "unqualified") ||
        (action.action === "replaced_by" && claim.scope === "unqualified");
      if (target.scope !== claim.scope && !clarifiesScope)
        throw new Error(
          `Cannot ${action.action} across scopes: ${target.scope} / ${claim.scope}`,
        );
      if (action.action === "resolves" && target.kind !== "open_question")
        throw new Error("Only an open question may be resolved");
      if (action.action === "resolves") {
        if (target.subject !== claim.subject || target.aspect !== claim.aspect)
          throw new Error(
            "Resolution must match the question subject and aspect",
          );
        if (
          liveStates.get(targetId) === "resolved" ||
          retiredHere.has(targetId)
        )
          throw new Error("A question cannot have multiple accepted answers");
        retiredHere.add(targetId);
      }
      const historicalRecap =
        claim.status === "historical" &&
        (finishedTargets.has(targetId) ||
          liveStates.get(targetId) === "resolved");
      const disputedRecap =
        claim.status === "disputed" && liveStates.get(targetId) === "disputed";
      if (
        claim.status !== "active" &&
        (["replaces", "resolves"].includes(action.action) ||
          (action.action === "equivalent" &&
            !historicalRecap &&
            !disputedRecap))
      )
        throw new Error(
          `Non-active incoming claim ${claim.ref} cannot retire a current target`,
        );
      if (action.action === "replaces") {
        if (retiredHere.has(targetId))
          throw new Error(
            "A target cannot be replaced twice in one transaction",
          );
        retiredHere.add(targetId);
      }
      const currentTime = Date.parse(claim.observedAt);
      const targetTime = Date.parse(target.observedAt);
      if (action.action === "replaces" && currentTime < targetTime)
        throw new Error("An older source cannot replace a newer claim");
      if (action.action === "replaced_by" && currentTime > targetTime)
        throw new Error(
          "A newer source cannot be labeled replaced by an older claim",
        );
      let from = claim.id;
      let to = targetId;
      let type = action.action;
      if (action.action === "replaces") type = "supersedes";
      if (action.action === "replaced_by") {
        type = "supersedes";
        from = targetId;
        to = claim.id;
      }
      ledger.relations.push({
        id: `rel:${hash(`${from}:${type}:${to}`).slice(0, 24)}`,
        from,
        to,
        type,
        reason: action.reason,
        sourceId: source.revisionId,
        introducedIn: current.version + 1,
      });
    }
  }
  if (seen.size !== incoming.size)
    throw new Error("Every incoming claim must be reconciled");
  ledger.claims.push(...incoming.values());
  ledger.coverage.push(
    ...extraction.coverage.map((entry) => ({
      ...entry,
      sourceId: source.revisionId,
    })),
  );
  ledger.sources.push({
    revisionId: source.revisionId,
    nodeId: source.nodeId,
    sessionId: source.sessionId,
    revision: source.revision,
    captureId: source.captureId,
    capturedAt: source.capturedAt,
    contentHash: source.contentHash,
  });
  ledger.version++;
  validateLedger(ledger);
  return ledger;
}

export function validateLedger(ledger) {
  if (ledger?.schemaVersion !== 2) throw new Error("Unsupported ledger schema");
  validateIdentity(ledger, "Ledger identity");
  if (!Number.isSafeInteger(ledger.version) || ledger.version < 0)
    throw new Error("Invalid ledger version");
  if (
    !Array.isArray(ledger.sources) ||
    !Array.isArray(ledger.claims) ||
    !Array.isArray(ledger.relations) ||
    !Array.isArray(ledger.coverage)
  )
    throw new Error("Invalid ledger collections");
  const sourceIds = new Set();
  const sessionRevisions = new Set();
  for (const source of ledger.sources) {
    const sessionRevision = `${source.sessionId}\u0000${source.revision}`;
    if (
      sourceIds.has(source.revisionId) ||
      sessionRevisions.has(sessionRevision)
    )
      throw new Error("Duplicate source revision");
    sourceIds.add(source.revisionId);
    sessionRevisions.add(sessionRevision);
  }
  const ids = new Set(ledger.claims.map((claim) => claim.id));
  if (ids.size !== ledger.claims.length)
    throw new Error("Duplicate immutable claim ID");
  for (const claim of ledger.claims) {
    if (!sourceIds.has(claim.sourceId))
      throw new Error("Claim references an unknown source");
    if (!claim.evidence?.length) throw new Error("Claim lacks provenance");
    for (const evidence of claim.evidence) {
      if (
        typeof evidence.quote !== "string" ||
        !Number.isSafeInteger(evidence.start) ||
        !Number.isSafeInteger(evidence.end) ||
        evidence.start < 0 ||
        evidence.end < evidence.start ||
        evidence.end - evidence.start !== evidence.quote.length
      )
        throw new Error("Invalid evidence offsets");
      if (!sourceIds.has(evidence.documentId))
        throw new Error("Evidence references an unknown source");
    }
  }
  const seen = new Set();
  const successors = new Map();
  const answers = new Set();
  for (const relation of ledger.relations) {
    if (
      !ids.has(relation.from) ||
      !ids.has(relation.to) ||
      relation.from === relation.to ||
      seen.has(relation.id)
    )
      throw new Error("Invalid relation");
    if (
      !["equivalent", "supersedes", "resolves", "conflicts"].includes(
        relation.type,
      )
    )
      throw new Error("Invalid relation type");
    if (!sourceIds.has(relation.sourceId))
      throw new Error("Relation references an unknown source");
    seen.add(relation.id);
    if (relation.type === "resolves") {
      if (answers.has(relation.to))
        throw new Error("A question cannot have multiple accepted answers");
      answers.add(relation.to);
    }
    if (["supersedes", "equivalent"].includes(relation.type)) {
      const from = relation.type === "supersedes" ? relation.to : relation.from;
      const to = relation.type === "supersedes" ? relation.from : relation.to;
      if (successors.has(from) && successors.get(from) !== to)
        throw new Error("Ambiguous retirement");
      successors.set(from, to);
    }
  }
  for (const entry of ledger.coverage)
    if (!sourceIds.has(entry.sourceId))
      throw new Error("Coverage references an unknown source");
  for (const id of ids) {
    const visited = new Set();
    for (let next = id; next; next = successors.get(next)) {
      if (visited.has(next)) throw new Error("Claim retirement cycle");
      visited.add(next);
    }
  }
  return true;
}
