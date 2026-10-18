const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'tmp/prepublicacao-20261017');
function json(name){const b=fs.readFileSync(path.join(dir,name));return JSON.parse(b[0]===255&&b[1]===254?b.toString('utf16le').replace(/^\uFEFF/,''):b.toString('utf8').replace(/^\uFEFF/,''));}
const remote=json('functions.json'),manifest=json('remote-functions-manifest.json');
const local=fs.readdirSync(path.join(root,'supabase/functions'),{withFileTypes:true}).filter(d=>d.isDirectory()&&!d.name.startsWith('_')).map(d=>d.name);
const normalize=b=>b.toString('utf8').replace(/\r\n/g,'\n').trim();
const functions=remote.map(fn=>{
  const snapshot=manifest.find(m=>m.slug===fn.slug&&m.version===fn.version);
  if(!snapshot)throw Error(`Missing remote backup: ${fn.slug}`);
  const changes=[],missing=[];
  for(const file of snapshot.files){
    const relative=file.path.replace(/\\/g,'/');
    const remotePath=path.join(dir,'remote-functions',fn.slug,relative);
    const bytes=fs.readFileSync(remotePath);const digest=crypto.createHash('sha256').update(bytes).digest('hex');
    if(digest!==file.sha256)throw Error(`Snapshot hash mismatch: ${fn.slug}/${relative}`);
    const localPath=path.join(root,relative);
    if(!fs.existsSync(localPath))missing.push(relative);
    else if(normalize(bytes)!==normalize(fs.readFileSync(localPath)))changes.push(relative);
  }
  // Also follow the local dependency graph, since a changed shared module must
  // be bundled again even when the entrypoint itself has not changed.
  const visited=new Set();function dependencies(file){if(visited.has(file))return;visited.add(file);if(!fs.existsSync(file))return;const code=fs.readFileSync(file,'utf8');for(const m of code.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)){if(m[1].startsWith('.'))dependencies(path.resolve(path.dirname(file),m[1]));}}
  dependencies(path.join(root,'supabase/functions',fn.slug,'index.ts'));
  const bundled=new Set(snapshot.files.map(f=>f.path.replace(/\\/g,'/')));
  const newDependencies=[...visited].map(p=>path.relative(root,p).replace(/\\/g,'/')).filter(p=>!bundled.has(p));
  return {slug:fn.slug,version:fn.version,verify_jwt:fn.verify_jwt,backup_files:snapshot.files.length,changed_files:changes,remote_only:missing,new_dependencies:newDependencies,requires_deploy:changes.length>0||newDependencies.length>0};
});
const inventory=json('inventory.json').rows[0].inventory;
const migrations=fs.readdirSync(path.join(root,'supabase/migrations')).filter(f=>f.endsWith('.sql')).map(file=>({file,version:file.split('_')[0],sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'supabase/migrations',file))).digest('hex')}));
const result={project:'gpmbkptimjipqsayrvce',generated_at:new Date().toISOString(),functions,new_functions:local.filter(s=>!remote.some(f=>f.slug===s)),migrations:{remote:inventory.migrations,local:migrations,pending:migrations.filter(m=>!inventory.migrations.some(r=>r.version===m.version)),remote_only:inventory.migrations.filter(m=>!migrations.some(l=>l.version===m.version))},summary:{remote_functions:remote.length,local_functions:local.length,requires_deploy:functions.filter(f=>f.requires_deploy).length,backed_up_functions:functions.length}};
fs.writeFileSync(path.join(dir,'release-comparison.json'),JSON.stringify(result,null,2));
process.stdout.write(JSON.stringify({summary:result.summary,new_functions:result.new_functions,pending_migrations:result.migrations.pending.map(m=>m.file),remote_only_migrations:result.migrations.remote_only},null,2));
