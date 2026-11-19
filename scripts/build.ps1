<#
  Compiles the Java sources and assembles an exploded web app.
    CrimeRadar/build/classes   compiled classes (+ db.properties copied next to them)
    CrimeRadar/build/webapp    webapp files + WEB-INF/classes
  Run from anywhere:  powershell -File scripts\build.ps1
  Exit code 0 = success.
#>
param(
    # Tomcat 9 install folder. Empty = found by scripts\tomcat-home.ps1 (CATALINA_HOME, installer folder, Downloads).
    [string]$TomcatHome
)

$ErrorActionPreference = 'Stop'
if (-not $TomcatHome) { $TomcatHome = & (Join-Path $PSScriptRoot 'tomcat-home.ps1') }
if (-not $TomcatHome) { Write-Error 'Tomcat 9 not found. Set CATALINA_HOME or pass -TomcatHome <folder>.'; exit 1 }
$repo    = Split-Path -Parent $PSScriptRoot
$app     = Join-Path $repo 'CrimeRadar'
$src     = Join-Path $app 'src\main\java'
$web     = Join-Path $app 'src\main\webapp'
$lib     = Join-Path $web 'WEB-INF\lib'
$build   = Join-Path $app 'build'
$classes = Join-Path $build 'classes'
$out     = Join-Path $build 'webapp'
$servletApi = Join-Path $TomcatHome 'lib\servlet-api.jar'

if (-not (Test-Path $servletApi)) { Write-Error "servlet-api.jar not found at $servletApi. Pass -TomcatHome."; exit 1 }
if (-not (Get-Command javac -ErrorAction SilentlyContinue)) { Write-Error 'javac is not on PATH.'; exit 1 }

# 1. compile
if (Test-Path $classes) { Remove-Item -Recurse -Force $classes }
New-Item -ItemType Directory -Force $classes | Out-Null
$files = Get-ChildItem $src -Recurse -Filter *.java | ForEach-Object { '"' + ($_.FullName -replace '\\', '/') + '"' }
$argFile = Join-Path $build 'sources.txt'
Set-Content -Path $argFile -Value $files -Encoding ASCII
$jars = @($servletApi) + (Get-ChildItem $lib -Filter *.jar | ForEach-Object { $_.FullName })
$cp = $jars -join ';'
Write-Host "Compiling $($files.Count) files with javac --release 17 ..."
& javac --release 17 -encoding UTF-8 -Xlint:all -Xlint:-serial -cp $cp -d $classes "@$argFile"
if ($LASTEXITCODE -ne 0) { Write-Host "javac failed (exit $LASTEXITCODE)"; exit 1 }

# 2. credentials file next to the classes (its content is never printed)
$props = Join-Path $src 'db.properties'
if (Test-Path $props) {
    Copy-Item $props (Join-Path $classes 'db.properties') -Force
    Write-Host 'Copied db.properties next to the classes.'
} else {
    Write-Host 'WARNING: src\main\java\db.properties is missing. Copy db.properties.example and set your password.'
}

# 3. exploded web app
robocopy $web $out /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Host "robocopy (webapp) failed: $LASTEXITCODE"; exit 1 }
robocopy $classes (Join-Path $out 'WEB-INF\classes') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Host "robocopy (classes) failed: $LASTEXITCODE"; exit 1 }

Write-Host "Build OK. Exploded web app: $out"
exit 0
