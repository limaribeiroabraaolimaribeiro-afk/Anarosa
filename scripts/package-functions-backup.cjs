const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const dir = process.argv[2] || 'tmp/prepublicacao-20261017';
const functions = JSON.parse(fs.readFileSync(path.join(dir, 'remote-functions-manifest.json')));
const blobs = {};
for (const fn of functions) {
  for (const file of fn.files) {
    const bytes = fs.readFileSync(path.join(dir, 'remote-functions', fn.slug, file.path));
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw Error(`Snapshot changed: ${fn.slug}`);
    }
    blobs[file.sha256] ??= bytes.toString('base64');
  }
}
const bundle = zlib.gzipSync(Buffer.from(JSON.stringify({ functions, blobs })), { level: 9 });
fs.writeFileSync(path.join(dir, 'functions-source.json.gz'), bundle);
process.stdout.write(JSON.stringify({
  functions: functions.length,
  unique_files: Object.keys(blobs).length,
  compressed_bytes: bundle.length,
}) + '\n');
