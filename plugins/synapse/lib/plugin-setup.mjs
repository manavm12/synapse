import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { AppToolsClient, appToolJson } from "./app-tools-client.mjs";
import { waitForApproval, withDeadline } from "./deadline.mjs";
import { promptHookHealth } from "./hook-health.mjs";
import { openExternalUrl } from "./open-url.mjs";
import {
  activateDestination,
  activeDestinations,
  deactivateDestination,
  withReceiverLease,
} from "./onboarding-state.mjs";
import { connectProject, resolveProjectRoot } from "./project-registry.mjs";
import { ReceiverClient, ReceiverHttpError } from "./receiver-client.mjs";
import {
  credentialHash,
  validateReceiverIdentity,
} from "./receiver-contract.mjs";
import { disconnectReceiver } from "./receiver-enrollment.mjs";
import {
  beginReceiverConnection,
  completeReceiverConnection,
  getReceiverConnection,
  getReceiverConnectionById,
  markCredentialReady,
  markReceiverDisconnecting,
  receiverRegistryPath,
  receiverTarget,
  recordReceiverPairing,
  removeReceiverConnection,
} from "./receiver-registry.mjs";
import { createReceiverSecretStore } from "./receiver-secrets.mjs";

const exec = promisify(execFile);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class AuthorizationChanged extends Error {}
function unavailable(connection, error) {
  const reconnect =
    error instanceof AuthorizationChanged ||
    (error instanceof ReceiverHttpError && [401, 403].includes(error.status));
  return {
    status: reconnect ? "reconnect_required" : "unavailable",
    connection_id: connection.connectionId,
    message: reconnect
      ? "Receiver authorization changed. Ask Synapse to reconnect."
      : "Receiver verification is temporarily unavailable. Retry status or setup; existing enrollment is preserved.",
  };
}

export function setupIdentity(value) {
  if (
    value?.principal_type !== "user" ||
    value.authentication_method !== "oauth" ||
    !UUID.test(value.user_id ?? "") ||
    !UUID.test(value.project_id ?? "") ||
    !/^[a-z][a-z0-9_-]{1,62}$/.test(value.project_alias ?? "") ||
    typeof value.username !== "string" ||
    value.username.length > 128
  ) {
    throw new Error(
      "Use the live get_identity result from your Synapse OAuth connection",
    );
  }
  return {
    userId: value.user_id.toLowerCase(),
    projectId: value.project_id.toLowerCase(),
    username: value.username,
    projectAlias: value.project_alias,
  };
}

export async function configuredReceiverServer() {
  const config = JSON.parse(
    await readFile(new URL("../.mcp.json", import.meta.url), "utf8"),
  );
  const url = new URL(config.mcpServers?.["synapse-memory"]?.url);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/mcp" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Synapse plugin has an invalid service configuration");
  }
  return url.origin;
}

export async function primaryProject(
  project,
  { cwd = process.cwd(), signal } = {},
) {
  const { stdout } = await exec(
    "git",
    [
      "-C",
      resolve(project ?? cwd),
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ],
    { signal },
  );
  return realpath(
    await resolveProjectRoot(dirname(stdout.trim()), cwd, {
      execGit: (command, args, options) =>
        exec(command, args, { ...options, signal }),
    }),
  );
}

export async function savedProject(
  project,
  {
    sessionId = process.env.CODEX_THREAD_ID,
    signal,
    createClient = (options) => new AppToolsClient(options),
  } = {},
) {
  const root = await primaryProject(project, { signal });
  const client = createClient({ signal });
  try {
    const tools = await client.listTools();
    if (
      ![
        "list_projects",
        "create_thread",
        "send_message_to_thread",
        "read_thread",
      ].every((name) => tools.some((tool) => tool.name === name))
    )
      throw new Error(
        "This Codex installation lacks the native task tools required by Synapse. Update Codex before enabling incoming tasks.",
      );
    const list = appToolJson(
      await client.callTool("list_projects", {}, { threadId: sessionId }),
    );
    for (const item of list.projects ?? []) {
      if (item.hostId !== "local" || !item.isGitRepository || !item.path)
        continue;
      if ((await realpath(item.path).catch(() => null)) === root) return root;
    }
    throw new Error(
      "Choose a saved local Git project in Codex for incoming tasks",
    );
  } finally {
    await client.close();
  }
}

function sameAccount(expected, actual) {
  return (
    expected.userId === actual.userId &&
    expected.projectId === actual.projectId &&
    expected.projectAlias === actual.projectAlias
  );
}

