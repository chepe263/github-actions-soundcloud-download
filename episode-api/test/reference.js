'use strict';

/**
 * Compara nuestras etiquetas con los MP3 de referencia etiquetados a mano.
 * Opcional: si la carpeta no existe, se omite (no falla en CI).
 *
 *   REFERENCE_DIR="C:\Users\chepe263\Downloads\kyau-albert" npm run test:reference
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const id3 = require('../lib/id3');
const { getEpisode } = require('../lib/episode');
const { renderTagPreview, downloadArtwork } = require('../lib/jobs');

const REFERENCE_DIR = process.env.REFERENCE_DIR || 'C:/Users/chepe263/Downloads/kyau-albert';
const FIXTURE = path.join(__dirname, '../fixtures/sample.mp3');

(async () => {
  if (!fs.existsSync(REFERENCE_DIR) || !fs.existsSync(FIXTURE)) {
    console.log('⏭  Sin REFERENCE_DIR o sin fixture; se omite la comparación.');
    return;
  }

  const episode = await getEpisode({ offline: true });
  const edition = episode.feed && episode.feed.subtitle;
  const referenceFile = fs.readdirSync(REFERENCE_DIR)
    .filter(name => name.toLowerCase().endsWith('.mp3'))
    .find(name => !edition || name.includes(edition.replace(/ Edition$/, '')));
  if (!referenceFile) {
    console.log(`⏭  No hay MP3 de referencia para "${edition}"; se omite.`);
    return;
  }

  const preview = renderTagPreview(episode);
  const frames = { ...preview.frames };
  if (typeof frames.APIC === 'string' && frames.APIC) {
    frames.APIC = await downloadArtwork(frames.APIC);
  }

  const ours = path.join(os.tmpdir(), `episode-api-reference-${process.pid}.mp3`);
  await id3.writeTagsToFile(FIXTURE, ours, frames, {
    version: preview.version,
    strip: preview.strip,
    preserve: preview.preserve,
    id3v1: {
      title: frames.TIT2,
      artist: frames.TPE1,
      album: frames.TALB,
      year: frames.TYER,
      track: frames.TRCK,
      genre: 255
    }
  });

  try {
    const ref = id3.summarize(await id3.readTagsFromFile(path.join(REFERENCE_DIR, referenceFile)));
    const got = id3.summarize(await id3.readTagsFromFile(ours));
    const keys = [...new Set([...Object.keys(ref.tags), ...Object.keys(got.tags)])].sort();
    const diffs = keys.filter(key => String(ref.tags[key]) !== String(got.tags[key]));

    // El archivo de Noviembre de referencia NO trae carátula; nosotros sí, por requisito.
    const expected = diffs.filter(key => key === 'APIC' && ref.tags[key] === undefined);
    const unexpected = diffs.filter(key => !expected.includes(key));

    console.log(`Referencia: ${referenceFile}`);
    console.log(`  ID3v2 ref=${ref.version} nuestro=${got.version} | ID3v1 ref=${ref.hasId3v1} nuestro=${got.hasId3v1}`);
    console.log(`  frames ref=${ref.frameCount} nuestro=${got.frameCount}`);
    for (const key of unexpected) {
      const a = String(ref.tags[key]).replace(/\n/g, '⏎').slice(0, 100);
      const b = String(got.tags[key]).replace(/\n/g, '⏎').slice(0, 100);
      console.log(`  ✗ ${key}\n      ref : ${a}\n      our : ${b}`);
    }
    if (expected.length) {
      console.log(`  ℹ APIC añadido: ${got.tags.APIC} (la referencia de Noviembre no lo trae; ahora es obligatorio)`);
    }

    if (ref.version !== got.version || ref.hasId3v1 !== got.hasId3v1 || unexpected.length) {
      throw new Error(`${unexpected.length} frame(s) distinto(s) / versión distinta`);
    }
    console.log(`✅ ${keys.length - expected.length} frames idénticos, 0 diferencias (+${expected.length} carátula obligatoria).`);
  } finally {
    fs.rmSync(ours, { force: true });
  }
})().catch(error => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
