# Local setup and diagnostics

Synapse setup is resumable: completed steps are detected and left alone. It uses
Codex's supported plugin and MCP commands instead of editing `~/.codex` directly,
and it never removes or replaces an existing marketplace, plugin, or project
binding.

## Requirements and distribution boundary

- Node.js 24, npm 11, Git, and a current Codex CLI are required.
- The marketplace source is this repository checkout. During the private alpha,
  the user must already have authorized access to this private repository. The
  setup command does not clone it or make the plugin public.
- OAuth uses an email magic link. Supabase's built-in email sender reaches only
  project-team addresses. Arbitrary alpha users require custom SMTP to be
  configured by the operator; setup does not change hosted settings.
- Setup includes the messaging receiver. Its credential is generated locally,
  stored in macOS Keychain, and never printed or placed in the browser URL.

Install dependencies in the Synapse checkout, then connect a primary Git
checkout to the alias selected during hosted account creation:

```sh
npm ci --ignore-scripts
npm run synapse -- setup /absolute/path/to/project --alias <project-alias>
```

Setup performs these stages in order:

1. Validate that the target is a primary Git checkout and the alias is valid.
2. Add this checkout as the `synapse` marketplace if it is missing.
3. Install `synapse@synapse` if it is missing.
4. Run `codex mcp login synapse-memory` if no successful login receipt exists.
5. Add the local alias binding if it is missing.
6. Open the receiver consent page and finish enrollment automatically after the
   user approves **Enable incoming tasks**.

If setup stops, fix the reported problem and run the same command again. To
repeat OAuth deliberately after logout, revocation, or an account change, add
`--login`. The receipt in `~/.synapse/setup-state.json` contains the MCP resource
and completion time, never an OAuth token.

Receiver approval is the only additional interaction. Setup waits for up to five
minutes and can be rerun safely if the terminal closes or approval takes longer.
The lower-level receiver commands remain available for diagnostics and recovery.

## Read-only doctor

```sh
npm run synapse -- doctor /absolute/path/to/project --alias <project-alias>
```

`doctor` reads Codex's JSON list output, the non-secret setup receipt, and the
local project registry in read-only mode. It makes no repairs. Use `--json` for
machine-readable output.

Codex reports that an MCP server supports OAuth, but its read-only list command
does not prove that the current token is live. A login receipt therefore means
only that `codex mcp login` previously exited successfully. After setup or any
credential change, start a new Codex task, call `get_identity`, and verify the
expected username, project alias, and `authentication_method: oauth`.

Linked worktrees can use hooks after their main checkout is connected, but setup
and doctor take the primary checkout path because that is the durable local
binding.
