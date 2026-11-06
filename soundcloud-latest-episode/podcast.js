'use strict';

const { browserHeaders } = require('./soundcloud');

// Feed oficial de Kyau & Albert (el que usa iTunes, id 296499169).
const OFFICIAL_FEED = 'http://www.kyauandalbert.com/EuphonicSessions-Podcast-KyauandAlbert.xml';

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function extractTag(item, name) {
  const match = item.match(new RegExp(`<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`, 'i'));
  return match ? decodeEntities(match[1].trim()) : null;
}

function extractEnclosure(item) {
  const match = item.match(/<enclosure\b[^>]*>/i);
  if (!match) return null;
  const tag = match[0];
  const url = (tag.match(/\burl="([^"]+)"/i) || [])[1];
  if (!url) return null;
  const length = Number((tag.match(/\blength="([^"]+)"/i) || [])[1]) || null;
  const type = (tag.match(/\btype="([^"]+)"/i) || [])[1] || null;
  return { url: decodeEntities(url), length, type };
}

function rssItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(match => match[1]);
}

function soundcloudRssCandidates(user) {
  const candidates = [];
  if (user.urn) candidates.push(user.urn);
  candidates.push(`soundcloud:users:${user.id}`);
  // No codificar los dos puntos: feeds.soundcloud.com los espera literalmente.
  return [...new Set(candidates)].map(urn => `https://feeds.soundcloud.com/users/${urn}/sounds.rss`);
}

/** Busca el <item> del RSS que corresponde al track. */
function findItem(items, track) {
  const id = String(track.id);
  const exact = items.find(item =>
    item.includes(`tracks/${id}`) || item.includes(`/stream/${id}-`) || item.includes(`/${id}-`)
  );
  if (exact) return exact;

  const monthYear = (track.title.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i) || [])[0];
  if (monthYear) {
    const byTitle = items.find(item => {
      const title = extractTag(item, 'title') || '';
      return title.toLowerCase().includes(monthYear.toLowerCase());
    });
    if (byTitle) return byTitle;
  }

  // Los feeds vienen ordenados por fecha descendente.
  return items[0] || null;
}

/**
 * Comprueba con un Range GET que la URL entrega realmente un MP3.
 * No baja el archivo completo (para el episodio de 2 h son ~289 MB).
 */
async function probeMp3(url) {
  try {
    const res = await fetch(url, {
      headers: browserHeaders({ Accept: 'audio/mpeg,*/*', Range: 'bytes=0-2047' }),
      redirect: 'follow',
      signal: AbortSignal.timeout(25000)
    });
    const head = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || '';
    const contentRange = res.headers.get('content-range');
    const length = contentRange
      ? Number(contentRange.split('/')[1])
      : Number(res.headers.get('content-length')) || null;
    const isMpeg = /audio\/mpeg|audio\/mp3|audio\/x-mpeg/i.test(contentType) ||
      head.subarray(0, 3).toString('latin1') === 'ID3' ||
      (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);

    return {
      verified: (res.ok || res.status === 206) && isMpeg,
      status: res.status,
      contentType,
      length,
      resolvedUrl: res.url || url
    };
  } catch (error) {
    return { verified: false, reason: error.message };
  }
}

function makeSource(url, label, fallbackLength, probe, track) {
  const length = probe.length || fallbackLength || null;
  const bitrateKbps = length && track.duration
    ? Math.round((length * 8) / (track.duration / 1000) / 1000)
    : null;

  return {
    kind: 'mp3',
    label,
    url,
    extension: 'mp3',
    protocol: 'progressive',
    mimeType: probe.contentType || 'audio/mpeg',
    length,
    bitrateKbps,
    verified: probe.verified,
    probeStatus: probe.status || null,
    resolvedUrl: probe.resolvedUrl || null,
    usable: probe.verified === true
  };
}

/**
 * Resuelve el MP3 original de mayor calidad que Euphonic Sessions ofrece.
 * Orden de preferencia:
 *   1) <enclosure> del RSS de SoundCloud (feeds.soundcloud.com/stream/...mp3)
 *   2) <enclosure> del feed oficial de kyauandalbert.com
 *   3) URL derivada de id + permalinks (sin necesidad del RSS)
 *
 * Los dos feeds apuntan al MISMO archivo (~289 MB, 320 kbps, con tag ID3).
 */
async function resolveDirectMp3(user, track, { get } = {}) {
  const sources = [];
  const notes = [];
  const seen = new Set();
  const httpGet = get || (async url => {
    const res = await fetch(url, { headers: browserHeaders(), signal: AbortSignal.timeout(25000) });
    return { status: res.status, ok: res.ok, text: await res.text() };
  });

  const add = async (url, label, fallbackLength) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    const probe = await probeMp3(url);
    const source = makeSource(url, label, fallbackLength, probe, track);
    sources.push(source);
    if (!source.verified) {
      notes.push(`${label}: no se pudo verificar como MP3 (${probe.reason || `HTTP ${probe.status}`}).`);
    }
  };

  // 1) RSS de SoundCloud
  for (const feedUrl of soundcloudRssCandidates(user)) {
    try {
      const res = await httpGet(feedUrl);
      if (!res.ok) {
        notes.push(`RSS ${feedUrl} respondió HTTP ${res.status}.`);
        continue;
      }
      const items = rssItems(res.text);
      const item = findItem(items, track);
      const enclosure = item ? extractEnclosure(item) : null;
      if (enclosure) {
        await add(enclosure.url, 'RSS de SoundCloud (enclosure)', enclosure.length);
      } else {
        notes.push(`RSS ${feedUrl}: ${items.length} items, sin enclosure para este episodio.`);
      }
      break;
    } catch (error) {
      notes.push(`RSS ${feedUrl}: ${error.message}`);
    }
  }

  // 2) Feed oficial de Kyau & Albert
  try {
    const res = await httpGet(OFFICIAL_FEED);
    if (res.ok) {
      const items = rssItems(res.text);
      const item = findItem(items, track);
      const enclosure = item ? extractEnclosure(item) : null;
      if (enclosure) {
        await add(enclosure.url, 'Feed oficial de Kyau & Albert (enclosure)', enclosure.length);
      }
    } else {
      notes.push(`Feed oficial respondió HTTP ${res.status}.`);
    }
  } catch (error) {
    notes.push(`Feed oficial: ${error.message}`);
  }

  // 3) URL derivada (fallback sin RSS)
  if (track.permalink && user.permalink) {
    const derived = `https://feeds.soundcloud.com/stream/${track.id}-${user.permalink}-${track.permalink}.mp3`;
    await add(derived, 'URL derivada de feeds.soundcloud.com', null);
  }

  return { sources, notes };
}

module.exports = { resolveDirectMp3, probeMp3, OFFICIAL_FEED, soundcloudRssCandidates };
