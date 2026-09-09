import { AppToolsClient, appToolJson } from "./app-tools-client.mjs";
import {
  acceptProvisioning,
  acknowledgeMessage,
  getReservedDelivery,
  markNativeMutationIssued,
  markNativeMutationUncertain,
  retryRoutingMessage,
} from "./inbox.mjs";
import { ReceiverClient } from "./receiver-client.mjs";
import { validateReceiverIdentity } from "./receiver-contract.mjs";
import {
  getReceiverConnection,
  receiverRegistryPath,
  withReceiverAuthorization,
} from "./receiver-registry.mjs";
import { MacOsKeychainStore } from "./receiver-secrets.mjs";

function sameReceiverIdentity(expected, actual) {
  return (
    expected?.installationId === actual?.installationId &&
    expected?.userId === actual?.userId &&
    expected?.projectId === actual?.projectId &&
    expected?.projectAlias === actual?.projectAlias
  );
}

function allowInsecure(env) {
  return env.SYNAPSE_ALLOW_INSECURE_RECEIVER_HTTP === "1";
}

function connectionAuthorizes(connection, expected, now) {
  return (
    connection?.status === "connected" &&
    sameReceiverIdentity(expected, connection.identity) &&
    Date.parse(connection.identity.expiresAt) > now
  );
}

export async function authorizeCloudDelivery(
  delivery,
  {
    env = process.env,
    registryPath = receiverRegistryPath(env),
    secretStore = null,
    createReceiverClient = (options) => new ReceiverClient(options),
    now = Date.now,
    signal,
  } = {},
) {
  if (delivery.source !== "cloud") return null;
  const expected = delivery.receiverAuthorization;
  const connection = getReceiverConnection(delivery.projectRoot, {
    path: registryPath,
  });
  if (!expected || !connectionAuthorizes(connection, expected, now())) {
    throw new Error("Cloud receiver authorization is no longer current");
  }
  const credentials = secretStore ?? new MacOsKeychainStore();
  const credential = await credentials.get(connection.credentialAccount, {
    signal,
  });
  const client = createReceiverClient({
    serverUrl: connection.serverUrl,
    credential,
    allowInsecureHttp: allowInsecure(env),
    timeoutMs: 2_500,
    signal,
  });
  const response = await client.getIdentity();
  signal?.throwIfAborted();
  const fresh = validateReceiverIdentity(response.identity);
  if (
    !sameReceiverIdentity(expected, fresh) ||
    !(Date.parse(fresh.expiresAt) > now())
  ) {
    throw new Error("Cloud receiver authorization is no longer current");
  }
  const current = getReceiverConnection(delivery.projectRoot, {
    path: registryPath,
  });
  if (
    !connectionAuthorizes(current, expected, now()) ||
    current.connectionId !== connection.connectionId ||
    current.credentialAccount !== connection.credentialAccount ||
    current.serverUrl !== connection.serverUrl
  ) {
    throw new Error("Cloud receiver authorization is no longer current");
  }
  return fresh;
}

export function selectProject(projects, projectRoot) {
  const project = projects.find(
    (candidate) =>
      candidate.path === projectRoot &&
      (candidate.hostId == null || candidate.hostId === "local"),
  );
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
    signal,
    createClient = () => new AppToolsClient({ signal }),
    accept = acceptProvisioning,
    acknowledge = acknowledgeMessage,
    markIssued = markNativeMutationIssued,
    authorizeCloud = authorizeCloudDelivery,
    cloudAuthorizationOptions,
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
        await authorizeCloud(delivery, {
          ...cloudAuthorizationOptions,
          signal,
        });
        signal?.throwIfAborted();
        withReceiverAuthorization(
          {
            projectRoot: delivery.projectRoot,
            identity: delivery.receiverAuthorization,
          },
          () =>
            markIssued({
              jobId: delivery.jobId,
              deliveryId: delivery.deliveryId,
              receiverIdentity: delivery.receiverAuthorization,
            }),
          {
            path:
              cloudAuthorizationOptions?.registryPath ??
              receiverRegistryPath(cloudAuthorizationOptions?.env),
            now: cloudAuthorizationOptions?.now,
          },
        );
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
      await authorizeCloud(delivery, { ...cloudAuthorizationOptions, signal });
      signal?.throwIfAborted();
      withReceiverAuthorization(
        {
          projectRoot: delivery.projectRoot,
          identity: delivery.receiverAuthorization,
        },
        () =>
          markIssued({
            jobId: delivery.jobId,
            deliveryId: delivery.deliveryId,
            receiverIdentity: delivery.receiverAuthorization,
          }),
        {
          path:
            cloudAuthorizationOptions?.registryPath ??
            receiverRegistryPath(cloudAuthorizationOptions?.env),
          now: cloudAuthorizationOptions?.now,
        },
      );
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
  { jobId, deliveryId, ownerThreadId, turnId, receiverIdentity = null },
  {
    load = getReservedDelivery,
    route = routeDelivery,
    retry = retryRoutingMessage,
    uncertain = markNativeMutationUncertain,
    signal,
    routeOptions,
  } = {},
) {
  const delivery = load({ jobId, deliveryId, receiverIdentity });
  if (!delivery) return null;
  try {
    return await route(delivery, {
      ...routeOptions,
      ownerThreadId,
      turnId,
      signal,
    });
  } catch (error) {
    if (delivery.source === "cloud" && error.nativeMutationIssued === true) {
      uncertain({ jobId, deliveryId, error: error.message });
    } else {
      retry({ jobId, deliveryId, error: error.message });
    }
    throw error;
  }
}
