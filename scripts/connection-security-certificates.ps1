param([Parameter(Mandatory=$true)][string]$Folder)
$ErrorActionPreference = 'Stop'
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
function New-Leaf([string]$Name,[string]$Usage,$Authority) {
  $rsa = [System.Security.Cryptography.RSA]::Create(2048)
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new("CN=$Name",$rsa,$hash,$padding)
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true))
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment),$true))
  $oids = [System.Security.Cryptography.OidCollection]::new()
  [void]$oids.Add([System.Security.Cryptography.Oid]::new($Usage))
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids,$false))
  if ($Usage -eq '1.3.6.1.5.5.7.3.1') { $san=[System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new(); $san.AddDnsName($Name); $request.CertificateExtensions.Add($san.Build()) }
  $serial=[byte[]]::new(16); [System.Security.Cryptography.RandomNumberGenerator]::Fill($serial)
  $unsigned=$request.Create($Authority.Certificate,$now.AddHours(-1),$now.AddDays(3),$serial)
  $cert=[System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($unsigned,$rsa)
  return @{Key=$rsa;Certificate=$cert}
}
$ca=New-Authority 'Rocketbrain-v18-Owned-Test-CA'
$wrong=New-Authority 'Rocketbrain-v18-Untrusted-Test-CA'
$server=New-Leaf 'rb-db.local' '1.3.6.1.5.5.7.3.1' $ca
$client=New-Leaf 'rb-client' '1.3.6.1.5.5.7.3.2' $ca
foreach($entry in @(@{Name='ca';Value=$ca},@{Name='wrong-ca';Value=$wrong},@{Name='server';Value=$server},@{Name='client';Value=$client})) {
  [IO.File]::WriteAllText((Join-Path $target ($entry.Name+'.pem')),$entry.Value.Certificate.ExportCertificatePem())
  [IO.File]::WriteAllText((Join-Path $target ($entry.Name+'-key.pem')),$entry.Value.Key.ExportPkcs8PrivateKeyPem())
  $entry.Value.Certificate.Dispose();$entry.Value.Key.Dispose()
}
