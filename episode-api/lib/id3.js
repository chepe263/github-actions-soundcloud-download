'use strict';

/**
 * Lector / escritor ID3v2 en JS puro. Sin dependencias, sin ffmpeg.
 * - Lee ID3v2.2/2.3/2.4 (texto, TXXX/WXXX/COMM/APIC y frames binarios).
 * - Escribe ID3v2.3 por defecto (máxima compatibilidad) o 2.4.
 * - Reescribe el archivo por streaming: nunca carga un MP3 de ~276 MB en memoria.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const ENCODING = { LATIN1: 0, UTF16: 1, UTF16BE: 2, UTF8: 3 };

// Tope de RAM: un ID3v2 con carátula enorme no debe hacer que el proceso
// asigne cientos de MB. 8 MB es más que suficiente para etiquetas normales.
const MAX_TAG_BYTES = Number(process.env.MAX_ID3_TAG_BYTES || 8 * 1024 * 1024);

function synchsafeToInt(value) {
  // Cada BYTE guarda 7 bits; no se pueden usar desplazamientos del entero de
  // 32 bits porque mezclarían grupos contiguos.
  const b0 = (value >>> 24) & 0x7f;
  const b1 = (value >>> 16) & 0x7f;
  const b2 = (value >>> 8) & 0x7f;
  const b3 = value & 0x7f;
  return (b0 << 21) | (b1 << 14) | (b2 << 7) | b3;
}

function intToSynchsafe(value) {
  return Buffer.from([
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f
  ]);
}

function decodeUtf16(buffer, littleEndian) {
  let out = '';
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const code = littleEndian
      ? buffer[i] | (buffer[i + 1] << 8)
      : (buffer[i] << 8) | buffer[i + 1];
    out += String.fromCharCode(code);
  }
  return out;
}

function decodeString(buffer, encoding) {
  if (!buffer || !buffer.length) return '';
  // Quitar terminadores NUL finales: 0x00 (latin1/utf8) o 0x0000 (utf16).
  if (encoding === ENCODING.UTF16 || encoding === ENCODING.UTF16BE) {
    while (buffer.length >= 2 && buffer[buffer.length - 1] === 0 && buffer[buffer.length - 2] === 0) {
      buffer = buffer.subarray(0, buffer.length - 2);
    }
  } else {
    while (buffer.length && buffer[buffer.length - 1] === 0) {
      buffer = buffer.subarray(0, buffer.length - 1);
    }
  }
  if (!buffer.length) return '';
  switch (encoding) {
    case ENCODING.UTF8:
      return buffer.toString('utf8');
    case ENCODING.UTF16BE:
      return decodeUtf16(buffer, false);
    case ENCODING.UTF16: {
      let littleEndian = true;
      let offset = 0;
      if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
        littleEndian = false;
        offset = 2;
      } else if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
        offset = 2;
      }
      return decodeUtf16(buffer.subarray(offset), littleEndian);
    }
    default:
      return buffer.toString('latin1');
  }
}

function nullTerminator(encoding) {
  return encoding === ENCODING.UTF16 || encoding === ENCODING.UTF16BE
    ? Buffer.from([0, 0])
    : Buffer.from([0]);
}

function splitAtNull(buffer, encoding) {
  const terminator = nullTerminator(encoding);
  const width = terminator.length;
  for (let i = 0; i + width <= buffer.length; i += width > 1 ? 2 : 1) {
    if (buffer[i] === 0 && (width === 1 || buffer[i + 1] === 0)) {
      return [buffer.subarray(0, i), buffer.subarray(i + width)];
    }
  }
  return [buffer, Buffer.alloc(0)];
}

function decodeFrame(id, data) {
  if (!data.length) return { raw: '', bytes: 0 };
  const encoding = data[0];
  const payload = data.subarray(1);

  if (id === 'TXXX' || id === 'WXXX') {
    const [description, value] = splitAtNull(payload, encoding);
    return {
      description: decodeString(description, id === 'WXXX' ? ENCODING.LATIN1 : encoding),
      text: decodeString(value, id === 'WXXX' ? ENCODING.LATIN1 : encoding)
    };
  }

  if (id === 'COMM' || id === 'USLT' || id === 'SYLT') {
    const language = payload.subarray(0, 3).toString('latin1');
    const [description, text] = splitAtNull(payload.subarray(3), encoding);
    return {
      language,
      description: decodeString(description, encoding),
      text: decodeString(text, encoding)
    };
  }

  if (id === 'APIC') {
    const [mime, rest] = splitAtNull(payload, ENCODING.LATIN1);
    const pictureType = rest[0];
    const [description, image] = splitAtNull(rest.subarray(1), encoding);
    return {
      mimeType: mime.toString('latin1'),
      pictureType,
      description: decodeString(description, encoding),
      bytes: image.length,
      image: Buffer.from(image)
    };
  }

  if (/^[TW]/.test(id)) {
    return { text: decodeString(payload, id.startsWith('W') ? ENCODING.LATIN1 : encoding) };
  }

  return { raw: data.subarray(0, 24).toString('hex'), bytes: data.length };
}

/** Parsea un buffer que contiene (al menos) la cabecera ID3v2 completa. */
function readTagsFromBuffer(buffer) {
  if (buffer.length < 10 || buffer.toString('latin1', 0, 3) !== 'ID3') {
    return { present: false, version: null, audioOffset: 0, frames: [], size: 0 };
  }

  const major = buffer[3];
  const revision = buffer[4];
  const flags = buffer[5];
  const size = synchsafeToInt(buffer.readUInt32BE(6));
  const tagEnd = 10 + size;
  const frames = [];
  let offset = 10;

  // Extended header (flag 0x40 en v2.3/2.4): los primeros 4 bytes son su tamaño.
  if (flags & 0x40 && buffer.length >= offset + 4) {
    const extSize = major === 4
      ? synchsafeToInt(buffer.readUInt32BE(offset))
      : buffer.readUInt32BE(offset);
    offset += extSize;
  }

  const limit = Math.min(tagEnd, buffer.length);
  while (offset + 10 <= limit) {
    const id = buffer.toString('latin1', offset, offset + 4);
    if (!/^[A-Z0-9]{4}$/.test(id) || id === '\0\0\0\0') break; // padding
    const rawSize = buffer.readUInt32BE(offset + 4);
    const frameSize = major === 4 ? synchsafeToInt(rawSize) : rawSize;
    if (frameSize < 0 || offset + 10 + frameSize > limit) break;
    const frameFlags = buffer.readUInt16BE(offset + 8);
    const data = buffer.subarray(offset + 10, offset + 10 + frameSize);
    frames.push({ id, size: frameSize, flags: frameFlags, ...decodeFrame(id, data) });
    offset += 10 + frameSize;
  }

  return {
    present: true,
    version: `2.${major}.${revision}`,
    major,
    flags,
    size,
    audioOffset: tagEnd,
    frames
  };
}

