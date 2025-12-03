const { webkit } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
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

  if (clientId) {
    const outputPath = path.join(__dirname, 'client_id.txt');
    fs.writeFileSync(outputPath, clientId, 'utf8');
    console.log('client_id saved to:', outputPath);
    console.log('Value:', clientId);
  } else {
    console.error('No client_id found in requests');
    process.exit(1);
  }
})();
