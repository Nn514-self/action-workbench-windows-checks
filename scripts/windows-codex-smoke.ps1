# Offline CLI qualification after fetching the pinned public distribution. No model request or login.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'Requires native Windows x64' }
$work = Join-Path ([IO.Path]::GetTempPath()) ('Codex 验收 ' + [Guid]::NewGuid().ToString('N'))
$version = '0.172.0'
$name = 'codex-x86_64-pc-windows-msvc.exe'
$zipHash = 'c4292fc0414fc78682e733ff570ddec377922ebe1a29925a6d5bcc5aeff43ea0'
$exeHash = '3f42b12274b353ecb3ec555e6c8d0a43f6c6cb29c3a546179bc12dee4855deb6'
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
  function Invoke-Isolated([string[]]$CommandArgs, [string]$File=$exe) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName=$File; $info.WorkingDirectory=$work; $info.UseShellExecute=$false
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
  if ($v.Code -ne 0 -or $v.Text -notmatch ('(?m)^codex-cli ' + [regex]::Escape($version) + '\r?$')) { throw 'Unexpected native CLI version' }
  # Capture the installed adapter's real argv through the native test fixture. Do not maintain a second copy of the CLI flags.
  $root = Split-Path -Parent $PSScriptRoot
  $fixture = Join-Path $work '适配 验收.exe'
  $compiler = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
  & $compiler /nologo /codepage:65001 /target:exe "/out:$fixture" (Join-Path $root 'test/fixtures/windows-decision.cs')
  if ($LASTEXITCODE -ne 0) { throw 'Unable to compile native argv fixture' }
  $adapter = [uri]::new((Resolve-Path (Join-Path $root 'dist/codex.js')).Path).AbsoluteUri
  $probe = @'
const {localCodex} = await import(process.argv[1]);
const provider = localCodex({bin:process.argv[2],model:'验收 模型'});
const result = await provider.decide({capabilities:[],tools:[],history:[{role:'user',text:'查询运费 记录参数'}],now:new Date().toISOString()});
if (result.type !== 'reply' || result.text !== '运费八元') process.exitCode=1;
'@
  $capture = Invoke-Isolated -File (Get-Command node.exe -CommandType Application).Source -CommandArgs @('--input-type=module','-e',$probe,$adapter,$fixture)
  if ($capture.Code -ne 0) { throw 'Could not capture the packaged adapter arguments' }
  $actual = [IO.File]::ReadAllText((Join-Path $work 'adapter-argv')).Split([char]0)
  if ($actual[-1] -ne '-') { throw 'Expected the adapter to read stdin' }
  # Replace the stdin prompt with --help: the real parser sees all flags, but cannot make a model request.
  $help = Invoke-Isolated -CommandArgs ($actual[0..($actual.Length-2)] + '--help')
  if ($help.Code -ne 0 -or !$help.Text.Contains('--output-schema')) {
    if ($help.Text -match "unexpected argument '([a-zA-Z0-9_-]+)'") { throw "Codex $version rejected adapter option $($Matches[1])" }
    throw "Codex $version rejected the packaged adapter command (exit $($help.Code))"
  }
  $disable = @(); $names = @()
  for ($i=0; $i -lt $actual.Length-1; $i++) {
    if ($actual[$i] -ceq '--disable') { $names += $actual[$i+1]; $disable += @('--disable',$actual[$i+1]) }
  }
  if ('shell_tool' -cnotin $names -or 'hooks' -cnotin $names) { throw 'Missing adapter isolation flags' }
  $features = Invoke-Isolated -CommandArgs ($disable + @('features','list'))
  if ($features.Code -ne 0) { throw "Codex $version rejected a feature flag" }
  foreach ($name in $names) {
    if ($features.Text -notmatch ('(?m)^' + [regex]::Escape($name) + '[ \t]+[^\r\n]+[ \t]+false[ \t]*\r?$')) { throw "Feature not disabled: $name" }
  }
  # File mode and a fresh CODEX_HOME avoid querying a user's keychain.
  $auth = Invoke-Isolated -CommandArgs @('-c','cli_auth_credentials_store="file"','login','status')
  if ($auth.Code -eq 0 -or $auth.Text -notmatch '(?i)not logged in') { throw 'Isolated Codex did not report a signed-out state' }
  Write-Output "WINDOWS CODEX CLI PASS version=$version sha256=$exeHash adapter-argv=accepted disabled=$($names.Count) login=signed-out live-model=not-run"
} finally { Remove-Item -LiteralPath $work -Recurse -Force }
