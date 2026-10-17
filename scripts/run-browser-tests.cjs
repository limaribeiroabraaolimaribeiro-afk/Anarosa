const { fork } = require('node:child_process');
const path = require('node:path');
const server = fork(path.join(__dirname, 'serve-local.cjs'), [], {
  env: { ...process.env, ANAROSA_PUBLIC_ROOT: path.resolve(__dirname, '../_site') },
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
let runner, finished = false;
const timer = setTimeout(() => {
  server.kill();
  process.exitCode = 1;
}, 15000);
server.on('message', (message) => {
  if (message !== 'ready') return;
  clearTimeout(timer);
  runner = fork(require.resolve('@playwright/test/cli'), ['test', ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  runner.on('exit', (code) => {
    finished = true;
    process.exitCode = code ?? 1;
    server.send('shutdown');
  });
});
server.on('exit', (code) => {
  clearTimeout(timer);
  if (!finished) {
    if (runner) runner.kill();
    process.exitCode = code || 1;
  }
});
process.on('SIGINT', () => {
  if (runner) runner.kill();
  server.kill();
  process.exitCode = 130;
});
