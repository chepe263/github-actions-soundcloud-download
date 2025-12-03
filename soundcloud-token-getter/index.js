const { webkit } = require('playwright');
const fs = require('fs');
const path = require('path');

const CLIENT_ID_FILE = path.join(__dirname, 'client_id.txt');

/**
 * Test if a client_id is valid by making a simple API request
 * @param {string} clientId - The client_id to test
 * @returns {Promise<boolean>} - True if valid, false otherwise
 */
async function testClientId(clientId) {
  try {
    const url = `https://api-v2.soundcloud.com/resolve?url=https://soundcloud.com/soundcloud&client_id=${clientId}`;
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Fetch a new client_id from SoundCloud using Playwright
 * @returns {Promise<string|null>} - The client_id or null if not found
 */
async function fetchNewClientId() {
  console.log('Starting Playwright browser...');
  const browser = await webkit.launch({
    headless: true
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  let clientId = null;

  // Listen to all requests
  page.on('request', request => {
    const url = request.url();
    
    // Check if URL contains client_id parameter
    if (url.includes('client_id=')) {
      try {
        const urlObj = new URL(url);
        const extractedClientId = urlObj.searchParams.get('client_id');
        
        if (extractedClientId && !clientId) {
          clientId = extractedClientId;
          console.log('Found client_id:', clientId);
        }
      } catch (error) {
        // Invalid URL, skip
      }
    }
  });

  console.log('Navigating to SoundCloud...');
  await page.goto('https://soundcloud.com/', {
    waitUntil: 'networkidle'
  });

  // Wait a bit to ensure all requests are captured
  await page.waitForTimeout(3000);

  await browser.close();

  return clientId;
}

(async () => {
  // Check if client_id file exists
  if (fs.existsSync(CLIENT_ID_FILE)) {
    const existingClientId = fs.readFileSync(CLIENT_ID_FILE, 'utf8').trim();
    console.log('Found existing client_id:', existingClientId);
    console.log('Testing if client_id is still valid...');
    
    const isValid = await testClientId(existingClientId);
    
    if (isValid) {
      console.log('✓ Existing client_id is valid, skipping browser launch');
      console.log('Value:', existingClientId);
      return;
    } else {
      console.log('✗ Existing client_id is invalid, fetching new one...');
    }
  } else {
    console.log('No existing client_id found, fetching new one...');
  }

  // Fetch new client_id
  const clientId = await fetchNewClientId();

  if (clientId) {
    fs.writeFileSync(CLIENT_ID_FILE, clientId, 'utf8');
    console.log('client_id saved to:', CLIENT_ID_FILE);
    console.log('Value:', clientId);
  } else {
    console.error('No client_id found in requests');
    process.exit(1);
  }
})();
