'use strict';

/**
 * Caché de CONTENIDO en disco, persistente por defecto.
 *
 * Se guarda por clave de contenido, no por job:
 *   mp3-<episodeId>.mp3      MP3 original descargado (+ .json con url/bytes)
 *   art-<hash-url>.<ext>     carátula del feed
 *   tagged-<hash-spec>.mp3   MP3 ya etiquetado (dedup por config)
 *
 * A diferencia de los jobs, ESTO NO SE BORRA con el TTL de 30 min:
 * CACHE_TTL_MS y CACHE_MAX_BYTES son 0 (= nunca / sin límite) por defecto.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CACHE_DIR = process.env.CACHE_DIR
  ? path.resolve(process.env.CACHE_DIR)
  : path.join(__dirname, '../cache');
const TTL_MS = Number(process.env.CACHE_TTL_MS || 0);
const MAX_BYTES = Number(process.env.CACHE_MAX_BYTES || 0);

function ensure() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  return CACHE_DIR;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function extension(mimeType) {
  if (/png/i.test(mimeType)) return 'png';
  if (/webp/i.test(mimeType)) return 'webp';
  return 'jpg';
}

/* ---------------- MP3 de origen ---------------- */

function mp3Path(episodeId) {
  return path.join(CACHE_DIR, `mp3-${episodeId}.mp3`);
}

function mp3MetaPath(episodeId) {
  return `${mp3Path(episodeId)}.json`;
}

function invalidateMp3(episodeId) {
  fs.rmSync(mp3Path(episodeId), { force: true });
  fs.rmSync(mp3MetaPath(episodeId), { force: true });
  fs.rmSync(`${mp3Path(episodeId)}.part`, { force: true });
}

/** Devuelve { hit, path, bytes, fetchedAt }. La URL debe coincidir (evita mezclar fixture/producción). */
function readMp3(episodeId, expectedUrl) {
  try {
    const meta = JSON.parse(fs.readFileSync(mp3MetaPath(episodeId), 'utf8'));
    const stat = fs.statSync(mp3Path(episodeId));
    if (meta.url === expectedUrl && meta.bytes === stat.size && stat.size > 0) {
      return { hit: true, path: mp3Path(episodeId), bytes: stat.size, fetchedAt: meta.fetchedAt };
    }
  } catch {
    // Sin entrada válida.
  }
  invalidateMp3(episodeId);
  return { hit: false, path: mp3Path(episodeId) };
}

function commitMp3(episodeId, url, bytes) {
  ensure();
  fs.writeFileSync(mp3MetaPath(episodeId), JSON.stringify({
    url,
    bytes,
    fetchedAt: new Date().toISOString()
  }, null, 2), 'utf8');
  return { path: mp3Path(episodeId), bytes };
}

/* ---------------- Carátula ---------------- */

function artworkPrefix(url) {
  return `art-${hash(url)}.`;
}

function readArtwork(url) {
  const prefix = artworkPrefix(url);
  try {
    const name = fs.readdirSync(CACHE_DIR).find(file => file.startsWith(prefix));
    if (!name) return null;
    const data = fs.readFileSync(path.join(CACHE_DIR, name));
    if (!data.length) return null;
    const mimeType = name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return { hit: true, mimeType, data };
  } catch {
    return null;
  }
}

function putArtwork(url, mimeType, data) {
  ensure();
  const target = path.join(CACHE_DIR, `${artworkPrefix(url)}${extension(mimeType)}`);
  fs.writeFileSync(target, data);
  return target;
}

/* ---------------- MP3 etiquetado ---------------- */

function taggedKey(spec) {
  return hash(JSON.stringify(spec));
}

function taggedPath(key) {
  return path.join(CACHE_DIR, `tagged-${key}.mp3`);
}

function getTagged(key) {
  const file = taggedPath(key);
  try {
    return fs.statSync(file).size > 0 ? file : null;
  } catch {
    return null;
  }
}

function taggedTemp(key) {
  return `${taggedPath(key)}.part-${process.pid}`;
}

function commitTagged(key, tempPath) {
  ensure();
  fs.renameSync(tempPath, taggedPath(key));
  return taggedPath(key);
}

/* ---------------- Inspección / limpieza ---------------- */

function stats() {
  ensure();
  const files = fs.readdirSync(CACHE_DIR).map(name => {
    const stat = fs.statSync(path.join(CACHE_DIR, name));
    return { name, bytes: stat.size, mtime: stat.mtime.toISOString() };
  });
  return {
    dir: CACHE_DIR,
    ttlMs: TTL_MS,
    maxBytes: MAX_BYTES,
    persistentByDefault: TTL_MS === 0 && MAX_BYTES === 0,
    entries: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    files
  };
}

function clear() {
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  ensure();
  return stats();
}

/**
 * Limpieza OPCIONAL. Con los valores por defecto no hace nada: el caché es
 * persistente a propósito para no volver a bajar 276 MB.
 */
function sweep() {
  if (!TTL_MS && !MAX_BYTES) return { deleted: 0, reason: 'persistente (TTL=0, MAX_BYTES=0)' };
  ensure();
  let entries = stats().files;
  let deleted = 0;

  if (TTL_MS > 0) {
    const cutoff = Date.now() - TTL_MS;
    for (const file of [...entries]) {
      if (Date.parse(file.mtime) < cutoff) {
        fs.rmSync(path.join(CACHE_DIR, file.name), { force: true });
        deleted++;
      }
    }
    entries = stats().files;
  }

  if (MAX_BYTES > 0) {
    let total = entries.reduce((sum, file) => sum + file.bytes, 0);
    const oldestFirst = [...entries].sort((a, b) => Date.parse(a.mtime) - Date.parse(b.mtime));
    for (const file of oldestFirst) {
      if (total <= MAX_BYTES) break;
      fs.rmSync(path.join(CACHE_DIR, file.name), { force: true });
      total -= file.bytes;
      deleted++;
    }
  }
  return { deleted };
}

module.exports = {
  CACHE_DIR,
  readMp3,
  commitMp3,
  invalidateMp3,
  readArtwork,
  putArtwork,
  taggedKey,
  getTagged,
  taggedTemp,
  commitTagged,
  stats,
  clear,
  sweep
};
