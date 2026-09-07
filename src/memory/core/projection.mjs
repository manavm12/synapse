import { currentClaims } from "./ledger.mjs";
import { hash } from "./source.mjs";

const slug = (text) =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 55) || "memory";
const topicId = (name) => `topic:${slug(name)}-${hash(name).slice(0, 6)}`;

export const PROJECTION_VERSION = "bounded-subtopic-bundles-v1";

export function deriveTopicProjection(ledger) {
  const current = currentClaims(ledger);
  const claimsById = new Map(ledger.claims.map((claim) => [claim.id, claim]));
  const groups = new Map();
  const topics = new Map([
    [
      "root",
      {
        id: "root",
        parentId: "",
        title: "Project memory",
        summary: "Evidence-backed claim views",
        index: "",
      },
    ],
  ]);
  const childCounts = new Map();
  for (const claim of current) {
    if (claim.subtopic && claim.subtopic !== claim.topic) {
      const key = `${claim.topic}\u0000${claim.subtopic}`;
      childCounts.set(key, (childCounts.get(key) ?? 0) + 1);
    }
  }
  const claimToItem = new Map();
  const bundleIndex = new Map();
  for (const claim of current) {
    const parent = topicId(claim.topic);
    topics.set(parent, {
      id: parent,
      parentId: "root",
      title: claim.topic,
      summary: "Current supported claims",
      index: "",
    });
    let primary = parent;
    const childKey = `${claim.topic}\u0000${claim.subtopic}`;
    if ((childCounts.get(childKey) ?? 0) >= 2) {
      primary = topicId(childKey);
      topics.set(primary, {
        id: primary,
        parentId: parent,
        title: claim.subtopic,
        summary: "Related claim details",
        index: "",
      });
    }
    const subject =
      primary !== parent ? `${claim.topic} / ${claim.subtopic}` : claim.subject;
    const baseKey = `${primary}\u0000${subject}\u0000${claim.scope}`;
    let index = bundleIndex.get(baseKey) ?? 0;
    let key = `${baseKey}\u0000${index}`;
    const size = claim.title.length + claim.assertion.length;
    if (
      groups.has(key) &&
      (groups.get(key).claims.length >= 8 ||
        groups.get(key).characters + size > 3000)
    ) {
      index++;
      bundleIndex.set(baseKey, index);
      key = `${baseKey}\u0000${index}`;
    }
    if (!groups.has(key))
      groups.set(key, {
        key,
        primary,
        subject,
        scope: claim.scope,
        claims: [],
        characters: 0,
      });
    groups.get(key).claims.push(claim);
    groups.get(key).characters += size;
  }
  const items = [...groups.values()].map((group) => {
    const id = `item:${hash(group.key).slice(0, 24)}`;
    const lines = [];
    const evidence = [];
    const claimIds = [];
    for (const claim of group.claims) {
      claimToItem.set(claim.id, id);
      claimIds.push(claim.id);
      const prefix =
        claim.state === "disputed"
          ? "DISPUTED observation"
          : claim.state === "resolved"
            ? "RESOLVED question"
            : "Current claim";
      lines.push(`${prefix} — ${claim.title}: ${claim.assertion}`);
      evidence.push(...claim.evidence);
      if (claim.answeredBy) {
        lines.push(`Answer: ${claimsById.get(claim.answeredBy).assertion}`);
        evidence.push(...claimsById.get(claim.answeredBy).evidence);
      }
      const seenHistory = new Set();
      const appendHistory = (claimId) => {
        for (const relation of ledger.relations.filter(
          (entry) => entry.type === "supersedes" && entry.from === claimId,
        )) {
          if (seenHistory.has(relation.to)) continue;
          seenHistory.add(relation.to);
          const old = claimsById.get(relation.to);
          lines.push(`Historical, superseded (not current): ${old.assertion}`);
          evidence.push(...old.evidence);
          appendHistory(old.id);
        }
      };
      appendHistory(claim.id);
      for (const relation of ledger.relations.filter(
        (entry) => entry.type === "equivalent" && entry.to === claim.id,
      ))
        evidence.push(...claimsById.get(relation.from).evidence);
    }
    return {
      id,
      key: hash(group.key).slice(0, 32),
      kind: group.claims.every((claim) => claim.kind === "open_question")
        ? "open_question"
        : "fact",
      primary: group.primary,
      secondary: [],
      claimIds,
      versions: [
        {
          version: ledger.version,
          title: `${group.subject} [${group.scope}]`,
          body: lines.join("\n\n"),
          status: group.claims.every((claim) => claim.state === "resolved")
            ? "resolved"
            : group.claims.every((claim) => claim.state === "disputed")
              ? "disputed"
              : "active",
          observedAt:
            group.claims
              .map((claim) => claim.observedAt)
              .filter(Boolean)
              .sort()
              .at(-1) ?? null,
          evidence: [
            ...new Map(
              evidence.map((entry) => [entry.segmentId, entry]),
            ).values(),
          ],
          replacedBy: null,
        },
      ],
    };
  });
  const edges = ledger.relations.flatMap((relation) => {
    if (!["conflicts", "resolves"].includes(relation.type)) return [];
    const from = claimToItem.get(relation.from);
    const to = claimToItem.get(relation.to);
    if (!from || !to || from === to) return [];
    return [
      {
        id: relation.id,
        from,
        to,
        type: relation.type === "conflicts" ? "contradicts" : "supports",
        reason: relation.reason,
        relationId: relation.id,
      },
    ];
  });
  for (const topic of topics.values()) {
    const children = [...topics.values()].filter(
      (child) => child.parentId === topic.id,
    );
    const notes = items.filter((item) => item.primary === topic.id);
    topic.index = [
      `# ${topic.title}`,
      ...children.map((child) => `- ${child.title}`),
      ...notes.map((note) => `- ${note.versions[0].title}`),
    ].join("\n");
  }
  return {
    schemaVersion: 2,
    projectionVersion: PROJECTION_VERSION,
    ledgerVersion: ledger.version,
    topics: [...topics.values()],
    items,
    edges,
  };
}
