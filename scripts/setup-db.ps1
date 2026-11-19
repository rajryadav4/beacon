<#
  Builds the app tables (sql/app_tables.sql), imports ml/output, seeds the demo account,
  and prints row counts. Run it AFTER sql/crime_radar_all.sql.
    scripts\setup-db.ps1                 full setup
    scripts\setup-db.ps1 --risk-only     only re-import ml/output/cell_risk.csv and metrics.json
    scripts\setup-db.ps1 --reset         also wipe saved places, trips and preferences
    scripts\setup-db.ps1 --drop-only     drop every app table (before re-running crime_radar_all.sql)
  Exit code 0 = success, 2 = database problem (for example MySQL password not set).
#>
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'build.ps1')
if ($LASTEXITCODE -ne 0) { exit 1 }

$app = Join-Path $repo 'CrimeRadar'
$cp  = (Join-Path $app 'build\classes') + ';' + (Join-Path $app 'src\main\webapp\WEB-INF\lib\*')
Push-Location $repo
try {
    & java -cp $cp crimeradar.tools.SetupAppSchema @args
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $code
