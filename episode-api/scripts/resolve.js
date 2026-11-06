'use strict';

/**
 * Resolver independiente: consulta el feed + SoundCloud y deja data/episode.json.
 * Separa "resolver" de "servir": el servidor con DATA_ONLY=1 solo lee ese archivo.
 *
 *   npm run resolve
 */
const { getEpisode, DATA_FILE } = require('../lib/episode');

(async () => {
  const episode = await getEpisode({ force: true });
  console.log(`✓ ${episode.title}`);
  console.log(`  MP3      : ${episode.download ? episode.download.url : '(sin MP3)'}`);
  console.log(`  Playlist : ${episode.playlist.split('\n').length} líneas`);
  console.log(`  Guardado : ${DATA_FILE}`);
})().catch(error => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
