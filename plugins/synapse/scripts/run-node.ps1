param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$ScriptPath,

  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]]$ScriptArguments
)

$nodePath = $env:CODEX_MCP_NODE_PATH
if ([string]::IsNullOrWhiteSpace($nodePath) -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  Write-Error 'Synapse needs the Node runtime supplied by Codex. Update/restart Codex and try again.'
  exit 1
}

& $nodePath --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'check-runtime.mjs')
if ($LASTEXITCODE -ne 0) {
  Write-Error 'This Codex runtime lacks the SQLite support required by Synapse. Update Codex.'
  exit 1
}

& $nodePath --disable-warning=ExperimentalWarning $ScriptPath @ScriptArguments
exit $LASTEXITCODE
