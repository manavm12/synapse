import { runStatusCli } from "./status.mjs";

process.exitCode = await runStatusCli(process.argv.slice(2));
