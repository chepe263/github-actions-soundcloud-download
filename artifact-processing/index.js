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
 * @param {string} created_at - ISO 8601 date string
 * @param {string} permalink_url - SoundCloud track URL
 * @returns {string} Formatted header with title, date, and URL
 */
function header(created_at, permalink_url){
  const date = new Date(created_at);
  const monthName = monthNames[date.getMonth()];
  const year = date.getFullYear();
  
  return `Euphonic Sessions with Kyau & Albert
${monthName} ${year} Edition
${permalink_url}`;
}

/**
 * Generates a formatted header for "Best Of" playlist files
 * @param {string} created_at - ISO 8601 date string
 * @param {string} permalink_url - SoundCloud track URL
 * @returns {string} Formatted header for Best Of edition
 */
function headerBestOf(created_at, permalink_url){
  const date = new Date(created_at);
  const year = date.getFullYear();
  
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
    '$1. $2$3"$4"'
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
    
    // Parse the created_at date
    const createdDate = new Date(track.created_at);
    const year = createdDate.getFullYear();
    // Use month 13 for Best Of episodes, otherwise use actual month
    const month = isBestOf ? '13' : String(createdDate.getMonth() + 1).padStart(2, '0');
    const monthName = monthNames[createdDate.getMonth()];
    
    // Create year folder
    const yearDir = path.join(outputDir, String(year));
    if (!fs.existsSync(yearDir)) {
      fs.mkdirSync(yearDir, { recursive: true });
    }
    
    // Create txt file with month name (add "-BestOf" suffix if it's a Best Of episode)
    const txtFileName = isBestOf 
      ? `${year}-13-December (Best of ${year}).txt`
      : `${year}-${month}-${monthName}.txt`;
    const txtFilePath = path.join(yearDir, txtFileName);
    
    // Write header and formatted description to file
    const prettyDescription = pretty_playlist(track.description || '');
    const headerContent = isBestOf 
      ? headerBestOf(track.created_at, track.permalink_url)
      : header(track.created_at, track.permalink_url);
    const content = headerContent + '\n\n' + prettyDescription;
    
    fs.writeFileSync(txtFilePath, content);
    
    console.log(`✓ ${year}/${txtFileName} - ${track.title}`);
  });

  console.log(`\n✅ Done! Files created in: ${outputDir}`);
}

// Run the processing
processPlaylists();