/** Lee SOLO los bytes necesarios del archivo (la cabecera ID3v2). */
async function readTagsFromFile(filePath) {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const header = Buffer.alloc(10);
    await fd.read(header, 0, 10, 0);
    if (header.toString('latin1', 0, 3) !== 'ID3') {
      return { present: false, version: null, audioOffset: 0, frames: [], size: 0 };
    }
    const size = synchsafeToInt(header.readUInt32BE(6));
    if (size > MAX_TAG_BYTES) {
      throw new Error(`Etiqueta ID3v2 demasiado grande (${size} bytes > ${MAX_TAG_BYTES}); rechazada por límite de RAM.`);
    }
    const buf = Buffer.alloc(10 + size);
    await fd.read(buf, 0, buf.length, 0);
    const parsed = readTagsFromBuffer(buf);
    const stat = await fd.stat();
    const tail = Buffer.alloc(128);
    let hasId3v1 = false;
    if (stat.size >= 128) {
      await fd.read(tail, 0, 128, stat.size - 128);
      hasId3v1 = tail.toString('latin1', 0, 3) === 'TAG';
    }
    return { ...parsed, fileSize: stat.size, hasId3v1, audioEnd: hasId3v1 ? stat.size - 128 : stat.size };
  } finally {
    await fd.close();
  }
}

