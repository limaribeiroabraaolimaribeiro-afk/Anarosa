param(
  [Parameter(Mandatory=$true)][string]$Cli,
  [string]$ProjectRef='gpmbkptimjipqsayrvce',
  [string]$Destination='tmp/prepublicacao-20261017'
)
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$linked=(Get-Content -LiteralPath (Join-Path $root 'supabase/.temp/project-ref') -Raw).Trim()
if($linked -ne $ProjectRef -or $ProjectRef -ne 'gpmbkptimjipqsayrvce'){throw 'Unexpected project; inspection stopped.'}
$target=[IO.Path]::GetFullPath((Join-Path $root $Destination))
if(-not $target.StartsWith($root+[IO.Path]::DirectorySeparatorChar)){throw 'Destination must be in workspace.'}
[IO.Directory]::CreateDirectory($target)|Out-Null
$utf8=New-Object Text.UTF8Encoding($false)
$script:hasFailures=$false
Add-Type -AssemblyName System.Security
function Capture([string]$Name,[string[]]$CliArgs){
  $stderr=Join-Path $target ($Name+'.stderr.txt')
  $ErrorActionPreference='Continue'
  $output=& $Cli @CliArgs 2>$stderr
  $code=$LASTEXITCODE
  if($code -ne 0){$script:hasFailures=$true}
  $ErrorActionPreference='Stop'
  $joined=$output -join "`n"
  if($Name -eq 'secret-names' -and $code -eq 0){
    $protected=[Security.Cryptography.ProtectedData]::Protect($utf8.GetBytes($joined),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    [IO.File]::WriteAllBytes((Join-Path $target 'secrets-list.dpapi'),$protected)
    $safe=@($joined|ConvertFrom-Json|ForEach-Object{[PSCustomObject]@{name=$_.name;updated_at=$_.updated_at}})|ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $target ($Name+'.json')),$safe,$utf8)
  }else{[IO.File]::WriteAllText((Join-Path $target ($Name+'.json')),$joined,$utf8)}
  [PSCustomObject]@{check=$Name;exit_code=$code;bytes=([Text.Encoding]::UTF8.GetByteCount(($output -join "`n")))}|ConvertTo-Json -Compress
}
Capture 'functions' @('functions','list','--project-ref',$ProjectRef,'-o','json')
Capture 'inventory' @('db','query','--linked','--project-ref',$ProjectRef,'--file',(Join-Path $root 'scripts/sql/pre-publication-inventory.sql'),'-o','json')
Capture 'advisors' @('db','advisors','--linked','--project-ref',$ProjectRef,'--type','all','--fail-on','none','-o','json')
Capture 'backups' @('backups','list','--project-ref',$ProjectRef,'-o','json')
Capture 'secret-names' @('secrets','list','--project-ref',$ProjectRef,'-o','json')
if($script:hasFailures){throw 'One or more read-only checks failed. Review the private diagnostic files.'}
