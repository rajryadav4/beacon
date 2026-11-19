<#
  Prints the Tomcat 9 install folder that build.ps1 and run-tomcat.ps1 use.
  Search order:
    1. the CATALINA_HOME environment variable
    2. the Windows installer folder (C:\Program Files\Apache Software Foundation\Tomcat 9.*)
    3. an apache-tomcat-9.* folder (or a folder one level inside it) in your Downloads folder
  A folder counts only if it has lib\servlet-api.jar. Prints nothing if no folder matches.
  To use another folder, pass -TomcatHome to build.ps1 or run-tomcat.ps1.
#>
$candidates = @()
if ($env:CATALINA_HOME) { $candidates += $env:CATALINA_HOME }
$candidates += Get-ChildItem 'C:\Program Files\Apache Software Foundation' -Directory -Filter 'Tomcat 9*' -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName }
$candidates += Get-ChildItem (Join-Path $HOME 'Downloads') -Directory -Filter 'apache-tomcat-9*' -ErrorAction SilentlyContinue |
    ForEach-Object {
        $_.FullName
        Get-ChildItem $_.FullName -Directory -Filter 'apache-tomcat-9*' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
    }
$candidates | Where-Object { $_ -and (Test-Path (Join-Path $_ 'lib\servlet-api.jar')) } | Select-Object -First 1
