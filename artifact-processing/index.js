const fs = require('fs');
const path = require('path');

const artifactDir = path.join(__dirname, '../artifact-preview');
const outputDir = path.join(artifactDir, 'out-playlists');

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
  
  // Remove "Tracklist:" prefix if present
  let result = description.replace(/^Tracklist:\s*/i, '');
  
  // First regex: Format track numbers and add quotes around track titles
  // Handles lines with parentheses or brackets (remix/label info)
  // Pattern: ^(\d+)\s(.*)(\s-\s)(.*?)(?= \(| \[)
  // Replace: $1. $2$3"$4"
  result = result.replace(
    /^(\d+)\s(.*)(\s-\s)(.*?)(?= \(| \[)/gm,
    (match, num, artist, sep, title) => {
      return `${num}. ${artist}${sep}"${title.trim()}"`;
    }
  );
  
  // Second regex: Format track numbers for lines WITHOUT parentheses or brackets
  // This catches older format lines that end after the track title
  // Pattern: ^(\d+)\s(.*)(\s-\s)(.*)$
  // Replace: $1. $2$3"$4"
  result = result.replace(
    /^(\d+)\s(.*)(\s-\s)(.*)$/gm,
    (match, num, artist, sep, title) => {
      // Only apply if not already formatted (no period after number and no quotes)
      if (!match.includes('"') && !match.match(/^\d+\./)) {
        return `${num}. ${artist}${sep}"${title.trim()}"`;
      }
      return match;
    }
  );
  
  // Third regex: Move [TRACK OF THE MONTH] and [CLASSIC OF THE MONTH] tags
  // Pattern: (.*\n)(.*)(\s+)(\[(TRACK|CLASSIC) OF THE MONTH\])
  // Replace: $1\n$4\n$2\n
  result = result.replace(
    /(.*\n)(.*)(\s+)(\[(TRACK|CLASSIC) OF THE MONTH\])/g,
    '$1\n$4\n$2\n'
  );
  
  return result;
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

  // Read all JSON files from artifact-preview
  const files = fs.readdirSync(artifactDir)
    .filter(file => file.endsWith('.json') && file !== '_summary.json');

  console.log(`Processing ${files.length} files...\n`);

  files.forEach(file => {
    const filePath = path.join(artifactDir, file);
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