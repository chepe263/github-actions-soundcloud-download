'use strict';

/**
 * Verifica que el servidor funciona con un heap de 64 MB (host con RAM limitada).
 *   node test/lowram.js
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const child = spawn(process.execPath, [
  '--max-old-space-size=64',
  '--max-semi-space-size=2',
  'server.js'
], {
  cwd: root,
  env: { ...process.env, DATA_ONLY: '1', PORT: '0' },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
child.stdout.on('data', chunk => { output += chunk.toString(); });
child.stderr.on('data', chunk => { output += chunk.toString(); });

const timeout = setTimeout(() => {
  console.error('❌ Timeout esperando al servidor low-RAM\n' + output);
  child.kill();
  process.exit(1);
}, 20000);

(async () => {
  let port = null;
  while (!port) {
    const match = /escuchando en http:\/\/localhost:(\d+)/.exec(output);
    if (match) { port = Number(match[1]); break; }
    if (child.exitCode !== null) throw new Error(`El servidor terminó: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const base = `http://127.0.0.1:${port}`;
  const health = await (await fetch(`${base}/health`)).json();
  const episode = await (await fetch(`${base}/episode`)).json();

  console.log(`Servidor low-RAM arrancado en ${base}`);
  console.log(`  node       : ${health.node}`);
  console.log(`  dataOnly   : ${health.dataOnly}`);
  console.log(`  RSS        : ${health.rssMb} MB`);
  console.log(`  heap usado : ${health.heapMb} MB (tope 64 MB)`);
  console.log(`  playlist   : ${episode.playlist.split('\n').length} líneas`);
  console.log(`  MP3        : ${episode.download.bitrateKbps} kbps`);

  if (!health.ok || !episode.download || !episode.playlist) {
    throw new Error('La respuesta no es válida');
  }
  console.log('\n✅ Modo RAM limitada OK.');
})().catch(error => {
  console.error(`❌ ${error.message}\n${output}`);
  process.exitCode = 1;
}).finally(() => {
  clearTimeout(timeout);
  child.kill();
});
