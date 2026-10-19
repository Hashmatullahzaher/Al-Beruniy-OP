[CmdletBinding()]
param(
  [string]$Container = "abos-shareholder-finance-0036-pg",
  [string]$Database = "abos_capital_browser_preview_0038"
)

$ErrorActionPreference = "Stop"
if ($Database -ne "abos_capital_browser_preview_0038" -or $Container -ne "abos-shareholder-finance-0036-pg") {
  throw "This runner is locked to the dedicated disposable capital PostgreSQL container and browser database."
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$details = docker inspect $Container | ConvertFrom-Json
if (-not $details -or $details[0].State.Status -ne "running") {
  throw "The dedicated PostgreSQL container is not running."
}

$containerEnvironment = @{}
foreach ($entry in $details[0].Config.Env) {
  $parts = $entry -split "=", 2
  $containerEnvironment[$parts[0]] = $parts[1]
}
$postgresUser = $containerEnvironment["POSTGRES_USER"]
$postgresPassword = $containerEnvironment["POSTGRES_PASSWORD"]
$hostPort = $details[0].NetworkSettings.Ports."5432/tcp"[0].HostPort
if (-not $postgresUser -or -not $postgresPassword -or -not $hostPort) {
  throw "The disposable PostgreSQL connection metadata is incomplete."
}
if ($hostPort -ne "55442") { throw "Refusing a PostgreSQL port other than disposable 55442." }

$existing = docker exec -e "PGPASSWORD=$postgresPassword" $Container psql -X -qAt -v ON_ERROR_STOP=1 -U $postgresUser -d postgres -c "SELECT 1 FROM pg_database WHERE datname='$Database'"
if ($existing -ne "1") {
  docker exec -e "PGPASSWORD=$postgresPassword" $Container createdb -U $postgresUser $Database
  if ($LASTEXITCODE -ne 0) { throw "Could not create the disposable browser database." }
}

$encodedUser = [System.Uri]::EscapeDataString($postgresUser)
$encodedPassword = [System.Uri]::EscapeDataString($postgresPassword)
$ownerUrl = "postgresql://${encodedUser}:${encodedPassword}@127.0.0.1:${hostPort}/${Database}"
$identityUrl = "postgresql://abos_v1_identity_runtime_test_login:synthetic-identity-runtime-only-2026@127.0.0.1:${hostPort}/${Database}"
$financeUrl = "postgresql://abos_e1_finance_runtime_test_login:synthetic-finance-runtime-only-2026@127.0.0.1:${hostPort}/${Database}"
$treasuryUrl = "postgresql://abos_e1_treasury_runtime_test_login:synthetic-treasury-runtime-only-2026@127.0.0.1:${hostPort}/${Database}"

$env:ABOS_DATABASE_URL = $ownerUrl
$env:ABOS_TEST_DATABASE_URL = $ownerUrl
$env:ABOS_TEST_CLUSTER_LOCK_DATABASE = "postgres"
$env:ABOS_IDENTITY_DATABASE_URL = $identityUrl
$env:ABOS_FINANCE_DATABASE_URL = $financeUrl
$env:ABOS_TREASURY_DATABASE_URL = $treasuryUrl
$env:ABOS_ENVIRONMENT = "development"
$env:ABOS_SANDBOX_RUNTIME_MARKER = "capital-browser-0038"
$env:ABOS_SANDBOX_SIGNING_SECRET = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$env:ABOS_SANDBOX_MAX_SESSION_SECONDS = "3600"
$env:ABOS_SHAREHOLDER_FINANCE_REVIEW_MODE = "0"
$env:ABOS_V1_PREVIEW_E2E = "1"
$env:NODE_ENV = "development"

Push-Location $root
try {
  pnpm --filter @abos/e1-integration preview:capital-bootstrap
  if ($LASTEXITCODE -ne 0) { throw "Capital browser database bootstrap failed." }
  pnpm --filter @abos/web test:capital
  if ($LASTEXITCODE -ne 0) { throw "Capital browser workflow failed." }
} finally {
  Pop-Location
  foreach ($key in @(
    "ABOS_DATABASE_URL", "ABOS_TEST_DATABASE_URL", "ABOS_TEST_CLUSTER_LOCK_DATABASE",
    "ABOS_IDENTITY_DATABASE_URL", "ABOS_FINANCE_DATABASE_URL", "ABOS_TREASURY_DATABASE_URL",
    "ABOS_ENVIRONMENT", "ABOS_SANDBOX_RUNTIME_MARKER", "ABOS_SANDBOX_SIGNING_SECRET",
    "ABOS_SANDBOX_MAX_SESSION_SECONDS", "ABOS_SHAREHOLDER_FINANCE_REVIEW_MODE", "ABOS_V1_PREVIEW_E2E", "NODE_ENV"
  )) {
    Remove-Item "Env:$key" -ErrorAction SilentlyContinue
  }
}
