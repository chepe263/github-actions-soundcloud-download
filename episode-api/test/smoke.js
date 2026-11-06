'use strict';

/**
 * Prueba end-to-end. Hostea LOCALMENTE el MP3 descargado (sample.mp3) y corre
 * la API en modo DATA_ONLY (bajo consumo) contra él.
 *
 *   npm test
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function hashAudioRange(file, start, end) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { start, end })) hash.update(chunk);
  return hash.digest('hex');
}

const { createFixtureServer, FIXTURES } = require('../scripts/fixture-serve');
const { createServer } = require('../server');
const { getEpisode } = require('../lib/episode');
const { CONFIG_FILE } = require('../lib/jobs');
const id3 = require('../lib/id3');
const cache = require('../lib/cache');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function api(base, route, options = {}) {
  const res = await fetch(`${base}${route}`, options);
  const contentType = res.headers.get('content-type') || '';
  const body = contentType.includes('json')
    ? await res.json()
    : contentType.startsWith('text/') ? await res.text() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body };
}

async function main() {
  const sample = path.join(FIXTURES, 'sample.mp3');
  assert.ok(fs.existsSync(sample), 'Falta fixtures/sample.mp3 — ejecuta: npm run fixture:download');
  const originalConfig = fs.readFileSync(CONFIG_FILE, 'utf8');
  cache.clear(); // caché frío y determinista para la prueba

  const fixture = createFixtureServer({ dir: FIXTURES });
  const fixturePort = await listen(fixture);
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/sample.mp3`;
  console.log(`Fixture local : ${fixtureUrl} (${(fs.statSync(sample).size / 1024 / 1024).toFixed(1)} MB)`);

  // Resolver: una sola vez, deja data/episode.json.
  const resolved = await getEpisode({ force: true });
  assert.ok(resolved.download && resolved.download.url, 'sin URL de MP3');
  assert.match(resolved.playlist, /TRACK OF THE MONTH/, 'playlist no formateado');
  console.log(`Resolver      : ${resolved.title}`);

  const apiServer = createServer({ dataOnly: true, mp3SourceUrl: fixtureUrl });
  const apiPort = await listen(apiServer);
  const base = `http://127.0.0.1:${apiPort}`;
  console.log(`API           : ${base} (DATA_ONLY=1)\n`);

  let jobId = null;
  try {
    let r = await api(base, '/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    console.log(`✓ /health  rss=${r.body.rssMb}MB heap=${r.body.heapMb}MB dataOnly=${r.body.dataOnly}`);

    r = await api(base, '/episode');
    assert.equal(r.status, 200);
    assert.ok(r.body.download.url.endsWith('.mp3'));
    assert.match(r.body.playlist, /^\d+\. .* - ".*"/m);
    console.log(`✓ /episode  MP3=${r.body.download.bitrateKbps}kbps playlist=${r.body.playlist.split('\n').length} líneas`);

    r = await api(base, '/episode/playlist');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/plain/);
    assert.match(r.body, /CLASSIC OF THE MONTH/);
    console.log('✓ /episode/playlist');

    r = await api(base, '/episode/download-url');
    assert.ok(r.body.url.startsWith('https://feeds.soundcloud.com/stream/'));
    console.log('✓ /episode/download-url');

    r = await api(base, '/episode/tags');
    assert.equal(r.body.source.available, true);
    const preview = r.body.toApply.frames;
    assert.equal(preview.TIT2, 'November 2026 Edition');
    assert.equal(String(preview.TRCK), '255');
    assert.equal(preview.TDOR, '2026-11-01');
    assert.equal(preview.TORY, '2026');
    assert.equal(preview.TYER, '2026');
    assert.equal(preview.TDRC, '2026');
    assert.equal(preview.USLT, resolved.playlist, 'USLT debe ser la salida completa de parsePlaylist()');
    assert.match(preview.APIC, /^https:\/\/i1\.sndcdn\.com\/artworks-/, 'APIC debe venir del itunes:image del feed');
    assert.equal(r.body.toApply.version, '2.4');
    console.log(`✓ /episode/tags  origen: ${JSON.stringify(r.body.source.tags)}`);
    console.log(`  TIT2="${preview.TIT2}" | TRCK="${preview.TRCK}" | TDOR="${preview.TDOR}"`);
    console.log(`  USLT = ${preview.USLT.split('\n').length} líneas (Lyrics)`);

    r = await api(base, '/config/tags');
    assert.match(r.body._descriptions.TIT2, /Edition/);
    console.log(`✓ GET /config/tags  ${Object.keys(r.body._descriptions).length} descripciones de frames`);

    // Correcciones: cambiar TIT2 en caliente y comprobar que el job lo aplica.
    const customTitle = 'Euphonic Sessions - PRUEBA DE ETIQUETAS';
    r = await api(base, '/config/tags', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frames: { TIT2: customTitle } })
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.config.frames.TIT2, customTitle);
    console.log('✓ PUT /config/tags (corrección aplicada en caliente)');

    r = await api(base, '/tags/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: { TPE1: 'Artista de prueba' } })
    });
    assert.equal(r.body.frames.TPE1, 'Artista de prueba');
    console.log('✓ POST /tags/preview');

    // Job completo contra el MP3 hosteado localmente.
    r = await api(base, '/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceUrl: fixtureUrl, filename: 'prueba.mp3' })
    });
    assert.equal(r.status, 200);
    jobId = r.body.id;
    console.log(`✓ POST /jobs -> ${jobId}`);

    let job;
    for (let i = 0; i < 60; i++) {
      const status = await api(base, `/jobs/${jobId}`);
      job = status.body;
      if (job.status === 'ready' || job.status === 'failed') break;
      await sleep(250);
    }
    assert.equal(job.status, 'ready', `job falló: ${job.error}`);
    assert.ok(!job.cacheHit.mp3, 'con caché frío el primer job debe descargar');
    console.log(`✓ job listo: ${(job.bytes / 1024 / 1024).toFixed(1)} MB, ${Object.keys(job.tagsApplied).length} frames, tag=${job.tagBytes}B`);
    console.log(`  etiquetas de origen: ${JSON.stringify(job.sourceTags.tags)}`);

    r = await api(base, `/jobs/${jobId}/file`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /audio\/mpeg/);
    assert.match(r.headers.get('content-disposition'), /prueba\.mp3/);
    assert.equal(r.body.subarray(0, 3).toString('latin1'), 'ID3');

    const tagged = job.file; // ahora apunta al caché de contenido
    assert.ok(tagged && fs.existsSync(tagged), 'job.file debe existir');
    const parsedOut = await id3.readTagsFromFile(tagged);
    const back = id3.summarize(parsedOut);
    assert.equal(back.version, '2.4.0');
    assert.equal(back.tags.TIT2, customTitle, 'TIT2 no se escribió');
    assert.equal(back.tags.TPE1, 'Kyau & Albert');
    assert.equal(back.tags.TALB, 'Euphonic Sessions with Kyau & Albert');
    assert.equal(back.tags.TRCK, '255');
    assert.equal(back.tags.TDOR, '2026-11-01');
    assert.equal(back.tags.TORY, '2026');
    assert.equal(back.tags.TYER, '2026');
    assert.equal(back.tags.TDRC, '2026');
    assert.equal(back.tags.TSSE, 'Lavf58.43.100', 'TSSE debe conservarse del MP3 de origen');
    assert.match(back.tags['TXXX:creation_time'], /^2026-10-31/);
    assert.equal(back.tags.USLT, resolved.playlist, 'USLT debe contener el playlist completo');
    assert.equal(back.hasId3v1, true);
    assert.match(String(back.tags.APIC), /^\[imagen image\/jpeg, \d+ bytes\]$/, 'APIC es obligatorio');
    const apicFrame = parsedOut.frames.find(frame => frame.id === 'APIC');
    assert.ok(apicFrame && apicFrame.image && apicFrame.image.length > 0);
    assert.equal(apicFrame.image.subarray(0, 2).toString('hex'), 'ffd8', 'APIC debe ser un JPEG válido');
    assert.equal(apicFrame.image.length, job.artwork.bytes);
    assert.equal(apicFrame.pictureType, 3, 'front cover');
    assert.equal(job.artwork.source, 'podcast feed XML (<itunes:image>)');

    // Integridad: el audio (todo lo que va después del tag) no debe cambiar.
    const parsedSrc = await id3.readTagsFromFile(sample);
    const srcHash = await hashAudioRange(sample, parsedSrc.audioOffset, parsedSrc.audioEnd - 1);
    const outHash = await hashAudioRange(tagged, parsedOut.audioOffset, parsedOut.audioEnd - 1);
    assert.equal(outHash, srcHash, '¡El audio cambió al re-etiquetar!');
    console.log(`✓ audio intacto (sha256 ${srcHash.slice(0, 16)}…), solo cambió la cabecera ID3`);
    console.log(`✓ archivo etiquetado: ID3v${back.version}, ${back.frameCount} frames`);
    console.log(`  TIT2=${back.tags.TIT2} | TRCK=${back.tags.TRCK}`);
    console.log(`  TDOR=${back.tags.TDOR} | TORY=${back.tags.TORY} | TDRC=${back.tags.TDRC}`);
    console.log(`  USLT=${back.tags.USLT.split('\n').length} líneas | TSSE=${back.tags.TSSE} | ID3v1=${back.hasId3v1}`);
    console.log(`  APIC=${back.tags.APIC} (${job.artwork.url})`);

    // Range (útil para el frontend / reproductores).
    const rangeRes = await fetch(`${base}/jobs/${jobId}/file`, { headers: { Range: 'bytes=0-99' } });
    assert.equal(rangeRes.status, 206);
    assert.equal((await rangeRes.arrayBuffer()).byteLength, 100);
    console.log('✓ Range 206 en /jobs/:id/file');

    r = await api(base, `/jobs/${jobId}`, { method: 'DELETE' });
    assert.equal(r.body.deleted, true);
    console.log('✓ DELETE /jobs/:id');

    // ---- Caché de contenido ----
    r = await api(base, '/cache');
    assert.equal(r.status, 200);
    assert.ok(r.body.entries >= 4, 'deben existir mp3+meta+carátula+etiquetado');
    assert.equal(r.body.persistentByDefault, true);
    console.log(`✓ GET /cache: ${r.body.entries} entradas, ${(r.body.totalBytes / 1024 / 1024).toFixed(1)} MB, persistente=${r.body.persistentByDefault}`);

    // Segundo job idéntico: todo desde caché, sin red ni re-etiquetado.
    r = await api(base, '/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceUrl: fixtureUrl, filename: 'prueba2.mp3' })
    });
    const job2Id = r.body.id;
    let job2;
    for (let i = 0; i < 60; i++) {
      const status = await api(base, `/jobs/${job2Id}`);
      job2 = status.body;
      if (job2.status === 'ready' || job2.status === 'failed') break;
      await sleep(250);
    }
    assert.equal(job2.status, 'ready', `segundo job falló: ${job2.error}`);
    assert.equal(job2.cacheHit.mp3, true, 'el MP3 debe venir del caché');
    assert.equal(job2.cacheHit.artwork, true, 'la carátula debe venir del caché');
    assert.equal(job2.cacheHit.tagged, true, 'el MP3 etiquetado debe venir del caché');
    assert.equal(job2.bytes, job.bytes);
    console.log('✓ segundo job: 100% caché (sin descarga, sin carátula, sin re-etiquetar)');

    // Borrar el job NO borra el contenido cacheado.
    r = await api(base, `/jobs/${job2Id}`, { method: 'DELETE' });
    assert.equal(r.body.deleted, true);
    r = await api(base, '/cache');
    assert.ok(r.body.entries >= 4, 'el caché debe sobrevivir al borrado del job');
    console.log('✓ DELETE /jobs/:id conserva el caché de contenido');

    console.log('\n✅ Smoke test completo.');
  } finally {
    // Restaurar la plantilla original y cerrar servidores.
    fs.writeFileSync(CONFIG_FILE, originalConfig, 'utf8');
    if (jobId) {
      const dir = path.join(__dirname, `../jobs/${jobId}`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    await new Promise(resolve => apiServer.close(resolve));
    await new Promise(resolve => fixture.close(resolve));
  }
}

main().catch(error => {
  console.error(`\n❌ ${error.message}`);
  if (process.env.DEBUG) console.error(error.stack);
  process.exit(1);
});
