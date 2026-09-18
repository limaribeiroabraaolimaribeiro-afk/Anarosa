#!/usr/bin/env node
/**
 * Varredura simples por segredos versionados (cross-platform).
 * Uso: npm run secrets:scan
 * Sai com código 1 se encontrar algo suspeito.
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');

const PATTERNS = [
  /(client_secret|service_role(_key)?|refresh_token|access_token|api[_-]?key)\s*[:=]\s*['"][A-Za-z0-9._\-\/+]{16,}['"]/i,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, // JWT real
  /sk_(live|test)_[A-Za-z0-9]{16,}/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

// arquivos de teste/docs podem conter exemplos claramente falsos
const ALLOW = [/^supabase\/functions\/_tests\//, /^docs\//, /^scripts\/secrets-scan\.js$/];

const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((f) => !ALLOW.some((rx) => rx.test(f)))
  .filter((f) => /\.(js|ts|json|html|css|sql|toml|md|env|example|txt|yml|yaml)$/i.test(f) || f.startsWith('.env'));

let hits = 0;
for (const file of files) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  content.split(/\r?\n/).forEach((line, i) => {
    for (const rx of PATTERNS) {
      if (rx.test(line)) {
        hits++;
        console.log(`${file}:${i + 1}: possível segredo (padrão ${rx.source.slice(0, 40)}…)`);
      }
    }
  });
}

if (hits === 0) {
  console.log(`nenhum segredo encontrado (${files.length} arquivos verificados)`);
  process.exit(0);
}
console.error(`\n${hits} ocorrência(s) suspeita(s). Revise antes de commitar.`);
process.exit(1);
