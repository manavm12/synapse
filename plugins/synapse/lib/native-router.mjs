import { AppToolsClient, appToolJson } from "./app-tools-client.mjs";
import {
  acceptProvisioning,
  acknowledgeMessage,
  getReservedDelivery,
  markNativeMutationIssued,
  markNativeMutationUncertain,
  retryRoutingMessage,
} from "./inbox.mjs";

export function selectProject(projects, projectRoot) {
  const project = projects.find((candidate) => candidate.path === projectRoot);
  if (!project) {
    throw new Error(`No saved Codex project exactly matches ${projectRoot}`);
  }
  if (typeof project.projectId !== "string" || project.projectId === "") {
    throw new Error(`Saved Codex project is missing its ID: ${projectRoot}`);
  }
  return project;
}

function taskTarget(project) {
  return {
    type: "project",
    projectId: project.projectId,
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
    markIssued = markNativeMutationIssued,
  } = {},
) {
  const client = createClient();
  let mutationIssued = false;
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
      delivery.channel.projectId !== project.projectId
    ) {
      throw new Error(
        `Channel ${delivery.channelId} belongs to another Codex project`,
      );
    }

    if (delivery.channel.threadId) {
      if (delivery.source === "cloud") {
        markIssued({
          jobId: delivery.jobId,
          deliveryId: delivery.deliveryId,
        });
        mutationIssued = true;
      }
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
        projectId: project.projectId,
      });
    }

    if (delivery.source === "cloud") {
      markIssued({
        jobId: delivery.jobId,
        deliveryId: delivery.deliveryId,
      });
      mutationIssued = true;
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
        projectId: project.projectId,
      });
    }
    if (!created.clientThreadId) {
      throw new Error("Codex did not return a temporary or permanent task ID");
    }
    return accept({
      jobId: delivery.jobId,
      deliveryId: delivery.deliveryId,
      clientThreadId: created.clientThreadId,
      projectId: project.projectId,
      hostId,
    });
  } catch (error) {
    if (mutationIssued) error.nativeMutationIssued = true;
    throw error;
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
    uncertain = markNativeMutationUncertain,
  } = {},
) {
  const delivery = load({ jobId, deliveryId });
  if (!delivery) return null;
  try {
    return await route(delivery, { ownerThreadId, turnId });
  } catch (error) {
    if (delivery.source === "cloud" && error.nativeMutationIssued === true) {
      uncertain({ jobId, deliveryId, error: error.message });
    } else {
      retry({ jobId, deliveryId, error: error.message });
    }
    throw error;
  }
}
