import { AppServerClient } from "./app-server-client.mjs";
import {
  acknowledgeMessage,
  bindChannelThread,
  getReservedDelivery,
  retryRoutingMessage,
} from "./inbox.mjs";
import { ensureChannelWorktree } from "./worktree.mjs";

const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

export function selectProject(projects, projectRoot) {
  const matches = projects.filter((project) =>
    project.roots?.some((root) => root.path === projectRoot),
  );
  if (matches.length === 0) {
    throw new Error(`No saved Codex project exactly matches ${projectRoot}`);
  }
  return (
    matches.find(
      (project) =>
        project.metadata?.createdBy !== "synapse-compatibility-probe",
    ) ?? matches[0]
  );
}

export function threadHasDeliveryMarker(threadResponse, markers) {
  const pending = [threadResponse];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (value.type === "userMessage") {
      const text = JSON.stringify(value.content ?? value);
      if (markers.some((marker) => text.includes(marker))) return true;
      continue;
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) pending.push(...child);
      else if (child && typeof child === "object") pending.push(child);
    }
  }
  return false;
}

async function listAll(client, method, params = {}) {
  const data = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await client.request(method, {
      ...params,
      cursor,
      limit: PAGE_LIMIT,
    });
    data.push(...(response?.data ?? []));
    if (!response?.nextCursor) return data;
    cursor = response.nextCursor;
  }
  throw new Error(`${method} exceeded ${MAX_PAGES} pages`);
}

function queuedMessageId(deliveryId) {
  return `synapse-${deliveryId}`;
}

export async function routeDelivery(
  delivery,
  {
    createClient = () => new AppServerClient(),
    createWorktree = ensureChannelWorktree,
    bindThread = bindChannelThread,
    acknowledge = acknowledgeMessage,
  } = {},
) {
  const client = createClient();
  try {
    await client.start();
    const projects = await listAll(client, "project/list");
    const project = selectProject(projects, delivery.projectRoot);
    if (
      delivery.channel.projectId &&
      delivery.channel.projectId !== project.id
    ) {
      throw new Error(
        `Channel ${delivery.channelId} belongs to another Codex project`,
      );
    }

    let threadId = delivery.channel.threadId;
    if (!threadId) {
      const worktree = await createWorktree({
        projectRoot: delivery.projectRoot,
        channelId: delivery.channelId,
      });
      const started = await client.request("thread/start", {
        cwd: worktree.path,
        projectId: project.id,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        serviceName: "synapse",
        ephemeral: false,
      });
      threadId = started?.thread?.id;
      if (!threadId)
        throw new Error("Codex did not return a permanent task ID");
      bindThread({
        jobId: delivery.jobId,
        deliveryId: delivery.deliveryId,
        threadId,
        projectId: project.id,
        hostId: "local",
      });
      await client.request("thread/name/set", {
        threadId,
        name: `Synapse: ${delivery.channelId}`,
      });
    }

    const existing = await client.request("thread/read", {
      threadId,
      includeTurns: true,
    });
    if (!threadHasDeliveryMarker(existing, delivery.dedupeMarkers)) {
      const clientUserMessageId = queuedMessageId(delivery.deliveryId);
      const queued = await listAll(client, "thread/queue/list", { threadId });
      let submission = queued.find(
        (candidate) => candidate.clientUserMessageId === clientUserMessageId,
      );
      if (!submission) {
        const response = await client.request("thread/queue/add", {
          threadId,
          clientUserMessageId,
          input: [
            {
              type: "text",
              text: delivery.nativePrompt,
              text_elements: [],
            },
          ],
        });
        submission = response?.queuedSubmission;
      }
      if (!submission?.id) {
        throw new Error("Codex did not persist the queued task message");
      }
    }

    return acknowledge({
      jobId: delivery.jobId,
      deliveryId: delivery.deliveryId,
      threadId,
      hostId: "local",
      projectId: project.id,
    });
  } finally {
    await client.close();
  }
}

export async function runReservedDelivery(
  { jobId, deliveryId },
  {
    load = getReservedDelivery,
    route = routeDelivery,
    retry = retryRoutingMessage,
  } = {},
) {
  const delivery = load({ jobId, deliveryId });
  if (!delivery) return null;
  try {
    return await route(delivery);
  } catch (error) {
    retry({ jobId, deliveryId, error: error.message });
    throw error;
  }
}
