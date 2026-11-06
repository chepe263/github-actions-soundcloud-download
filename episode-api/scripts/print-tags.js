'use strict';

/**
 * Imprime las etiquetas ID3 que trae el MP3 descargado.
 *   npm run tags
 *   TAGS_FILE=../otro.mp3 npm run tags
 *   node scripts/print-tags.js --json
 */
const fs = require('node:fs');
const path = require('node:path');
const id3 = require('../lib/id3');

const file = process.env.TAGS_FILE
  ? path.resolve(process.env.TAGS_FILE)
  : path.join(__dirname, '../fixtures/episode.mp3');

(async () => {
  if (!fs.existsSync(file)) {
    console.error(`No existe ${file}. Ejecuta primero: npm run fixture:download`);
    process.exit(1);
  }

  const parsed = await id3.readTagsFromFile(file);
  const summary = id3.summarize(parsed);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Archivo : ${file}`);
  console.log(`Tamaño  : ${(parsed.fileSize / 1024 / 1024).toFixed(1)} MB`);
  console.log(`ID3v2   : ${summary.version || 'ausente'} (${summary.size} bytes, ${summary.frameCount} frames)`);
  console.log(`ID3v1   : ${summary.hasId3v1 ? 'sí' : 'no'}`);
  console.log('');
  console.log('Etiquetas que trae de origen:');
  console.log('────────────────────────────────────────────────────────────');

  if (!summary.frameCount) {
    console.log('  (sin frames ID3v2)');
  } else {
    for (const [key, value] of Object.entries(summary.tags)) {
      const shown = Array.isArray(value) ? value.join(' | ') : String(value);
      const oneLine = shown.replace(/\r?\n/g, ' ⏎ ');
      console.log(`  ${key.padEnd(28)} = ${oneLine.slice(0, 300)}${oneLine.length > 300 ? ' …' : ''}`);
    }
  }

  console.log('────────────────────────────────────────────────────────────');
  console.log('\nFrames crudos (id / tamaño):');
  for (const frame of parsed.frames) {
    const label = frame.description ? `${frame.id}:${frame.description}` : frame.id;
    console.log(`  ${label.padEnd(28)} ${String(frame.size).padStart(8)} bytes`);
  }
})().catch(error => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
