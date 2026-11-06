'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sc = require('./soundcloud');
const { resolveDirectMp3 } = require('./podcast');
const { downloadHls, downloadProgressive } = require('./m3u8');
const { parsePlaylist } = require('../soundcloud-playlist-prettier-single/index.js');

const DEFAULT_OUT = path.join(__dirname, '../artifact-preview/latest-episode');

function help() {
  console.log(`Uso: node index.js [opciones]

Obtiene el episodio más reciente de Euphonic Sessions:
  - su URL de descarga directa del MP3 original (320 kbps, sin yt-dlp)
  - su URL pública, título, fecha y descripción (el playlist)
  - el playlist formateado con el parser que ya usas

La fuente principal es el <enclosure> del feed del podcast; el HLS/AAC
de la API queda solo como fallback si no hay MP3 disponible.

Opciones:
  --user <nombre>      Usuario de SoundCloud (default: euphonicsessions, o $SOUNDCLOUD_USER)
  --out <carpeta>      Carpeta de salida (default: artifact-preview/latest-episode)
  --audio              Además descarga el archivo de audio usando solo la URL de la API
  --clip               Copia el texto formateado al portapapeles
  --url-only           Imprime solo la URL de descarga directa (útil para pipes)
  --client-id <valor> client_id explícito (salta la detección automática)
  --quiet              No imprime el playlist por consola
  -h, --help           Muestra esta ayuda

Ejemplos:
  node index.js
  node index.js --audio
  node index.js --audio --clip
  node index.js --url-only
`);
}

