'use strict';

/**
 * Resuelve un episodio combinando dos fuentes:
 *  - Podcast XML (SoundCloud RSS + feed oficial de Kyau & Albert):
 *      MP3 de 320 kbps, títulos, fecha, artista, álbum, género, copyright, guid...
 *  - SoundCloud API v2: descripción del track -> playlist "ya arreglado"
 *      reutilizando parsePlaylist() de soundcloud-playlist-prettier-single.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sc = require('../../soundcloud-latest-episode/soundcloud');
const { resolveDirectMp3 } = require('../../soundcloud-latest-episode/podcast');
const { parsePlaylist, pretty_playlist } = require('../../soundcloud-playlist-prettier-single/index.js');

const OFFICIAL_FEED = 'http://www.kyauandalbert.com/EuphonicSessions-Podcast-KyauandAlbert.xml';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .trim();
}

function tag(xml, name) {
  const match = xml.match(new RegExp(`<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`, 'i'));
  return match ? decodeEntities(match[1]) : null;
}

/** Extrae el href de <itunes:image href="..."/> del XML del podcast. */
function imageHref(xml) {
  if (!xml) return null;
  const tag = xml.match(/<itunes:image\b[^>]*>/i);
  if (tag) {
    const href = (tag[0].match(/\bhref="([^"]+)"/i) || [])[1];
    if (href) return decodeEntities(href);
  }
  const block = xml.match(/<image>[\s\S]*?<url>([^<]+)<\/url>/i);
  return block ? decodeEntities(block[1].trim()) : null;
}

