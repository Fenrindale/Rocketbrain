#Requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BaseArchive,
    [Parameter(Mandatory)][string]$ExtensionVsix,
    [Parameter(Mandatory)][string]$Compiler,
    [Parameter(Mandatory)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$desktop = Join-Path $repository 'desktop'
$lock = Get-Content -Raw -LiteralPath (Join-Path $desktop 'windows-x64.json') | ConvertFrom-Json
$basePath = (Resolve-Path -LiteralPath $BaseArchive).Path
$vsixPath = (Resolve-Path -LiteralPath $ExtensionVsix).Path
$compilerPath = (Resolve-Path -LiteralPath $Compiler).Path
if ((Get-FileHash -LiteralPath $basePath).Hash -ine $lock.source.sha256) {
    throw 'The Code OSS distribution archive does not match the pinned Windows x64 SHA-256.'
}
$vsixHash = (Get-FileHash -LiteralPath $vsixPath).Hash.ToLowerInvariant()
$output = (New-Item -ItemType Directory -Path $OutputDirectory -Force).FullName
$installer = Join-Path $output "RocketbrainDesktop-$($lock.version)-win32-x64-setup.exe"
$updateMetadata = Join-Path $output "RocketbrainDesktop-$($lock.version)-win32-x64-update.json"
$packageReceipt = Join-Path $output 'desktop-package-receipt.json'
if ((Test-Path -LiteralPath $installer) -or (Test-Path -LiteralPath $updateMetadata) -or (Test-Path -LiteralPath $packageReceipt)) {
    throw 'Choose an output directory without an existing desktop release.'
}
$stage = New-Item -ItemType Directory -Path (Join-Path $output ('desktop-staging-' + [Guid]::NewGuid().ToString('N')))
$payload = (New-Item -ItemType Directory -Path (Join-Path $stage.FullName 'payload')).FullName
$unpackedVsix = (New-Item -ItemType Directory -Path (Join-Path $stage.FullName 'vsix')).FullName

function Expand-PinnedArchive {
    param([string]$Archive, [string]$Destination)
    & tar.exe -xf $Archive -C $Destination
    if ($LASTEXITCODE -ne 0) { throw 'Archive extraction failed.' }
}

Expand-PinnedArchive $basePath $payload
Expand-PinnedArchive $vsixPath $unpackedVsix
$extensionFolder = Join-Path $unpackedVsix 'extension'
$extension = Get-Content -Raw -LiteralPath (Join-Path $extensionFolder 'package.json') | ConvertFrom-Json
if ("$($extension.publisher).$($extension.name)" -cne $lock.extensionId -or $extension.version -cne $lock.extensionVersion) {
    throw 'The bundled VSIX manifest does not match the desktop package lock.'
}

$app = Join-Path $payload 'resources/app'
$builtIn = Join-Path $app 'extensions/rocketbrain'
Copy-Item -LiteralPath $extensionFolder -Destination $builtIn -Recurse
if (!(Test-Path -LiteralPath (Join-Path $builtIn 'dist/extension.js') -PathType Leaf)) { throw 'Bundling Rocketbrain failed.' }

& node (Join-Path $desktop 'patch-workbench.cjs') $app
if ($LASTEXITCODE -ne 0) { throw 'The pinned Code OSS workbench patch failed.' }
$rocketMark = Get-Content -Raw -LiteralPath (Join-Path $repository 'media/rocketbrain.svg')
$media = Join-Path $app 'out/media'
foreach ($icon in @('code-icon.svg', 'vscode-icon.svg')) {
    Set-Content -LiteralPath (Join-Path $media $icon) -Value $rocketMark -Encoding utf8NoBOM
}
$letterpressFolders = @($media, (Join-Path $app 'out/vs/workbench/browser/parts/editor/media'))
foreach ($folder in $letterpressFolders) {
    foreach ($theme in @('dark', 'light', 'hcDark', 'hcLight')) {
        $color = if ($theme -in @('light','hcLight')) { '#404D5A' } else { '#C5C5C5' }
        $mark = $rocketMark.Replace('#C5C5C5', $color)
        Set-Content -LiteralPath (Join-Path $folder "letterpress-$theme.svg") -Value $mark -Encoding utf8NoBOM
    }
}
$productPath = Join-Path $app 'product.json'
$product = Get-Content -Raw -LiteralPath $productPath | ConvertFrom-Json -AsHashtable
$product['nameShort'] = 'Rocketbrain'
$product['nameLong'] = 'Rocketbrain'
$product['applicationName'] = 'rocketbrain-desktop'
$product['dataFolderName'] = '.rocketbrain-desktop'
$product['sharedDataFolderName'] = '.rocketbrain-desktop-shared'
$product['urlProtocol'] = 'rocketbrain-desktop'
$product['win32MutexName'] = 'rocketbrain-desktop'
$product['win32DirName'] = 'Rocketbrain Desktop'
$product['win32NameVersion'] = 'Rocketbrain Desktop'
$product['win32RegValueName'] = 'Rocketbrain Desktop'
$product['win32ShellNameShort'] = 'Rocketbrain'
$product['win32AppUserModelId'] = 'Rocketbrain.Desktop'
$product['target'] = 'user'
$product['reportIssueUrl'] = 'https://github.com/Fenrindale/Rocketbrain/issues'
$product['releaseNotesUrl'] = 'https://github.com/Fenrindale/Rocketbrain'
$product['rocketbrainDesktop'] = [ordered]@{
    version = $lock.version
    platform = $lock.platform
    baseArchiveSha256 = $lock.source.sha256
    codeOssCommit = $lock.source.codeOssCommit
    extensionVersion = $extension.version
    extensionVsixSha256 = $vsixHash
}
$product.Remove('updateUrl')
$product.Remove('downloadUrl')
$relativeBundle = 'vs/workbench/workbench.desktop.main.js'
$bundlePath = Join-Path (Join-Path $app 'out') $relativeBundle
$bundleHash = [System.Security.Cryptography.SHA256]::HashData([System.IO.File]::ReadAllBytes($bundlePath))
$product['checksums'][$relativeBundle] = [Convert]::ToBase64String($bundleHash).TrimEnd('=')
$product | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $productPath -Encoding utf8NoBOM

Rename-Item -LiteralPath (Join-Path $payload 'VSCodium.exe') -NewName 'Rocketbrain.exe'
$visualManifest = Join-Path $payload 'VSCodium.VisualElementsManifest.xml'
$visualXml = (Get-Content -Raw -LiteralPath $visualManifest).Replace('ShortDisplayName="VSCodium"', 'ShortDisplayName="Rocketbrain"')
Set-Content -LiteralPath (Join-Path $payload 'Rocketbrain.VisualElementsManifest.xml') -Value $visualXml -Encoding utf8NoBOM
Remove-Item -LiteralPath $visualManifest
foreach ($suffix in @('', '.cmd')) {
    $old = Join-Path $payload "bin/codium$suffix"
    $new = Join-Path $payload "bin/rocketbrain-desktop$suffix"
    $updated = (Get-Content -Raw -LiteralPath $old).Replace('VSCodium.exe', 'Rocketbrain.exe').Replace('NAME="VSCodium"', 'NAME="Rocketbrain"').Replace('APP_NAME="codium"', 'APP_NAME="rocketbrain-desktop"')
    [System.IO.File]::WriteAllText($new, $updated)
    Remove-Item -LiteralPath $old
}

& $compilerPath "/DPayloadPath=$payload" "/DOutputPath=$output" "/DDesktopVersion=$($lock.version)" `
    "/DInstallerFileVersion=$($lock.installerFileVersion)" (Join-Path $desktop 'windows-setup.iss')
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'Windows installer compilation failed.' }

$receipt = [ordered]@{
    desktopVersion = $lock.version
    platform = $lock.platform
    baseArchiveSha256 = $lock.source.sha256
    codeOssCommit = $lock.source.codeOssCommit
    workbenchSha256 = [Convert]::ToHexString($bundleHash).ToLowerInvariant()
    extensionVersion = $extension.version
    extensionVsixSha256 = $vsixHash
    installerFile = Split-Path -Leaf $installer
    installerSha256 = (Get-FileHash -LiteralPath $installer).Hash.ToLowerInvariant()
    installerBytes = (Get-Item -LiteralPath $installer).Length
}
$signature = (Get-AuthenticodeSignature -LiteralPath $installer).Status
$authenticode = switch ($signature) {
    Valid { 'signed' }
    NotSigned {
        if ($lock.version -notmatch '-preview\.\d+$') { throw 'A stable desktop release requires a signed installer.' }
        'unsigned-preview'
    }
    default { throw "Unexpected installer signature state: $signature" }
}
[ordered]@{
    schemaVersion = 1
    product = 'Rocketbrain Desktop'
    version = $lock.version
    target = $lock.platform
    installer = [ordered]@{
        name = $receipt.installerFile
        size = $receipt.installerBytes
        sha256 = $receipt.installerSha256
        authenticode = $authenticode
    }
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $updateMetadata -Encoding utf8NoBOM
$receipt | ConvertTo-Json | Tee-Object -FilePath $packageReceipt
