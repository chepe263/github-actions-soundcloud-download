const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CLIENT_ID_FILE = path.join(__dirname, '../soundcloud-token-getter/client_id.txt');
const OUTPUT_DIR = path.join(__dirname, 'soundcloud-jsons');

// Create axios instance with browser-like headers
const axiosInstance = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://soundcloud.com/',
    'Origin': 'https://soundcloud.com'
  }
});

// Helper function for delay
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function for retry with exponential backoff
async function retryRequest(fn, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Check if it's a captcha/rate limit error
      if (error.response && (error.response.status === 403 || error.response.status === 429)) {
        const waitTime = Math.min(1000 * Math.pow(2, attempt - 1) + Math.random() * 1000, 30000);
        console.log(`⚠ Rate limited or CAPTCHA detected. Waiting ${Math.round(waitTime)}ms before retry ${attempt}/${maxRetries}...`);
        await delay(waitTime);
      } else if (attempt < maxRetries) {
        const waitTime = 1000 * attempt + Math.random() * 500;
        console.log(`⚠ Request failed. Retrying in ${Math.round(waitTime)}ms (${attempt}/${maxRetries})...`);
        await delay(waitTime);
      }
    }
  }
  
  throw lastError;
}

async function main() {
  // Get SoundCloud username from environment or default
  const username = process.env.SOUNDCLOUD_USER || process.argv[2];
  
  if (!username) {
    console.error('Error: SOUNDCLOUD_USER environment variable or username argument required');
    console.error('Usage: SOUNDCLOUD_USER=username npm run download');
    console.error('   or: node download.js username');
    process.exit(1);
  }

  // Read client_id from file
  let clientId;
  try {
    clientId = fs.readFileSync(CLIENT_ID_FILE, 'utf8').trim();
    console.log('Loaded client_id:', clientId);
  } catch (error) {
    console.error('Error reading client_id file:', error.message);
    console.error('Make sure to run the token getter first!');
    process.exit(1);
  }

  // Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  try {
    console.log(`\nFetching user: ${username}`);
    
    // Resolve user with retry logic
    const userResponse = await retryRequest(() =>
      axiosInstance.get('https://api-v2.soundcloud.com/resolve', {
        params: {
          url: `https://soundcloud.com/${username}`,
          client_id: clientId
        }
      })
    );

    const user = userResponse.data;
    console.log(`Found user: ${user.username} (ID: ${user.id})`);
    console.log(`Track count: ${user.track_count}`);

    // Add delay between requests
    await delay(2000 + Math.random() * 2000);

    // Get user's tracks with retry logic
    console.log('\nFetching tracks...');
    const tracksResponse = await retryRequest(() =>
      axiosInstance.get(`https://api-v2.soundcloud.com/users/${user.id}/tracks`, {
        params: {
          client_id: clientId,
          limit: 200,
          linked_partitioning: 1
        }
      })
    );

    const tracks = tracksResponse.data.collection;
    console.log(`Downloaded ${tracks.length} tracks`);

    // Save each track's metadata
    const summary = [];
    
    for (const track of tracks) {
      const trackData = {
        id: track.id,
        title: track.title,
        description: track.description || '',
        permalink_url: track.permalink_url,
        duration: track.duration,
        playback_count: track.playback_count,
        likes_count: track.likes_count,
        comment_count: track.comment_count,
        created_at: track.created_at,
        genre: track.genre,
        tag_list: track.tag_list,
        artwork_url: track.artwork_url
      };

      // Save individual track file
      const filename = `${track.id}_${sanitizeFilename(track.title)}.json`;
      const filepath = path.join(OUTPUT_DIR, filename);
      fs.writeFileSync(filepath, JSON.stringify(trackData, null, 2));

      summary.push({
        id: track.id,
        title: track.title,
        url: track.permalink_url
      });

      console.log(`  ✓ ${track.title}`);
      
      // Add small delay between track processing to avoid hitting rate limits
      await delay(100 + Math.random() * 200);
    }

    // Save summary file
    const summaryData = {
      user: {
        username: user.username,
        id: user.id,
        permalink_url: user.permalink_url
      },
      download_date: new Date().toISOString(),
      track_count: tracks.length,
      tracks: summary
    };

    fs.writeFileSync(
      path.join(OUTPUT_DIR, '_summary.json'),
      JSON.stringify(summaryData, null, 2)
    );

    console.log(`\n✓ Successfully downloaded ${tracks.length} tracks to ${OUTPUT_DIR}`);
    console.log(`✓ Summary saved to ${path.join(OUTPUT_DIR, '_summary.json')}`);

  } catch (error) {
    if (error.response) {
      console.error(`API Error: ${error.response.status} - ${error.response.statusText}`);
      console.error('Response:', error.response.data);
    } else {
      console.error('Error:', error.message);
    }
    process.exit(1);
  }
}

function sanitizeFilename(filename) {
  return filename
    .replace(/[^a-z0-9]/gi, '_')
    .replace(/_+/g, '_')
    .substring(0, 50)
    .toLowerCase();
}

main();
