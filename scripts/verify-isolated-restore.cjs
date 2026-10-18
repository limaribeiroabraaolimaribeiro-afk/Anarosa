const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const evidence = path.resolve(root, process.env.ANAROSA_HOMOLOG_EVIDENCE_DIR || 'tmp/homologacao-20261017');
if (!evidence.startsWith(path.join(root, 'tmp') + path.sep)) throw Error('Evidence must stay in private workspace tmp');
const backup = path.join(root, '.backups/gpmbkptimjipqsayrvce/20261018T005827Z');
const container = process.env.ANAROSA_HOMOLOG_CONTAINER || process.argv[2] || 'anarosa-restore-20261017-v3';
const database = 'anarosa_restore';
const owner = 'supabase_admin';
const image = 'supabase/postgres@sha256:49c938c7918f1543618b60568f5a995e52d98f19883075a14f89643e8b1571fe';
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function docker(args, input) {
  return execFileSync('docker.exe', ['--context', 'desktop-linux', ...args], {
    input, timeout: 120000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
function guard() {
  if (!/^anarosa-restore-[a-z0-9-]+$/.test(container)) throw Error('Invalid restore container');
  const context = JSON.parse(docker(['context', 'inspect', 'desktop-linux']))[0];
  if (!context.Endpoints.docker.Host.startsWith('npipe://')) throw Error('A local named pipe is required');
  const c = JSON.parse(docker(['inspect', container]))[0];
  if (c.Config.Labels['anarosa.purpose'] !== 'isolated-backup-restore' ||
      c.Config.Image !== image || c.HostConfig.NetworkMode !== 'none' ||
      Object.keys(c.HostConfig.PortBindings || {}).length || !c.State.Running) {
    throw Error('Container isolation guard failed');
  }
  return c;
}
function sql(text) {
  guard();
  return docker(['exec', '-i', container, 'psql', '-X', '-h', '/tmp', '-U', owner,
    '-d', database, '-qAt', '--set', 'ON_ERROR_STOP=1'], 'set search_path=public;\n' + text).toString('utf8').trim();
}
function unseal(file) {
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'database-backup-manifest.json')));
  const entry = manifest.files.find((x) => x.file === file);
  const cipher = fs.readFileSync(path.join(backup, file));
  if (!entry || hash(cipher) !== entry.encrypted_sha256) throw Error('Cipher checksum mismatch');
  // The secret archive travels only through memory and pipes, never a plaintext file.
  const p = path.join(backup, file).replaceAll("'", "''");
  const code = `Add-Type -AssemblyName System.Security; $b=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('${p}'),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::OpenStandardOutput().Write($b,0,$b.Length)`;
  const bytes = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { maxBuffer: 32 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (hash(bytes) !== entry.plaintext_sha256) throw Error('Archive checksum mismatch');
  return bytes;
}
function persistFailure(error, name) {
  if (!/^[a-z-]+$/.test(name)) return;
  const destination = path.join(evidence, `${name}-${Date.now()}.log.dpapi`).replaceAll("'", "''");
  const code = `Add-Type -AssemblyName System.Security; $m=New-Object IO.MemoryStream; [Console]::OpenStandardInput().CopyTo($m); $b=[Security.Cryptography.ProtectedData]::Protect($m.ToArray(),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [IO.File]::WriteAllBytes('${destination}',$b)`;
  const details = JSON.stringify({ message: error.message, stack: error.stack, stderr: error.stderr?.toString('utf8') });
  execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { input: details, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}
function copyBlocks(text) {
  const result = new Map();
  const re = /^COPY (.+) FROM stdin;\n([\s\S]*?)^\\\.\n/gm;
  for (const match of text.replaceAll('\r\n', '\n').matchAll(re)) {
    const rows = match[2] ? match[2].slice(0, -1).split('\n').sort() : [];
    result.set(match[1], { rows: rows.length, sha256: hash(rows.join('\n')) });
  }
  return result;
}
function verify() {
  const c = guard();
  const restore = JSON.parse(fs.readFileSync(path.join(evidence, 'restore-completed.json')));
  if (restore.container !== container || restore.migrations_applied || fs.existsSync(path.join(evidence, 'local-migrations.json'))) throw Error('Expected unmigrated restore; preserve the original integrity evidence');
  const dump = unseal('database-full.dump.dpapi');
  const sourceText = execFileSync(path.join(root, 'tmp/tools/postgresql-17.6/bin/pg_restore.exe'), ['--data-only', '--no-owner', '--no-privileges', '--file=-'], { input: dump, maxBuffer: 32 * 1024 * 1024, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).toString('utf8');
  const restoredText = docker(['exec', container, 'pg_dump', '-h', '/tmp', '-U', owner, '-d', database, '--data-only', '--no-owner', '--no-privileges']).toString('utf8');
  const source = copyBlocks(sourceText), restored = copyBlocks(restoredText);
  if (source.size < 20) throw Error('Unexpectedly few archived tables');
  const comparisons = [...source].map(([table, expected]) => ({ table, ...expected, equal: JSON.stringify(expected) === JSON.stringify(restored.get(table)) }));
  const dataEqual = comparisons.every((x) => x.equal) && [...restored.keys()].every((table) => source.has(table));
  const inventory = JSON.parse(sql(fs.readFileSync(path.join(root, 'scripts/sql/pre-publication-inventory.sql'), 'utf8')));
  const origin = JSON.parse(fs.readFileSync(path.join(backup, 'inventory.json'))).rows[0].inventory;
  const ordered = (items) => (items || []).map((x) => JSON.stringify(canonical(x))).sort();
  const equal = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
  const checks = {
    archive_data_equal: dataEqual,
    eight_migrations: inventory.migrations.length === 8 && equal(origin.migrations, inventory.migrations),
    columns_equal: equal(origin.columns, inventory.columns),
    routines_equal: equal(origin.routines, inventory.routines),
    constraints_equal: equal(origin.constraints, inventory.constraints),
    policies_equal: equal(origin.policies, inventory.policies),
    table_security_equal: equal(origin.tables.map(({ estimated_rows, ...x }) => x), inventory.tables.map(({ estimated_rows, ...x }) => x)),
    auth_counts_equal: same(origin.auth, inventory.auth),
    storage_counts_equal: same(origin.storage, inventory.storage),
    socket_only: sql("select current_setting('listen_addresses')='';") === 't',
    cron_launch_disabled: sql("select current_setting('cron.launch_active_jobs');") === 'off',
    net_worker_excludes_restore_database: sql("select current_setting('pg_net.database_name') <> current_database();") === 't',
    postgres_role_not_superuser: sql("select not rolsuper from pg_roles where rolname='postgres';") === 't',
    migration_role_owns_database: sql("select pg_get_userbyid(datdba)='postgres' from pg_database where datname=current_database();") === 't',
    extension_versions_equal: equal(origin.extensions, inventory.extensions),
    constraints_validated: sql("select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in ('public','private','auth','storage') and not convalidated;") === '0',
  };
  const result = { verified_utc: new Date().toISOString(), container, container_id: c.Id, database, archive_sha256: hash(dump), checks, tables: comparisons, extensions: { source: origin.extensions, restored: inventory.extensions }, passed: Object.values(checks).every(Boolean) };
  fs.writeFileSync(path.join(evidence, 'restore-integrity.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(evidence, 'restored-inventory.json'), JSON.stringify(inventory, null, 2));
  restore.integrity_validated = result.passed;
  fs.writeFileSync(path.join(evidence, 'restore-completed.json'), JSON.stringify(restore, null, 2));
  dump.fill(0);
  console.log(JSON.stringify({ passed: result.passed, checks, tables: comparisons.length }, null, 2));
  if (!result.passed) process.exitCode = 1;
}
module.exports = { guard, sql, docker, hash, root, evidence, backup, container, database, owner, persistFailure };
if (require.main === module) try { verify(); } catch (error) {
  persistFailure(error, 'integrity-error');
  // SQL/COPY errors may contain customer rows: never print child-process buffers.
  console.error('Isolated integrity verification failed. No migration was applied; inspect private evidence.');
  process.exitCode = 1;
}
