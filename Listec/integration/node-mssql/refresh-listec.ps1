# Rebuild Listec from TypeScript and start the worksheet API on 0.0.0.0:3100.
# Use this after git pull when Tracer region chips return HTTP 404 (stale dist or old process).
# Requires .env next to Listec with SQL credentials (see .env.example).

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "npm run build..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Starting Listec (node dist/example.express.js). Stop with Ctrl+C." -ForegroundColor Green
Write-Host "For Dockerized api-matter: keep LISTEC_API_HOST unset or 0.0.0.0 (not 127.0.0.1)." -ForegroundColor Yellow
node dist/example.express.js
