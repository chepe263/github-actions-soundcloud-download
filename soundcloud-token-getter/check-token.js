const fs = require('fs');
const path = require('path');

const CLIENT_ID_FILE = path.join(__dirname, 'client_id.txt');

async function checkToken() {
  // If file doesn't exist, exit with error (Playwright will create it)
  if (!fs.existsSync(CLIENT_ID_FILE)) {
    console.log('No existing client_id found - Playwright will create one');
    process.exit(1);
  }

  const clientId = fs.readFileSync(CLIENT_ID_FILE, 'utf8').trim();
  console.log('Found existing client_id:', clientId);

  try {
    const url = `https://api-v2.soundcloud.com/resolve?url=https://soundcloud.com/soundcloud&client_id=${clientId}`;
    const response = await fetch(url);

    if (response.ok) {
      console.log('✓ Existing client_id is valid - skipping Playwright');
      process.exit(0);
    } else {
      console.log(`✗ Existing client_id is invalid (HTTP ${response.status}) - deleting file`);
      fs.unlinkSync(CLIENT_ID_FILE);
      process.exit(1);
    }
  } catch (e) {
    console.log('✗ Error testing client_id:', e.message, '- deleting file');
    fs.unlinkSync(CLIENT_ID_FILE);
    process.exit(1);
  }
}

checkToken();
