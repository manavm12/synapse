import { AppToolsClient, appToolJson } from "./app-tools-client.mjs";
import {
  acceptProvisioning,
  acknowledgeMessage,
  getReservedDelivery,
  retryRoutingMessage,
} from "./inbox.mjs";

export function selectProject(projects, projectRoot) {
  const project = projects.find((candidate) => candidate.path === projectRoot);
  if (!project) {
    throw new Error(`No saved Codex project exactly matches ${projectRoot}`);
  }
  return project;
}

function taskTarget(project) {
  return {
    type: "project",
    projectId: project.id,
    environment: project.isGitRepository
      ? {
          type: "worktree",
          startingState: { type: "working-tree" },
        }
      : { type: "local" },
  };
}

export async function routeDelivery(
  delivery,
  {
    ownerThreadId,
    turnId,
    createClient = () => new AppToolsClient(),
    accept = acceptProvisioning,
    acknowledge = acknowledgeMessage,
  } = {},
) {
  const client = createClient();
  try {
    await client.start();
    const listed = appToolJson(
      await client.callTool(
        "list_projects",
        {},
        {
          threadId: ownerThreadId,
          turnId,
        },
      ),
    );
    const project = selectProject(listed.projects ?? [], delivery.projectRoot);
    if (
      delivery.channel.projectId &&
      delivery.channel.projectId !== project.id
    ) {
      throw new Error(
        `Channel ${delivery.channelId} belongs to another Codex project`,
      );
    }

    if (delivery.channel.threadId) {
      await client.callTool(
        "send_message_to_thread",
        {
          threadId: delivery.channel.threadId,
          hostId: delivery.channel.hostId ?? "local",
          prompt: delivery.nativePrompt,
        },
        { threadId: ownerThreadId, turnId },
      );
      return acknowledge({
        jobId: delivery.jobId,
        deliveryId: delivery.deliveryId,
        threadId: delivery.channel.threadId,
        hostId: delivery.channel.hostId ?? "local",
        projectId: project.id,
      });
    }

    const created = appToolJson(
      await client.callTool(
        "create_thread",
        {
          prompt: delivery.nativePrompt,
          title: `Synapse: ${delivery.channelId}`,
          target: taskTarget(project),
        },
        { threadId: ownerThreadId, turnId },
      ),
    );
    const hostId = created.hostId ?? "local";
    if (created.threadId) {
      return acknowledge({
        jobId: delivery.jobId,
        deliveryId: delivery.deliveryId,
        threadId: created.threadId,
        hostId,
        projectId: project.id,
      });
    }
    if (!created.clientThreadId) {
      throw new Error("Codex did not return a temporary or permanent task ID");
    }
    return accept({
      jobId: delivery.jobId,
      deliveryId: delivery.deliveryId,
      clientThreadId: created.clientThreadId,
      projectId: project.id,
      hostId,
    });
  } finally {
    await client.close();
  }
}

export async function runReservedDelivery(
  { jobId, deliveryId, ownerThreadId, turnId },
  {
    load = getReservedDelivery,
    route = routeDelivery,
    retry = retryRoutingMessage,
  } = {},
) {
  const delivery = load({ jobId, deliveryId });
  if (!delivery) return null;
  try {
    return await route(delivery, { ownerThreadId, turnId });
  } catch (error) {
    retry({ jobId, deliveryId, error: error.message });
    throw error;
  }
}
