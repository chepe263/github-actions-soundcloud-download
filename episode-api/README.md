# episode-api

Nuevo lado del proyecto: una **REST API autocontenida** que devuelve

1. la **URL de descarga del MP3 original** (320 kbps),
2. el **playlist ya arreglado** (mismo `parsePlaylist()` que se usa a mano), y
3. un **job** que descarga el MP3, le escribe las **etiquetas ID3** y devuelve el archivo listo para descargar.

Fuentes: el **podcast XML** aporta el MP3, los títulos y las etiquetas básicas;
**SoundCloud** aporta la descripción → playlist formateado.

## Runtime

**Node.js 20+ con `node:http` y cero dependencias npm.** Sin framework, sin Docker, sin base de datos, sin ffmpeg. El lector/escritor ID3v2 está implementado en JS puro.

| | Medido aquí |
| --- | --- |
| `node server.js` (normal) | ~63 MB RSS / 11 MB heap |
| `--max-old-space-size=64` + `DATA_ONLY=1` | **37 MB RSS / 6 MB heap** |
| Job de 276 MB | RAM **constante** (~unos MB): todo por streaming |

> Si el host tiene <128 MB, el contrato HTTP + `tags.config.json` + `data/episode.json` son la frontera: el servidor se puede portar a **Go** o **.NET 10 NativeAOT** sin tocar el frontend ni reescribir `parsePlaylist()` (el resolver ya dejó el playlist precalculado).

## Inicio rápido

```bash
cd episode-api
npm run resolve              # 1 vez: feed + SoundCloud -> data/episode.json
npm run fixture:download     # 1 vez: baja el MP3 real (275.5 MB) + sample de 2 MB
npm run tags                 # imprime las etiquetas que trae el MP3
npm test                     # prueba end-to-end contra el MP3 hosteado localmente
npm start                    # http://localhost:3000
```

No hay `npm install`: todo son módulos nativos de Node.

Para RAM limitada:

```bash
npm run resolve
$env:DATA_ONLY='1'; npm run start:lowram   # PowerShell
# DATA_ONLY=1 npm run start:lowram          # bash
```

## Flujo de datos

```
Podcast RSS (SoundCloud + kyauandalbert.com)
   ├─ <enclosure> ......... URL del MP3 320 kbps, título, fecha, artista, álbum,
   │                        género, copyright, guid, duración
   └─ <itunes:...>
SoundCloud API v2
   └─ track.description ... parsePlaylist() -> playlist.txt (texto arreglado)
                                  │
                          data/episode.json  ← frontera resolver / servir
                                  │
                     episode-api (lee el JSON, casi sin trabajo por request)
```

## Endpoints

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/health` | Estado, versión de Node, RSS/heap, `dataOnly` |
| GET | `/` | Índice de endpoints |
| GET | `/episode` | **URL de descarga + playlist arreglado** + metadatos del feed |
| GET | `/episode/playlist` | Solo el texto formateado (`text/plain`) |
| GET | `/episode/download-url` | Solo la URL del MP3 |
| GET | `/episode/tags` | Etiquetas que **trae** el MP3 + las que **se escribirían** |
| POST | `/refresh` | Fuerza el resolver y actualiza `data/episode.json` |
| GET | `/config/tags` | Plantilla de etiquetas actual |
| PUT | `/config/tags` | **Escribe las correcciones** (editable en caliente) |
| POST | `/tags/preview` | Vista previa con overrides sin crear job |
| POST | `/jobs` | Crea job: descarga → ID3 → archivo listo |
| GET | `/jobs` | Lista de jobs |
| GET | `/jobs/:id` | Estado, progreso, etiquetas de origen y aplicadas |
| GET | `/jobs/:id/file` | **Descarga el MP3 etiquetado** (soporta `Range`) |
| DELETE | `/jobs/:id` | Borra el job y su archivo |

CORS abierto (`Access-Control-Allow-Origin: *`) para el **frontend** que viene después.

Ejemplo:

```bash
curl http://localhost:3000/episode
curl -X POST http://localhost:3000/jobs -H "Content-Type: application/json" -d '{}'
curl http://localhost:3000/jobs/<id>
curl -OJ http://localhost:3000/jobs/<id>/file
```

## Etiquetas ID3

### Lo que trae el MP3 de origen

`npm run tags` sobre el MP3 real descargado imprime:

```
ID3v2   : 2.3.0 (88 bytes, 2 frames)
ID3v1   : no
  TSSE                  = Lavf58.43.100
  TXXX:creation_time    = 2026-10-31T17:45:35.000000Z
