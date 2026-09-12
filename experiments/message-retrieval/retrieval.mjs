import { readFileSync } from "node:fs";
import {
  currentClaims,
  deriveTopicProjection,
  segmentsFor,
  validateLedger,
} from "../../src/memory/core/index.mjs";
import { createMemoryRetrievalService } from "../../src/server/memory-retrieval/index.mjs";
import { hash } from "./corpus.mjs";

export function createRepository(input) {
  const corpus =
    typeof input === "string" ? JSON.parse(readFileSync(input, "utf8")) : input;
  const load = (identity) => {
    const project = corpus.projects.find(
      (p) =>
        p.identity.userId === identity.userId &&
        p.identity.projectId === identity.projectId,
    );
    if (!project) throw new Error("recipient_memory_unavailable");
    validateLedger(project.ledger);
    if (
      project.ledger.ownerId !== identity.userId ||
      project.ledger.projectId !== identity.projectId
    )
      throw new Error("tenant_mismatch");
    return project;
  };
  return { load };
}
const boundedQuery = (query) => {
  let result = "";
  for (const character of query) {
    if (
      Buffer.byteLength(result + character) > 512 ||
      result.length + character.length > 450
    )
      break;
    result += character;
  }
  return result;
};
const normalized = (text) => text.normalize("NFKC").toLowerCase();
const terms = (text) =>
  [
    ...new Set(
      normalized(text).match(/[\p{L}\p{N}][\p{L}\p{N}._:/-]*/gu) ?? [],
    ),
  ].slice(0, 32);
