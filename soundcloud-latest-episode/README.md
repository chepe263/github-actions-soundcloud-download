# soundcloud-latest-episode

Automatiza **el primer paso** del flujo que de verdad se usa: conseguir el episodio más
reciente de *Euphonic Sessions with Kyau & Albert*, su URL pública, su descripción (el
playlist) y —sobre todo— el **enlace directo al MP3 original de 320 kbps**, sin `yt-dlp`,
sin `ffmpeg` y sin descargar los ~136 episodios del histórico.

Después genera el texto formateado reutilizando **el mismo parser** de
`soundcloud-playlist-prettier-single/index.js` (el que antes se alimentaba pegando a mano
`entrada.txt`).

## tl;dr

```bash
cd soundcloud-latest-episode
node index.js                 # URL del MP3 + playlist formateado en consola y en archivos
node index.js --audio         # además baja el MP3 original (320 kbps, ~276 MB)
node index.js --clip          # además copia el texto formateado al portapapeles
node index.js --url-only      # solo imprime la URL de descarga (para pipes / scripts)
```

No requiere `npm install`: solo Node.js 20+ (usa `fetch` nativo).

## De dónde sale el MP3 (lo importante)

Euphonic Sessions es un **podcast**, no solo un track de SoundCloud. El archivo de mayor
calidad no está en `media.transcodings` (streams) sino en el `<enclosure>` del RSS:

| Fuente | URL | Resultado |
| --- | --- | --- |
| **RSS de SoundCloud** (principal) | `https://feeds.soundcloud.com/users/soundcloud:users:{id}/sounds.rss` | `<enclosure type="audio/mpeg" url="https://feeds.soundcloud.com/stream/{track_id}-{user}-{slug}.mp3" length="288909158"/>` |
| **Feed oficial de Kyau & Albert** (secundaria) | `http://www.kyauandalbert.com/EuphonicSessions-Podcast-KyauandAlbert.xml` | `<enclosure url="http://www.kyauandalbert.com/ES/EuphonicSessions-Kyau&Albert-{Month}{Year}.mp3" .../>` |
| URL derivada (fallback) | `https://feeds.soundcloud.com/stream/{id}-{user.permalink}-{track.permalink}.mp3` | No necesita el RSS. |

Los dos feeds apuntan **al mismo archivo**: `audio/mpeg`, 288.909.158 bytes, tag `ID3`,
acepta `Range`, y para 120 min da **~320 kbps**. El enclosure de SoundCloud hace 302 a una
URL firmada de `cf-media.sndcdn.com`; el script guarda el enclosure (estable) y sigue la
redirección al descargar.

> Verificado con un `GET Range: bytes=0-2047`: `206`, `audio/mpeg`,
> `content-range: bytes 0-2047/288909158`, primeros bytes `ID3\x03...`.

### Por qué no se usa `download_url` ni el tráfico de Playwright

Revisado en el repo **y en todo su histórico** (las 3 versiones de
`soundcloud-downloader/download.js` y las 2 de `soundcloud-token-getter/index.js`):

- El consumidor de la API solo guarda metadatos (`title`, `description`, `permalink_url`).
  Ahí es donde históricamente se habría leído `track.download_url`, pero el "download" de
  ese código es *de metadatos*, no del audio.
- El token-getter de Playwright solo escucha peticiones con `client_id=`.
- Sniffing real con Playwright sobre la página del episodio: **ninguna URL de descarga** en
  el tráfico anónimo (solo llamadas `client_id=`); el único "Download" del DOM es
  *"Download on the App Store"*. El botón de descarga requiere sesión.

Y la API v2 de hoy:

| Lo que se esperaba | Lo que devuelve hoy |
| --- | --- |
| `download_url` porque `downloadable: true` | **No viene** de forma anónima. |
| `/tracks/{id}/download?client_id=…` → 302 al MP3 | **401** (OAuth). |
| `media.transcodings` con MP3 progresivo | **Retirado el 31-dic-2025**: solo `aac_160k` / `aac_96k` HLS (`abr_sq` da 404). |
| `client_id` vía Playwright | Innecesario: está en `window.__sc_hydration.apiClient.id` (pero `isExpiring`, se pide fresco siempre). |