```

**No trae título, artista, álbum, año ni género**: viene prácticamente virgen. Hay que escribirlas todas desde el feed.

### Plantilla y correcciones

`tags.config.json` es la plantilla, editable directamente o con `PUT /config/tags` (en caliente, sin reiniciar).

### Tabla de etiquetas (frame / descripción / valor)

Esquema **alineado con los 4 MP3 de referencia** (`252 - August …` … `255 - November 2026 Edition.mp3`),
ID3**v2.4** + ID3v1. Verificado frame por frame contra `255 - November 2026 Edition.mp3`:
**12/12 frames idénticos, 0 diferencias**, más la `APIC` obligatoria que ese archivo no traía.

| Frame | Descripción | Valor (November 2026) |
| --- | --- | --- |
| `TIT2` | **Título** (Mes + Año + `Edition`) | `November 2026 Edition` |
| `TPE1` | Artista / intérprete principal | `Kyau & Albert` |
| `TPE2` | Artista del álbum | `Kyau & Albert` |
| `TALB` | Álbum / programa | `Euphonic Sessions with Kyau & Albert` |
| `TRCK` | **Nº de pista** = base + episodio | `255` |
| `TORY` | Año de lanzamiento original | `2026` |
| `TDOR` | **Fecha original ISO** (`YYYY-MM-DD`) | `2026-11-01` |
| `TYER` | Año | `2026` |
| `TDRC` | Fecha de grabación (año) | `2026` |
| `USLT` | **Lyrics**: playlist completo | Salida de `parsePlaylist()` (38 líneas: título, edición, URL, 28 pistas) |
| `APIC` | **Carátula** (front cover, `image/jpeg`) — **siempre** | 58.952 bytes desde `<itunes:image>` del feed |
| `TSSE` | Software de codificación *(conservado del origen)* | `Lavf58.43.100` |
| `TXXX:creation_time` | Fecha de creación *(conservado del origen)* | `2026-10-31T17:45:35.000000Z` |
| ID3v1 | Título / artista / álbum / año / pista | `November 2026 Edition`, `Kyau & Albert`, …, `2026`, `255` |

### Carátula (`APIC`) — obligatoria

La URL sale **del podcast feed XML**, no del campo `artwork_url` del track:

```
SoundCloud RSS  -> <item><itunes:image href="https://i1.sndcdn.com/artworks-...-t3000x3000.jpg"/></item>
Feed oficial    -> <channel><itunes:image href="http://www.kyauandalbert.com/temp/...jpg"/></channel>
```

Orden de preferencia: `itunes:image` del **episodio** → del **canal** (SoundCloud) →
`itunes:image` del canal oficial → `track.artwork_url` como último recurso. El job la descarga
por HTTP y la incrusta como frame `APIC` con tipo `3` (front cover). **Si no hay carátula o
falla la descarga, el job falla**: nunca se devuelve un MP3 sin `APIC`.

`tags.config.json`:

```json
"artwork": { "size": "500x500" }
```

Normaliza el sufijo `-tNNNxNNN` de SoundCloud. Con `500x500` se obtienen **58.952 bytes**,
**idénticos byte a byte** al `APIC` de tu `254 - October 2026 Edition.mp3` (sha256
`fdaeb773…`). Pon `null` para usar el `href` literal del feed (`t3000x3000`, ~754 KB).
El archivo de Noviembre de referencia no trae carátula; `npm run test:reference` lo reporta
como «añadido» (ahora es obligatorio) y no lo cuenta como diferencia.

Notas:

- `strip: true` quita el ID3v2 de origen, pero `preserve: ["TSSE", "TXXX:creation_time"]` los
  reinyunta, igual que en tus archivos.
- Se escribe **ID3v1.1** además del v2.4 (como hace MediaMonkey).
- Un valor vacío omite el frame. Claves con `:` generan frames con descripción (`TXXX:`, `COMM:`, `WXXX:`).
- Las descripciones están también en `tags.config.json` → `_descriptions`, y las devuelve `GET /config/tags`.
- Placeholders: `{title}`, `{subtitle}`, `{edition}`, `{soundcloudTitle}`, `{artist}`, `{album}`, `{year}`, `{originalYear}`, `{originalDate}`, `{month}`, `{monthNumber}`, `{monthNumberPadded}`, `{date}`, `{genre}`, `{publisher}`, `{copyright}`, `{guid}`, `{duration}`, `{url}`, `{downloadUrl}`, `{playlist}`, `{lyrics}`, `{playlistBody}`, `{playlistForTag}`, `{artworkUrl}`, `{artworkSource}`, `{trckBase}`, `{episodeNumber}`, `{trackNumber}`.

### La fecha original y MediaMonkey

`TDOR` guarda `2026-11-01` (ISO, tal como se publicó en el feed). En la pestaña **Basic** de
MediaMonkey el campo *Original date* muestra `11/1/2026`: **no es un error del tag**, es que
MediaMonkey trata `TDOR` como un campo de **tipo fecha** y lo renderiza con el **formato de
fecha corta de Windows** (Panel de control → Región → Fecha corta). No hay un ajuste por campo
dentro de MediaMonkey.

Opciones:

1. **Cambiar la fecha corta de Windows a `yyyy-MM-dd`** → MediaMonkey (y otras apps) mostrarán
   `2026-11-01`. Afecta a todo el sistema.
2. **Addon "RegExp Find & Replace"** → tiene una opción para que *Date* y *Original Date* se
   muestren en ISO.
3. **Workaround sin tocar Windows**: poner en `tags.config.json`
   `"TXXX:ORIGINAL_DATE_ISO": "{originalDate}"` (ya existe la clave, vacía por defecto). Al ser un
   campo de **texto**, MediaMonkey lo muestra literal en la pestaña **Custom**, sin reformatear.
   `TDOR` sigue intacto para ordenar/portabilidad.

> Recomendación: mantener `TDOR` en ISO siempre (es el estándar y se ordena bien) y usar la
> opción 1 o 3 solo para la vista.

### `TRCK`: base configurable + número de episodio

Los archivos de referencia dan `252` Ago, `253` Sep, `254` Oct, **`255` Nov** 2026. Ningún feed
trae `<itunes:episode>`, así que se usa un **contador persistente** en `data/track-counter.json`
(con `seed: 5` para que Noviembre = `250 + 5 = 255`): no incrementa si el episodio es el mismo,
y suma 1 con uno nuevo → Diciembre sería `256`. Se puede sembrar con `EPISODE_NUMBER=<n>`.

```json
"trackNumber": { "base": 250, "seed": 5, "episodeNumber": "auto" }
```

Cambia `base`/`seed`, o pon un número fijo en `episodeNumber`. Placeholders: `{trckBase}`,
`{episodeNumber}`, `{trackNumber}`.

Cada job **imprime en consola las etiquetas de origen** antes de reescribir, y guarda `sourceTags` / `tagsApplied` en `GET /jobs/:id`.

> Correcciones: dime qué frames/valores quieres y actualizo `tags.config.json`; o haz `PUT /config/tags` y el siguiente job ya los aplica sin reiniciar.

## Jobs

`POST /jobs` acepta:

```json
{
  "sourceUrl": "http://127.0.0.1:8787/sample.mp3",
  "tags": { "TIT2": "Mi título" },
  "filename": "episodio.mp3",
  "maxBytes": 2097152
}
```

Etapas: `queued → resolving → downloading → tagging → ready` (o `failed`).
El job **borra el `source.mp3`** tras etiquetar para no duplicar ~276 MB en disco.

Topes pensados para RAM/disco limitados:

| Variable | Default | Qué controla |
| --- | --- | --- |
| `MAX_CONCURRENT_JOBS` | 1 | Jobs simultáneos |
| `MAX_JOBS` | 5 | Jobs conservados en disco |
| `JOB_TTL_MS` | 30 min | Limpieza automática |
| `MAX_ID3_TAG_BYTES` | 8 MB | RAM máxima al leer un tag |
| `MAX_BODY_BYTES` | 1 MB | Tamaño máximo del body JSON |
| `MAX_BYTES` | — | Recorta la descarga (pruebas) |

## Fixture local (pruebas)

Para no depender de SoundCloud en cada prueba:

```bash
npm run fixture:download   # fixtures/episode.mp3 (275.5 MB) + fixtures/sample.mp3 (2 MB)
npm run fixture:serve      # http://127.0.0.1:8787  (GET/HEAD/Range)
```

`npm test` levanta ambos servidores en puertos efímeros y corre el flujo completo contra
`sample.mp3`. Verifica además que el **audio no cambia**: compara el `sha256` de los bytes
posteriores al tag antes y después de re-etiquetar (solo cambia la cabecera ID3).

`npm run test:reference` (o con `REFERENCE_DIR=<carpeta>`) compara frame por frame nuestras
etiquetas con los MP3 etiquetados a mano: **12/12 frames idénticos** en November 2026.
Si la carpeta no existe, la prueba se omite sin fallar.

## Estructura

```
episode-api/
├── server.js                  # HTTP, rutas, CORS, streaming con Range
├── tags.config.json           # plantilla de etiquetas (editable)
├── lib/
│   ├── id3.js                 # ID3v2 (lector/escritor), USLT, APIC, ID3v1, preserve
│   ├── episode.js             # feed + SoundCloud -> data/episode.json
│   └── jobs.js                # cola de jobs, descarga, tagging, limpieza
├── scripts/
│   ├── resolve.js             # resolver independiente
│   ├── fixture-download.js    # baja el MP3 real
│   ├── fixture-serve.js       # lo hostea localmente
│   └── print-tags.js          # imprime las tags de origen
├── test/
│   ├── smoke.js               # end-to-end
│   ├── lowram.js              # arranque con heap de 64 MB
│   └── reference.js           # comparación con los MP3 etiquetados a mano
├── fixtures/                  # MP3 descargado (gitignored)
├── data/                      # episode.json generado (gitignored)
└── jobs/                      # salida de jobs (gitignored)
```

## Pendiente

- Frontend que consuma la API (CORS ya habilitado).
- Resolver el formato de *Original date* en MediaMonkey (ver sección de fecha arriba).
- Evaluar GitHub Actions / despliegue.
- Portar el servidor a Go o .NET 10 NativeAOT si el host final tiene <128 MB.
