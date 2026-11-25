$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'The WSL verification fixture requires a disposable GitHub-hosted Windows runner.'
}

$wsl = Join-Path $env:SystemRoot 'System32/wsl.exe'
if (-not (Test-Path -LiteralPath $wsl -PathType Leaf)) { throw 'The hosted image did not include WSL.' }

function Invoke-WslFixture([string[]]$ArgumentList) {
    $lines = & $wsl @ArgumentList
    if ($LASTEXITCODE -ne 0) { throw "WSL fixture command $($ArgumentList[0]) exited with code $LASTEXITCODE. $lines" }
    return (($lines -join "`n") -replace "`0", '').Trim()
}

$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 12)
$distro = "RocketbrainFixture-$suffix"
$root = Join-Path $env:RUNNER_TEMP "rocketbrain-wsl-$suffix"
$workspace = Join-Path $root 'Spring workspace'
$install = Join-Path $root 'distribution'
New-Item -ItemType Directory -Path $root,$workspace,$install | Out-Null
$archive = Join-Path $root 'ubuntu-noble-wsl-amd64-24.04lts.rootfs.tar.gz'
$sha = '2a790896740b14d637dbdc583cce1ba081ac53b9e9cdb46dc09a2f73abbd9934'
$source = 'https://cloud-images.ubuntu.com/wsl/releases/24.04/current/ubuntu-noble-wsl-amd64-24.04lts.rootfs.tar.gz'
$registered = $false

try {
    & curl.exe --fail --silent --show-error --location --retry 2 --max-time 160 --proto '=https' --output $archive $source
    if ($LASTEXITCODE -ne 0) { throw 'Could not download the pinned Ubuntu WSL root filesystem.' }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha) {
        throw 'The Ubuntu WSL root filesystem digest differs from the pinned fixture.'
    }
    Invoke-WslFixture @('--import', $distro, $install, $archive, '--version', '1') | Out-Null
    $registered = $true
    $listing = Invoke-WslFixture @('--list', '--verbose')
    if ($listing -notmatch ("(?m)" + [Regex]::Escape($distro) + '\s+[^\r\n]+\s+1\s*$')) { throw 'The exact fixture distro did not register as WSL 1.' }
    $kernel = Invoke-WslFixture @('--distribution', $distro, '--exec', '/usr/bin/uname', '-s')
    if ($kernel -ne 'Linux') { throw 'The imported distribution did not start a Linux process.' }
    $linux = Invoke-WslFixture @('--distribution', $distro, '--exec', '/usr/bin/wslpath', '-a', '-u', $workspace)
    $back = Invoke-WslFixture @('--distribution', $distro, '--exec', '/usr/bin/wslpath', '-a', '-w', $linux)
    if ([IO.Path]::GetFullPath($back) -ne [IO.Path]::GetFullPath($workspace)) { throw 'WSL did not round-trip the owned Windows workspace path.' }
    Set-Content -LiteralPath (Join-Path $workspace 'workspace.txt') -Encoding utf8NoBOM -NoNewline -Value 'rocketbrain-wsl-workspace'
    $marker = Invoke-WslFixture @('--distribution', $distro, '--cd', $linux, '--exec', '/usr/bin/cat', 'workspace.txt')
    if ($marker -ne 'rocketbrain-wsl-workspace') { throw 'WSL did not read the existing Windows workspace from the mapped working directory.' }
    [ordered]@{ verified = $true; wslVersion = 1; kernel = $kernel; ubuntuRootfsSha256 = $sha; localWorkspaceRoundTrip = $true; linuxWorkingDirectory = $true } |
        ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $env:RUNNER_TEMP 'rocketbrain-wsl-runtime.json') -Encoding utf8NoBOM
} finally {
    if ($registered) { Invoke-WslFixture @('--unregister', $distro) | Out-Null }
}
