param([switch]$VerifyWorkbench, [switch]$VerifyJavaDebug)

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

function Invoke-CheckedDownload([string]$Remote, [string]$Destination, [string]$Sha256) {
    & curl.exe --fail --silent --show-error --location --retry 2 --max-time 160 --proto '=https' --output $Destination $Remote
    if ($LASTEXITCODE -ne 0) { throw 'Could not download the pinned verification fixture.' }
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256) {
        throw 'A verification fixture digest differs from its pinned value.'
    }
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
    Invoke-CheckedDownload $source $archive $sha
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
    $proof = [ordered]@{ verified = $true; wslVersion = 1; kernel = $kernel; ubuntuRootfsSha256 = $sha; localWorkspaceRoundTrip = $true; linuxWorkingDirectory = $true }

    if ($VerifyWorkbench -or $VerifyJavaDebug) {
        Write-Host 'Preparing the disposable Linux JDK and build tools.'
        $command = @('--distribution', $distro, '--exec')
        Invoke-WslFixture ($command + @('/usr/bin/apt-get', 'update', '-q')) | Out-Null
        Invoke-WslFixture ($command + @('/usr/bin/env', 'DEBIAN_FRONTEND=noninteractive', '/usr/bin/apt-get', 'install', '-y', '-q', '--no-install-recommends', 'openjdk-21-jdk-headless', 'maven', 'unzip', 'python3')) | Out-Null
        $gradle = Join-Path $root 'gradle-9.1.0-bin.zip'
        Invoke-CheckedDownload 'https://services.gradle.org/distributions/gradle-9.1.0-bin.zip' $gradle 'a17ddd85a26b6a7f5ddb71ff8b05fc5104c0202c6e64782429790c933686c806'
        $gradleZip = Invoke-WslFixture ($command + @('/usr/bin/wslpath', '-a', '-u', $gradle))
        Invoke-WslFixture ($command + @('/usr/bin/unzip', '-q', $gradleZip, '-d', '/opt')) | Out-Null
        Invoke-WslFixture ($command + @('/usr/bin/ln', '-s', '/opt/gradle-9.1.0/bin/gradle', '/usr/bin/gradle')) | Out-Null
        $proof['maven'] = Invoke-WslFixture ($command + @('/usr/bin/mvn', '--version'))
        $proof['gradle'] = Invoke-WslFixture ($command + @('/usr/bin/gradle', '--version'))

        $repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
        if ($VerifyJavaDebug) {
            $javaRuntime = Join-Path $root 'windows-java-runtime'
            & node (Join-Path $repo 'scripts/java-provision.js') --target $javaRuntime --java-home $env:JAVA_HOME
            if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the local JDT LS and Java debug adapter fixture.' }
            $env:ROCKETBRAIN_JAVA_TEST_CONFIG = Join-Path $javaRuntime 'rocketbrain-java-runtime.json'
            $env:ROCKETBRAIN_WSL_TEST_JAVA_DEBUG = '1'
        }
        Get-ChildItem -LiteralPath (Join-Path $repo 'test/fixtures/wsl-jvm') | Copy-Item -Destination $workspace -Recurse
        $linuxFixture = Invoke-WslFixture ($command + @('/usr/bin/mktemp', '-d', '/tmp/rocketbrain-wsl-XXXXXXXX'))
        if ($linuxFixture -cnotmatch '^/tmp/rocketbrain-wsl-[0-9A-Za-z]{8}$') { throw 'The owned Linux fixture path was not generated.' }
        $linuxProject = "$linuxFixture/Case Project"
        Invoke-WslFixture ($command + @('/usr/bin/mkdir', '--', $linuxProject)) | Out-Null
        Invoke-WslFixture ($command + @('/usr/bin/cp', '-R', '--', "$linux/.", $linuxProject)) | Out-Null
        $linuxUnc = Invoke-WslFixture ($command + @('/usr/bin/wslpath', '-a', '-w', $linuxProject))
        $linuxSuffix = [Regex]::Escape("\$distro" + $linuxProject.Replace('/', '\'))
        if ($linuxUnc -cnotmatch ('^\\\\(?:wsl\.localhost|wsl\$)' + $linuxSuffix + '$')) {
            throw 'The owned Linux project did not map to the exact registered WSL share.'
        }
        if (-not (Test-Path -LiteralPath $linuxUnc -PathType Container)) { throw 'Windows could not read the owned Linux project via WSL UNC.' }
        if ((Invoke-WslFixture ($command + @('/usr/bin/wslpath', '-a', '-u', $linuxUnc))) -cne $linuxProject) {
            throw 'The WSL UNC path did not preserve the exact owned Linux project path.'
        }

        $version = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
        $vsix = Join-Path $repo "rocketbrain-$version.vsix"
        $proof['vsixSha256'] = (Get-FileHash -LiteralPath $vsix -Algorithm SHA256).Hash.ToLowerInvariant()
        $proof['vsixBytes'] = (Get-Item -LiteralPath $vsix).Length
        $env:ROCKETBRAIN_WSL_TEST_DISTRIBUTION = $distro
        $env:ROCKETBRAIN_WSL_TEST_WORKSPACE = $workspace
        $env:ROCKETBRAIN_WSL_TEST_LINUX_PROJECT = $linuxProject
        $env:ROCKETBRAIN_WSL_TEST_UNC_WORKSPACE = $linuxUnc
        $env:NODE_UNC_HOST_ALLOWLIST = 'wsl.localhost\wsl$'
        $workspaceFile = Join-Path $root 'rocketbrain-wsl.code-workspace'
        $folders = @(@{ path = $linuxUnc })
        if (!$VerifyJavaDebug) { $folders = @(@{ path = $workspace }) + $folders }
        @{ folders = $folders } | ConvertTo-Json -Depth 4 |
            Set-Content -LiteralPath $workspaceFile -Encoding utf8NoBOM
        $env:ROCKETBRAIN_JAVA_TEST_WORKSPACE = $workspaceFile
        $env:ROCKETBRAIN_NATIVE_CHECKS = 'wsl-workspace-host'
        $env:ROCKETBRAIN_TEST_OUTPUT = Join-Path $root 'native-workbench.json'
        $editor = & node -e 'require("@vscode/test-electron").downloadAndUnzipVSCode("1.100.3").then(console.log, error => { console.error(error.message); process.exitCode = 1; })'
        if ($LASTEXITCODE -ne 0) { throw 'Could not prepare an isolated VS Code test runtime.' }
        $env:ROCKETBRAIN_VSCODE = $editor | Select-Object -Last 1
        if (-not (Test-Path -LiteralPath $env:ROCKETBRAIN_VSCODE -PathType Leaf)) { throw 'The selected VS Code test runtime is absent.' }
        & node (Join-Path $repo 'scripts/test-vsix.js') $vsix
        if ($LASTEXITCODE -ne 0) {
            if ($VerifyJavaDebug) {
                Get-ChildItem -LiteralPath (Join-Path $repo '.vscode-test/core-user') -Filter '.log' -Recurse -File -Force |
                    Where-Object { $_.Directory.Name -ceq '.metadata' } |
                    Select-Object -First 3 | ForEach-Object { Get-Content -LiteralPath $_.FullName -Tail 50 }
            }
            throw 'The packaged native WSL workbench check failed.'
        }
        if (-not (Test-Path -LiteralPath $env:ROCKETBRAIN_TEST_OUTPUT -PathType Leaf)) { throw 'The native WSL workbench did not emit verification.' }
        $proof['native'] = Get-Content -LiteralPath $env:ROCKETBRAIN_TEST_OUTPUT -Raw | ConvertFrom-Json
    }
    $proof |
        ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $env:RUNNER_TEMP 'rocketbrain-wsl-runtime.json') -Encoding utf8NoBOM
} finally {
    if ($registered) { Invoke-WslFixture @('--unregister', $distro) | Out-Null }
}
