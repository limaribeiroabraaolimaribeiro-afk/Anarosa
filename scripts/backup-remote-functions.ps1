param([Parameter(Mandatory=$true)][string]$Cli,[string]$Destination='tmp/prepublicacao-20261017')
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$project='gpmbkptimjipqsayrvce'
if((Get-Content -LiteralPath (Join-Path $root 'supabase/.temp/project-ref') -Raw).Trim() -ne $project){throw 'Unexpected linked project.'}
$target=[IO.Path]::GetFullPath((Join-Path $root $Destination))
if(-not $target.StartsWith($root+[IO.Path]::DirectorySeparatorChar)){throw 'Invalid destination.'}
$functions=Get-Content -LiteralPath (Join-Path $target 'functions.json') -Raw|ConvertFrom-Json
$utf8=New-Object Text.UTF8Encoding($false)
$manifest=@()
$existingManifest=Join-Path $target 'remote-functions-manifest.json'
function Flatten($Items){foreach($item in $Items){if($item -is [array]){Flatten $item}elseif(-not $item.slug -and $item.value){Flatten $item.value}else{$item}}}
if(Test-Path -LiteralPath $existingManifest){$manifest=@(Flatten (Get-Content -LiteralPath $existingManifest -Raw|ConvertFrom-Json))}
foreach($function in $functions){
  if($function.slug -notmatch '^[a-z0-9-]+$'){throw 'Invalid function slug.'}
  $dir=Join-Path $target ('remote-functions/'+$function.slug)
  $existing=$manifest|Where-Object {$_.slug -eq $function.slug -and $_.version -eq $function.version -and $_.download_exit -eq 0}
  if($existing -and @($existing.files).Count -gt 0){continue}
  [IO.Directory]::CreateDirectory((Join-Path $dir 'supabase'))|Out-Null
  Copy-Item -LiteralPath (Join-Path $root 'supabase/config.toml') -Destination (Join-Path $dir 'supabase/config.toml')
  $ErrorActionPreference='Continue'
  $output=& $Cli functions download $function.slug --project-ref $project --use-api --workdir $dir 2>&1
  $code=$LASTEXITCODE
  $ErrorActionPreference='Stop'
  [IO.File]::WriteAllText((Join-Path $dir 'download.log'),($output -join "`n"),$utf8)
  $files=@(Get-ChildItem -LiteralPath (Join-Path $dir 'supabase/functions') -Recurse -File -ErrorAction SilentlyContinue|ForEach-Object{[PSCustomObject]@{path=$_.FullName.Substring($dir.Length+1).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}})
  $manifest+=[PSCustomObject]@{slug=$function.slug;version=$function.version;bundle_sha256=$function.ezbr_sha256;verify_jwt=$function.verify_jwt;download_exit=$code;files=$files}
  [IO.File]::WriteAllText((Join-Path $target 'remote-functions-manifest.json'),(ConvertTo-Json -InputObject $manifest -Depth 8),$utf8)
  [PSCustomObject]@{function=$function.slug;exit_code=$code;files=$files.Count}|ConvertTo-Json -Compress
  if($code -ne 0){throw 'Function download failed; inspect private download log.'}
}
