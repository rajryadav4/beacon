<#
  Runs SQL against the CrimeRadar database with the app's own db.properties (no mysql client needed).
    scripts\sql.ps1 "SELECT COUNT(*) FROM CellStats"
    scripts\sql.ps1 "EXPLAIN SELECT ..."
  Needs scripts\build.ps1 to have run once.
#>
$repo = Split-Path -Parent $PSScriptRoot
$app  = Join-Path $repo 'CrimeRadar'
$cp   = (Join-Path $app 'build\classes') + ';' + (Join-Path $app 'src\main\webapp\WEB-INF\lib\*')
& java -cp $cp crimeradar.tools.SqlConsole @args
exit $LASTEXITCODE
