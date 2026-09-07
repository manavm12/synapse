const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function requireHttps(serverUrl, allowInsecureHttp) {
  const url = new URL(serverUrl);
  if (
    url.protocol !== "https:" &&
    !(
      allowInsecureHttp &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    )
  ) {
    throw new Error(
      "Receiver server must use HTTPS (localhost HTTP requires explicit development configuration)",
    );
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

async function readJson(response) {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new ReceiverProtocolError("Receiver response is too large");
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ReceiverProtocolError("Receiver returned invalid JSON");
  }
}

export class ReceiverHttpError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = "ReceiverHttpError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export class ReceiverProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReceiverProtocolError";
  }
}

export class ReceiverNetworkError extends Error {
  constructor(message, { cause, ambiguous = false } = {}) {
    super(message, { cause });
    this.name = "ReceiverNetworkError";
    this.ambiguous = ambiguous;
  }
}

export class ReceiverClient {
  constructor({
    serverUrl,
    credential = null,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    allowInsecureHttp = false,
  }) {
    if (typeof fetchImpl !== "function")
      throw new Error("fetch is unavailable");
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 30_000
    ) {
      throw new Error(
        "Receiver timeout must be between 1 and 30000 milliseconds",
      );
    }
    this.baseUrl = requireHttps(serverUrl, allowInsecureHttp);
    this.credential = credential;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async createPairing(credentialHash) {
    return this.#request("POST", "/receiver/pairings", {
      body: { credential_hash: credentialHash },
      authenticated: false,
    });
  }

  async completePairing(pairingId) {
    return this.#request(
      "POST",
      `/receiver/pairings/${encodeURIComponent(pairingId)}/complete`,
    );
  }

  async getIdentity() {
    return this.#request("GET", "/receiver/identity");
  }

  async claim(limit = 10) {
    return this.#request("POST", "/receiver/claim", { body: { limit } });
  }

  async confirmImport(messageId, claimToken) {
    return this.#request("POST", "/receiver/import", {
      body: { message_id: messageId, claim_token: claimToken },
    });
  }

  async getMessage(messageId) {
    return this.#request(
      "GET",
      `/receiver/messages/${encodeURIComponent(messageId)}`,
    );
  }

  async sendEvents(events) {
    return this.#request("POST", "/receiver/events", { body: { events } });
  }

  async disconnect() {
    return this.#request("POST", "/receiver/disconnect");
  }

  async #request(method, path, { body, authenticated = true } = {}) {
    if (authenticated && typeof this.credential !== "string") {
      throw new Error("Receiver credential is unavailable");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl), {
        method,
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
          ...(authenticated
            ? { authorization: `Bearer ${this.credential}` }
            : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = controller.signal.aborted;
      throw new ReceiverNetworkError(
        timedOut
          ? "Receiver request timed out"
          : "Receiver server is unavailable",
        { cause: error, ambiguous: method !== "GET" },
      );
    } finally {
      clearTimeout(timer);
    }
    const result = await readJson(response);
    if (!result || Array.isArray(result) || typeof result !== "object") {
      throw new ReceiverProtocolError(
        "Receiver returned an invalid JSON object",
      );
    }
    if (!response.ok) {
      throw new ReceiverHttpError(
        `Receiver request failed with HTTP ${response.status}`,
        {
          status: response.status,
          code: typeof result?.code === "string" ? result.code : undefined,
        },
      );
    }
    return { ...result, statusCode: response.status };
  }
}
