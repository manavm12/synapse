import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function openExternalUrl(url, { platform = process.platform, runCommand = exec, signal } = {}) {
  const value = new URL(url);
  if (!["https:", "http:"].includes(value.protocol)) throw new Error("Browser URL must use HTTP or HTTPS");
  if (platform === "darwin") return runCommand("/usr/bin/open", [value.href], { signal, stdio: "ignore" });
  if (platform === "win32") return runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $args[0]", value.href], { signal, windowsHide: true, stdio: "ignore" });
  if (platform === "linux") return runCommand("xdg-open", [value.href], { signal, stdio: "ignore" });
  throw new Error(`Opening a browser is not supported on ${platform}`);
}
