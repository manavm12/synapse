param(
  [Parameter(Mandatory = $true)][ValidateSet("protect", "unprotect")][string]$Operation,
  [Parameter(Mandatory = $true)][string]$Service,
  [Parameter(Mandatory = $true)][string]$Account
)
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Security
$value = [Console]::In.ReadToEnd()
$entropy = [System.Text.Encoding]::UTF8.GetBytes("${Service}:${Account}")
if ($Operation -eq "protect") {
  $plain = [System.Text.Encoding]::UTF8.GetBytes($value)
  $protected = [System.Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($protected))
} else {
  $protected = [Convert]::FromBase64String($value.Trim())
  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))
}
