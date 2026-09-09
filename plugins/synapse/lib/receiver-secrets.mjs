import { spawn } from "node:child_process";

export const RECEIVER_KEYCHAIN_SERVICE = "com.openai.synapse.receiver.v1";
const MAX_KEYCHAIN_OUTPUT_BYTES = 8 * 1024;
const DEFAULT_KEYCHAIN_TIMEOUT_MS = 5_000;
const SAFE_ACCOUNT = /^receiver:[a-zA-Z0-9._:-]{1,128}$/;
const SAFE_CREDENTIAL = /^syn_recv_[a-zA-Z0-9_-]{43}$/;

function collect(
  child,
  {
    input,
    timeoutMs = DEFAULT_KEYCHAIN_TIMEOUT_MS,
    allowedExitCodes = [],
    signal,
  } = {},
) {
  return new Promise((resolvePromise, reject) => {
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const append = (target) => (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_KEYCHAIN_OUTPUT_BYTES) {
        child.kill();
        finish(() =>
          reject(new Error("macOS Keychain returned too much output")),
        );
        return;
      }
      target.push(chunk);
    };
    child.stdout?.on("data", append(stdout));
    child.stderr?.on("data", append(stderr));
    child.once("error", (error) =>
      finish(() =>
        reject(new Error("macOS Keychain operation failed", { cause: error })),
      ),
    );
    child.once("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      finish(() =>
        code === 0 || allowedExitCodes.includes(code)
          ? resolvePromise(output)
          : reject(new Error("macOS Keychain operation failed")),
      );
    });
    const abort = () => {
      child.kill();
      finish(() => reject(signal.reason));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("macOS Keychain operation timed out")));
    }, timeoutMs);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    if (child.stdin) {
      child.stdin.once("error", (error) =>
        finish(() =>
          reject(
            new Error("macOS Keychain operation failed", { cause: error }),
          ),
        ),
      );
      child.stdin.end(input);
    }
  });
}

export class MacOsKeychainStore {
  constructor({
    spawnImpl = spawn,
    platform = process.platform,
    timeoutMs = DEFAULT_KEYCHAIN_TIMEOUT_MS,
  } = {}) {
    if (platform !== "darwin") {
      throw new Error(
        "Receiver credentials require macOS Keychain on this release; no plaintext fallback is available",
      );
    }
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
  }

  async set(account, secret, { signal } = {}) {
    signal?.throwIfAborted();
    if (!SAFE_ACCOUNT.test(account) || !SAFE_CREDENTIAL.test(secret)) {
      throw new Error("Invalid receiver Keychain account or credential");
    }
    const child = this.spawnImpl("/usr/bin/security", ["-i"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    await collect(child, {
      input: `add-generic-password -U -s ${RECEIVER_KEYCHAIN_SERVICE} -a ${account} -w ${secret}\n`,
      timeoutMs: this.timeoutMs,
      signal,
    });
    if ((await this.get(account, { signal })) !== secret) {
      throw new Error("macOS Keychain did not persist the receiver credential");
    }
  }

  async get(account, { signal } = {}) {
    signal?.throwIfAborted();
    if (!SAFE_ACCOUNT.test(account))
      throw new Error("Invalid Keychain account");
    const child = this.spawnImpl(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        RECEIVER_KEYCHAIN_SERVICE,
        "-a",
        account,
        "-w",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const secret = (
      await collect(child, { timeoutMs: this.timeoutMs, signal })
    ).replace(/[\r\n]+$/, "");
    if (!SAFE_CREDENTIAL.test(secret)) {
      throw new Error("macOS Keychain returned an invalid receiver credential");
    }
    return secret;
  }

  async delete(account, { signal } = {}) {
    signal?.throwIfAborted();
    if (!SAFE_ACCOUNT.test(account))
      throw new Error("Invalid Keychain account");
    const child = this.spawnImpl(
      "/usr/bin/security",
      [
        "delete-generic-password",
        "-s",
        RECEIVER_KEYCHAIN_SERVICE,
        "-a",
        account,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await collect(child, {
      timeoutMs: this.timeoutMs,
      allowedExitCodes: [44],
      signal,
    });
  }
}
