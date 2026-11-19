<#
  Keeps the database fresh from the Seattle open data API (SPD dataset tazs-3rd5).
    scripts\sync.ps1             fetch new offenses, drop data older than 4 years,
                                 rebuild the summary tables (the running app reloads in 30 s)
    scripts\sync.ps1 -Retrain    also refresh the CSV, retrain the risk model, rebuild the
                                 static JSON, and re-import the model:
                                   python pipeline/fetch_spd.py
                                   python ml/train_risk_model.py
                                   python pipeline/build_ui_data.py
                                   scripts\setup-db.ps1 --risk-only
  Exit code: 0 ok, 2 database error, 3 API error, 1 anything else.

  RUN IT TWICE A DAY with Windows Task Scheduler (run these once yourself; this script does NOT
  create the tasks). Use your own paths; the "start in" folder is the repository root:

    schtasks /Create /TN "CrimeRadar Sync 0600" /SC DAILY /ST 06:00 /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\CrimeRadar\scripts\sync.ps1"
    schtasks /Create /TN "CrimeRadar Sync 1800" /SC DAILY /ST 18:00 /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\CrimeRadar\scripts\sync.ps1"

  Retrain once a day is enough (add -Retrain to the 06:00 task only).
  Show or remove a task:  schtasks /Query /TN "CrimeRadar Sync 0600"   schtasks /Delete /TN "CrimeRadar Sync 0600" /F
  MySQL must be running when the task starts. Output is also saved in logs\sync.log.
#>
param(
    [switch]$Retrain
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
New-Item -ItemType Directory -Force (Join-Path $repo 'logs') | Out-Null
$log = Join-Path $repo 'logs\sync.log'

function Write-Log([string]$text) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $text"
    Write-Host $line
    Add-Content -Path $log -Value $line
}

& (Join-Path $PSScriptRoot 'build.ps1') | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Log 'Build failed.'; exit 1 }

$app = Join-Path $repo 'CrimeRadar'
$cp  = (Join-Path $app 'build\classes') + ';' + (Join-Path $app 'src\main\webapp\WEB-INF\lib\*')

Write-Log 'Sync started.'
$ErrorActionPreference = 'Continue'
& java -cp $cp crimeradar.tools.SyncIncidents 2>&1 | ForEach-Object { Write-Log "$_" }
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Write-Log "SyncIncidents finished with exit code $code."
if ($code -ne 0) { exit $code }

if ($Retrain) {
    $steps = @(
        @('python', 'pipeline/fetch_spd.py'),
        @('python', 'ml/train_risk_model.py'),
        @('python', 'pipeline/build_ui_data.py')
    )
    $ErrorActionPreference = 'Continue'
    foreach ($s in $steps) {
        Write-Log ("Running: " + ($s -join ' '))
        & $s[0] $s[1..($s.Length - 1)] 2>&1 | ForEach-Object { Write-Log "$_" }
        if ($LASTEXITCODE -ne 0) { Write-Log "Step failed with exit code $LASTEXITCODE."; exit 1 }
    }
    Write-Log 'Running: scripts\setup-db.ps1 --risk-only'
    & (Join-Path $PSScriptRoot 'setup-db.ps1') --risk-only 2>&1 | ForEach-Object { Write-Log "$_" }
    if ($LASTEXITCODE -ne 0) { Write-Log "setup-db failed with exit code $LASTEXITCODE."; exit 2 }
    $ErrorActionPreference = 'Stop'
}

Write-Log 'Sync done.'
exit 0
