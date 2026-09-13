#requires -Version 5.1

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$TargetReleaseDir,
  [string[]]$ExtraFiles = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Azure Artifact Signing Public Trust certificates carry this EKU marker in
# addition to the Code Signing EKU. The CN alone is not globally unique.
$artifactSigningPublicTrustEku = '1.3.6.1.4.1.311.97.1.0'

if ($env:SKIP_WIN_CODESIGN -eq '1') {
  Write-Host 'SKIP_WIN_CODESIGN=1; skipping Authenticode verification.'
  exit 0
}

if ($env:OS -ne 'Windows_NT') {
  throw 'Authenticode verification must run on Windows.'
}
if ([string]::IsNullOrWhiteSpace($env:AZURE_ARTIFACT_SIGNING_PUBLISHER)) {
  throw 'AZURE_ARTIFACT_SIGNING_PUBLISHER is required for Authenticode verification.'
}

. (Join-Path $PSScriptRoot 'artifact-signing-tools.ps1')
Import-BundledPowerShellSecurityModule

$releaseDir = (Resolve-Path -LiteralPath $TargetReleaseDir).Path
$files = @()
$files += Get-ChildItem -LiteralPath $releaseDir -File -Filter '*.exe'

$bundleDir = Join-Path $releaseDir 'bundle'
if (Test-Path -LiteralPath $bundleDir) {
  $files += Get-ChildItem -LiteralPath $bundleDir -File -Recurse |
    Where-Object { $_.Extension.ToLowerInvariant() -in @('.exe', '.msi') }
}

if (-not [string]::IsNullOrWhiteSpace($env:POSTAL_SNAP_INSTALLED_EXE)) {
  $ExtraFiles += $env:POSTAL_SNAP_INSTALLED_EXE.Trim()
}

foreach ($extra in $ExtraFiles) {
  if ($extra -and (Test-Path -LiteralPath $extra)) {
    $files += Get-Item -LiteralPath $extra
  }
}

$files = @($files | Sort-Object FullName -Unique)
if ($files.Count -eq 0) {
  throw "No Windows runtime or installer artifacts were found under $releaseDir"
}

$expectedPublisher = $env:AZURE_ARTIFACT_SIGNING_PUBLISHER.Trim()
$expectedSubject = $env:AZURE_ARTIFACT_SIGNING_PUBLISHER_DN
if (-not [string]::IsNullOrWhiteSpace($expectedSubject)) {
  $expectedSubject = $expectedSubject.Trim()
} else {
  $expectedSubject = $null
  Write-Host 'AZURE_ARTIFACT_SIGNING_PUBLISHER_DN is not set; pinning the publisher CN and the Artifact Signing Public Trust EKU only.'
}
foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Invalid or missing Authenticode signature: $($file.FullName) ($($signature.Status))"
  }
  if (-not $signature.SignerCertificate) {
    throw "Missing signer certificate: $($file.FullName)"
  }

  $actualPublisher = $signature.SignerCertificate.GetNameInfo(
    [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
  )
  if ($actualPublisher -ne $expectedPublisher) {
    throw "Unexpected publisher for $($file.FullName). Expected '$expectedPublisher', got '$actualPublisher'."
  }
  if ($expectedSubject) {
    $subject = $signature.SignerCertificate.Subject.Trim()
    if ($subject -ne $expectedSubject) {
      throw "Unexpected certificate Subject for $($file.FullName). Expected '$expectedSubject', got '$subject'."
    }
  }

  $ekuExtension = $signature.SignerCertificate.Extensions |
    Where-Object { $_.Oid.Value -eq '2.5.29.37' } |
    Select-Object -First 1
  if (-not $ekuExtension) {
    throw "Signer certificate has no Extended Key Usage extension: $($file.FullName)"
  }
  $ekus = @($ekuExtension.EnhancedKeyUsages | ForEach-Object { $_.Value })
  if ($ekus -notcontains $artifactSigningPublicTrustEku) {
    throw "Signer certificate for $($file.FullName) is not an Azure Artifact Signing Public Trust certificate (missing EKU $artifactSigningPublicTrustEku)."
  }

  if (-not $signature.TimeStamperCertificate) {
    throw "Missing RFC3161 timestamp: $($file.FullName)"
  }

  Write-Host "Verified: $($file.FullName)"
}

Write-Host "Verified $($files.Count) timestamped Windows artifact(s) from '$expectedPublisher'."
