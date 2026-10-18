param(
  [string]$Container='anarosa-restore-20261017-v3',
  [string]$BackupDirectory='.backups/gpmbkptimjipqsayrvce/20261018T005827Z',
  [string]$EvidenceDirectory='tmp/homologacao-20261017',
  [switch]$ResumeEmptyDatabase
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$backup=(Resolve-Path -LiteralPath (Join-Path $root $BackupDirectory)).Path
$evidence=[IO.Path]::GetFullPath((Join-Path $root $EvidenceDirectory))
if(-not $backup.StartsWith($root+'\.backups\') -or -not $evidence.StartsWith($root+'\tmp\')){throw 'Private workspace paths required.'}
if($Container -notmatch '^anarosa-restore-[a-z0-9-]+$'){throw 'Unexpected container name.'}
[IO.Directory]::CreateDirectory($evidence)|Out-Null
$utf8=New-Object Text.UTF8Encoding($false)
function Run([string]$Arguments,[byte[]]$InputBytes=@(),[int]$Timeout=120000){
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName='docker.exe';$info.Arguments='--context desktop-linux '+$Arguments;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
  $info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $process=New-Object Diagnostics.Process;$process.StartInfo=$info;[void]$process.Start()
  $out=$process.StandardOutput.ReadToEndAsync();$err=$process.StandardError.ReadToEndAsync()
  try{if($InputBytes.Length){$process.StandardInput.BaseStream.Write($InputBytes,0,$InputBytes.Length)}}catch [IO.IOException]{}
  $process.StandardInput.Close()
  if(-not $process.WaitForExit($Timeout)){$process.Kill();throw 'Isolated operation timed out.'}
  $result=[PSCustomObject]@{Code=$process.ExitCode;Out=$out.Result;ErrorText=$err.Result};$process.Dispose();return $result
}
function Hash([byte[]]$Bytes){$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function Unseal([string]$File){
  $entry=@($manifest.files|Where-Object {$_.file -eq $File})
  if($entry.Count -ne 1){throw 'Backup manifest entry missing.'}
  $cipher=[IO.File]::ReadAllBytes((Join-Path $backup $File))
  if((Hash $cipher) -ne $entry[0].encrypted_sha256){throw 'Encrypted backup checksum mismatch.'}
  $bytes=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  if((Hash $bytes) -ne $entry[0].plaintext_sha256){throw 'Plaintext backup checksum mismatch.'}
  return ,$bytes
}
function Guard {
  $context=Run 'context inspect desktop-linux'
  if($context.Code -ne 0 -or -not (($context.Out|ConvertFrom-Json)[0].Endpoints.docker.Host.StartsWith('npipe://'))){throw 'A local Windows named pipe is required.'}
  $result=Run "inspect $Container";if($result.Code -ne 0){throw 'Local restore container unavailable.'}
  $item=($result.Out|ConvertFrom-Json)[0]
  if($item.Config.Labels.'anarosa.purpose' -ne 'isolated-backup-restore' -or $item.HostConfig.NetworkMode -ne 'none' -or @($item.HostConfig.PortBindings.PSObject.Properties).Count -ne 0 -or -not $item.State.Running){throw 'Isolation guard failed.'}
  if($item.Config.Image -ne 'supabase/postgres@sha256:49c938c7918f1543618b60568f5a995e52d98f19883075a14f89643e8b1571fe'){throw 'Unverified database image.'}
  $probe=Run "exec $Container psql -X -h /tmp -U supabase_admin -d postgres -At -c `"select current_setting('listen_addresses')='';`""
  if($probe.Code -ne 0 -or $probe.Out.Trim() -ne 't'){throw 'Database must listen on Unix socket only.'}
  return $item
}
function Sql([string]$Database,[string]$Text){
  $null=Guard
  return Run "exec -i $Container psql -X -h /tmp -U supabase_admin -d $Database --set ON_ERROR_STOP=1 -At" ($utf8.GetBytes($Text))
}
function RequireSuccess($Result,[string]$Name){
  $bytes=$utf8.GetBytes($Result.Out+"`n"+$Result.ErrorText)
  $cipher=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.File]::WriteAllBytes((Join-Path $evidence ($Name+'.log.dpapi')),$cipher)
  if($Result.Code -ne 0){throw "$Name failed. Details encrypted in private evidence directory."}
}
$manifest=Get-Content -LiteralPath (Join-Path $backup 'database-backup-manifest.json') -Raw|ConvertFrom-Json
if($manifest.project -ne 'gpmbkptimjipqsayrvce'){throw 'Unexpected backup origin.'}
if(Test-Path -LiteralPath (Join-Path $evidence 'restore-completed.json')){throw 'A completed restore already exists; do not overwrite evidence.'}
$inspection=Guard
$exists=Sql 'postgres' "select count(*) from pg_database where datname='anarosa_restore';"
if($exists.Code -ne 0){throw 'Could not inspect local database.'}
$resume=$exists.Out.Trim() -eq '1'
if($resume){
  if(-not $ResumeEmptyDatabase){throw 'Existing database requires an explicit empty-database resume.'}
  $empty=Sql 'anarosa_restore' "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_' and c.relkind in ('r','p','v','m','S');"
  if($empty.Code -ne 0 -or $empty.Out.Trim() -ne '0'){throw 'Resume refused: database contains objects. Never overwrite existing data.'}
}
$dump=Unseal 'database-full.dump.dpapi';$roles=Unseal 'roles.sql.dpapi'
# Keep the original Supabase bootstrap identity (OID 10). PostgreSQL 17 checks
# explicit GRANTED BY against that identity. The role already exists from initdb.
$roleSql=$utf8.GetString($roles) -replace '(?m)^CREATE ROLE supabase_admin;\r?\r?$', ''
if(-not $resume){
  RequireSuccess (Sql 'postgres' $roleSql) 'roles-restore'
  RequireSuccess (Sql 'postgres' "create database anarosa_restore owner postgres template template0;") 'create-local-database'
}
# Managed Supabase permits the postgres role to own its platform event trigger.
# Stock PostgreSQL checks SUPERUSER during ownership transfer. Promote only in
# this networkless clone and restore NOSUPERUSER before any integrity check.
if($roleSql -notmatch 'ALTER ROLE postgres WITH NOSUPERUSER'){throw 'Unexpected postgres role attributes.'}
RequireSuccess (Sql 'postgres' 'alter role postgres superuser;') 'temporary-local-restore-privilege'
$null=Guard
try {
  $restore=Run "exec -i $Container pg_restore --host=/tmp --username=supabase_admin --dbname=anarosa_restore --single-transaction --exit-on-error" $dump
} finally {
  RequireSuccess (Sql 'postgres' 'alter role postgres nosuperuser;') 'restore-original-role-privilege'
}
RequireSuccess $restore 'database-restore'
$completed=[ordered]@{project_origin=$manifest.project;container=$Container;database='anarosa_restore';completed_utc=[DateTime]::UtcNow.ToString('o');network='none';published_ports=0;socket_only=$true;archive_sha256=(Hash $dump);restore_exit_code=$restore.Code;integrity_validated=$false;migrations_applied=$false;image=$inspection.Config.Image}
[IO.File]::WriteAllText((Join-Path $evidence 'restore-completed.json'),($completed|ConvertTo-Json -Depth 5),$utf8)
[Array]::Clear($dump,0,$dump.Length);[Array]::Clear($roles,0,$roles.Length)
Write-Output 'Archive restored into isolated local database. Integrity validation is still required before migrations.'
