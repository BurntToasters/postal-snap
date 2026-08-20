$ErrorActionPreference = "Stop"
if ($env:WINDOWS_CERTIFICATE_PFX_BASE64) {
  if (-not $env:WINDOWS_CERTIFICATE_PASSWORD) { throw "Set WINDOWS_CERTIFICATE_PASSWORD for the PFX." }
  $temporary = Join-Path ([IO.Path]::GetTempPath()) ("postal-snap-" + [Guid]::NewGuid().ToString() + ".pfx")
  try {
    [IO.File]::WriteAllBytes($temporary, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE_PFX_BASE64))
    $password = ConvertTo-SecureString $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
    $imported = Import-PfxCertificate -FilePath $temporary -CertStoreLocation Cert:\CurrentUser\My -Password $password
    if (-not $imported) { throw "The Windows signing certificate could not be imported." }
    if ($env:WINDOWS_CERTIFICATE_THUMBPRINT -and $imported.Thumbprint -ne $env:WINDOWS_CERTIFICATE_THUMBPRINT) {
      throw "The imported Windows certificate does not match WINDOWS_CERTIFICATE_THUMBPRINT."
    }
    $env:WINDOWS_CERTIFICATE_THUMBPRINT = $imported.Thumbprint
  } finally {
    Remove-Item $temporary -Force -ErrorAction SilentlyContinue
  }
}
if (-not $env:WINDOWS_CERTIFICATE_THUMBPRINT) { throw "Set WINDOWS_CERTIFICATE_THUMBPRINT or provide the PFX secrets." }
$cert = Get-ChildItem Cert:\CurrentUser\My\$env:WINDOWS_CERTIFICATE_THUMBPRINT
if (-not $cert.HasPrivateKey) { throw "The configured signing certificate has no private key." }
if ($env:GITHUB_ENV) {
  "WINDOWS_CERTIFICATE_THUMBPRINT=$($cert.Thumbprint)" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
}
Write-Host "Windows artifact signing certificate is available: $($cert.Subject)"