/** Representación legible para imprimir / devolver por la API. */
function summarize(parsed) {
  const tags = {};
  for (const frame of parsed.frames) {
    const value = frame.mimeType
      ? `[imagen ${frame.mimeType}, ${frame.bytes} bytes]`
      : frame.text !== undefined
        ? frame.text
        : frame.description !== undefined
          ? `${frame.description}: ${frame.text || ''}`.trim()
          : `[binario ${frame.bytes} bytes]`;
    const key = frame.description ? `${frame.id}:${frame.description}` : frame.id;
    if (tags[key] === undefined) tags[key] = value;
    else tags[key] = [].concat(tags[key], value);
  }
  return {
    present: parsed.present,
    version: parsed.version,
    size: parsed.size,
    flags: parsed.flags,
    audioOffset: parsed.audioOffset,
    hasId3v1: parsed.hasId3v1 || false,
    frameCount: parsed.frames.length,
    tags
  };
}

function encodeString(text, encoding) {
  switch (encoding) {
    case ENCODING.UTF8:
      return Buffer.from(text, 'utf8');
    case ENCODING.UTF16:
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    case ENCODING.UTF16BE: {
      const le = Buffer.from(text, 'utf16le');
      for (let i = 0; i + 1 < le.length; i += 2) {
        const tmp = le[i];
        le[i] = le[i + 1];
        le[i + 1] = tmp;
      }
      return le;
    }
    default:
      return Buffer.from(text, 'latin1');
  }
}

function buildFrame(id, value, { version }) {
  const major = version === '2.4' ? 4 : 3;
  const textEncoding = major === 4 ? ENCODING.UTF8 : ENCODING.UTF16;
  const isUrl = id.startsWith('W');
  const encoding = isUrl ? ENCODING.LATIN1 : textEncoding;
  const terminator = nullTerminator(encoding);

  // Los frames con descripción se indican como "TXXX:Nombre" / "COMM:desc".
  const colon = id.indexOf(':');
  const frameId = colon === -1 ? id : id.slice(0, colon);
  const description = colon === -1 ? null : id.slice(colon + 1);
  let data;

  if (frameId === 'APIC') {
    if (!value || !Buffer.isBuffer(value.data)) {
      throw new Error('APIC requiere { mimeType, data: Buffer }; descarga la carátula antes de escribir.');
    }
    // encoding, mime\0, tipo(3 = front cover), descripción\0, imagen.
    data = Buffer.concat([
      Buffer.from([ENCODING.LATIN1]),
      Buffer.from(value.mimeType || 'image/jpeg', 'latin1'),
      Buffer.from([0]),
      Buffer.from([3]),
      encodeString(description || '', ENCODING.LATIN1),
      Buffer.from([0]),
      value.data
    ]);
  } else if (frameId === 'USLT' || frameId === 'SYLT') {
    // encoding, idioma (3), descriptor terminado en NUL, texto.
    data = Buffer.concat([
      Buffer.from([encoding]),
      Buffer.from('XXX', 'latin1'),
      encodeString(description || '', encoding),
      terminator,
      encodeString(String(value), encoding)
    ]);
  } else if (description !== null) {
    const descBuf = encodeString(description, encoding);
    const valueBuf = encodeString(String(value), encoding);
    const prefix = frameId === 'COMM' ? Buffer.from('eng', 'latin1') : Buffer.alloc(0);
    data = Buffer.concat([
      Buffer.from([encoding]),
      prefix,
      descBuf,
      terminator,
      valueBuf
    ]);
  } else {
    data = Buffer.concat([
      Buffer.from([encoding]),
      encodeString(String(value), encoding)
    ]);
  }

  const sizeBuffer = Buffer.alloc(4);
  if (major === 4) intToSynchsafe(data.length).copy(sizeBuffer);
  else sizeBuffer.writeUInt32BE(data.length, 0);

  return Buffer.concat([
    Buffer.from(frameId, 'latin1'),
    sizeBuffer,
    Buffer.from([0, 0]),
    data
  ]);
}

/** Construye el tag ID3v2 completo a partir de { "TIT2": "..." , "TXXX:URL": "..." }. */
function buildTagBuffer(frames, { version = '2.3' } = {}) {
  const major = version === '2.4' ? 4 : 3;
  const normalized = {};

  const seen = new Set();
  for (const [key, value] of Object.entries(frames || {})) {
    if (value === null || value === undefined || value === '') continue;
    let id = key;
    let rendered = value;
    // Normalizar el frame de fecha según la versión del tag.
    if (major === 3 && key.startsWith('TDRC')) {
      id = key.replace('TDRC', 'TYER');
      rendered = String(value).slice(0, 4); // TYER admite solo el año
    }
    // En v2.4 no se normaliza TYER: MediaMonkey escribe TDRC y TYER a la vez.
    if (seen.has(id)) continue; // evitar duplicados al normalizar
    seen.add(id);
    normalized[id] = rendered;
  }

  const body = Buffer.concat(Object.entries(normalized).map(([id, value]) => buildFrame(id, value, { version })));
  const header = Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([major, 0, 0]),
    intToSynchsafe(body.length)
  ]);
  return Buffer.concat([header, body]);
}

