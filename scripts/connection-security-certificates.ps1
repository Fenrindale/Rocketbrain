param([Parameter(Mandatory=$true)][string]$Folder, [string]$ServerName='rb-db.local', [switch]$ServerRotation, [switch]$ExpiringServer)
$ErrorActionPreference = 'Stop'
if ($ServerName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.\-]{0,252}$') { throw 'Use an explicit DNS name for the owned test certificate.' }
$target = (Resolve-Path -LiteralPath $Folder).Path
if (-not (Test-Path -LiteralPath (Join-Path $target 'owner.json'))) { throw 'Certificate fixture ownership marker is missing.' }
$hash = [System.Security.Cryptography.HashAlgorithmName]::SHA256
$padding = [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
$now = [DateTimeOffset]::UtcNow
function New-Authority([string]$Name) {
  $rsa = [System.Security.Cryptography.RSA]::Create(2048)
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new("CN=$Name", $rsa, $hash, $padding)
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$false,0,$true))
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign,$true))
  $cert = $request.CreateSelfSigned($now.AddDays(-1),$now.AddDays(7))
  return @{ Key=$rsa; Certificate=$cert }
}
function New-Leaf([string]$Name,[string]$Usage,$Authority,[DateTimeOffset]$ValidUntil=$now.AddDays(3)) {
  $rsa = [System.Security.Cryptography.RSA]::Create(2048)
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new("CN=$Name",$rsa,$hash,$padding)
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true))
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment),$true))
  $oids = [System.Security.Cryptography.OidCollection]::new()
  [void]$oids.Add([System.Security.Cryptography.Oid]::new($Usage))
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids,$false))
  if ($Usage -eq '1.3.6.1.5.5.7.3.1') { $san=[System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new(); $san.AddDnsName($Name); $request.CertificateExtensions.Add($san.Build()) }
  $serial=[byte[]]::new(16); [System.Security.Cryptography.RandomNumberGenerator]::Fill($serial)
  $unsigned=$request.Create($Authority.Certificate,$now.AddHours(-1),$ValidUntil,$serial)
  $cert=[System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($unsigned,$rsa)
  return @{Key=$rsa;Certificate=$cert}
}
function Write-Certificates($entries) {
  foreach($entry in $entries) {
    [IO.File]::WriteAllText((Join-Path $target ($entry.Name+'.pem')),$entry.Value.Certificate.ExportCertificatePem())
    [IO.File]::WriteAllText((Join-Path $target ($entry.Name+'-key.pem')),$entry.Value.Key.ExportPkcs8PrivateKeyPem())
    $entry.Value.Certificate.Dispose();$entry.Value.Key.Dispose()
  }
}
if ($ExpiringServer) {
  $issuer=[System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile((Join-Path $target 'rotation-ca.pem'),(Join-Path $target 'rotation-ca-key.pem'))
  try {
    $leaf=New-Leaf $ServerName '1.3.6.1.5.5.7.3.1' @{ Certificate=$issuer } ($now.AddSeconds(20))
    Write-Certificates @(@{Name='rotation-expiring';Value=$leaf})
  } finally { $issuer.Dispose() }
  exit 0
}
$ca=New-Authority 'Rocketbrain-v18-Owned-Test-CA'
$wrong=New-Authority 'Rocketbrain-v18-Untrusted-Test-CA'
$server=New-Leaf $ServerName '1.3.6.1.5.5.7.3.1' $ca
$client=New-Leaf 'rb-client' '1.3.6.1.5.5.7.3.2' $ca
if ($env:ROCKETBRAIN_OWNED_CLIENT_PFX_PASSPHRASE) {
  $pbe=[System.Security.Cryptography.PbeParameters]::new([System.Security.Cryptography.PbeEncryptionAlgorithm]::Aes256Cbc,$hash,10000)
  $bundle=$client.Certificate.ExportPkcs12($pbe,$env:ROCKETBRAIN_OWNED_CLIENT_PFX_PASSPHRASE)
  [IO.File]::WriteAllBytes((Join-Path $target 'client.p12'),$bundle)
}
$entries=@(@{Name='ca';Value=$ca},@{Name='wrong-ca';Value=$wrong},@{Name='server';Value=$server},@{Name='client';Value=$client})
if ($ServerRotation) {
  $next=New-Authority 'Rocketbrain-Owned-Rotation-CA'
  $usage='1.3.6.1.5.5.7.3.1'
  $entries+=@(@{Name='rotation-ca';Value=$next},
    @{Name='rotation-server';Value=(New-Leaf $ServerName $usage $next)},
    @{Name='rotation-alt';Value=(New-Leaf $ServerName $usage $next)})
}
Write-Certificates $entries