const cosine = (a, b) => {
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return dot / Math.sqrt(aa * bb || 1);
};
export function reciprocalRankFusion(lists, limit = 30) {
  const scores = new Map();
  for (const list of lists)
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + index + 1));
    });
  return [...scores]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map((x) => x[0]);
}
export function createView(repository, identity) {
  const project = repository.load(identity);
  const ledger = structuredClone(project.ledger),
    sources = structuredClone(project.sources);
  if (
    sources.some(
      (s) =>
        s.ownerId !== identity.userId || s.projectId !== identity.projectId,
    )
  )
    throw new Error("tenant_mismatch");
  const generation = ledger.version;
  const fingerprint = hash(ledger);
  const projection = deriveTopicProjection(ledger);
  const claims = currentClaims(ledger, { includeHistory: true });
  const claimsById = new Map(claims.map((c) => [c.id, c]));
  const sourceById = new Map(sources.map((s) => [s.revisionId, s]));
  const segments = sources.flatMap((s) => segmentsFor(s));
  const segmentById = new Map(segments.map((s) => [s.id, s]));
  const processed = new Set(ledger.sources.map((s) => s.revisionId));
  const service = createMemoryRetrievalService({
    adapter: {
      load: async (trusted) => {
        if (
          trusted.ownerId !== identity.userId ||
          trusted.projectId !== identity.projectId
        )
          throw new Error("tenant_mismatch");
        return { ledger, projection };
      },
    },
    sourceReader: {
      read: async (trusted) => {
        const source = sourceById.get(trusted.revisionId);
        if (
          source?.ownerId !== trusted.ownerId ||
          source?.projectId !== trusted.projectId
        )
          return null;
        return source;
      },
    },
  });
  function verify(evidence) {
    const source = sourceById.get(evidence.documentId);
    const canonical = ledger.sources.find(
      (s) => s.revisionId === evidence.documentId,
    );
    const segment = segmentById.get(evidence.segmentId);
    if (
      !source ||
      !segment ||
      segment.documentId !== source.revisionId ||
      evidence.start < segment.start ||
      evidence.end > segment.end ||
      source.ownerId !== identity.userId ||
      source.projectId !== identity.projectId ||
      hash(source.markdown) !== source.contentHash ||
      (canonical && canonical.contentHash !== source.contentHash) ||
      source.markdown.slice(evidence.start, evidence.end) !== evidence.quote
    )
      throw new Error("invalid_citation");
    return {
      revisionId: source.revisionId,
      segmentId: evidence.segmentId,
      start: evidence.start,
      end: evidence.end,
      quote: evidence.quote,
      contentHash: source.contentHash,
      capturedAt: source.capturedAt,
    };
  }
  function resolve(id) {
    const claim = claimsById.get(id);
    if (claim)
      return {
        id,
        type: "claim",
        assertion: claim.assertion,
        status: claim.state,
        scope: claim.scope,
        subject: claim.subject,
        citations: claim.evidence.slice(0, 2).map(verify),
        supports: [claim.id],
      };
    const segment = segmentById.get(id);
    if (!segment) throw new Error("unknown_evidence");
    const citation = verify({
      documentId: segment.documentId,
      segmentId: segment.id,
      start: segment.start,
      end: segment.end,
      quote: segment.text,
    });
    const supporting = claims.filter((c) =>
      c.evidence.some((e) => e.segmentId === id),
    );
    return {
      id,
      type: "source",
      assertion: segment.text,
      status: processed.has(segment.documentId) ? "source_only" : "unprocessed",
      scope: "source context; no current-policy inference",
      subject: sourceById.get(segment.documentId).title,
      citations: [citation],
      supports: [id, ...supporting.map((c) => c.id)],
    };
  }
  const describe = (id) => {
    const c = claimsById.get(id);
    if (c)
      return {
        id,
        title: c.title,
        assertion: c.assertion,
        status: c.state,
        scope: c.scope,
        topic: c.topic,
        subject: c.subject,
        aspect: c.aspect,
        kind: c.kind,
        relationships: relations(id),
      };
    const s = segmentById.get(id);
    return s
      ? {
          id,
          text: s.text,
          status: processed.has(s.documentId) ? "source_only" : "unprocessed",
        }
      : null;
  };
  async function search(query, { all = false } = {}) {
    let cursor;
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const page = await service.search(identity, {
        query: boundedQuery(query),
        status: all ? "all" : "current",
        limit: 10,
        evidence_limit: 0,
        ...(cursor ? { cursor } : {}),
      });
      ids.push(...page.results.map((c) => c.claim_id));
      cursor = page.next_cursor;
      if (!cursor) break;
    }
    return ids;
  }
  function searchSources(query) {
    const ts = terms(query);
    return segments
      .map((s) => ({
        id: s.id,
        score: ts.reduce(
          (n, t) => n + (normalized(s.text).includes(t) ? 1 : 0),
          0,
        ),
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, 20)
      .map((s) => s.id);
  }
  function relations(id) {
    if (!claimsById.has(id)) throw new Error("unknown_claim");
    return ledger.relations
      .filter((r) => r.from === id || r.to === id)
      .slice(0, 12)
      .map((r) => ({ type: r.type, from: r.from, to: r.to }));
  }
  function companions(id) {
    return relations(id)
      .filter(
        (r) =>
          r.type === "conflicts" || (r.type === "supersedes" && r.to === id),
      )
      .map((r) => (r.from === id ? r.to : r.from));
  }
  return {
    identity,
    generation,
    fingerprint,
    claims,
    projection,
    service,
    search,
    searchSources,
    relations,
    describe,
    resolve,
    companions,
    unchanged: () => hash(repository.load(identity).ledger) === fingerprint,
    read: async (id) => {
      if (claimsById.has(id) || segmentById.has(id)) return [describe(id)];
      const note = projection.items.find((n) => n.id === id);
      if (!note) throw new Error("unknown_record");
      return note.claimIds.map(describe);
    },
    topics: async (id) =>
      service.topics(identity, { topic_id: id || "root", limit: 20 }),
  };
}

export async function buildSemanticIndex(view, provider, signal) {
  const items = view.claims.map((c) => ({
    id: c.id,
    text: [c.subject, c.aspect, c.scope, c.assertion, c.topic, c.state].join(
      "\n",
    ),
  }));
  const vectors = await provider.embed(
    items.map((x) => x.text),
    { signal },
  );
  return {
    fingerprint: view.fingerprint,
    identity: view.identity,
    items,
    vectors,
  };
}
export function createHybridSearch(view, provider, index, signal) {
  if (
    index.fingerprint !== view.fingerprint ||
    index.identity.userId !== view.identity.userId ||
    index.identity.projectId !== view.identity.projectId
  )
    throw new Error("stale_or_foreign_index");
  return async (query) => {
    const lexical = await view.search(query, { all: true });
    const [vector] = await provider.embed([query], { signal });
    const semantic = index.items
      .map((item, i) => ({
        id: item.id,
        score: cosine(vector, index.vectors[i]),
      }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, 20)
      .map((x) => x.id);
    return reciprocalRankFusion([lexical, semantic]);
  };
}
