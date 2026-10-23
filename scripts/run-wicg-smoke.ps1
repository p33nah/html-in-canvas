param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 8000,
  [ValidateRange(1024, 65535)]
  [int]$DebuggingPort = 9222,
  [ValidateSet('tests/wicg-smoke.html', 'tests/gpu-single.html', 'tests/gpu-multiple.html')]
  [string]$Page = 'tests/wicg-smoke.html'
)

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
$chromeVersion = '158.0.8119.0'
$chrome = Join-Path $localAppData "html-in-canvas-env\chrome-for-testing\$chromeVersion\chrome-win64\chrome.exe"
$profile = Join-Path $localAppData "html-in-canvas-env\profile-canary-$chromeVersion"
$pythonLauncher = Get-Command py.exe -ErrorAction SilentlyContinue

if (!(Test-Path $chrome)) {
  throw "Chrome for Testing $chromeVersion non trovato: $chrome"
}
if (!$pythonLauncher) {
  throw 'Python Launcher (py.exe) non trovato.'
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  throw "La porta del server $Port è già in uso. Scegli una porta libera con -Port."
}
if (Get-NetTCPConnection -LocalPort $DebuggingPort -State Listen -ErrorAction SilentlyContinue) {
  throw "La porta DevTools $DebuggingPort è già in uso. Scegli una porta libera con -DebuggingPort."
}

$python = (& $pythonLauncher.Source -c 'import sys; print(sys.executable)').Trim()
if ($LASTEXITCODE -ne 0 -or !(Test-Path $python)) {
  throw 'Python interpreter del server locale non individuato.'
}

$server = $null
try {
  $server = Start-Process -FilePath $python `
    -ArgumentList @('-m', 'http.server', "$Port", '--bind', '127.0.0.1') `
    -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru

  $url = "http://127.0.0.1:$Port/$Page"
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1
      if ($response.StatusCode -eq 200) {
        $ready = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  if (!$ready) {
    throw "Il server locale non risponde su $url"
  }

  $browserArguments = @(
    "--user-data-dir=$profile",
    '--incognito',
    '--no-first-run',
    '--enable-blink-features=CanvasDrawElement',
    '--remote-debugging-address=127.0.0.1',
    "--remote-debugging-port=$DebuggingPort",
    $url
  )
  $browser = Start-Process -FilePath $chrome -ArgumentList $browserArguments -PassThru -Wait
  if ($browser.ExitCode -ne 0) {
    throw "Chrome for Testing si è chiuso con codice $($browser.ExitCode)."
  }
} finally {
  if ($server -and !$server.HasExited) {
    Stop-Process -Id $server.Id -Force
  }
}
