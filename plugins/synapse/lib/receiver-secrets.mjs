import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RECEIVER_KEYCHAIN_SERVICE = "com.openai.synapse.receiver.v1";
const MAX_OUTPUT_BYTES = 8 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const SAFE_ACCOUNT = /^receiver:[a-zA-Z0-9._:-]{1,128}$/;
const SAFE_CREDENTIAL = /^syn_recv_[a-zA-Z0-9_-]{43}$/;

function validAccount(value) {
  if (!SAFE_ACCOUNT.test(value))
    throw new Error("Invalid receiver credential account");
}
function validCredential(value) {
  if (!SAFE_CREDENTIAL.test(value))
    throw new Error("Invalid receiver credential");
}

function collect(
  child,
  {
    input,
    label,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    allowedExitCodes = [],
    signal,
  } = {},
) {
  return new Promise((resolvePromise, reject) => {
    const stdout = [];
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
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(() => reject(new Error(`${label} returned too much output`)));
      } else target?.push(chunk);
    };
    child.stdout?.on("data", append(stdout));
    // Drain but never report helper stderr; a faulty helper must not leak a secret.
    child.stderr?.on("data", append());
    child.once("error", (error) =>
      finish(() =>
        reject(new Error(`${label} operation failed`, { cause: error })),
      ),
    );
    child.once("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      finish(() =>
        code === 0 || allowedExitCodes.includes(code)
          ? resolvePromise(output)
          : reject(new Error(`${label} operation failed`)),
      );
    });
    const abort = () => {
      child.kill();
      finish(() => reject(signal.reason));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`${label} operation timed out`)));
    }, timeoutMs);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    if (child.stdin) {
      child.stdin.once("error", (error) =>
        finish(() =>
          reject(new Error(`${label} operation failed`, { cause: error })),
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
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (platform !== "darwin")
      throw new Error("macOS Keychain is only available on macOS");
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
  }
  async set(account, secret, { signal } = {}) {
    signal?.throwIfAborted();
    validAccount(account);
    validCredential(secret);
    const child = this.spawnImpl("/usr/bin/security", ["-i"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    await collect(child, {
      input: `add-generic-password -U -s ${RECEIVER_KEYCHAIN_SERVICE} -a ${account} -w ${secret}\n`,
      label: "macOS Keychain",
      timeoutMs: this.timeoutMs,
      signal,
    });
    if ((await this.get(account, { signal })) !== secret)
      throw new Error("macOS Keychain did not persist the receiver credential");
  }
  async get(account, { signal } = {}) {
    signal?.throwIfAborted();
    validAccount(account);
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
      await collect(child, {
        label: "macOS Keychain",
        timeoutMs: this.timeoutMs,
        signal,
      })
    ).replace(/[\r\n]+$/, "");
    validCredential(secret);
    return secret;
  }
  async delete(account, { signal } = {}) {
    signal?.throwIfAborted();
    validAccount(account);
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
      label: "macOS Keychain",
      timeoutMs: this.timeoutMs,
      allowedExitCodes: [44],
      signal,
    });
  }
}

export class WindowsDpapiStore {
  constructor({
    spawnImpl = spawn,
    platform = process.platform,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env = process.env,
    directory = resolve(
      env.SYNAPSE_HOME ?? join(homedir(), ".synapse"),
      "receiver-secrets",
    ),
    script = fileURLToPath(
      new URL("../scripts/windows-secret.ps1", import.meta.url),
    ),
  } = {}) {
    if (platform !== "win32")
      throw new Error("Windows DPAPI is only available on Windows");
    Object.assign(this, { spawnImpl, timeoutMs, directory, script });
  }
  path(account) {
    validAccount(account);
    return join(
      this.directory,
      `${createHash("sha256").update(account).digest("hex")}.dpapi`,
    );
  }
  run(operation, account, input, signal) {
    const child = this.spawnImpl(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        this.script,
        operation,
        RECEIVER_KEYCHAIN_SERVICE,
        account,
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    return collect(child, {
      input,
      label: "Windows DPAPI",
      timeoutMs: this.timeoutMs,
      signal,
    });
  }
  async set(account, secret, { signal } = {}) {
    signal?.throwIfAborted();
    validCredential(secret);
    const path = this.path(account);
    const encrypted = (
      await this.run("protect", account, secret, signal)
    ).trim();
    if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(encrypted))
      throw new Error("Windows DPAPI returned invalid protected data");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${encrypted}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, path);
      await chmod(path, 0o600).catch(() => {});
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    if ((await this.get(account, { signal })) !== secret)
      throw new Error("Windows DPAPI did not persist the receiver credential");
  }
  async get(account, { signal } = {}) {
    signal?.throwIfAborted();
    const encrypted = await readFile(this.path(account), "utf8");
    const secret = (
      await this.run("unprotect", account, encrypted.trim(), signal)
    ).replace(/[\r\n]+$/, "");
    validCredential(secret);
    return secret;
  }
  async delete(account, { signal } = {}) {
    signal?.throwIfAborted();
    await unlink(this.path(account)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export class LinuxSecretServiceStore {
  constructor({
    spawnImpl = spawn,
    platform = process.platform,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (platform !== "linux")
      throw new Error("Secret Service is only available on Linux");
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
  }
  run(arguments_, { input, allowedExitCodes, signal } = {}) {
    const child = this.spawnImpl("secret-tool", arguments_, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    return collect(child, {
      input,
      label: "Linux Secret Service",
      timeoutMs: this.timeoutMs,
      allowedExitCodes,
      signal,
    });
  }
  async set(account, secret, { signal } = {}) {
    signal?.throwIfAborted();
    validAccount(account);
    validCredential(secret);
    await this.run(
      [
        "store",
        "--label",
        "Synapse receiver",
        "service",
        RECEIVER_KEYCHAIN_SERVICE,
        "account",
        account,
      ],
      { input: secret, signal },
    );
    if ((await this.get(account, { signal })) !== secret)
      throw new Error(
        "Linux Secret Service did not persist the receiver credential",
      );
  }
  async get(account, { signal } = {}) {
    signal?.throwIfAborted();
    validAccount(account);
    const secret = (
      await this.run(
        ["lookup", "service", RECEIVER_KEYCHAIN_SERVICE, "account", account],
        { signal },
      )
    ).replace(/[\r\n]+$/, "");
    validCredential(secret);
    return secret;
  }
  async delete(account, { signal } = {}) {
    signal?.throwIfAborted();
    validAccount(account);
    await this.run(
      ["clear", "service", RECEIVER_KEYCHAIN_SERVICE, "account", account],
      { allowedExitCodes: [1], signal },
    );
  }
}

export function createReceiverSecretStore({
  platform = process.platform,
  ...options
} = {}) {
  if (platform === "darwin")
    return new MacOsKeychainStore({ ...options, platform });
  if (platform === "win32")
    return new WindowsDpapiStore({ ...options, platform });
  if (platform === "linux")
    return new LinuxSecretServiceStore({ ...options, platform });
  throw new Error(`Receiver credentials are not supported on ${platform}`);
}