## Qué hace, paso a paso

1. **Consigue un `client_id` válido** desde `__sc_hydration`, lo valida contra `/resolve` y
   lo renueva en cada ejecución. Fallbacks: `client_id.txt` de `soundcloud-token-getter`
   y, por último, Playwright escuchando `client_id=`.
2. **Resuelve el usuario** con `/resolve?url=https://soundcloud.com/euphonicsessions`.
3. **Encuentra el episodio más reciente** con `/users/{id}/tracks?limit=20`, ordenando por
   `created_at` y pidiendo el track completo (`/tracks/{id}`) para la descripción íntegra.
4. **Resuelve el MP3** (`podcast.js`): RSS de SoundCloud → feed oficial → URL derivada.
   Cada candidato se verifica con un `Range` GET antes de considerarlo usable.
5. **Reúne también los fallbacks de la API** (`soundcloud.js`): `download_url` si algún día
   aparece, y los `media.transcodings` → m3u8 firmado. El MP3 **siempre gana** (score 200
   frente a 90 del mejor HLS).
6. **Escribe los archivos** y llama a `parsePlaylist()` del parser existente.

## Descargar sin yt-dlp ni ffmpeg

- Con MP3 disponible (lo normal): `--audio` hace un **streaming directo** con `fetch` +
  `pipeline`, siguiendo la redirección firmada, con progreso por bytes y sin cargar 276 MB
  en memoria. Resultado: `<titulo>.mp3`.
- Solo si no hay MP3: cae al **HLS AAC** y concatena `init.mp4` + segmentos `.m4s` en
  orden (fMP4 sin cifrar) para producir un `.m4a` válido. ~723 segmentos, ~145 MB a
  160 kbps, firma válida ~4 h.

## Archivos de salida

Por defecto en `artifact-preview/latest-episode/` (ya ignorado por `.gitignore`):

| Archivo | Contenido |
| --- | --- |
| `episode.json` | Metadatos, **todas** las URLs resueltas (MP3 + HLS), cuál se seleccionó, bitrate, tamaño y notas. |
| `url-descarga.txt` | Solo la URL de descarga directa (el enclosure del MP3). |
| `entrada.txt` | Copia cruda del episodio (URL, título, descripción) para el parser. |
| `playlist.txt` | **Texto formateado listo para copiar**, generado por `parsePlaylist()`. |
| `<titulo>.mp3` / `.m4a` | El audio, solo con `--audio`. |

## Opciones

| Opción | Descripción |
| --- | --- |
| `--user <nombre>` | Usuario de SoundCloud. Default `euphonicsessions` o `$SOUNDCLOUD_USER`. |
| `--out <carpeta>` | Carpeta de salida. |
| `--audio` | Descarga el episodio (MP3 original por defecto). |
| `--clip` | Copia `playlist.txt` al portapapeles (`Set-Clipboard` / `pbcopy` / `xclip`). |
| `--url-only` | Imprime solo la URL de descarga y no escribe archivos. |
| `--client-id <valor>` | Salta la detección automática del token. |
| `--quiet` | No imprime el playlist por consola. |
| `-h`, `--help` | Ayuda. |

## Notas

- El script **no toca** el workflow de GitHub Actions ni `artifact-integration`. Según lo
  acordado, primero se valida en local; el workflow se evalúa después.
- `soundcloud-playlist-prettier-single/index.js` se usa tal cual (se importa
  `parsePlaylist`), así que el formato de salida es idéntico al que ya copiabas a mano.
- Las líneas sueltas con URLs dentro de la descripción se omiten al construir
  `entrada.txt`, para que no sobreescriban el `permalink_url`.
- Si el `client_id` deja de publicarse en `__sc_hydration`, el fallback de Playwright
  necesita `cd ../soundcloud-token-getter && npm install && npx playwright install webkit`
  (es el mismo motor que usa `soundcloud-token-getter/index.js`).
- Datos de origen: la descripción de noviembre 2026 trae `Dsir` en vez de `Désir` (viene
  así de la API). Para ese tipo de errores existe `artifact-processing/corrections.json`.
