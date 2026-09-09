param([ValidateSet('start','stop','restart','status','logs')][string]$Action = 'start')
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $projectRoot
docker info | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop must be running with Linux containers.' }
function Invoke-Compose { docker compose --env-file .quickstart/config.env -f docker/quickstart/compose.yaml @args; if ($LASTEXITCODE -ne 0) { throw 'Docker Compose failed.' } }
if (-not (Test-Path -LiteralPath '.quickstart/config.env')) {
    if ($Action -ne 'start') { throw 'Run start first.' }
    $adminEmail = Read-Host 'Administrator email'
    if ($adminEmail -notmatch '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$') { throw 'Invalid email.' }
    New-Item -ItemType Directory -Path '.quickstart/secrets' -Force | Out-Null
    foreach ($name in @('postgres_password','master_key','log_service_token','admin_password')) {
        $target = Join-Path $projectRoot ('.quickstart/secrets/' + $name)
        if (-not (Test-Path -LiteralPath $target)) {
            $bytes = New-Object byte[] 32
            $random = [Security.Cryptography.RandomNumberGenerator]::Create()
            try { $random.GetBytes($bytes) } finally { $random.Dispose() }
            $value = [Convert]::ToBase64String($bytes)
            [IO.File]::WriteAllText($target, $value, [Text.UTF8Encoding]::new($false))
        }
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    icacls .quickstart /inheritance:r /grant:r "${identity}:(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict secret directory permissions.' }
    [IO.File]::WriteAllLines((Join-Path $projectRoot '.quickstart/config.env'), @("GEO_ADMIN_EMAIL=$adminEmail",'GEO_BIND=127.0.0.1','GEO_HTTP_PORT=8080','GEO_HTTPS_PORT=8443','GEO_SITE_ADDRESS=http://localhost','GEO_ORIGIN=http://localhost:8080'), [Text.UTF8Encoding]::new($false))
}
foreach ($name in @('postgres_password','master_key','log_service_token','admin_password')) {
    if (-not (Test-Path -LiteralPath ".quickstart/secrets/$name")) { throw "Missing $name. Restore your backup; do not regenerate credentials." }
}
switch ($Action) {
    start { Invoke-Compose config --quiet; Invoke-Compose build api web; Invoke-Compose up -d --wait --wait-timeout 180; Write-Output 'Ready: http://localhost:8080/app/'; Write-Output 'Administrator password: .quickstart/secrets/admin_password' }
    stop { Invoke-Compose stop }
    restart { Invoke-Compose restart }
    status { Invoke-Compose ps }
    logs { Invoke-Compose logs --tail 100 }
}
