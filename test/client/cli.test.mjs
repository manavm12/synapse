import assert from "node:assert/strict";
import test from "node:test";

import { parseArguments, submitTask } from "../../src/client/cli.mjs";

test("the CLI parses the local relay, host, and project commands", () => {
  assert.deepEqual(parseArguments(["relay", "run", "--port", "0"]), {
    command: "relay-run",
    host: "127.0.0.1",
    port: 0,
  });
  assert.deepEqual(parseArguments(["host", "run", "--id", "laptop"]), {
    command: "host-run",
    hostId: "laptop",
    relayUrl: "http://127.0.0.1:8787",
  });
  assert.deepEqual(
    parseArguments(["project", "add", "website", "/tmp/website", "--permissions", ":read-only"]),
    {
      command: "project-add",
      alias: "website",
      path: "/tmp/website",
      permissions: ":read-only",
    },
  );
});

test("send selects a project and preserves the exact prompt", () => {
  assert.deepEqual(
    parseArguments([
      "send",
      "feature-42",
      "--project",
      "website",
      "Fix",
      "the",
      "form",
    ]),
    {
      command: "send",
      conversationId: "feature-42",
      project: "website",
      hostId: "local",
      relayUrl: "http://127.0.0.1:8787",
      prompt: "Fix the form",
      wait: true,
    },
  );
});

test("submitTask posts once and consumes server-sent status events", async () => {
  const requests = [];
  const events = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: url.toString(), options });
    if (options.method === "POST") {
      return new Response(
        JSON.stringify({
          task: {
            id: "task-1",
            hostId: "local",
            conversationId: "demo",
            project: "synapse",
            prompt: "Do it",
            status: "queued",
          },
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      'data: {"id":"task-1","status":"running"}\n\n' +
        'data: {"id":"task-1","status":"completed","result":"done"}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };

  const result = await submitTask(
    {
      relayUrl: "http://127.0.0.1:8787",
      hostId: "local",
      conversationId: "demo",
      project: "synapse",
      prompt: "Do it",
    },
    { fetchImpl, onEvent: (event) => events.push(event.status) },
  );

  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    hostId: "local",
    conversationId: "demo",
    project: "synapse",
    prompt: "Do it",
  });
  assert.deepEqual(events, ["queued", "running", "completed"]);
  assert.equal(result.result, "done");
});
