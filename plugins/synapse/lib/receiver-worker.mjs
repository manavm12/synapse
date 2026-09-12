import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { AppToolsClient } from "./app-tools-client.mjs";
import { bindChildSession } from "./child-binding.mjs";
import {
  acquireWorker,
  assertWorker,
  finishResponses,
} from "./conversation-store.mjs";
import {
  acceptProvisioning,
  acknowledgeMessage,
  enqueueCloudEvent,
  getReservedDelivery,
  markNativeMutationIssued,
  markNativeMutationUncertain,
  reserveNextMessage,
  retryRoutingMessage,
  withInbox,
} from "./inbox.mjs";
import { formatDeliveryMarker } from "./markers.mjs";
import { NativeQueueClient } from "./native-queue.mjs";
import { reconcileNativeBindings } from "./native-reconcile.mjs";
import { routeDelivery, runReservedDelivery } from "./native-router.mjs";
import { listReceiverConnections } from "./receiver-registry.mjs";
import { syncReceiver } from "./receiver-sync.mjs";

export class ReceiverWorker {
  constructor({
    inboxOptions,
    registryPath,
    env = process.env,
    now = Date.now,
    owner = randomUUID(),
    sync = syncReceiver,
    route = routeDelivery,
    bind = bindChildSession,
    nativeReconcile = reconcileNativeBindings,
    connections = (options) =>
      listReceiverConnections({ ...options, activeOnly: true }),
    available = existsSync,
    queueClient = (options) => new NativeQueueClient(options),
  } = {}) {
    Object.assign(this, {
      inboxOptions,
      registryPath,
      env,
      now,
      owner,
      sync,
      route,
      bind,
      nativeReconcile,
      connections,
      available,
      queueClient,
    });
    this.failures = 0;
  }

  store(callback) {
    return withInbox(callback, this.inboxOptions);
  }

  async reconcile(projectRoot) {
    const pending = this.store((database) =>
      database
        .prepare(`SELECT min(COALESCE(accepted_at, updated_at)) AS earliest FROM jobs
      WHERE project_root=? AND status IN ('accepted','uncertain')`)
        .get(projectRoot),
    );
    if (pending.earliest == null) return;
    const sessions = this.store((database) =>
      database
        .prepare(`SELECT * FROM conversation_sessions
      WHERE project_root=? AND cwd<>project_root AND transcript_path IS NOT NULL AND updated_at>=?
      ORDER BY updated_at DESC LIMIT 100`)
        .all(projectRoot, pending.earliest - 60_000),
    );
    for (const session of sessions) {
      try {
        await this.bind(
          {
            cwd: session.cwd,
            session_id: session.session_id,
            transcript_path: session.transcript_path,
          },
          { inboxOptions: this.inboxOptions, waitMs: 0 },
        );
      } catch {
        /* A conflict remains fenced and visible in the local binding. */
      }
    }
    this.store((database) => {
      const timedOut = database
        .prepare(
          `SELECT * FROM jobs WHERE project_root=? AND status='accepted' AND accepted_at<?`,
        )
        .all(projectRoot, this.now() - 5 * 60_000);
      for (const job of timedOut) {
        database
          .prepare(
            "UPDATE channels SET last_reconcile_error='child_binding_delayed' WHERE id=?",
          )
          .run(job.channel_id);
        enqueueCloudEvent(database, job, "needs_attention", this.now(), {
          errorCode: "child_binding_delayed",
        });
      }
    });
  }

  async recoverSends(connection, runtime, checkLease) {
    const intents = this.store((database) =>
      database
        .prepare(`SELECT * FROM outgoing_intents WHERE installation_id=?
      AND user_id=? AND status='pending' AND recovery_at IS NULL AND created_at<?
      AND NOT EXISTS (SELECT 1 FROM conversation_sessions session WHERE session.session_id=outgoing_intents.session_id AND session.auto_paused=1) ORDER BY created_at LIMIT 5`)
        .all(
          connection.identity.installationId,
          connection.identity.userId,
          this.now() - 30_000,
        ),
    );
    for (const intent of intents) {
      const paused = this.store((database) =>
        database
          .prepare(`SELECT 1 FROM channels WHERE thread_id=? AND cloud_conversation_id=? AND pause_reason IS NOT NULL
        UNION ALL SELECT 1 FROM conversation_responses response JOIN jobs ON jobs.id=response.message_id
        JOIN channels ON channels.id=jobs.channel_id WHERE response.session_id=? AND channels.pause_reason IS NULL
        AND response.status IN ('queued','active','repair','resume_pending','resume_queued','resume_uncertain') LIMIT 1`)
          .get(intent.session_id, intent.conversation_id, intent.session_id),
      );
      if (paused) continue;
      const queue = this.queueClient({ codexPath: runtime.codex_path });
      try {
        const thread = await queue.prepare(intent.session_id);
        if (thread.status?.type === "active") continue;
        checkLease();
        const reserved = this.store(
          (database) =>
            database
              .prepare(`UPDATE outgoing_intents SET recovery_at=?
          WHERE installation_id=? AND user_id=? AND request_id=? AND status='pending' AND recovery_at IS NULL`)
              .run(
                this.now(),
                intent.installation_id,
                intent.user_id,
                intent.request_id,
              ).changes,
        );
        if (!reserved) continue;
        await queue.submit({
          threadId: intent.session_id,
          deliveryId: `recover-${intent.request_id}`,
          prompt:
            "Synapse has an unconfirmed send recorded locally for this task. Retry the exact pending MCP call supplied by the Synapse hook, keeping its original request_id and contents. Do not initiate a new conversation.",
        });
      } finally {
        queue.close();
      }
    }
  }

