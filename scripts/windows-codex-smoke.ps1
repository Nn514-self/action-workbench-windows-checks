# Offline CLI qualification after fetching the pinned public distribution. No model request or login.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'Requires native Windows x64' }
$work = Join-Path ([IO.Path]::GetTempPath()) ('Codex 验收 ' + [Guid]::NewGuid().ToString('N'))
$version = '0.147.0'
$name = 'codex-x86_64-pc-windows-msvc.exe'
$zipHash = 'a1c073ede409178502b1ff11bed635d2b644424352f9d4f3999de8272c6aebbd'
$exeHash = '935a1911ed2556e4ffcec995f4886ac2ac425863ba26fed264df62e30272ad9d'
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $zip = Join-Path $work 'cli.zip'
  Invoke-WebRequest "https://github.com/openai/codex/releases/download/rust-v$version/$name.zip" -OutFile $zip
  if ((Get-FileHash -LiteralPath $zip).Hash -ne $zipHash) { throw 'Codex archive checksum mismatch' }
  Expand-Archive -LiteralPath $zip -DestinationPath $work
  $binaries = @(Get-ChildItem -LiteralPath $work -Recurse -Filter '*.exe' | Where-Object { $_.Name -in @($name,'codex.exe') })
  if ($binaries.Count -ne 1 -or (Get-FileHash -LiteralPath $binaries[0].FullName).Hash -ne $exeHash) { throw 'Codex executable checksum mismatch' }
  $exe = $binaries[0].FullName
  # Isolate the child from the caller's home, tokens and credential stores. Only safe OS variables are inherited.
  function Invoke-Isolated([string[]]$CommandArgs) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName=$exe; $info.WorkingDirectory=$work; $info.UseShellExecute=$false
    $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true; $info.CreateNoWindow=$true
    $info.Environment.Clear()
    foreach ($key in @('SystemRoot','PATH','TEMP','TMP')) { $info.Environment[$key]=[Environment]::GetEnvironmentVariable($key) }
    $info.Environment['CODEX_HOME']=$work; $info.Environment['USERPROFILE']=$work; $info.Environment['HOME']=$work
    foreach ($arg in $CommandArgs) { $info.ArgumentList.Add($arg) }
    $p=[Diagnostics.Process]::Start($info)
    try {
      $out=$p.StandardOutput.ReadToEndAsync(); $err=$p.StandardError.ReadToEndAsync()
      if (!$p.WaitForExit(20000)) { $p.Kill($true); $p.WaitForExit(); throw 'Codex CLI timed out' }
      return @{Code=$p.ExitCode; Text=($out.Result + $err.Result)}
    } finally { $p.Dispose() }
  }
  $v = Invoke-Isolated -CommandArgs @('--version')
  if ($v.Code -ne 0 -or $v.Text -notmatch 'codex-cli 0\.147\.0\b') { throw 'Unexpected native CLI version' }
  $help = Invoke-Isolated -CommandArgs @('--no-daemon','-a','never','exec','--ephemeral','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--sandbox','read-only','--help')
  if ($help.Code -ne 0 -or !$help.Text.Contains('--output-schema')) { throw 'Native CLI does not recognize the isolated exec interface' }
  # File mode and a fresh CODEX_HOME avoid querying a user's keychain.
  $auth = Invoke-Isolated -CommandArgs @('-c','cli_auth_credentials_store="file"','login','status')
  if ($auth.Code -eq 0 -or $auth.Text -notmatch '(?i)not logged in') { throw 'Isolated Codex did not report a signed-out state' }
  Write-Output "WINDOWS CODEX CLI PASS version=$version sha256=$exeHash exec=available login=signed-out live-model=not-run"
} finally { Remove-Item -LiteralPath $work -Recurse -Force }
