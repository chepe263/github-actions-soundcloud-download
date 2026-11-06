'use strict';

/**
 * REST API autocontenida (node:http, cero dependencias).
 *
 *   node server.js
 *   PORT=3000 DATA_ONLY=1 node --max-old-space-size=64 server.js   # RAM limitada
 *
 * Endpoints:
 *   GET  /health                 estado
 *   GET  /                       índice
 *   GET  /episode                URL de descarga + playlist ya arreglado + metadatos
 *   GET  /episode/playlist       solo el texto formateado
 *   GET  /episode/download-url   solo la URL del MP3
 *   GET  /episode/tags           etiquetas que TRAE el MP3 + las que se escribirían
 *   POST /refresh                fuerza el resolver y actualiza data/episode.json
 *   GET  /config/tags            plantilla de etiquetas actual
 *   PUT  /config/tags            escribe la plantilla (correcciones)
 *   POST /tags/preview           vista previa de etiquetas con overrides
 *   POST /jobs                   crea job: descarga + ID3 + archivo listo
 *   GET  /jobs                   lista
 *   GET  /jobs/:id               estado / progreso
 *   GET  /jobs/:id/file          descarga el MP3 etiquetado
 *   DELETE /jobs/:id             borra el job y su archivo
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const id3 = require('./lib/id3');
const { getEpisode, invalidateCache, loadCachedEpisode, DATA_FILE } = require('./lib/episode');
const {
  createJob, getJob, listJobs, deleteJob,
  loadConfig, saveConfig, renderTagPreview
} = require('./lib/jobs');

const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1024 * 1024);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  cors(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  cors(res);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Body demasiado grande (>${MAX_BODY_BYTES} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Body no es JSON válido'));
      }
    });
    req.on('error', reject);
  });
}

function createServer(options = {}) {
  const config = {
    dataOnly: options.dataOnly ?? (process.env.DATA_ONLY === '1'),
    fixtureFile: options.fixtureFile ?? process.env.FIXTURE_FILE ?? path.join(__dirname, 'fixtures/episode.mp3'),
    mp3SourceUrl: options.mp3SourceUrl ?? process.env.MP3_SOURCE_URL ?? null,
    maxBytes: options.maxBytes ?? (process.env.MAX_BYTES ? Number(process.env.MAX_BYTES) : null),
    port: options.port ?? Number(process.env.PORT || 3000)
  };

  async function episode() {
    return config.dataOnly ? getEpisode({ offline: true }) : getEpisode();
  }

  async function sourceTags() {
    if (!fs.existsSync(config.fixtureFile)) {
      return { available: false, reason: `No existe ${config.fixtureFile}; ejecuta npm run fixture:download` };
    }
    const parsed = await id3.readTagsFromFile(config.fixtureFile);
    return { available: true, file: config.fixtureFile, ...id3.summarize(parsed) };
  }

  function streamFile(req, res, filePath, filename) {
    const stat = fs.statSync(filePath);
    const type = 'audio/mpeg';
    const encoded = encodeURIComponent(filename).replace(/['()]/g, escape);
    const common = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `attachment; filename="${filename.replace(/["\r\n]/g, '_')}"; filename*=UTF-8''${encoded}`
    };

    const range = req.headers.range;
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      if (match) {
        start = match[1] ? Number(match[1]) : 0;
        end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        if (start > end || start >= stat.size) {
          cors(res);
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          return res.end();
        }
        status = 206;
      }
    }

    cors(res);
    res.writeHead(status, {
      ...common,
      'Content-Length': end - start + 1,
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {})
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath, { start, end }).pipe(res);
  }

  const routes = {
    'GET /health': async () => ({
      ok: true,
      node: process.version,
      dataOnly: config.dataOnly,
      dataFile: fs.existsSync(DATA_FILE) ? DATA_FILE : null,
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heapMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    }),

    'GET /': async () => ({
      name: 'episode-api',
      endpoints: [
        'GET /health', 'GET /episode', 'GET /episode/playlist', 'GET /episode/download-url',
        'GET /episode/tags', 'POST /refresh', 'GET /config/tags', 'PUT /config/tags',
        'POST /tags/preview', 'POST /jobs', 'GET /jobs', 'GET /jobs/:id',
        'GET /jobs/:id/file', 'DELETE /jobs/:id'
      ]
    }),

    'GET /episode': async () => episode(),
    'GET /episode/playlist': async (_req, res) => sendText(res, 200, (await episode()).playlist),
    'GET /episode/download-url': async () => {
      const ep = await episode();
      return { url: ep.download ? ep.download.url : null, ...ep.download };
    },
    'GET /episode/tags': async () => ({
      source: await sourceTags(),
      toApply: renderTagPreview(await episode())
    }),

    'POST /refresh': async () => {
      invalidateCache();
      const ep = await getEpisode({ force: true });
      return { refreshed: true, dataFile: DATA_FILE, resolvedAt: ep.resolvedAt };
    },

    'GET /config/tags': async () => loadConfig(),
    'PUT /config/tags': async (req) => {
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Se espera un objeto JSON');
      if (body.frames && (typeof body.frames !== 'object' || Array.isArray(body.frames))) {
        throw new Error('frames debe ser un objeto');
      }
      const current = loadConfig();
      const next = {
        ...current,
        ...body,
        frames: { ...(current.frames || {}), ...(body.frames || {}) }
      };
      return { saved: true, config: saveConfig(next) };
    },
    'POST /tags/preview': async (req) => {
      const body = await readBody(req);
      return renderTagPreview(await episode(), body.tags || body.frames || {});
    },

    'POST /jobs': async (req) => {
      const body = await readBody(req);
      const ep = await episode();
      return createJob({
        episode: ep,
        sourceUrl: body.sourceUrl || config.mp3SourceUrl,
        tagsOverride: body.tags || null,
        filename: body.filename || null,
        maxBytes: body.maxBytes || config.maxBytes
      });
    },
    'GET /jobs': async () => ({ jobs: listJobs() })
  };

  const server = http.createServer(async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    try {
      // /jobs/:id y /jobs/:id/file
      const jobMatch = /^\/jobs\/([^/]+)(\/file)?$/.exec(pathname);
      if (jobMatch && (req.method === 'GET' || req.method === 'DELETE')) {
        const job = getJob(jobMatch[1]);
        if (!job) return sendJson(res, 404, { error: 'Job no encontrado' });
        if (req.method === 'DELETE') {
          return sendJson(res, 200, { deleted: deleteJob(jobMatch[1]) });
        }
        if (jobMatch[2]) {
          if (job.status !== 'ready' || !job.file || !fs.existsSync(job.file)) {
            return sendJson(res, 409, { error: 'El archivo aún no está listo', job });
          }
          return streamFile(req, res, job.file, job.filename || `${job.id}.mp3`);
        }
        return sendJson(res, 200, job);
      }

      const key = `${req.method} ${pathname}`;
      const handler = routes[key];
      if (!handler) return sendJson(res, 404, { error: `Ruta no encontrada: ${key}` });

      const result = await handler(req, res);
      // Los handlers que ya escribieron la respuesta devuelven undefined.
      if (result !== undefined && !res.writableEnded) sendJson(res, 200, result);
    } catch (error) {
      if (!res.writableEnded) sendJson(res, 500, { error: error.message });
      console.error(`[api] ${req.method} ${pathname}: ${error.message}`);
    }
  });

  server.config = config;
  return server;
}

if (require.main === module) {
  const server = createServer();
  server.listen(server.config.port, () => {
    console.log(`episode-api escuchando en http://localhost:${server.address().port}`);
    console.log(`  dataOnly: ${server.config.dataOnly} | dataFile: ${DATA_FILE}`);
    console.log(`  RSS: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`);
  });
}

module.exports = { createServer };
