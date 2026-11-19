<#
  Runs the exploded web app on Tomcat 9 in the foreground.
  Uses a project-local CATALINA_BASE (CrimeRadar/build/tomcat). The Tomcat install is not changed.
  URL: http://localhost:8080/CrimeRadar/   (stop with Ctrl+C)
  Run scripts\build.ps1 first (this script runs it if the web app is missing).
#>
param(
    # Tomcat 9 install folder. Empty = found by scripts\tomcat-home.ps1 (CATALINA_HOME, installer folder, Downloads).
    [string]$TomcatHome,
    [int]$Port = 8080
)

$ErrorActionPreference = 'Stop'
if (-not $TomcatHome) { $TomcatHome = & (Join-Path $PSScriptRoot 'tomcat-home.ps1') }
if (-not $TomcatHome) { Write-Error 'Tomcat 9 not found. Set CATALINA_HOME or pass -TomcatHome <folder>.'; exit 1 }
$repo  = Split-Path -Parent $PSScriptRoot
$build = Join-Path $repo 'CrimeRadar\build'
$webapp = Join-Path $build 'webapp'
$base  = Join-Path $build 'tomcat'

if (-not (Test-Path (Join-Path $webapp 'WEB-INF\classes'))) {
    & (Join-Path $PSScriptRoot 'build.ps1') -TomcatHome $TomcatHome
    if ($LASTEXITCODE -ne 0) { exit 1 }
}

# CATALINA_BASE: copy conf from the Tomcat home the first time
foreach ($d in 'conf', 'logs', 'temp', 'work', 'webapps') { New-Item -ItemType Directory -Force (Join-Path $base $d) | Out-Null }
$serverXml = Join-Path $base 'conf\server.xml'
if (-not (Test-Path $serverXml)) {
    Copy-Item (Join-Path $TomcatHome 'conf\*') (Join-Path $base 'conf') -Recurse -Force
}
# keep the HTTP port in sync with -Port
$xml = Get-Content $serverXml -Raw
$updated = [regex]::Replace($xml, '(<Connector port=")\d+(" protocol="HTTP/1\.1")', "`${1}$Port`${2}")
if ($updated -ne $xml) { Set-Content -Path $serverXml -Value $updated -Encoding UTF8 -NoNewline }

# deploy the exploded app at context /CrimeRadar (META-INF/context.xml is read from there)
$target = Join-Path $base 'webapps\CrimeRadar'
robocopy $webapp $target /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Host "robocopy failed: $LASTEXITCODE"; exit 1 }

# JAVA_HOME from the java that is on PATH
if (-not $env:JAVA_HOME) {
    $line = (cmd /c "java -XshowSettings:properties -version 2>&1" | Select-String 'java\.home' | Select-Object -First 1).ToString()
    $env:JAVA_HOME = ($line -split '=', 2)[1].Trim()
}
$env:CATALINA_HOME = $TomcatHome
$env:CATALINA_BASE = $base
$env:CATALINA_OPTS = '-Duser.timezone=America/Los_Angeles'

Write-Host "Starting Tomcat on http://localhost:$Port/CrimeRadar/ (Ctrl+C to stop)"
& (Join-Path $TomcatHome 'bin\catalina.bat') run
exit $LASTEXITCODE
