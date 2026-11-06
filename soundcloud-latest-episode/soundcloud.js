'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BASE = 'https://api-v2.soundcloud.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function browserHeaders(extra = {}) {
  return {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://soundcloud.com/',
    'Origin': 'https://soundcloud.com',
    ...extra
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * GET con reintentos suaves para 429/403/5xx y errores de red.
 * Devuelve siempre status/text/json; NO lanza para 401/404 (algunos son esperados).
 */
async function get(url, { attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: browserHeaders(),
        signal: AbortSignal.timeout(25000)
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // No es JSON (por ejemplo la homepage o un m3u8).
      }
      const result = { status: res.status, ok: res.ok, headers: res.headers, text, json };

      const retryable = res.status === 429 || res.status === 403 || res.status >= 500;
      if (retryable && attempt < attempts) {
        await sleep(600 * attempt + Math.random() * 400);
        continue;
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(600 * attempt + Math.random() * 400);
        continue;
      }
    }
  }
  throw lastError || new Error('La petición falló');
}

function withClientId(url, clientId) {
  const parsed = new URL(url, BASE);
  if (!parsed.searchParams.has('client_id')) {
    parsed.searchParams.set('client_id', clientId);
  }
  return parsed.toString();
}

async function testClientId(clientId) {
  const url = `${BASE}/resolve?url=${encodeURIComponent('https://soundcloud.com/soundcloud')}&client_id=${encodeURIComponent(clientId)}`;
  try {
    const res = await get(url);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Obtiene un client_id desde la página principal de SoundCloud.
 * Desde 2026 el sitio publica el token en window.__sc_hydration.apiClient.id
 * (marcado como "expiring"), así que NO se cachea: se pide fresco en cada run.
 */
async function clientIdFromHydration() {
  const home = await get('https://soundcloud.com/');
  if (!home.ok) return null;

  const match = home.text.match(/window\.__sc_hydration\s*=\s*(\[[\s\S]*?\])\s*;?\s*<\/script>/);
  if (!match) return null;

  let hydration;
  try {
    hydration = JSON.parse(match[1]);
  } catch {
    return null;
  }

  const apiClient = hydration.find(entry => entry.hydratable === 'apiClient');
  if (!apiClient || !apiClient.data || !apiClient.data.id) return null;

  return { clientId: apiClient.data.id, isExpiring: apiClient.data.isExpiring === true };
}

/**
 * Fallback: replica el enfoque original del repo (Playwright escuchando peticiones
 * con client_id=). Solo se usa si la hidratación falla; requiere playwright instalado
 * en soundcloud-token-getter (o en este módulo).
 */
async function clientIdFromPlaywright() {
  let playwright = null;
  for (const candidate of ['playwright', '../soundcloud-token-getter/node_modules/playwright']) {
    try {
      playwright = require(candidate);
      break;
    } catch {
      // Intentar la siguiente ubicación.
    }
  }

  if (!playwright) {
    throw new Error(
      'No se pudo obtener client_id. Instala el fallback de Playwright:\n' +
      '  cd ../soundcloud-token-getter && npm install && npx playwright install webkit\n' +
      'O pásalo a mano con --client-id <valor>.'
    );
  }

  const browser = await playwright.webkit.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let found = null;
    page.on('request', request => {
      if (found || !request.url().includes('client_id=')) return;
      try {
        found = new URL(request.url()).searchParams.get('client_id');
      } catch {
        // URL inválida, ignorar.
      }
    });
    await page.goto('https://soundcloud.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    if (!found) throw new Error('Playwright no capturó ninguna petición con client_id.');
    return { clientId: found, isExpiring: false };
  } finally {
    await browser.close();
  }
}

/**
 * Resuelve un client_id válido probando, en orden:
 *   1) --client-id explícito
 *   2) window.__sc_hydration.apiClient.id (sin navegador)
 *   3) client_id.txt generado por soundcloud-token-getter (Playwright)
 *   4) Playwright en vivo
 */
async function resolveClientId(explicit) {
  if (explicit) {
    return { clientId: explicit, source: '--client-id', isExpiring: false, validated: true };
  }

  const candidates = [];

  try {
    const hydration = await clientIdFromHydration();
    if (hydration) {
      candidates.push({ ...hydration, source: 'window.__sc_hydration.apiClient' });
    }
  } catch {
    // Caída de red o cambio de markup: se intenta con los fallbacks.
  }

  const cachedPath = path.join(__dirname, '../soundcloud-token-getter/client_id.txt');
  if (fs.existsSync(cachedPath)) {
    const cached = fs.readFileSync(cachedPath, 'utf8').trim();
    if (cached) {
      candidates.push({ clientId: cached, source: cachedPath, isExpiring: false });
    }
  }

  for (const candidate of candidates) {
    if (await testClientId(candidate.clientId)) {
      return { ...candidate, validated: true };
    }
  }

  const fallback = await clientIdFromPlaywright();
  return { ...fallback, source: 'playwright (network sniffing)', validated: true };
}

async function resolveUser(clientId, username) {
  const url = `${BASE}/resolve?url=${encodeURIComponent(`https://soundcloud.com/${username}`)}&client_id=${encodeURIComponent(clientId)}`;
  const res = await get(url);
  if (!res.ok) {
    throw new Error(`No se pudo resolver el usuario "${username}" (HTTP ${res.status}): ${res.text.slice(0, 160)}`);
  }
  return res.json;
}

/**
 * Devuelve el track más reciente. No se fía del orden del listado:
 * ordena por created_at y luego pide el track completo (trae la descripción
 * íntegra y media.transcodings).
 */
async function findLatestTrack(clientId, user, { limit = 20 } = {}) {
  const url = `${BASE}/users/${user.id}/tracks?client_id=${encodeURIComponent(clientId)}&limit=${limit}&linked_partitioning=1`;
  const res = await get(url);
  if (!res.ok) {
    throw new Error(`No se pudieron listar los tracks (HTTP ${res.status}): ${res.text.slice(0, 160)}`);
  }

  const collection = (res.json && res.json.collection ? res.json.collection : [])
    .filter(track => track && track.kind === 'track' && track.id);

  if (!collection.length) {
    throw new Error('El usuario no tiene tracks públicos en el listado.');
  }

  collection.sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
  const newest = collection[0];

  const full = await get(`${BASE}/tracks/${newest.id}?client_id=${encodeURIComponent(clientId)}`);
  return full.ok && full.json ? full.json : newest;
}

function expiryFromUrl(url) {
  try {
    const expires = Number(new URL(url).searchParams.get('expires'));
    return expires ? new Date(expires * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * Comprueba si un download_url realmente entrega un archivo sin sesión OAuth.
 * SoundCloud suele responder 401 aquí, aunque el track diga downloadable=true.
 */
async function probeDownload(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: browserHeaders(),
      redirect: 'manual',
      signal: AbortSignal.timeout(20000)
    });
  } catch (error) {
    return { usable: false, reason: error.message };
  }

  const location = res.headers.get('location');
  const contentType = res.headers.get('content-type');
  if (res.body) await res.body.cancel().catch(() => {});

  if (res.status === 401 || res.status === 403) {
    return { usable: false, httpStatus: res.status, reason: 'requiere sesión OAuth' };
  }
  if (res.status >= 300 && res.status < 400 && location) {
    return { usable: true, httpStatus: res.status, contentType, directUrl: location };
  }
  if (res.ok && /audio|octet-stream|mpegurl/i.test(contentType || '')) {
    return { usable: true, httpStatus: res.status, contentType, directUrl: url };
  }
  return { usable: false, httpStatus: res.status, reason: 'no devolvió un archivo' };
}

/**
 * Reúne TODAS las URLs de descarga candidatas, en este orden de preferencia:
 *  - extraSources: MP3 original del podcast (ver podcast.js) <- fuente principal
 *  - download_url (archivo original, si existe y no pide OAuth)
 *  - cada media.transcodings[].url -> GET devuelve {"url": "<m3u8 firmado>"}
 *
 * Desde el 31-dic-2025 ya no hay transcodings MP3 progresivos: solo HLS AAC,
 * que queda como último recurso cuando no hay MP3 disponible.
 */
async function resolveDownloads(clientId, track, extraSources = [], extraNotes = []) {
  const sources = [...extraSources];
  const notes = [...extraNotes];

  if (track.download_url) {
    const url = withClientId(track.download_url, clientId);
    const probe = await probeDownload(url);
    sources.push({
      kind: 'original',
      label: 'archivo original (download_url)',
      url: probe.directUrl || url,
      apiUrl: track.download_url,
      protocol: 'progressive',
      ...probe
    });
  } else if (track.downloadable) {
    notes.push(
      `La API marca downloadable=true pero no expone download_url de forma anónima; ` +
      `/tracks/${track.id}/download responde 401 (requiere OAuth).`
    );
  }

  const transcodings = (track.media && track.media.transcodings) || [];
  for (const transcoding of transcodings) {
    const apiUrl = withClientId(transcoding.url, clientId);
    const res = await get(apiUrl, { attempts: 2 });
    if (!res.ok || !res.json || !res.json.url) {
      notes.push(`Transcoding ${transcoding.preset || '?'} no disponible (HTTP ${res.status}).`);
      continue;
    }

    sources.push({
      kind: 'stream',
      label: `${transcoding.preset || 'stream'} (${(transcoding.format && transcoding.format.protocol) || 'hls'})`,
      preset: transcoding.preset || null,
      protocol: (transcoding.format && transcoding.format.protocol) || 'hls',
      mimeType: (transcoding.format && transcoding.format.mime_type) || null,
      snipped: transcoding.snipped === true,
      url: res.json.url,
      apiUrl: transcoding.url,
      expiresAt: expiryFromUrl(res.json.url),
      usable: true
    });
  }

  const score = source => {
    // El MP3 original del podcast (320 kbps) gana siempre: es el archivo de
    // mayor calidad que ofrece Euphonic Sessions, no un transcoding de stream.
    if (source.kind === 'mp3' && source.usable) return 200;
    if (source.kind === 'original' && source.usable) return 100;
    if (source.kind !== 'stream' || source.usable === false || source.snipped) return -1;
    if (source.preset === 'aac_160k') return 90;
    if (source.preset === 'aac_96k') return 80;
    if (source.protocol === 'progressive') return 70;
    if (source.protocol === 'hls') return 60;
    return 10;
  };

  const usable = sources.filter(source => score(source) > 0).sort((a, b) => score(b) - score(a));
  return { sources, selected: usable[0] || null, notes };
}

module.exports = {
  BASE,
  UA,
  browserHeaders,
  get,
  withClientId,
  resolveClientId,
  resolveUser,
  findLatestTrack,
  resolveDownloads
};
