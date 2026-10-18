param([Parameter(Mandatory=$true)][string]$PostgresBin,[string]$Directory='tmp/prepublicacao-20261017')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$target=(Resolve-Path -LiteralPath $Directory).Path
$pg=(Resolve-Path -LiteralPath (Join-Path $PostgresBin 'pg_restore.exe')).Path
$utf8=New-Object Text.UTF8Encoding($false)
function Hash([byte[]]$Bytes){$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function Decrypt([string]$Name){return ,([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Join-Path $target $Name)),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))}
$archive=Decrypt 'database-full.dump.dpapi'
function Inspect([string]$Arguments){
  $info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=$pg;$info.Arguments=$Arguments;$info.UseShellExecute=$false;$info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.CreateNoWindow=$true
  $process=New-Object Diagnostics.Process;$process.StartInfo=$info;[void]$process.Start()
  $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
  try{$process.StandardInput.BaseStream.Write($archive,0,$archive.Length)}catch [IO.IOException]{ }
  try{$process.StandardInput.Close()}catch [IO.IOException]{ }
  if(-not $process.WaitForExit(60000)){$process.Kill();throw 'Archive verification timed out.'}
  if($process.ExitCode -ne 0){throw ('Archive verification failed; pg_restore exit code '+$process.ExitCode)}
  return $stdout.Result
}
$list=Inspect '--list'
if($list -notmatch 'TABLE public store_orders' -or $list -notmatch 'TABLE DATA public store_orders'){throw 'Critical order table absent in archive.'}
$sql=Inspect '--file=- --no-owner --no-privileges'
if($sql -notmatch 'PostgreSQL database dump complete'){throw 'Full archive decode did not complete.'}
$cipher=[Security.Cryptography.ProtectedData]::Protect($utf8.GetBytes($list),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes((Join-Path $target 'archive-list.txt.dpapi'),$cipher)
$records=@()
foreach($name in @('database-full.dump.dpapi','roles.sql.dpapi','archive-list.txt.dpapi')){
  $plain=Decrypt $name;$encrypted=[IO.File]::ReadAllBytes((Join-Path $target $name))
  $records+=[PSCustomObject]@{file=$name;plaintext_bytes=$plain.Length;plaintext_sha256=Hash $plain;encrypted_sha256=Hash $encrypted;decrypt_verified=$true}
}
$manifest=[PSCustomObject]@{project='gpmbkptimjipqsayrvce';dump_file_updated_at=(Get-Item -LiteralPath (Join-Path $target 'database-full.dump.dpapi')).LastWriteTimeUtc.ToString('o');verified_at=[DateTime]::UtcNow.ToString('o');type='Full PostgreSQL custom archive; roles without passwords';protection='Windows DPAPI CurrentUser (terminal owner profile)';archive_list_verified=$true;full_archive_decode_verified=$true;full_restore_tested=$false;files=$records}
[IO.File]::WriteAllText((Join-Path $target 'database-backup-manifest.json'),(ConvertTo-Json -InputObject $manifest -Depth 6),$utf8)
$manifest|ConvertTo-Json -Depth 6