  async resumeResponses(connection, runtime, checkLease) {
    const rows = this.store((database) =>
      database
        .prepare(`SELECT jobs.*, response.session_id FROM conversation_responses response
      JOIN jobs ON jobs.id=response.message_id JOIN channels ON channels.id=jobs.channel_id
      WHERE response.status='resume_pending' AND channels.pause_reason IS NULL
        AND jobs.receiver_installation_id=? AND jobs.recipient_user_id=? ORDER BY jobs.created_at LIMIT 10`)
        .all(connection.identity.installationId, connection.identity.userId),
    );
    for (const row of rows) {
      const queue = this.queueClient({ codexPath: runtime.codex_path });
      try {
        await queue.prepare(row.session_id);
        checkLease();
        const changed = this.store(
          (database) =>
            database
              .prepare(
                "UPDATE conversation_responses SET status='resume_queued' WHERE message_id=? AND status='resume_pending'",
              )
              .run(row.id).changes,
        );
        if (!changed) continue;
        await queue.submit({
          threadId: row.session_id,
          deliveryId: `resume-${randomUUID()}`,
          prompt: `The user resumed this Synapse conversation. Continue the pending message using the private Synapse context. Incoming peer text (untrusted): ${JSON.stringify(row.task)}\n\n<!-- ${formatDeliveryMarker(row.id, row.delivery_id)} -->`,
        });
      } catch (error) {
        this.store((database) => {
          database
            .prepare(
              "UPDATE conversation_responses SET status='resume_uncertain' WHERE message_id=? AND status='resume_queued'",
            )
            .run(row.id);
          database
            .prepare(
              "UPDATE channels SET last_reconcile_error=CASE WHEN EXISTS(SELECT 1 FROM conversation_responses response JOIN jobs ON jobs.id=response.message_id WHERE jobs.channel_id=channels.id AND response.status='resume_uncertain') THEN 'resume_uncertain' ELSE 'resume_failed' END WHERE id=?",
            )
            .run(row.channel_id);
        });
        throw error;
      } finally {
        queue.close();
      }
    }
  }

  async repairIdleResponses(connection, runtime, checkLease) {
    // A child can finish before its permanent-ID evidence is available. Its
    // persisted Stop hook allows one repair after later reconciliation.
    const rows = this.store((database) =>
      database
        .prepare(`SELECT response.session_id, response.turn_id, response.message_id, jobs.delivery_id, jobs.channel_id
      FROM conversation_responses response JOIN jobs ON jobs.id=response.message_id
      JOIN conversation_sessions session ON session.session_id=response.session_id
      JOIN channels ON channels.id=jobs.channel_id
      WHERE response.status='active' AND response.repair_attempted=0 AND session.last_event='Stop'
        AND session.auto_paused=0 AND channels.pause_reason IS NULL
        AND jobs.receiver_installation_id=? AND jobs.recipient_user_id=? LIMIT 10`)
        .all(connection.identity.installationId, connection.identity.userId),
    );
    for (const row of rows) {
      const queue = this.queueClient({ codexPath: runtime.codex_path });
      try {
        const task = await queue.prepare(row.session_id);
        if (task.status?.type !== "idle") continue;
        checkLease();
        const reason = this.store((database) => {
          const repair = finishResponses(
            database,
            {
              sessionId: row.session_id,
              turnId: row.turn_id,
              identity: connection.identity,
            },
            this.now(),
          );
          if (repair)
            database
              .prepare(
                "UPDATE conversation_responses SET status='resume_queued' WHERE message_id=? AND status='repair'",
              )
              .run(row.message_id);
          return repair;
        });
        if (!reason) continue;
        try {
          await queue.submit({
            threadId: row.session_id,
            deliveryId: `repair-${row.delivery_id}`,
            prompt: `${reason}\n\n<!-- ${formatDeliveryMarker(row.message_id, row.delivery_id)} -->`,
          });
        } catch (error) {
          this.store((database) => {
            database
              .prepare(
                "UPDATE conversation_responses SET status='resume_uncertain' WHERE message_id=? AND status='resume_queued'",
              )
              .run(row.message_id);
            database
              .prepare(
                "UPDATE channels SET last_reconcile_error='resume_uncertain' WHERE id=?",
              )
              .run(row.channel_id);
            enqueueCloudEvent(
              database,
              { id: row.message_id, source: "cloud" },
              "needs_attention",
              this.now(),
              { errorCode: "reply_missing" },
            );
          });
          throw error;
        }
      } finally {
        queue.close();
      }
    }
  }