function expectedAccount(connection) {
  return {
    userId: connection.expectedUserId ?? connection.identity?.userId,
    projectId: connection.expectedProjectId ?? connection.identity?.projectId,
    projectAlias: connection.projectAlias,
  };
}

function clientFor(connection, credential, options, signal) {
  return options.createClient({
    serverUrl: connection.serverUrl,
    credential,
    signal,
    allowInsecureHttp: options.env.SYNAPSE_ALLOW_INSECURE_RECEIVER_HTTP === "1",
  });
}

function optionsFor(options = {}) {
  const env = options.env ?? process.env;
  return {
    env,
    registryPath: receiverRegistryPath(env),
    secretStore: options.secretStore ?? createReceiverSecretStore({ env }),
    createClient: (input) => new ReceiverClient(input),
    resolveRoot: savedProject,
    hookHealth: promptHookHealth,
    now: Date.now,
    ...options,
  };
}

async function verifyConnected(connection, expected, options, signal) {
  const credential = await options.secretStore.get(
    connection.credentialAccount,
    { signal },
  );
  const result = await clientFor(
    connection,
    credential,
    options,
    signal,
  ).getIdentity();
  signal?.throwIfAborted();
  if (result.identity?.enabled === false)
    throw new AuthorizationChanged("Receiver is disabled");
  const identity = validateReceiverIdentity(result.identity);
  if (
    !sameAccount(expected, identity) ||
    identity.installationId !== connection.identity?.installationId ||
    Date.parse(identity.expiresAt) <= options.now()
  )
    throw new AuthorizationChanged(
      "Receiver authorization changed; reconnect from Synapse setup",
    );
  const current = getReceiverConnection(connection.projectRoot, {
    path: options.registryPath,
  });
  if (
    current?.connectionId !== connection.connectionId ||
    current.status !== "connected"
  ) {
    throw new Error("Receiver changed during setup");
  }
  return { ...current, identity };
}

function summary(connection, input, options) {
  const hooks = options.hookHealth(
    input.session_id ?? options.env.CODEX_THREAD_ID,
    {
      path: options.registryPath,
      now: options.now,
    },
  );
  return {
    status: hooks.status === "verified" ? "ready" : "hooks_pending",
    enrollment_status: "connected",
    hooks,
    ...(hooks.status === "verified"
      ? {}
      : {
          message:
            "Your receiver is connected and the destination is saved, but this plugin's background prompt hook has not been verified in this chat. Review and trust Synapse hooks in Codex, then send a new prompt in a fresh local task. Check setup status there; do not repeat enrollment or run repository CLI commands.",
        }),
    connection_id: connection.connectionId,
    username: connection.identity.username,
    project_alias: connection.identity.projectAlias,
    project: connection.projectRoot,
    expires_at: connection.identity.expiresAt,
  };
}

async function retire(connection, options, signal) {
  deactivateDestination(connection.connectionId, {
    path: options.registryPath,
  });
  await disconnectReceiver(
    { project: connection.projectRoot },
    {
      ...options,
      resolveRoot: async () => connection.projectRoot,
      signal,
    },
  );
  signal?.throwIfAborted();
  removeReceiverConnection(connection.connectionId, {
    path: options.registryPath,
  });
}

