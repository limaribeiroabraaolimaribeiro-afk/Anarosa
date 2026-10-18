param([string]$Source='tmp/prepublicacao-20261017',[string]$Destination='.backups/gpmbkptimjipqsayrvce/20261018T005827Z')
$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$sourceDir=(Resolve-Path -LiteralPath (Join-Path $root $Source)).Path
$target=[IO.Path]::GetFullPath((Join-Path $root $Destination))
if(-not $target.StartsWith((Join-Path $root '.backups')+[IO.Path]::DirectorySeparatorChar)){throw 'Backup must stay inside the excluded .backups directory.'}
if(Test-Path -LiteralPath $target){throw 'Backup destination already exists. Do not overwrite a verified backup.'}
$verified=Get-Content -LiteralPath (Join-Path $sourceDir 'database-backup-manifest.json') -Raw|ConvertFrom-Json
if(-not $verified.full_archive_decode_verified){throw 'Verify full PostgreSQL archive first.'}
[IO.Directory]::CreateDirectory($target)|Out-Null
$utf8=New-Object Text.UTF8Encoding($false);$records=@()
function Hash([byte[]]$Bytes){$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
foreach($name in @('database-full.dump.dpapi','roles.sql.dpapi','archive-list.txt.dpapi','secrets-list.dpapi')){
  $bytes=[IO.File]::ReadAllBytes((Join-Path $sourceDir $name))
  [void][Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.File]::WriteAllBytes((Join-Path $target $name),$bytes)
  $records+=[PSCustomObject]@{file=$name;bytes=$bytes.Length;sha256=Hash $bytes}
}
$code=[IO.File]::ReadAllBytes((Join-Path $sourceDir 'functions-source.json.gz'))
$cipher=[Security.Cryptography.ProtectedData]::Protect($code,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
$decoded=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
if((Hash $decoded) -ne (Hash $code)){throw 'Function snapshot encryption failed.'}
[IO.File]::WriteAllBytes((Join-Path $target 'functions-source.json.gz.dpapi'),$cipher)
$records+=[PSCustomObject]@{file='functions-source.json.gz.dpapi';bytes=$cipher.Length;sha256=Hash $cipher}
foreach($name in @('database-backup-manifest.json','remote-functions-manifest.json','functions.json','secret-names.json','inventory.json','advisors.json','release-comparison.json','public-read-smoke.json','operations.json','security-context.json')){
  Copy-Item -LiteralPath (Join-Path $sourceDir $name) -Destination (Join-Path $target $name)
}
$manifest=[PSCustomObject]@{project='gpmbkptimjipqsayrvce';created_at=[DateTime]::UtcNow.ToString('o');protection='DPAPI CurrentUser; restore using the terminal owner Windows profile';database_archive_verified=$true;full_restore_tested=$false;functions=27;environment_secret_values_exported=$false;files=$records}
[IO.File]::WriteAllText((Join-Path $target 'release-backup-manifest.json'),(ConvertTo-Json -InputObject $manifest -Depth 5),$utf8)
[PSCustomObject]@{directory=$Destination;encrypted_artifacts=$records.Count;database_archive_verified=$true;full_restore_tested=$false}|ConvertTo-Json -Compress
