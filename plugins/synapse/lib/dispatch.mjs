import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { withDeadline } from "./deadline.mjs";
import { safeSessionId } from "./hook-input.mjs";
import { getJob, reserveNextMessage } from "./inbox.mjs";
import { parseDeliveryMarker } from "./markers.mjs";
import { reconcileNativeBindings } from "./native-reconcile.mjs";
import { runReservedDelivery } from "./native-router.mjs";
import { activeDestinations, withReceiverLease } from "./onboarding-state.mjs";
import { receiverRegistryPath } from "./receiver-registry.mjs";
import { syncReceiver } from "./receiver-sync.mjs";

const exec = promisify(execFile);

export function isDeliveryPrompt(prompt, inboxOptions) {
  const marker = parseDeliveryMarker(prompt);
  if (!marker) return false;
  const job = getJob(marker.jobId, inboxOptions);
  return Boolean(
    job &&
      (marker.version === 2
        ? job.deliveryId === marker.deliveryId
        : job.markerVersion === 1),
  );
}

async function localQueueRoot(cwd, signal) {
  if (typeof cwd !== "string" || !cwd || cwd.length > 4096) return null;
  try {
    const values = await Promise.all(
      ["--git-dir", "--git-common-dir", "--show-toplevel"].map(
        async (argument) => {
          const { stdout } = await exec(
            "git",
            ["-C", cwd, "rev-parse", argument],
            { signal },
          );
          const value = stdout.trim();
          return isAbsolute(value) ? value : resolve(cwd, value);
        },
      ),
    );
    return values[0] === values[1] ? values[2] : null;
  } catch {
    return null;
  }
}

export async function dispatchPrompt(
  input,
  {
    env = process.env,
    registryPath = receiverRegistryPath(env),
    inboxOptions,
    signal: parentSignal,
    sync = syncReceiver,
    deliver = runReservedDelivery,
    reconcile = reconcileNativeBindings,
    reconciliationOptions,
    syncOptions,
    deliveryOptions,
    timeoutMs = 25_000,
  } = {},
) {
  if (
    input?.hook_event_name !== "UserPromptSubmit" ||
    !safeSessionId(input.session_id) ||
    !env.CODEX_APP_TOOLS_PIPE_PATH ||
    isDeliveryPrompt(input.prompt, inboxOptions)
  )
    return null;
  return withDeadline(
    async (signal) => {
      const route = async (delivery, receiverIdentity) => {
        signal.throwIfAborted();
        await deliver(
          {
            jobId: delivery.jobId,
            deliveryId: delivery.deliveryId,
            ownerThreadId: input.session_id,
            turnId: safeSessionId(input.turn_id) ? input.turn_id : undefined,
            receiverIdentity,
          },
          { ...deliveryOptions, signal },
        );
        return { attempted: true };
      };
      for (const destination of activeDestinations({ path: registryPath })) {
        signal.throwIfAborted();
        try {
          const result = await withReceiverLease(
            `receiver:${destination.projectRoot}`,
            async () => {
              const receiver = await sync(
                { projectRoot: destination.projectRoot },
                { ...syncOptions, env, registryPath, inboxOptions, signal },
              );
              signal.throwIfAborted();
              if (!receiver.authorized) return null;
              const reconcileInput = {
                projectRoot: destination.projectRoot,
                installationId: receiver.identity.installationId,
                ownerThreadId: input.session_id,
              };
              const reconcileOptions = {
                ...reconciliationOptions,
                env,
                inboxOptions,
                signal,
              };
              await reconcile(reconcileInput, reconcileOptions);
              const delivery = reserveNextMessage(
                {
                  projectRoot: destination.projectRoot,
                  ownerSessionId: input.session_id,
                  source: "cloud",
                },
                { ...inboxOptions, receiverIdentity: receiver.identity },
              );
              // Failed/uncertain native responses also consume the one attempt.
              try {
                if (!delivery) return null;
                return await route(delivery, receiver.identity);
              } catch {
                return { attempted: true };
              } finally {
                if (!signal.aborted) {
                  if (delivery)
                    await reconcile(reconcileInput, {
                      ...reconcileOptions,
                      waitMs: 5000,
                    });
                  await sync(
                    {
                      projectRoot: destination.projectRoot,
                      receiptsOnly: true,
                    },
                    { ...syncOptions, env, registryPath, inboxOptions, signal },
                  ).catch(() => {});
                }
              }
            },
            { path: registryPath, ttlMs: timeoutMs + 5_000 },
          );
          if (result?.attempted) return result;
        } catch {
          signal.throwIfAborted();
        }
      }
      const root = await localQueueRoot(input.cwd, signal);
      signal.throwIfAborted();
      if (!root) return null;
      const delivery = reserveNextMessage(
        {
          projectRoot: root,
          ownerSessionId: input.session_id,
          source: "local",
        },
        inboxOptions,
      );
      return delivery ? route(delivery, null) : null;
    },
    { timeoutMs, signal: parentSignal },
  );
}
