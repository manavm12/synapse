import { WorkerConfigurationError } from "./diagnostics.mjs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function workerScope(scope) {
  if (!scope || !UUID.test(scope.ownerId) || !UUID.test(scope.projectId))
    throw new WorkerConfigurationError(
      "Exact owner and project UUIDs are required",
    );
  if (scope.revisionId !== undefined && !UUID.test(scope.revisionId))
    throw new WorkerConfigurationError("An exact revision UUID is required");
  return Object.freeze({
    ownerId: scope.ownerId.toLowerCase(),
    projectId: scope.projectId.toLowerCase(),
    ...(scope.revisionId === undefined
      ? {}
      : { revisionId: scope.revisionId.toLowerCase() }),
  });
}

export function parseWorkerArguments(args, { status = false } = {}) {
  if (
    (args.length === 1 && args[0] === "--help") ||
    (!status &&
      args.length === 2 &&
      args[0] === "--canary" &&
      args[1] === "--help")
  )
    return { help: true };
  if (!status && !args.length) return { scope: null, maxJobs: null };
  if (!status && args[0] !== "--canary")
    throw new WorkerConfigurationError(
      "Use --canary with --owner-id, --project-id and --max-jobs",
    );
  const input = status ? args : args.slice(1);
  const values = {};
  const allowed = status
    ? ["--owner-id", "--project-id"]
    : ["--owner-id", "--project-id", "--max-jobs", "--revision-id"];
  for (let index = 0; index < input.length; index += 2) {
    const flag = input[index],
      value = input[index + 1];
    if (
      !allowed.includes(flag) ||
      Object.hasOwn(values, flag) ||
      !value ||
      value.startsWith("--")
    )
      throw new WorkerConfigurationError(
        "Invalid or duplicate worker option; use --help",
      );
    values[flag] = value;
  }
  const scope = workerScope({
    ownerId: values["--owner-id"],
    projectId: values["--project-id"],
    ...(values["--revision-id"] === undefined
      ? {}
      : { revisionId: values["--revision-id"] }),
  });
  if (status) return { scope };
  const maxJobs = Number(values["--max-jobs"]);
  if (
    !/^[1-9]\d*$/.test(values["--max-jobs"]) ||
    !Number.isSafeInteger(maxJobs) ||
    maxJobs > 1000
  )
    throw new WorkerConfigurationError(
      "--max-jobs must be an integer from 1 to 1000",
    );
  if (scope.revisionId && maxJobs !== 1)
    throw new WorkerConfigurationError(
      "A revision-targeted canary requires --max-jobs 1",
    );
  return { scope, maxJobs };
}