function enclosure(xml) {
  const match = xml.match(/<enclosure\b[^>]*>/i);
  if (!match) return null;
  const raw = match[0];
  const url = (raw.match(/\burl="([^"]+)"/i) || [])[1];
  if (!url) return null;
  return {
    url: decodeEntities(url),
    length: Number((raw.match(/\blength="([^"]+)"/i) || [])[1]) || null,
    type: (raw.match(/\btype="([^"]+)"/i) || [])[1] || null
  };
}

function items(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(match => match[1]);
}

function channel(xml) {
  return xml.match(/<channel>([\s\S]*?)<item>/i)?.[1] || '';
}

function pickGenre(keywords) {
  if (!keywords) return 'Trance';
  const list = keywords.split(',').map(word => word.trim()).filter(Boolean);
  const known = ['trance', 'progressive', 'house', 'techno', 'ambient', 'dance', 'electronic'];
  const found = list.find(word => known.includes(word.toLowerCase()));
  const chosen = found || list[0] || 'Trance';
  return chosen.charAt(0).toUpperCase() + chosen.slice(1).toLowerCase();
}

function isoDate(pubDate) {
  if (!pubDate) return null;
  const date = new Date(pubDate);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function monthYearFromTitle(title) {
  const match = (title || '').match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
  if (!match) return null;
  const name = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
  return { name, year: Number(match[2]), number: MONTHS.indexOf(name) + 1, label: `${name} ${match[2]}` };
}

async function fetchFeed(url) {
  const res = await sc.get(url);
  if (!res.ok) throw new Error(`Feed ${url} respondió HTTP ${res.status}`);
  return res.text;
}

function findFeedItem(xml, track) {
  const list = items(xml);
  const id = String(track.id);
  const exact = list.find(item => item.includes(`tracks/${id}`) || item.includes(`/stream/${id}-`));
  if (exact) return exact;
  const my = monthYearFromTitle(track.title);
  if (my) {
    const byTitle = list.find(item => (tag(item, 'title') || '').toLowerCase().includes(my.label.toLowerCase()));
    if (byTitle) return byTitle;
  }
  return list[0] || '';
}

function parseFeedData(itemXml, channelXml) {
  const published = tag(itemXml, 'pubDate');
  const date = published ? new Date(published) : null;
  const my = monthYearFromTitle(tag(itemXml, 'title'));
  return {
    title: tag(itemXml, 'title'),
    subtitle: tag(itemXml, 'itunes:subtitle'),
    author: tag(itemXml, 'itunes:author') || tag(channelXml, 'itunes:author'),
    album: tag(channelXml, 'title'),
    publisher: tag(channelXml, 'itunes:author'),
    copyright: tag(channelXml, 'copyright'),
    summary: tag(itemXml, 'itunes:summary'),
    keywords: tag(itemXml, 'itunes:keywords'),
    explicit: tag(itemXml, 'itunes:explicit'),
    duration: tag(itemXml, 'itunes:duration'),
    link: tag(itemXml, 'link'),
    guid: tag(itemXml, 'guid'),
    published: published,
    publishedISO: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    year: date && !Number.isNaN(date.getTime()) ? date.getUTCFullYear() : (my ? my.year : null),
    month: my ? my.name : null,
    monthNumber: my ? my.number : null,
    enclosure: enclosure(itemXml)
  };
}

/** entrada.txt que espera el parser, sin líneas sueltas con URLs. */
function buildEntrada(track) {
  const description = (track.description || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter(line => !/^https?:\/\//i.test(line.trim()))
    .join('\n')
    .trim();
  return [track.permalink_url, '', track.title, '', description, ''].join('\n');
}

function formatPlaylist(track) {
  const input = path.join(os.tmpdir(), `episode-api-${track.id}-${process.pid}.txt`);
  const output = path.join(os.tmpdir(), `episode-api-${track.id}-${process.pid}.out.txt`);
  try {
    fs.writeFileSync(input, buildEntrada(track), 'utf8');
    parsePlaylist(input, output);
    return fs.readFileSync(output, 'utf8');
  } finally {
    fs.rmSync(input, { force: true });
    fs.rmSync(output, { force: true });
  }
}

/** Solo el tracklist formateado (sin la cabecera que añade parsePlaylist). */
function playlistBodyFrom(track) {
  const lines = (track.description || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter(line => /^\d+/.test(line.trim()));
  return pretty_playlist(lines.join('\n'), false);
}

let cache = null;
let cacheAt = 0;
const CACHE_TTL = 5 * 60 * 1000;
const DATA_DIR = path.join(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'episode.json');
const COUNTER_FILE = path.join(DATA_DIR, 'track-counter.json');

/**
 * Número de episodio secuencial. No está en ninguno de los dos feeds, así que
 * se lleva un contador persistente: el mismo episodio no lo incrementa; uno
 * nuevo sí. Se puede sembrar con EPISODE_NUMBER=<n>.
 */
function episodeNumberFor(episodeId) {
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
  } catch {
    // Sin contador previo.
  }
  if (state.lastEpisodeId === episodeId && Number.isFinite(state.number)) {
    return state.number;
  }

  let seed = Number(process.env.EPISODE_NUMBER);
  if (!Number.isFinite(seed) || seed <= 0) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../tags.config.json'), 'utf8'));
      seed = Number(config.trackNumber && config.trackNumber.seed);
    } catch {
      // Sin semilla configurada.
    }
  }
  const number = Number.isFinite(state.number)
    ? state.number + 1
    : (Number.isFinite(seed) && seed > 0 ? seed : 1);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(COUNTER_FILE, JSON.stringify({ lastEpisodeId: episodeId, number }, null, 2), 'utf8');
  return number;
}

/**
 * Frontera "resolver / servir": el resolver (Node, con red y parser) deja aquí
 * un JSON estático. Un servidor con RAM limitada puede arrancar con DATA_ONLY=1
 * y limitarse a LEER este archivo: sin fetch, sin regex, sin apenas memoria.
 */
function loadCachedEpisode() {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveEpisodeCache(episode) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(episode, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
  return DATA_FILE;
}

async function getEpisode({
  user = process.env.SOUNDCLOUD_USER || 'euphonicsessions',
  force = false,
  offline = false
} = {}) {
  if (offline) {
    const data = loadCachedEpisode();
    if (!data) throw new Error(`No existe ${DATA_FILE}. Ejecuta el resolver (POST /refresh o npm run resolve).`);
    return data;
  }
  if (!force && cache && Date.now() - cacheAt < CACHE_TTL) return cache;

  const token = await sc.resolveClientId(process.env.CLIENT_ID || null);
  const resolvedUser = await sc.resolveUser(token.clientId, user);
  const track = await sc.findLatestTrack(token.clientId, resolvedUser);
  const mp3 = await resolveDirectMp3(resolvedUser, track, { get: sc.get });
  const download = mp3.sources.find(source => source.verified) || mp3.sources[0] || null;

  const scFeed = await fetchFeed(`https://feeds.soundcloud.com/users/${resolvedUser.urn || `soundcloud:users:${resolvedUser.id}`}/sounds.rss`);
  const scChannel = channel(scFeed);
  const scItem = findFeedItem(scFeed, track);
  let officialItem = '';
  let officialChannel = '';
  try {
    const officialFeed = await fetchFeed(OFFICIAL_FEED);
    officialItem = findFeedItem(officialFeed, track);
    officialChannel = channel(officialFeed);
  } catch (error) {
    // El feed oficial es opcional.
  }

  const fromSoundcloud = parseFeedData(scItem, scChannel);
  const fromOfficial = parseFeedData(officialItem, officialChannel);
  const my = monthYearFromTitle(track.title);

  // Carátula: SIEMPRE desde el XML del podcast. Preferencia: imagen del episodio
  // en el feed de SoundCloud > imagen de canal > feed oficial > artwork del track.
  const feedArtworkUrl =
    imageHref(scItem) ||
    imageHref(scChannel) ||
    imageHref(officialItem) ||
    imageHref(officialChannel) ||
    null;
  const artworkUrl = feedArtworkUrl || track.artwork_url || null;

  const feed = {
    // Preferencia: títulos/etiquetas del podcast XML; SoundCloud como respaldo.
    title: fromOfficial.title || fromSoundcloud.title || track.title,
    subtitle: fromOfficial.subtitle || (my ? `${my.label} Edition` : null),
    artist: fromOfficial.author || fromSoundcloud.author || 'Kyau & Albert',
    album: fromOfficial.album || fromSoundcloud.album || 'Euphonic Sessions with Kyau & Albert',
    publisher: fromSoundcloud.publisher || fromOfficial.publisher || 'Euphonic',
    copyright: fromOfficial.copyright || fromSoundcloud.copyright || null,
    genre: pickGenre(fromOfficial.keywords || fromSoundcloud.keywords),
    keywords: fromOfficial.keywords || fromSoundcloud.keywords || null,
    summary: fromOfficial.summary || fromSoundcloud.summary || null,
    duration: fromSoundcloud.duration || fromOfficial.duration || null,
    guid: fromSoundcloud.guid || fromOfficial.guid || null,
    link: fromSoundcloud.link || track.permalink_url,
    published: fromSoundcloud.publishedISO || fromOfficial.publishedISO || track.created_at,
    originalDate: isoDate(fromSoundcloud.published || fromOfficial.published),
    originalYear: fromSoundcloud.year || fromOfficial.year || (my ? my.year : null),
    year: fromSoundcloud.year || fromOfficial.year || (my ? my.year : null),
    month: my ? my.name : null,
    monthNumber: my ? my.number : null,
    episodeNumber: episodeNumberFor(track.id),
    soundcloudFeed: fromSoundcloud,
    officialFeed: fromOfficial
  };

  const playlistBody = playlistBodyFrom(track);
  const episode = {
    id: track.id,
    title: track.title,
    permalink_url: track.permalink_url,
    created_at: track.created_at,
    duration_ms: track.duration,
    user: { username: resolvedUser.username, id: resolvedUser.id, urn: resolvedUser.urn },
    artworkUrl,
    artworkSource: feedArtworkUrl ? 'podcast feed XML (<itunes:image>)' : 'SoundCloud track.artwork_url',
    feed,
    download: download ? {
      url: download.url,
      source: download.label,
      type: download.mimeType || 'audio/mpeg',
      bytes: download.length || null,
      bitrateKbps: download.bitrateKbps || null,
      verified: download.verified === true
    } : null,
    playlist: formatPlaylist(track),
    playlistBody,
    playlistForTag: `${track.title}\n${track.permalink_url}\n\n${playlistBody}`,
    playlistSource: 'SoundCloud track description -> parsePlaylist()',
    sources: {
      mp3: mp3.sources,
      notes: mp3.notes
    },
    resolvedAt: new Date().toISOString()
  };

  cache = episode;
  cacheAt = Date.now();
  saveEpisodeCache(episode);
  return episode;
}

function invalidateCache() {
  cache = null;
  cacheAt = 0;
}

module.exports = {
  getEpisode,
  invalidateCache,
  loadCachedEpisode,
  saveEpisodeCache,
  monthYearFromTitle,
  DATA_FILE,
  OFFICIAL_FEED
};
