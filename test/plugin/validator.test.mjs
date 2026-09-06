import assert from "node:assert/strict";
import test from "node:test";

import {
  findRuntimePackageLoads,
  isValidSemver,
} from "../../scripts/validate-plugin.mjs";

test("plugin validation accepts only complete semantic versions", () => {
  assert.equal(isValidSemver("1.2.3-alpha+build"), true);
  assert.equal(isValidSemver("0.2.0+codex.20260906062809"), true);
  assert.equal(isValidSemver("01.2.3"), false);
  assert.equal(isValidSemver("1.2.3-foo."), false);
});

test("dependency validation detects supported package-loading forms", () => {
  const source = `
    import {
      thing
    } from "multiline-package";
    import "side-effect-package";
    export { value } from "re-export-package";
    const dynamic = import("dynamic-package");
    const commonjs = require("commonjs-package");
    const loader = createRequire(import.meta.url);
  `;
  assert.deepEqual(findRuntimePackageLoads(source).sort(), [
    "commonjs-package",
    "createRequire()",
    "dynamic-package",
    "multiline-package",
    "re-export-package",
    "side-effect-package",
  ]);
  assert.deepEqual(
    findRuntimePackageLoads(`
      import { readFile } from "node:fs/promises";
      export { helper } from "./helper.mjs";
      const local = await import("../local.mjs");
    `),
    [],
  );
});