export async function prepareSetup(input, dependencies = {}) {
  const options = optionsFor(dependencies);
  const expected = setupIdentity(input.identity);
  return withDeadline(
    async (signal) => {
      const serverUrl = options.serverUrl ?? (await configuredReceiverServer());
      const root = await options.resolveRoot(input.project, {
        signal,
        sessionId: input.session_id,
      });
      return withReceiverLease(
        `receiver:${root}`,
        async () => {
          signal.throwIfAborted();
          await connectProject(
            { project: root, alias: expected.projectAlias },
            {
              env: { ...options.env, SYNAPSE_HOST_DB: options.registryPath },
              resolveRoot: async () => root,
            },
          );
          let connection = getReceiverConnection(root, {
            path: options.registryPath,
          });
          if (connection && connection.serverUrl !== serverUrl)
            throw new Error(
              "This project uses another Synapse server; disable that connection first",
            );
          if (
            connection &&
            (connection.expectedUserId || connection.identity) &&
            !sameAccount(expected, expectedAccount(connection))
          ) {
            throw new Error(
              "This project belongs to another Synapse account; disable the previous connection explicitly",
            );
          }
          if (connection?.status === "connected" && !input.reconnect) {
            try {
              const live = await verifyConnected(
                connection,
                expected,
                options,
                signal,
              );
              activateDestination(live, { path: options.registryPath });
              return summary(live, input, options);
            } catch (error) {
              signal.throwIfAborted();
              return unavailable(connection, error);
            }
          }
          if (connection?.status === "disconnected") {
            removeReceiverConnection(connection.connectionId, {
              path: options.registryPath,
            });
            connection = null;
          } else if (
            connection &&
            (input.reconnect ||
              !connection.expectedUserId ||
              !connection.credentialReady)
          ) {
            // Unbound legacy pairings must never become a new account-bound setup.
            await retire(connection, options, signal);
            connection = null;
          }
          if (
            connection &&
            ["revoked", "disconnecting"].includes(connection.status)
          ) {
            return {
              status: "reconnect_required",
              connection_id: connection.connectionId,
            };
          }
          if (!connection) {
            const connectionId = randomUUID();
            const credentialAccount = `receiver:${connectionId}`;
            const credential = `syn_recv_${randomBytes(32).toString("base64url")}`;
            connection = beginReceiverConnection(
              {
                connectionId,
                projectRoot: root,
                projectAlias: expected.projectAlias,
                serverUrl,
                credentialAccount,
                credentialHash: credentialHash(credential),
                expectedUserId: expected.userId,
                expectedProjectId: expected.projectId,
                credentialReady: false,
              },
              { path: options.registryPath },
            );
            // Persist the account first so interruption during Keychain work remains recoverable.
            await options.secretStore.set(credentialAccount, credential, {
              signal,
            });
            signal.throwIfAborted();
            markCredentialReady(connectionId, { path: options.registryPath });
          } else {
            await options.secretStore.get(connection.credentialAccount, {
              signal,
            });
          }
          return {
            status: "approval_required",
            connection_id: connection.connectionId,
            credential_hash: connection.credentialHash,
          };
        },
        { path: options.registryPath, ttlMs: 35_000 },
      );
    },
    { timeoutMs: 30_000, signal: dependencies.signal },
  );
}

export function validateSetupPairing(pairing, connection, now = Date.now()) {
  const identity = pairing?.identity;
  if (
    !UUID.test(pairing?.pairing_id ?? "") ||
    !Number.isFinite(Date.parse(pairing?.expires_at)) ||
    Date.parse(pairing.expires_at) <= now ||
    !sameAccount(expectedAccount(connection), {
      userId: identity?.user_id,
      projectId: identity?.project_id,
      projectAlias: identity?.project_alias,
    })
  )
    throw new Error(
      "Pairing does not match your Synapse sign-in; restart setup",
    );
  const url = new URL(pairing.verification_url);
  if (
    url.origin !== new URL(connection.serverUrl).origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `/receiver/pairings/${pairing.pairing_id}`
  ) {
    throw new Error("Synapse returned an unexpected approval URL");
  }
  return url.href;
}

