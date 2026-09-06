import assert from "node:assert/strict";
import test from "node:test";

import { configureMcpResource, inviteUser } from "../../src/admin.mjs";

test("MCP resource configuration requires one exact HTTPS resource", async () => {
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      return { rowCount: 1, rows: [] };
    },
  };
  const configured = await configureMcpResource(
    { mcpUrl: "https://memory.example.com/mcp" },
    { pool },
  );
  assert.equal(configured.mcpResourceUrl, "https://memory.example.com/mcp");
  assert.deepEqual(queries[0].values, ["https://memory.example.com/mcp"]);
  await assert.rejects(
    configureMcpResource(
      { mcpUrl: "https://memory.example.com/mcp?resource=other" },
      { pool },
    ),
    /exactly in \/mcp/,
  );
});

test("a failed post-invite provisioning run can reuse its recorded Auth user", async () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const queries = [];
  const client = {
    async query(sql, values) {
      queries.push({ target: "client", sql, values });
      if (/returning id, alias/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              alias: "synapse",
            },
          ],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const pool = {
    async query(sql, values) {
      queries.push({ target: "pool", sql, values });
      return { rowCount: 1, rows: [{ id: "invite-1", user_id: userId }] };
    },
    async connect() {
      return client;
    },
  };
  let authCalls = 0;
  const auth = {
    auth: {
      admin: {
        async inviteUserByEmail() {
          authCalls += 1;
          throw new Error("existing Auth user must be reused");
        },
      },
    },
  };
  const result = await inviteUser(
    {
      email: "person@example.com",
      username: "person",
      projectAlias: "synapse",
    },
    { pool, auth },
  );
  assert.equal(authCalls, 0);
  assert.equal(result.userId, userId);
  assert.equal(result.projectAlias, "synapse");
  assert.equal(
    queries.some(({ sql }) => /insert into public\.profiles/i.test(sql)),
    true,
  );
  assert.equal(
    queries.some(({ sql }) => /status = 'sent'/i.test(sql)),
    true,
  );
});

test("a new Auth invite redirects through the hosted activation page", async () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  let inviteOptions;
  const client = {
    async query(sql) {
      if (/returning id, alias/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              alias: "synapse",
            },
          ],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const pool = {
    async query(sql) {
      if (/returning id, user_id/i.test(sql)) {
        return { rowCount: 1, rows: [{ id: "invite-1", user_id: null }] };
      }
      return { rowCount: 1, rows: [] };
    },
    async connect() {
      return client;
    },
  };
  const auth = {
    auth: {
      admin: {
        async inviteUserByEmail(_email, options) {
          inviteOptions = options;
          return { data: { user: { id: userId } }, error: null };
        },
      },
    },
  };
  await inviteUser(
    {
      email: "person@example.com",
      username: "person",
      projectAlias: "synapse",
    },
    {
      env: { MCP_RESOURCE_URL: "https://memory.example.com/mcp" },
      pool,
      auth,
    },
  );
  assert.equal(
    inviteOptions.redirectTo,
    "https://memory.example.com/auth/activate",
  );
});
