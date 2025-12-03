const fs = require('fs');
const path = require('path');

const artifactDir = path.join(__dirname, '../artifact-preview');
const outputDir = path.join(artifactDir, 'out-playlists');
const correctionsPath = path.join(__dirname, 'corrections.json');

// Load corrections dictionary
let corrections = {};
if (fs.existsSync(correctionsPath)) {
  corrections = JSON.parse(fs.readFileSync(correctionsPath, 'utf8'));
}

// Month names for file naming
const monthNames = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

/**
 * Generates a formatted header for a playlist file
 * @param {string} monthName - Month name (e.g., "January")
 * @param {number} year - Year (e.g., 2025)
 * @param {string} permalink_url - SoundCloud track URL
 * @returns {string} Formatted header with title, date, and URL
 */
function header(monthName, year, permalink_url){
  return `Euphonic Sessions with Kyau & Albert
${monthName} ${year} Edition
${permalink_url}`;
}

/**
 * Generates a formatted header for "Best Of" playlist files
 * @param {number} year - Year of the Best Of episode (e.g., 2018 for "Best Of 2018")
 * @param {string} permalink_url - SoundCloud track URL
 * @returns {string} Formatted header for Best Of edition
 */
function headerBestOf(year, permalink_url){
  return `Euphonic Sessions with Kyau & Albert
Best Of ${year}
${permalink_url}`;
}

/**
 * Formats a playlist description with proper track numbering and quotes
 * Also moves [TRACK OF THE MONTH] and [CLASSIC OF THE MONTH] tags to separate lines
 * @param {string} description - Raw playlist description from SoundCloud
 * @returns {string} Formatted playlist with proper styling
 */