export async function completeSetup(input, dependencies = {}) {
  const options = optionsFor(dependencies);
  const timeoutMs = dependencies.timeoutMs ?? 300_000;
  const initial = getReceiverConnectionById(input.connection_id, {
    path: options.registryPath,
  });
  if (!initial?.expectedUserId)
    throw new Error("Start setup before completing approval");
  return withDeadline(
    (signal) =>
      withReceiverLease(
        `receiver:${initial.projectRoot}`,
        async () => {
          let connection = getReceiverConnectionById(initial.connectionId, {
            path: options.registryPath,
          });
          if (connection?.status === "connected") {
            connection = await verifyConnected(
              connection,
              expectedAccount(connection),
              options,
              signal,
            );
            activateDestination(connection, { path: options.registryPath });
            return summary(connection, input, options);
          }
          if (!["starting", "pending"].includes(connection?.status))
            throw new Error("Setup was cancelled; reconnect from Synapse");
          const url = validateSetupPairing(
            input.pairing,
            connection,
            options.now(),
          );
          recordReceiverPairing(
            {
              connectionId: connection.connectionId,
              pairingId: input.pairing.pairing_id,
              verificationUrl: url,
              expiresAt: input.pairing.expires_at,
            },
            { path: options.registryPath },
          );
          options.onProgress?.(
            `Approve incoming tasks at ${url}. Synapse will finish automatically.`,
          );
          try {
            await (
              options.openUrl ??
              ((value) => openExternalUrl(value, { signal }))
            )(url, { signal });
          } catch {
            signal.throwIfAborted();
            options.onProgress?.(
              `Open ${url} in your browser to approve incoming tasks.`,
            );
          }
          const credential = await options.secretStore.get(
            connection.credentialAccount,
            { signal },
          );
          const client = clientFor(connection, credential, options, signal);
          while (true) {
            signal.throwIfAborted();
            if (
              getReceiverConnectionById(connection.connectionId, {
                path: options.registryPath,
              })?.status !== "pending"
            )
              throw new Error("Setup was cancelled; reconnect from Synapse");
            const result = await client.completePairing(
              input.pairing.pairing_id,
            );
            signal.throwIfAborted();
            if (result.status === "connected") {
              const identity = validateReceiverIdentity(result.identity);
              if (
                !sameAccount(expectedAccount(connection), identity) ||
                Date.parse(identity.expiresAt) <= options.now()
              ) {
                throw new Error(
                  "Browser approval used another account; reconnect from Synapse",
                );
              }
              const live = validateReceiverIdentity(
                (await client.getIdentity()).identity,
              );
              signal.throwIfAborted();
              if (
                !sameAccount(identity, live) ||
                identity.installationId !== live.installationId ||
                Date.parse(live.expiresAt) <= options.now()
              ) {
                throw new Error(
                  "Receiver authorization changed during approval",
                );
              }
              connection = completeReceiverConnection(
                { connectionId: connection.connectionId, identity: live },
                { path: options.registryPath },
              );
              activateDestination(connection, { path: options.registryPath });
              return summary(connection, input, options);
            }
            if (result.status !== "pending" || result.statusCode !== 202)
              throw new Error("Invalid receiver approval response");
            await waitForApproval(1_000, signal);
          }
        },
        { path: options.registryPath, ttlMs: timeoutMs + 5_000 },
      ),
    {
      timeoutMs,
      signal: dependencies.signal,
      message:
        "Approval is still pending. Ask Synapse to resume setup when ready.",
    },
  );
}

export async function setupStatus(input, dependencies = {}) {
  const options = optionsFor(dependencies);
  const connection = getReceiverConnectionById(input.connection_id, {
    path: options.registryPath,
  });
  if (!connection) return { status: "not_connected" };
  if (connection.status !== "connected")
    return {
      status: connection.status,
      connection_id: connection.connectionId,
    };
  try {
    return await withDeadline(
      async (signal) => {
        const live = await verifyConnected(
          connection,
          expectedAccount(connection),
          options,
          signal,
        );
        if (
          !activeDestinations({ path: options.registryPath }).some(
            (destination) =>
              destination.connectionId === connection.connectionId,
          )
        ) {
          return {
            status: "setup_required",
            connection_id: connection.connectionId,
            message:
              "Enrollment is valid but no receiving destination is enabled. Select Enable incoming tasks.",
          };
        }
        return summary(live, input, options);
      },
      { timeoutMs: 15_000, signal: dependencies.signal },
    );
  } catch (error) {
    dependencies.signal?.throwIfAborted();
    if (error.name === "TimeoutError") throw error;
    return unavailable(connection, error);
  }
}

export async function disableSetup(input, dependencies = {}) {
  const options = optionsFor(dependencies);
  // Retained targets also fence a reconnect that just replaced the old row.
  const target = receiverTarget(input.connection_id, {
    path: options.registryPath,
  });
  if (!target) return { status: "disabled" };
  const stopLocally = () => {
    const current = getReceiverConnection(target.projectRoot, {
      path: options.registryPath,
    });
    if (!current) return null;
    if (target.userId && expectedAccount(current).userId !== target.userId)
      throw new Error(
        "Receiver account changed; inspect setup before disabling",
      );
    deactivateDestination(current.connectionId, { path: options.registryPath });
    if (["starting", "pending", "connected"].includes(current.status))
      markReceiverDisconnecting(current.connectionId, {
        path: options.registryPath,
      });
    return current;
  };
  stopLocally();
  await withDeadline(
    async (signal) => {
      while (true) {
        signal.throwIfAborted();
        const result = await withReceiverLease(
          `receiver:${target.projectRoot}`,
          async () => {
            const current = stopLocally();
            if (current)
              await disconnectReceiver(
                { project: target.projectRoot },
                {
                  ...options,
                  resolveRoot: async () => target.projectRoot,
                  signal,
                },
              );
            return { status: "disabled" };
          },
          { path: options.registryPath, ttlMs: 35_000 },
        );
        if (!result?.busy) return result;
        await waitForApproval(100, signal);
      }
    },
    {
      timeoutMs: dependencies.timeoutMs ?? 30_000,
      signal: dependencies.signal,
    },
  );
  return { status: "disabled" };
}
