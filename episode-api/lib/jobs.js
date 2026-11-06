'use strict';

/**
 * Jobs: descargar MP3 -> leer/imprimir etiquetas de origen -> escribir ID3 ->
 * dejar el archivo listo para servir. Todo por streaming (RAM constante).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const id3 = require('./id3');
const cache = require('./cache');
const { getEpisode } = require('./episode');
const sc = require('../../soundcloud-latest-episode/soundcloud');

const CONFIG_FILE = path.join(__dirname, '../tags.config.json');
const JOBS_DIR = path.join(__dirname, '../jobs');

const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS || 1));
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 30 * 60 * 1000);
const MAX_JOBS = Math.max(1, Number(process.env.MAX_JOBS || 5));

const jobs = new Map();
const queue = [];
let running = 0;

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function saveConfig(config) {
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return config;
}

/** Normaliza opcionalmente el tamaño de las imágenes de SoundCloud (-tNNNxNNN). */
function normalizeArtworkUrl(url, size) {
  if (!url || !size) return url;
  const clean = String(size).replace(/^t/, '');
  return /-t\d+x\d+/i.test(url)
    ? url.replace(/-t\d+x\d+/i, `-t${clean}`)
    : url;
}

async function downloadArtwork(url) {
  const res = await fetch(url, {
    headers: sc.browserHeaders({ Accept: 'image/*' }),
    redirect: 'follow',
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar la carátula`);
  const mimeType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (!/^image\//i.test(mimeType)) throw new Error(`La carátula no es una imagen (${mimeType})`);
  const data = Buffer.from(await res.arrayBuffer());
  if (!data.length) throw new Error('La carátula descargada está vacía');
  return { mimeType, data };
}

function contextFromEpisode(episode, config = loadConfig()) {
  const feed = episode.feed || {};
  const monthNumber = feed.monthNumber || null;
  const artworkSize = config.artwork && config.artwork.size;

  // TRCK = base configurable + número de episodio.
  const trackConfig = config.trackNumber || {};
  const trckBase = Number(trackConfig.base ?? 250);
  const configuredNumber = trackConfig.episodeNumber;
  const episodeNumber = (configuredNumber === undefined || configuredNumber === null || configuredNumber === 'auto')
    ? (feed.episodeNumber || 1)
    : Number(configuredNumber);
  const trackNumber = trckBase + episodeNumber;

  return {
    title: feed.title || episode.title,
    subtitle: feed.subtitle || '',
    edition: feed.month && feed.year ? `${feed.month} ${feed.year} Edition` : (feed.subtitle || ''),
    soundcloudTitle: episode.title,
    artist: feed.artist || 'Kyau & Albert',
    album: feed.album || 'Euphonic Sessions with Kyau & Albert',
    publisher: feed.publisher || 'Euphonic',
    copyright: feed.copyright || '',
    genre: feed.genre || 'Trance',
    year: feed.year || '',
    month: feed.month || '',
    monthNumber: monthNumber || '',
    monthNumberPadded: monthNumber ? String(monthNumber).padStart(2, '0') : '',
    date: feed.published || episode.created_at || '',
    originalDate: feed.originalDate || '',
    originalYear: feed.originalYear || feed.year || '',
    duration: feed.duration || '',
    guid: feed.guid || '',
    keywords: feed.keywords || '',
    url: episode.permalink_url,
    downloadUrl: episode.download ? episode.download.url : '',
    playlist: episode.playlist || '',
    lyrics: episode.playlist || '',
    playlistBody: episode.playlistBody || '',
    playlistForTag: episode.playlistForTag || '',
    artworkUrl: normalizeArtworkUrl(episode.artworkUrl || '', artworkSize),
    artworkSource: episode.artworkSource || '',
    trckBase,
    episodeNumber,
    trackNumber
  };
}

function renderTagPreview(episode, override = {}) {
  const config = loadConfig();
  const frames = { ...(config.frames || {}), ...override };
  return {
    version: config.version,
    strip: config.strip !== false,
    preserve: config.preserve || [],
    frames: id3.renderFrames(frames, contextFromEpisode(episode, config))
  };
}

function id3v1From(frames, episode) {
  return {
    title: frames.TIT2 || episode.title,
    artist: frames.TPE1 || 'Kyau & Albert',
    album: frames.TALB || 'Euphonic Sessions with Kyau & Albert',
    year: frames.TYER || frames.TDRC || (episode.feed && episode.feed.year) || '',
    track: frames.TRCK || '',
    genre: 255
  };
}

function jobDir(id) {
  return path.join(JOBS_DIR, id);
}

function createJob(options = {}) {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  const id = crypto.randomUUID();
  const dir = jobDir(id);
  fs.mkdirSync(dir, { recursive: true });

  const job = {
    id,
    status: 'queued',
    stage: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    progress: { bytes: 0, total: 0 },
    sourceUrl: options.sourceUrl || null,
    maxBytes: options.maxBytes || null,
    tagsOverride: options.tagsOverride || null,
    filename: options.filename || null,
    episode: options.episode || null,
    sourceTags: null,
    tagsApplied: null,
    tagBytes: null,
    cacheHit: {},
    artwork: null,
    file: null,
    bytes: null,
    error: null,
    dir
  };

  jobs.set(id, job);
  queue.push(id);
  pump();
  return publicJob(job);
}

function publicJob(job) {
  const { dir, episode, tagsOverride, maxBytes, ...rest } = job;
  return {
    ...rest,
    links: job.status === 'ready'
      ? { status: `/jobs/${job.id}`, file: `/jobs/${job.id}/file` }
      : { status: `/jobs/${job.id}` }
  };
}

function update(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (!job || job.status !== 'queued') continue;
    running++;
    run(job).catch(error => {
      update(job, { status: 'failed', stage: 'failed', error: error.message });
      console.error(`[job ${job.id}] ✗ ${error.message}`);
    }).finally(() => {
      running--;
      prune();
      pump();
    });
  }
}

async function downloadTo(url, dest, job, extraHeaders = {}) {
  const headers = sc.browserHeaders({ Accept: 'audio/mpeg,*/*', ...extraHeaders });
  if (job.maxBytes) headers.Range = `bytes=0-${job.maxBytes - 1}`;

  const res = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(20 * 60 * 1000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar el MP3`);

  const contentRange = res.headers.get('content-range');
  const total = contentRange
    ? Number(contentRange.split('/')[1])
    : Number(res.headers.get('content-length')) || 0;

  let received = 0;
  let lastLogged = 0;
  const counter = new Transform({
    transform(chunk, _enc, callback) {
      received += chunk.length;
      if (received - lastLogged >= 8 * 1024 * 1024) {
        lastLogged = received;
        update(job, { progress: { bytes: received, total } });
        console.log(`[job ${job.id}] ${(received / 1024 / 1024).toFixed(1)} MB${total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB` : ''}`);
      }
      callback(null, chunk);
    }
  });

  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp, { flags: 'w' }));
  fs.renameSync(tmp, dest);
  return received;
}

async function run(job) {
  update(job, { status: 'running', stage: 'resolving' });

  const episode = job.episode || await getEpisode({ offline: process.env.DATA_ONLY === '1' });
  const sourceUrl = job.sourceUrl || process.env.MP3_SOURCE_URL || (episode.download && episode.download.url);
  if (!sourceUrl) throw new Error('No hay URL de MP3 (pasa sourceUrl o configura MP3_SOURCE_URL).');

  // 1) MP3 de origen: caché persistente (evita bajar ~276 MB en cada job).
  update(job, { stage: 'downloading', sourceUrl });
  const mp3 = cache.readMp3(episode.id, sourceUrl);
  let downloaded;
  if (mp3.hit) {
    downloaded = mp3.bytes;
    job.cacheHit.mp3 = true;
    console.log(`[job ${job.id}] MP3 desde caché (${(downloaded / 1024 / 1024).toFixed(1)} MB, sin descarga, ${mp3.fetchedAt})`);
  } else {
    downloaded = await downloadTo(sourceUrl, mp3.path, job);
    cache.commitMp3(episode.id, sourceUrl, downloaded);
    console.log(`[job ${job.id}] MP3 guardado en caché (${(downloaded / 1024 / 1024).toFixed(1)} MB)`);
  }
  const sourcePath = mp3.path;
  update(job, { progress: { bytes: downloaded, total: downloaded } });

  // 2) Leer e IMPRIMIR las etiquetas que trae el MP3 de origen.
  update(job, { stage: 'reading-tags' });
  const parsed = await id3.readTagsFromFile(sourcePath);
  const sourceTags = id3.summarize(parsed);
  job.sourceTags = sourceTags;
  console.log(`[job ${job.id}] etiquetas de origen:`, JSON.stringify(sourceTags.tags));

  const preview = renderTagPreview(episode, job.tagsOverride);
  const frames = { ...preview.frames };

  // 3) Carátula OBLIGATORIA, desde <itunes:image> del feed (con caché).
  const artworkUrl = frames.APIC;
  if (!artworkUrl || typeof artworkUrl !== 'string') {
    throw new Error('No hay URL de carátula (APIC) en la plantilla; es obligatoria.');
  }
  update(job, { stage: 'downloading-artwork', artworkUrl });
  let artwork = cache.readArtwork(artworkUrl);
  if (artwork) {
    job.cacheHit.artwork = true;
    console.log(`[job ${job.id}] carátula desde caché (${artwork.data.length} bytes)`);
  } else {
    artwork = await downloadArtwork(artworkUrl);
    cache.putArtwork(artworkUrl, artwork.mimeType, artwork.data);
    console.log(`[job ${job.id}] carátula descargada y cacheada (${artwork.data.length} bytes)`);
  }
  frames.APIC = artwork;
  job.artwork = { url: artworkUrl, source: episode.artworkSource, mimeType: artwork.mimeType, bytes: artwork.data.length };

  // 4) MP3 etiquetado: dedup por hash de (episodio + config + carátula).
  //    Si ya existe, no se vuelve a copiar/re-etiquetar 276 MB.
  const specFrames = Object.fromEntries(Object.entries(frames).map(([key, value]) => [
    key,
    value && Buffer.isBuffer(value.data)
      ? `artwork:${crypto.createHash('sha256').update(value.data).digest('hex')}`
      : value
  ]));
  const spec = {
    episodeId: episode.id,
    sourceUrl,
    version: preview.version,
    strip: preview.strip,
    preserve: preview.preserve,
    frames: specFrames,
    id3v1: id3v1From(frames, episode)
  };
  const key = cache.taggedKey(spec);
  let outPath = cache.getTagged(key);
  if (outPath) {
    job.cacheHit.tagged = true;
    console.log(`[job ${job.id}] MP3 etiquetado desde caché (sin re-etiquetar)`);
  } else {
    update(job, { stage: 'tagging' });
    const temp = cache.taggedTemp(key);
    await id3.writeTagsToFile(sourcePath, temp, frames, {
      version: preview.version,
      strip: preview.strip,
      preserve: preview.preserve,
      id3v1: id3v1From(frames, episode)
    });
    outPath = cache.commitTagged(key, temp);
  }

  const written = id3.summarize(await id3.readTagsFromFile(outPath));
  job.tagsApplied = written.tags;
  job.tagBytes = written.size + 10; // cabecera ID3v2 + cuerpo

  const bytes = fs.statSync(outPath).size;
  update(job, {
    status: 'ready',
    stage: 'ready',
    file: outPath,
    bytes,
    filename: job.filename || `${(episode.title || 'episode').replace(/[<>:"/\\|?*]/g, '_')}.mp3`
  });
  const hits = Object.keys(job.cacheHit).filter(name => job.cacheHit[name]);
  console.log(`[job ${job.id}] ✓ listo (${(bytes / 1024 / 1024).toFixed(1)} MB, ${written.frameCount} frames)${hits.length ? ` · caché: ${hits.join(', ')}` : ''}`);
}

function getJob(id) {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}

function listJobs() {
  return [...jobs.values()].map(publicJob);
}

function deleteJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === 'running') return false;
  fs.rmSync(job.dir, { recursive: true, force: true });
  jobs.delete(id);
  return true;
}

/**
 * Limpieza por TTL y número máximo de REGISTROS de job.
 * Ojo: los archivos viven en el caché de contenido, así que esto NO borra
 * el MP3 descargado ni el etiquetado. cache.sweep() es opcional y por defecto
 * no borra nada (persistente).
 */
function prune() {
  cache.sweep();
  const now = Date.now();
  const done = [...jobs.values()].filter(job => job.status === 'ready' || job.status === 'failed');
  for (const job of done) {
    if (now - Date.parse(job.updatedAt) > JOB_TTL_MS) deleteJob(job.id);
  }
  const remaining = [...jobs.values()]
    .filter(job => job.status === 'ready' || job.status === 'failed')
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  while (remaining.length > MAX_JOBS) {
    deleteJob(remaining.shift().id);
  }
}

const sweeper = setInterval(prune, 60 * 1000);
sweeper.unref();

module.exports = {
  createJob,
  getJob,
  listJobs,
  deleteJob,
  loadConfig,
  saveConfig,
  renderTagPreview,
  contextFromEpisode,
  downloadArtwork,
  normalizeArtworkUrl,
  CONFIG_FILE,
  JOBS_DIR
};
