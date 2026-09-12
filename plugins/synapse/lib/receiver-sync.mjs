import {
  acknowledgeCloudEvents,
  confirmCloudImport,
  listPendingCloudEvents,
  listPendingCloudImports,
  markCloudEventFailure,
  recordCloudImportFailure,
  stageCloudMessage,
} from "./inbox.mjs";
import { ReceiverClient } from "./receiver-client.mjs";
import {
  cloudChannelId,
  validateCloudMessage,
  validateReceiverIdentity,
} from "./receiver-contract.mjs";
import {
  getReceiverConnection,
  receiverRegistryPath,
} from "./receiver-registry.mjs";
import { createReceiverSecretStore } from "./receiver-secrets.mjs";

function sameIdentity(expected, actual) {
  return (
    expected?.installationId === actual.installationId &&
    expected?.userId === actual.userId &&
    expected?.projectId === actual.projectId &&
    expected?.projectAlias === actual.projectAlias
  );
}

function allowInsecure(env) {
  return env.SYNAPSE_ALLOW_INSECURE_RECEIVER_HTTP === "1";
}

async function flushEvents({ client, identity, inboxOptions }) {
  const events = listPendingCloudEvents(
    { installationId: identity.installationId },
    inboxOptions,
  );
  if (events.length === 0) return 0;
  try {
    const response = await client.sendEvents(events);
    const accepted = Array.isArray(response.accepted_event_ids)
      ? response.accepted_event_ids
      : [];
    const sent = new Set(events.map((event) => event.event_id));
    if (accepted.some((eventId) => !sent.has(eventId))) {
      throw new Error("Receiver accepted an event that was not submitted");
    }
    acknowledgeCloudEvents(
      { installationId: identity.installationId, eventIds: accepted },
      inboxOptions,
    );
    return accepted.length;
  } catch (error) {
    markCloudEventFailure(
      { eventIds: events.map((event) => event.event_id), error: error.message },
      inboxOptions,
    );
    return 0;
  }
}

async function importIsConfirmed(client, messageId) {
  try {
    const state = await client.getMessage(messageId);
    return state.message_id === messageId && state.imported === true;
  } catch {
    return false;
  }
}

async function flushImports({ client, identity, inboxOptions }) {
  const pending = listPendingCloudImports(
    { installationId: identity.installationId },
    inboxOptions,
  );
  const results = await Promise.all(
    pending.map(async (item) => {
      try {
        const response = await client.confirmImport(
          item.messageId,
          item.claimToken,
        );
        if (
          response.message_id !== item.messageId ||
          response.status !== "in_receiver_inbox"
        ) {
          throw new Error(
            "Receiver returned an invalid import acknowledgement",
          );
        }
        confirmCloudImport(
          {
            messageId: item.messageId,
            installationId: identity.installationId,
          },
          inboxOptions,
        );
        return 1;
      } catch (error) {
        if (await importIsConfirmed(client, item.messageId)) {
          confirmCloudImport(
            {
              messageId: item.messageId,
              installationId: identity.installationId,
            },
            inboxOptions,
          );
          return 1;
        }
        recordCloudImportFailure(
          { messageId: item.messageId, error: error.message },
          inboxOptions,
        );
        return 0;
      }
    }),
  );
  return results.reduce((total, value) => total + value, 0);
}

export async function syncReceiver(
  { projectRoot, receiptsOnly = false },
  {
    env = process.env,
    registryPath = receiverRegistryPath(env),
    inboxOptions,
    secretStore = null,
    createClient = (options) => new ReceiverClient(options),
    signal,
  } = {},
) {
  const connection = getReceiverConnection(projectRoot, { path: registryPath });
  if (connection?.status !== "connected" || !connection.identity) {
    return { authorized: false, connected: false, claimed: 0, activated: 0 };
  }
  const credentials = secretStore ?? createReceiverSecretStore({ env });
  const credential = await credentials.get(connection.credentialAccount, {
    signal,
  });
  const client = createClient({
    serverUrl: connection.serverUrl,
    credential,
    allowInsecureHttp: allowInsecure(env),
    timeoutMs: 2_500,
    signal,
  });
  const flushed = await flushEvents({
    client,
    identity: connection.identity,
    inboxOptions,
  });
  if (receiptsOnly) return { flushed };
  const claim = await client.claim(10, 2);
  signal?.throwIfAborted();
  const identity = validateReceiverIdentity(claim.identity);
  if (!sameIdentity(connection.identity, identity)) {
    throw new Error(
      "Receiver server identity does not match the local project binding",
    );
  }
  if (!Array.isArray(claim.messages)) {
    throw new Error("Receiver claim returned an invalid message list");
  }
  if (claim.messages.length > 10) {
    throw new Error("Receiver claim exceeded the requested batch limit");
  }
  const messages = claim.messages.map((value) =>
    validateCloudMessage(value, identity),
  );
  for (const message of messages) {
    stageCloudMessage(
      {
        message,
        identity,
        projectRoot,
        channelId: cloudChannelId(
          identity.installationId,
          identity.userId,
          message.conversationId,
        ),
      },
      inboxOptions,
    );
  }
  const activated = await flushImports({ client, identity, inboxOptions });
  signal?.throwIfAborted();
  return {
    authorized: true,
    connected: true,
    claimed: claim.messages.length,
    activated,
    identity,
  };
}