function renderFrames(frames, context) {
  const rendered = {};
  for (const [key, value] of Object.entries(frames || {})) {
    if (typeof value !== 'string') {
      rendered[key] = value;
      continue;
    }
    rendered[key] = value.replace(/\{(\w+)\}/g, (match, name) =>
      context[name] === undefined || context[name] === null ? '' : String(context[name])
    );
  }
  return rendered;
}

/** Construye un tag ID3v1.1 de 128 bytes (lo que escriben MediaMonkey/ffmpeg). */
function buildId3v1(fields = {}) {
  const buf = Buffer.alloc(128, 0);
  buf.write('TAG', 0, 'latin1');
  const put = (value, offset, length) => {
    buf.write(String(value === undefined || value === null ? '' : value).slice(0, length), offset, length, 'latin1');
  };
  put(fields.title, 3, 30);
  put(fields.artist, 33, 30);
  put(fields.album, 63, 30);
  put(fields.year, 93, 4);
  put(fields.comment || '', 97, 28);
  buf[125] = 0;                       // marca ID3v1.1
  buf[126] = Number(fields.track) || 0;
  buf[127] = fields.genre === undefined ? 255 : Number(fields.genre);
  return buf;
}

/** Devuelve el valor de texto de un frame leído, para poder conservarlo. */
function frameTextValue(frame) {
  if (frame.text !== undefined) return frame.text;
  if (frame.description !== undefined) return frame.text || '';
  return null;
}

/**
 * Reescribe srcPath en destPath con las etiquetas nuevas, por streaming.
 * Quita el ID3v2 anterior (y el ID3v1 final) sin cargar el audio en memoria.
 * `preserve` reinyunta frames del archivo de origen (TSSE, creation_time...).
 */
async function writeTagsToFile(srcPath, destPath, frames, {
  version = '2.3',
  strip = true,
  preserve = [],
  id3v1 = null
} = {}) {
  const sourceParsed = await readTagsFromFile(srcPath);
  const parsed = strip
    ? sourceParsed
    : { audioOffset: 0, audioEnd: fs.statSync(srcPath).size, hasId3v1: false };

  const toWrite = { ...frames };
  for (const key of preserve) {
    if (toWrite[key] !== undefined) continue;
    const sourceFrame = sourceParsed.frames.find(frame =>
      (frame.description ? `${frame.id}:${frame.description}` : frame.id) === key
    );
    const value = sourceFrame ? frameTextValue(sourceFrame) : null;
    if (value !== null && value !== undefined && value !== '') toWrite[key] = value;
  }

  const tag = buildTagBuffer(toWrite, { version });
  const start = parsed.audioOffset || 0;
  const end = (parsed.audioEnd || fs.statSync(srcPath).size) - 1;
  const v1 = id3v1 ? buildId3v1(id3v1) : null;

  const target = path.resolve(destPath) === path.resolve(srcPath)
    ? `${destPath}.retag-${process.pid}`
    : destPath;

  async function* chunks() {
    yield tag;
    if (end >= start) {
      for await (const chunk of fs.createReadStream(srcPath, { start, end })) {
        yield chunk;
      }
    }
    if (v1) yield v1;
  }

  await pipeline(Readable.from(chunks()), fs.createWriteStream(target, { flags: 'w' }));

  if (target !== destPath) {
    fs.renameSync(target, destPath);
  }
  return {
    tagBytes: tag.length,
    audioBytes: Math.max(0, end - start + 1),
    version,
    preserved: preserve.filter(key => toWrite[key] !== undefined),
    frames: toWrite,
    id3v1: Boolean(v1)
  };
}

module.exports = {
  readTagsFromBuffer,
  readTagsFromFile,
  summarize,
  buildTagBuffer,
  buildId3v1,
  renderFrames,
  writeTagsToFile,
  synchsafeToInt,
  intToSynchsafe
};
