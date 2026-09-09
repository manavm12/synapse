import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installLocalPlugin } from "./lib/local-plugin-install.mjs";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--replace-repo-plugin")) {
  console.error(
    "Usage: node scripts/install-local-plugin.mjs [--replace-repo-plugin]",
  );
  process.exitCode = 1;
} else {
  try {
    const result = await installLocalPlugin(
      resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      {
        replaceRepoPlugin: args.includes("--replace-repo-plugin"),
      },
    );
    console.log(JSON.stringify(result, null, 2));
    console.log(
      "Installed, not yet verified for receiving. Review/trust this plugin's hooks in Codex, then start a fresh task and check Synapse setup status. Existing credentials, destinations and queues were preserved.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