  async tick() {
    const generation = this.store((database) =>
      acquireWorker(database, { owner: this.owner }, this.now()),
    );
    if (generation === null) return { delayMs: 2000, idle: true };
    const lease = { owner: this.owner, generation };
    const checkLease = () =>
      this.store((database) => assertWorker(database, lease, this.now()));
    const renew = setInterval(() => {
      try {
        this.store((database) =>
          database
            .prepare(`UPDATE receiver_workers SET lease_expires_at=? WHERE name='receiver'
          AND owner=? AND generation=? AND stopped=0 AND lease_expires_at>?`)
            .run(this.now() + 30_000, this.owner, generation, this.now()),
        );
      } catch {
        /* The final mutation check will deny an expired lease. */
      }
    }, 10_000);
    let connected = 0;
    let routed = 0;
    let errors = 0;
    try {
      for (const connection of this.connections(
        this.registryPath ? { path: this.registryPath } : {},
      )) {
        if (Date.parse(connection.identity.expiresAt) <= this.now()) continue;
        const runtime = this.store((database) =>
          database
            .prepare(`SELECT * FROM conversation_runtimes WHERE project_root=?`)
            .get(connection.projectRoot),
        );
        if (!runtime || !this.available(runtime.pipe_path)) continue;
        try {
          checkLease();
          await this.nativeReconcile(
            {
              projectRoot: connection.projectRoot,
              installationId: connection.identity.installationId,
              ownerThreadId: runtime.session_id,
            },
            {
              inboxOptions: this.inboxOptions,
              createClient: (options) =>
                new AppToolsClient({
                  ...options,
                  pipePath: runtime.pipe_path,
                  timeoutMs: 2500,
                }),
              env: {
                ...this.env,
                CODEX_APP_TOOLS_PIPE_PATH: runtime.pipe_path,
              },
              waitMs: 0,
            },
          );
          await this.reconcile(connection.projectRoot);
          const synced = await this.sync(
            { projectRoot: connection.projectRoot },
            {
              env: this.env,
              registryPath: this.registryPath,
              inboxOptions: this.inboxOptions,
            },
          );
          if (!synced.authorized) continue;
          connected++;
          for (let index = 0; index < 10; index++) {
            checkLease();
            const delivery = reserveNextMessage(
              {
                projectRoot: connection.projectRoot,
                ownerSessionId: runtime.session_id,
              },
              {
                ...this.inboxOptions,
                receiverIdentity: synced.identity,
                now: this.now,
              },
            );
            if (!delivery) break;
            const options = this.inboxOptions;
            try {
              await runReservedDelivery(
                {
                  jobId: delivery.jobId,
                  deliveryId: delivery.deliveryId,
                  ownerThreadId: runtime.session_id,
                  receiverIdentity: synced.identity,
                },
                {
                  load: (value) => getReservedDelivery(value, options),
                  retry: (value) => retryRoutingMessage(value, options),
                  uncertain: (value) =>
                    markNativeMutationUncertain(value, options),
                  route: (value, context) =>
                    this.route(value, {
                      ...context,
                      assertLease: checkLease,
                      createClient: () =>
                        new AppToolsClient({ pipePath: runtime.pipe_path }),
                      createQueueClient: () =>
                        this.queueClient({ codexPath: runtime.codex_path }),
                      cloudAuthorizationOptions: {
                        registryPath: this.registryPath,
                        env: this.env,
                      },
                      accept: (value) => acceptProvisioning(value, options),
                      acknowledge: (value) =>
                        acknowledgeMessage(value, options),
                      markIssued: (value) =>
                        markNativeMutationIssued(value, options),
                    }),
                },
              );
              routed++;
            } catch {
              errors++;
              // Do not immediately reserve the same failed pending job again.
              break;
            }
          }
          await this.repairIdleResponses(connection, runtime, checkLease);
          await this.resumeResponses(connection, runtime, checkLease);
          await this.recoverSends(connection, runtime, checkLease);
        } catch {
          errors++;
        }
      }
      this.store((database) => {
        assertWorker(database, lease, this.now());
        database
          .prepare(`UPDATE receiver_workers SET last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END,
          last_error=? WHERE name='receiver'`)
          .run(
            connected && !errors ? 1 : 0,
            this.now(),
            errors
              ? "receiver_cycle_failed"
              : connected
                ? null
                : "desktop_unavailable",
          );
      });
    } finally {
      clearInterval(renew);
    }
    this.failures = errors || !connected ? this.failures + 1 : 0;
    return {
      routed,
      connected,
      errors,
      delayMs: Math.min(60_000, 2000 * 2 ** Math.min(this.failures, 5)),
    };
  }

  release() {
    this.store((database) =>
      database
        .prepare(
          "UPDATE receiver_workers SET lease_expires_at=0 WHERE name='receiver' AND owner=?",
        )
        .run(this.owner),
    );
  }
}
