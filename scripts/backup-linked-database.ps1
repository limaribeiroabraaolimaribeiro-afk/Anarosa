param(
  [Parameter(Mandatory=$true)][string]$Cli,
  [Parameter(Mandatory=$true)][string]$PostgresBin,
  [string]$Destination='tmp/prepublicacao-20261017'
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$project='gpmbkptimjipqsayrvce'
if((Get-Content -LiteralPath (Join-Path $root 'supabase/.temp/project-ref') -Raw).Trim() -ne $project){throw 'Unexpected linked project.'}
$target=[IO.Path]::GetFullPath((Join-Path $root $Destination))
if(-not $target.StartsWith($root+[IO.Path]::DirectorySeparatorChar)){throw 'Invalid backup destination.'}
[IO.Directory]::CreateDirectory($target)|Out-Null
if(Test-Path -LiteralPath (Join-Path $target 'database-backup-manifest.json')){throw 'A verified backup already exists here. Choose a new Destination; never overwrite it.'}
$pgBin=(Resolve-Path -LiteralPath $PostgresBin).Path
$utf8=New-Object Text.UTF8Encoding($false)
function RunMemory([string]$File,[string]$Arguments,[hashtable]$Environment=@{},[int]$Timeout=120000){
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=$File;$info.Arguments=$Arguments;$info.UseShellExecute=$false;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.CreateNoWindow=$true
  foreach($name in $Environment.Keys){$info.EnvironmentVariables[$name]=$Environment[$name]}
  $process=New-Object Diagnostics.Process;$process.StartInfo=$info;[void]$process.Start()
  $memory=New-Object IO.MemoryStream
  $copy=$process.StandardOutput.BaseStream.CopyToAsync($memory);$errorTask=$process.StandardError.ReadToEndAsync()
  if(-not $process.WaitForExit($Timeout)){$process.Kill();throw 'Read-only backup command timed out.'}
  $copy.GetAwaiter().GetResult()
  $result=[PSCustomObject]@{Code=$process.ExitCode;Bytes=$memory.ToArray();ErrorText=$errorTask.Result}
  $memory.Dispose();$process.Dispose();return $result
}
function Hash([byte[]]$Bytes){$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function Encrypt([string]$Name,[byte[]]$Bytes){
  $cipher=[Security.Cryptography.ProtectedData]::Protect($Bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.File]::WriteAllBytes((Join-Path $target ($Name+'.dpapi')),$cipher)
  $restored=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  if((Hash $restored) -ne (Hash $Bytes)){throw 'Encrypted backup verification failed.'}
  return [PSCustomObject]@{file=$Name+'.dpapi';plaintext_bytes=$Bytes.Length;plaintext_sha256=(Hash $Bytes);encrypted_sha256=(Hash $cipher);decrypt_verified=$true}
}
$plan=RunMemory $Cli 'db dump --linked --project-ref gpmbkptimjipqsayrvce --dry-run' @{} 45000
if($plan.Code -ne 0){throw 'CLI could not prepare read-only connection. No credentials were printed.'}
$script=$utf8.GetString($plan.Bytes)
$pgEnvironment=@{}
foreach($match in [regex]::Matches($script,'(?m)^(?:export\s+)?(PG[A-Z_]+)=(?:"([^"\r\n]*)"|''([^''\r\n]*)''|([^\s]+))')){
  $value=$match.Groups[2].Value;if(-not $match.Groups[2].Success){$value=$match.Groups[3].Value};if(-not $match.Groups[3].Success -and -not $match.Groups[2].Success){$value=$match.Groups[4].Value}
  $pgEnvironment[$match.Groups[1].Value]=$value -replace '\\([\\"$`])','$1'
}
if(-not $pgEnvironment.PGHOST -or -not $pgEnvironment.PGPASSWORD){throw 'CLI connection script format unsupported.'}
if($pgEnvironment.PGHOST -notmatch '(\.pooler\.supabase\.com|\.supabase\.co)$' -or (($pgEnvironment.PGHOST+$pgEnvironment.PGUSER) -notlike "*$project*")){throw 'Connection target does not match Anarosa.'}
$pgEnvironment.PGSSLMODE='require';$pgEnvironment.PGCONNECT_TIMEOUT='15';$pgEnvironment.PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=120000'
$started=[DateTime]::UtcNow.ToString('o')
$dump=RunMemory (Join-Path $pgBin 'pg_dump.exe') '--role=postgres --format=custom --compress=6 --lock-wait-timeout=5000' $pgEnvironment
if($dump.Code -ne 0){$failure=Encrypt 'database-dump-error' ($utf8.GetBytes($dump.ErrorText));throw 'pg_dump failed; error details encrypted in private backup directory.'}
if($dump.Bytes.Length -lt 5 -or $utf8.GetString($dump.Bytes,0,5) -ne 'PGDMP'){throw 'Invalid PostgreSQL archive.'}
$files=@(Encrypt 'database-full.dump' $dump.Bytes)
if($dump.ErrorText){$files+=Encrypt 'database-dump-notices' ($utf8.GetBytes($dump.ErrorText))}
$roles=RunMemory (Join-Path $pgBin 'pg_dumpall.exe') '--role=postgres --roles-only --no-role-passwords' $pgEnvironment
if($roles.Code -eq 0){$files+=Encrypt 'roles.sql' $roles.Bytes}else{$files+=Encrypt 'roles-error' ($utf8.GetBytes($roles.ErrorText))}
# Archive inspection from memory: never write plaintext customer rows/tokens to disk.
$inspectInfo=New-Object Diagnostics.ProcessStartInfo
$inspectInfo.FileName=Join-Path $pgBin 'pg_restore.exe';$inspectInfo.Arguments='--list';$inspectInfo.UseShellExecute=$false;$inspectInfo.RedirectStandardInput=$true;$inspectInfo.RedirectStandardOutput=$true;$inspectInfo.RedirectStandardError=$true;$inspectInfo.CreateNoWindow=$true
$inspect=New-Object Diagnostics.Process;$inspect.StartInfo=$inspectInfo;[void]$inspect.Start()
$listTask=$inspect.StandardOutput.ReadToEndAsync();$errTask=$inspect.StandardError.ReadToEndAsync()
try{$inspect.StandardInput.BaseStream.Write($dump.Bytes,0,$dump.Bytes.Length)}catch [IO.IOException]{ } # --list may exit after reading TOC, before consuming archive data.
try{$inspect.StandardInput.Close()}catch [IO.IOException]{ }
if(-not $inspect.WaitForExit(30000)){$inspect.Kill();throw 'Archive inspection timed out.'}
if($inspect.ExitCode -ne 0){throw 'Archive inspection failed.'}
$files+=Encrypt 'archive-list.txt' ($utf8.GetBytes($listTask.Result))
$manifest=[PSCustomObject]@{project=$project;started_at=$started;finished_at=[DateTime]::UtcNow.ToString('o');type='PostgreSQL custom archive; full database; roles without passwords';protection='Windows DPAPI CurrentUser';archive_list_verified=$true;full_restore_tested=$false;roles_exported=($roles.Code -eq 0);files=$files}
[IO.File]::WriteAllText((Join-Path $target 'database-backup-manifest.json'),(ConvertTo-Json -InputObject $manifest -Depth 6),$utf8)
$manifest|ConvertTo-Json -Depth 6
