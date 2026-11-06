'use strict';

const fs = require('node:fs');
const { once } = require('node:events');
const { Readable, Transform } = require('node:stream');
const { finished, pipeline } = require('node:stream/promises');

const { browserHeaders } = require('./soundcloud');

async function fetchBuffer(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: browserHeaders({ Accept: '*/*' }),
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      }
    }
  }
  throw lastError;
}

async function fetchText(url) {
  return (await fetchBuffer(url)).toString('utf8');
}

/**
 * Parsea un playlist HLS de medios. Devuelve la URL del init.mp4 (fMP4) y la
 * lista ordenada de segmentos. Si es un master playlist, baja a la primera variante.
 */
async function parseMediaPlaylist(url, depth = 0) {
  if (depth > 3) throw new Error('Demasiadas redirecciones de playlist HLS.');

  const text = await fetchText(url);
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

  if (lines.some(line => line.startsWith('#EXT-X-KEY'))) {
    throw new Error('El stream está cifrado (#EXT-X-KEY); hace falta ffmpeg/yt-dlp.');
  }

  const variantIndex = lines.findIndex(line => line.startsWith('#EXT-X-STREAM-INF'));
  if (variantIndex !== -1) {
    const variant = lines.slice(variantIndex + 1).find(line => !line.startsWith('#'));
    if (!variant) throw new Error('Master playlist sin variantes.');
    return parseMediaPlaylist(new URL(variant, url).toString(), depth + 1);
  }

  const mapLine = lines.find(line => line.startsWith('#EXT-X-MAP'));
  let initUrl = null;
  if (mapLine) {
    const match = /URI="([^"]+)"|URI='([^']+)'/.exec(mapLine);
    const uri = match && (match[1] || match[2]);
    if (uri) initUrl = new URL(uri, url).toString();
  }

  const segments = lines
    .filter(line => !line.startsWith('#'))
    .map(line => new URL(line, url).toString());

  if (!segments.length) throw new Error('El m3u8 no contiene segmentos.');

  return { initUrl, segments, playlistUrl: url };
}

/**
 * Descarga el audio SIN yt-dlp ni ffmpeg.
 * Los streams actuales de SoundCloud son fMP4 (init.mp4 + segmentos .m4s) sin
 * cifrar: concatenar los bytes en orden produce un .m4a válido.
 *
 * maxSegments es interno, útil para smoke tests.
 */
async function downloadHls(url, destPath, { concurrency = 6, maxSegments = null, onProgress } = {}) {
  const { initUrl, segments } = await parseMediaPlaylist(url);
  const selected = maxSegments ? segments.slice(0, maxSegments) : segments;
  const total = selected.length;

  const stream = fs.createWriteStream(destPath, { flags: 'w' });
  let bytes = 0;
  let done = 0;

  async function write(buffer) {
    bytes += buffer.length;
    if (!stream.write(buffer)) await once(stream, 'drain');
  }

  if (initUrl) {
    await write(await fetchBuffer(initUrl));
  }

  for (let offset = 0; offset < total; offset += concurrency) {
    const batch = selected.slice(offset, offset + concurrency);
    const buffers = await Promise.all(batch.map(segmentUrl => fetchBuffer(segmentUrl)));
    for (const buffer of buffers) {
      await write(buffer);
      done += 1;
      if (onProgress) onProgress(done, total, bytes);
    }
  }

  stream.end();
  await finished(stream);

  return { bytes, segments: total, init: Boolean(initUrl), file: destPath };
}

/**
 * Descarga directa por streaming (MP3 original del podcast o URL progresiva).
 * Sigue redirecciones, soporta Range y reporta bytes sin cargar todo en memoria.
 * maxBytes es interno, para smoke tests (pide solo ese rango).
 */
async function downloadProgressive(url, destPath, { onProgress, maxBytes = null } = {}) {
  const headers = browserHeaders({ Accept: 'audio/mpeg, */*' });
  if (maxBytes) headers.Range = `bytes=0-${maxBytes - 1}`;

  const res = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(15 * 60 * 1000)
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} al descargar ${new URL(url).host}`);
  }

  const contentRange = res.headers.get('content-range');
  const total = contentRange
    ? Number(contentRange.split('/')[1])
    : Number(res.headers.get('content-length')) || 0;

  let received = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (onProgress) onProgress(0, 1, received);
      callback(null, chunk);
    }
  });

  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(destPath));
  if (onProgress) onProgress(1, 1, received);

  return { bytes: received, total: total || received, segments: 1, init: false, file: destPath };
}

module.exports = { downloadHls, downloadProgressive, parseMediaPlaylist, fetchText };