function pretty_playlist(description){
  if (!description) return '';
  
  let result = description;
  
    // Trim extra space after 'DAT' in parentheses
    result = result.replace(/\(Straight From DAT \)/g, '(Straight From DAT)');

  // Remove "Tracklist:" prefix if present
  result = result.replace(/^Tracklist:\s*/i, '');

  // Normalize whitespace around dashes (e.g., "  -  " -> " - ")
  result = result.replace(/\s+-\s+/g, ' - ');
  
  // Fix common misspellings in month tags (MOTNH -> MONTH)
  result = result.replace(/\[(TRACK|CLASSIC|RECORD)\s+OF\s+THE\s+MOTNH\]/gi, '[$1 OF THE MONTH]');
  
  // Normalize "OF THE MONTH" tag spacing and ensure proper case
  result = result.replace(
    /\[(TRACK|CLASSIC|RECORD)\s+OF\s+THE\s+MONTH\]/gi,
    (match, type) => `[${type.toUpperCase()} OF THE MONTH]`
  );
  
  
  // Improved regex: If artist or title contains ' - ', merge artist/title accordingly
  result = result.replace(
    /^(\d+)\s+(.*?)(\s?-\s?)(.*?)(\s+\((.*?)\))?(\s+\[)/gm,
    (match, num, artist, sep, title, parenPart, parenContent) => {
      // Normalize spaces and fix "ft" to "ft."
      let cleanArtist = artist.replace(/\s+/g, ' ').replace(/\bft\.?\b/gi, 'ft.');
      let cleanTitle = title.trim();
      // If artist ends with '-' and title starts with '-', merge
      if (/^-/.test(cleanTitle) && /-$/.test(cleanArtist)) {
        cleanArtist = cleanArtist.replace(/-$/, '').trim() + '-' + cleanTitle.replace(/^-/, '').trim();
        cleanTitle = '';
      } else if (/^-/.test(cleanTitle)) {
        cleanArtist = cleanArtist + cleanTitle.replace(/^-/, '').trim();
        cleanTitle = '';
      }
      // Check if parentheses contain remix/mix keywords, 'Straight From DAT', or 'New V'
      const remixKeywords = /\b(remix|mix|rework|edit|version|dub|remaster|update|bootleg|mashup|VIP|RMX|Respray|Reprint)\b|Straight From DAT|New V/i;
      if (parenPart && remixKeywords.test(parenContent)) {
        // It's a remix - keep parentheses outside quotes
        return `${num}. ${cleanArtist} - "${cleanTitle}" ${parenPart.trim()} [`;
      } else if (parenPart) {
        // Not a remix - include in title with space
        return `${num}. ${cleanArtist} - "${cleanTitle} ${parenPart.trim()}" [`;
      } else {
        // No parentheses
        return `${num}. ${cleanArtist} - "${cleanTitle}" [`;
      }
    }
  );
  
  // Second regex: Format track numbers for lines WITHOUT parentheses or brackets
  // This catches older format lines that end after the track title
  // Pattern: ^(\d+)\s+(.*?)(\s?-\s?)(.*)$
  result = result.replace(
    /^(\d+)\s+(.*?)(\s?-\s?)(.*)$/gm,
    (match, num, artist, sep, title) => {
      // Only apply if not already formatted (no period after number and no quotes)
      if (!match.includes('"') && !match.match(/^\d+\./)) {
        // Normalize spaces and fix "ft" to "ft."
        const cleanArtist = artist.replace(/\s+/g, ' ').replace(/\bft\.?\b/gi, 'ft.');
        return `${num}. ${cleanArtist} - "${title.trim()}"`;
      }
      return match;
    }
  );
  
  // Move month tags to separate line before the track, and trim each line
  // Find any line ending with [TRACK/CLASSIC/RECORD OF THE MONTH], extract the tag, and reformat
  result = result.split('\n').map(line => {
    const trimmedLine = line.trim();
    const tagMatch = trimmedLine.match(/^(.+?)\s*(\[(TRACK|CLASSIC|RECORD) OF THE MONTH\])\s*$/i);
    if (tagMatch) {
      const trackLine = tagMatch[1].trim();
      const tag = tagMatch[2].toUpperCase();
      return `\n${tag}\n${trackLine}\n`;
    }
    return trimmedLine;
  }).join('\n');
  
  // Apply corrections from corrections.json
  for (const [wrong, correct] of Object.entries(corrections)) {
    result = result.replace(new RegExp(wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), correct);
  }
  
  // Clean up any double blank lines
  result = result.replace(/\n\n\n+/g, '\n\n');

  return result.trim();
}

/**
 * Processes all SoundCloud track JSON files and creates formatted playlist text files
 * organized by year and month. Reads from artifact-preview directory and outputs
 * to artifact-preview/out-playlists/YYYY/YYYY-MM-MonthName.txt
 */
function processPlaylists() {
  // Create output directory if it doesn't exist
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Read all JSON files from artifact-preview/soundcloud-json
  const jsonDir = path.join(artifactDir, 'soundcloud-json');
  const files = fs.existsSync(jsonDir)
    ? fs.readdirSync(jsonDir).filter(file => file.endsWith('.json') && file !== '_summary.json')
    : [];

  console.log(`Processing ${files.length} files from soundcloud-json...\n`);

  files.forEach(file => {
    const filePath = path.join(jsonDir, file);
    const track = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    
    // Check if this is a "Best Of" episode
    const titleLower = track.title.toLowerCase();
    const isBestOf = titleLower.includes('best of');
    
    let year, month, monthName;
    
    if (isBestOf) {
      // For Best Of episodes, extract year from title and place in following year's January
      // (Best Of 2018 was the January 2019 episode)
      const yearMatch = track.title.match(/(\d{4})/);
      const bestOfYear = yearMatch ? parseInt(yearMatch[1]) : new Date(track.created_at).getFullYear();
      year = bestOfYear + 1;  // Place in following year
      month = '01';
      monthName = 'January';
    } else {
      // Add 2 days to created_at as initial guess
      const createdDate = new Date(track.created_at);
      createdDate.setDate(createdDate.getDate() + 2);
      
      // Try to extract month from title
      const titleMatch = track.title.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
      
      if (titleMatch) {
        const titleMonthName = titleMatch[1].charAt(0).toUpperCase() + titleMatch[1].slice(1).toLowerCase();
        const titleYear = parseInt(titleMatch[2]);
        const titleMonth = monthNames.indexOf(titleMonthName) + 1;
        const createdMonth = createdDate.getMonth() + 1;
        
        // If title month differs from created_at month, use title
        if (titleMonth !== createdMonth) {
          monthName = titleMonthName;
          year = titleYear;
          month = String(titleMonth).padStart(2, '0');
        } else {
          // Same month, use created_at
          year = createdDate.getFullYear();
          month = String(createdMonth).padStart(2, '0');
          monthName = monthNames[createdDate.getMonth()];
        }
      } else {
        // No title match, use created_at with offset
        year = createdDate.getFullYear();
        month = String(createdDate.getMonth() + 1).padStart(2, '0');
        monthName = monthNames[createdDate.getMonth()];
      }
    }
    
    // Create year folder
    const yearDir = path.join(outputDir, String(year));
    if (!fs.existsSync(yearDir)) {
      fs.mkdirSync(yearDir, { recursive: true });
    }
    
    // Create txt file with month name
    const txtFileName = isBestOf 
      ? `${year}-01-January (Best of ${year - 1}).txt`
      : `${year}-${month}-${monthName}.txt`;
    const txtFilePath = path.join(yearDir, txtFileName);
    
    // Write header and formatted description to file
    const prettyDescription = pretty_playlist(track.description || '');
    const headerContent = isBestOf 
      ? headerBestOf(year - 1, track.permalink_url)  // Pass the Best Of year (previous year)
      : header(monthName, year, track.permalink_url);
    const content = headerContent + '\n\n' + prettyDescription;
    
    fs.writeFileSync(txtFilePath, content);
    
    console.log(`✓ ${year}/${txtFileName} - ${track.title}`);
  });

  console.log(`\n✅ Done! Files created in: ${outputDir}`);
}

// Run the processing
processPlaylists();