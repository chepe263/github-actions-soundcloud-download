'use strict';

/**
 * Descarga el MP3 real del episodio más reciente para usarlo como fixture local.
 * También genera un sample.mp3 (primeros MB) para que las pruebas sean rápidas.
 *
 *   npm run fixture:download
 *   SAMPLE_BYTES=2097152 npm run fixture:download
 */
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const sc = require('../../soundcloud-latest-episode/soundcloud');
const { resolveDirectMp3 } = require('../../soundcloud-latest-episode/podcast');

const FIXTURES = path.join(__dirname, '../fixtures');
const FULL = path.join(FIXTURES, 'episode.mp3');
const SAMPLE = path.join(FIXTURES, 'sample.mp3');
const SAMPLE_BYTES = Number(process.env.SAMPLE_BYTES || 2 * 1024 * 1024);

async function main() {
  fs.mkdirSync(FIXTURES, { recursive: true });

  const token = await sc.resolveClientId(null);
  const user = await sc.resolveUser(token.clientId, process.env.SOUNDCLOUD_USER || 'euphonicsessions');
  const track = await sc.findLatestTrack(token.clientId, user);
  const { sources } = await resolveDirectMp3(user, track, { get: sc.get });
  const source = sources.find(s => s.verified);

  if (!source) throw new Error('No se pudo resolver un MP3 verificado.');

  console.log(`Episodio : ${track.title}`);
  console.log(`MP3      : ${source.url}`);
  console.log(`Tamaño   : ${source.length ? (source.length / 1024 / 1024).toFixed(1) + ' MB' : 'desconocido'}`);
  console.log(`Destino  : ${FULL}\n`);

  const res = await fetch(source.url, {
    headers: sc.browserHeaders({ Accept: 'audio/mpeg,*/*' }),
    redirect: 'follow',
    signal: AbortSignal.timeout(20 * 60 * 1000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar el MP3`);

  const total = Number(res.headers.get('content-length')) || source.length || 0;
  let received = 0;
  let lastLogged = 0;
  const { Transform } = require('node:stream');
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (received - lastLogged >= 20 * 1024 * 1024) {
        lastLogged = received;
        console.log(`  ${(received / 1024 / 1024).toFixed(1)} MB${total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB` : ''}`);
      }
      cb(null, chunk);
    }
  });

  const tmp = `${FULL}.part`;
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));
  fs.renameSync(tmp, FULL);
  console.log(`\n✓ Descargado: ${(received / 1024 / 1024).toFixed(1)} MB`);

  // Muestra corta y válida (conserva la cabecera ID3 + frames de audio).
  const bytes = Math.min(SAMPLE_BYTES, fs.statSync(FULL).size);
  const fd = fs.openSync(FULL, 'r');
  const buf = Buffer.alloc(bytes);
  fs.readSync(fd, buf, 0, bytes, 0);
  fs.closeSync(fd);
  fs.writeFileSync(SAMPLE, buf);
  console.log(`✓ Sample para pruebas: ${SAMPLE} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch(error => {
  console.error(`\n❌ ${error.message}`);
  process.exit(1);
});
