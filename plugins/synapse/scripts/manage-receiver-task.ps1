param(
  [Parameter(Mandatory = $true)][ValidateSet("start", "stop", "status")][string]$Action,
  [Parameter(Mandatory = $true)][string]$Launcher
)
$ErrorActionPreference = "Stop"
$taskName = "Synapse Receiver"
if ($Action -eq "status") {
  Get-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
  exit 0
}
if ($Action -eq "stop") {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  # Stopping/unregistering the task only terminates the wrapper PowerShell
  # process Task Scheduler tracks; the node.exe child it launched via `&`
  # does not belong to that lifecycle on Windows and survives as an orphan.
  # Parse the exact target script path back out of the launcher we generated
  # and forcibly stop any node.exe process still running it.
  if (Test-Path -LiteralPath $Launcher) {
    $launcherContent = Get-Content -LiteralPath $Launcher -Raw
    if ($launcherContent -match "&\s+'[^']*'\s+'([^']*)'") {
      $scriptPath = $Matches[1]
      Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($scriptPath) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
  }
  exit 0
}
$powerShell = Join-Path $PSHOME "powershell.exe"
$quotedLauncher = '"' + $Launcher.Replace('"', '""') + '"'
$taskAction = New-ScheduledTaskAction -Execute $powerShell -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File $quotedLauncher"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