function parseArgs(argv) {
  const opts = {
    user: process.env.SOUNDCLOUD_USER || 'euphonicsessions',
    out: DEFAULT_OUT,
    audio: false,
    clip: false,
    urlOnly: false,
    clientId: null,
    quiet: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--user':
        opts.user = argv[++i];
        break;
      case '--out':
        opts.out = path.resolve(argv[++i]);
        break;
      case '--client-id':
        opts.clientId = argv[++i];
        break;
      case '--audio':
        opts.audio = true;
        break;
      case '--clip':
        opts.clip = true;
        break;
      case '--url-only':
      case '--url':
        opts.urlOnly = true;
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      case '-h':
      case '--help':
        help();
        process.exit(0);
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Opción desconocida: ${arg}\n`);
          help();
          process.exit(1);
        }
    }
  }

  for (const flag of ['user', 'out', 'clientId']) {
    if (opts[flag] === undefined) {
      console.error(`Falta el valor de --${flag}`);
      process.exit(1);
    }
  }

  return opts;
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 90) || 'episode';
}

/**
 * Genera el entrada.txt que consume soundcloud-playlist-prettier-single.
 * Se quitan las líneas sueltas con URLs de la descripción para que no
 * sobreescriban el permalink_url del episodio (el parser usa la última URL).
 */
function buildEntrada(track) {
  const description = (track.description || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter(line => !/^https?:\/\//i.test(line.trim()))
    .join('\n')
    .trim();

  return [
    track.permalink_url,
    '',
    track.title,
    '',
    description,
    ''
  ].join('\n');
}

function copyToClipboard(text) {
  const temp = path.join(os.tmpdir(), `sc-playlist-${process.pid}.txt`);
  fs.writeFileSync(temp, text, 'utf8');

  let result;
  if (process.platform === 'win32') {
    const literal = temp.replace(/'/g, "''");
    const command = `Get-Content -Raw -Encoding UTF8 -LiteralPath '${literal}' | Set-Clipboard`;
    result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
  } else if (process.platform === 'darwin') {
    result = spawnSync('pbcopy', [], { input: text, encoding: 'utf8' });
  } else {
    result = spawnSync('xclip', ['-selection', 'clipboard'], { input: text, encoding: 'utf8' });
  }

  fs.rmSync(temp, { force: true });

  if (result.error || result.status !== 0) {
    console.warn('⚠ No se pudo copiar al portapapeles:', result.error ? result.error.message : (result.stderr || '').trim());
  } else {
    console.log('📋 Texto formateado copiado al portapapeles.');
  }
}

/** Progreso común para MP3 (bytes) y para HLS (segmentos). */
function progressLogger(label) {
  let lastBytes = 0;
  let lastDone = 0;
  return (done, total, bytes) => {
    const finished = done === total && done > 0;
    const bytesJump = bytes - lastBytes >= 10 * 1024 * 1024;
    const segmentJump = total > 1 && (done - lastDone >= 50 || done === 1);
    if (!finished && !bytesJump && !segmentJump) return;
    lastBytes = bytes;
    lastDone = done;
    const unit = total > 1 ? `${done}/${total} segmentos (${Math.round((done / total) * 100)}%)` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    console.log(`  ${label}: ${unit} — ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.quiet && !opts.urlOnly) {
    console.log(`🎧 Buscando el episodio más reciente de "${opts.user}"...\n`);
  }

  const token = await sc.resolveClientId(opts.clientId);
  const user = await sc.resolveUser(token.clientId, opts.user);
  const track = await sc.findLatestTrack(token.clientId, user);
  const podcast = await resolveDirectMp3(user, track, { get: sc.get });
  const downloads = await sc.resolveDownloads(token.clientId, track, podcast.sources, podcast.notes);
  const selected = downloads.selected;

  if (opts.urlOnly) {
    if (!selected) {
      console.error('No se encontró ninguna URL de descarga directa.');
      process.exit(2);
    }
    console.log(selected.url);
    return;
  }

  if (!opts.quiet) {
    console.log(`✓ client_id: ${token.source}${token.isExpiring ? ' (expira: se renueva en cada ejecución)' : ''}`);
    console.log(`✓ Usuario: ${user.username} (ID ${user.id}, ${user.track_count} tracks)`);
    console.log(`✓ Episodio: ${track.title}`);
    console.log(`  Publicado: ${track.created_at}`);
    console.log(`  URL: ${track.permalink_url}`);
    console.log(`  Duración: ${Math.round(track.duration / 60000)} min`);
    console.log(`  Descripción: ${(track.description || '').split('\n').length} líneas`);
    console.log(`  downloadable: ${track.downloadable === true}`);
    console.log('');
    if (selected) {
      console.log(`⬇ URL de descarga directa (${selected.label}):`);
      console.log(`  ${selected.url}`);
      if (selected.kind === 'mp3') {
        const quality = selected.bitrateKbps ? `${selected.bitrateKbps} kbps` : 'bitrate desconocido';
        const size = selected.length ? ` — ${(selected.length / 1024 / 1024).toFixed(1)} MB` : '';
        console.log(`  MP3 original: ${quality}${size}`);
      }
      if (selected.expiresAt) console.log(`  Firma válida hasta: ${selected.expiresAt}`);
    } else {
      console.log('⚠ La API no expuso ninguna URL de descarga utilizable.');
    }
    for (const note of downloads.notes) console.log(`  · ${note}`);
    console.log('');
  }

  fs.mkdirSync(opts.out, { recursive: true });
  const entradaPath = path.join(opts.out, 'entrada.txt');
  const playlistPath = path.join(opts.out, 'playlist.txt');
  const audioExt = selected && selected.extension
    ? selected.extension
    : (selected && selected.protocol === 'progressive' ? 'mp3' : 'm4a');
  const audioPath = path.join(opts.out, `${sanitizeFilename(track.title)}.${audioExt}`);

  fs.writeFileSync(entradaPath, buildEntrada(track), 'utf8');

  const episode = {
    fetched_at: new Date().toISOString(),
    client_id_source: token.source,
    client_id_expiring: token.isExpiring,
    user: {
      username: user.username,
      id: user.id,
      permalink_url: user.permalink_url
    },
    track: {
      id: track.id,
      title: track.title,
      permalink_url: track.permalink_url,
      created_at: track.created_at,
      display_date: track.display_date || null,
      duration_ms: track.duration,
      description: track.description || '',
      downloadable: track.downloadable === true,
      has_downloads_left: track.has_downloads_left === true
    },
    download: {
      selected: selected || null,
      sources: downloads.sources,
      notes: downloads.notes
    }
  };

  fs.writeFileSync(path.join(opts.out, 'episode.json'), JSON.stringify(episode, null, 2), 'utf8');
  fs.writeFileSync(path.join(opts.out, 'url-descarga.txt'), selected ? `${selected.url}\n` : '', 'utf8');

  // Reutiliza exactamente el parser que ya se usa a mano.
  parsePlaylist(entradaPath, playlistPath);
  const formatted = fs.readFileSync(playlistPath, 'utf8');

  if (!opts.quiet) {
    console.log('');
    console.log('──────── Playlist formateado (copiar de aquí) ────────');
    console.log(formatted);
    console.log('─────────────────────────────────────────────────────');
  }

  if (opts.clip) copyToClipboard(formatted);

  if (opts.audio) {
    if (!selected) throw new Error('Sin URL de descarga no se puede bajar el audio (prueba sin --audio).');
    console.log(`\n⬇ Descargando audio en ${audioPath} (sin yt-dlp, sin ffmpeg)...`);
    const isDirect = selected.kind === 'mp3' || selected.kind === 'original' || selected.protocol === 'progressive';
    const result = isDirect
      ? await downloadProgressive(selected.url, audioPath, { onProgress: progressLogger('MP3') })
      : await downloadHls(selected.url, audioPath, { onProgress: progressLogger('HLS') });
    console.log(`✓ Audio guardado: ${result.file} (${(result.bytes / 1024 / 1024).toFixed(1)} MB, ${result.segments} segmentos)`);
  }

  if (!opts.quiet) {
    console.log(`\n📁 Archivos en ${opts.out}:`);
    for (const name of ['episode.json', 'url-descarga.txt', 'entrada.txt', 'playlist.txt']) {
      console.log(`   ${name}`);
    }
  }
}

main().catch(error => {
  console.error(`\n❌ ${error.message}`);
  if (process.env.DEBUG) console.error(error.stack);
  process.exit(1);
});
