const fs = require('fs');
const path = require('path');

const correctionsPath = path.join(__dirname, '../artifact-processing/corrections.json');

// Load corrections dictionary
let corrections = {};
if (fs.existsSync(correctionsPath)) {
  corrections = JSON.parse(fs.readFileSync(correctionsPath, 'utf8'));
}

/**
 * Formats a playlist description with proper track numbering and quotes
 * Same logic as artifact-processing/index.js pretty_playlist function
 * @param {string} description - Raw playlist description
 * @param {boolean} strictSpacing - If true, requires proper spacing (original behavior)
 * @returns {string} Formatted playlist with proper styling
 */
function pretty_playlist(description, strictSpacing = false){
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
  // Use strictSpacing to choose between \s+ (strict) or \s* (lenient)
  const spacingPattern = strictSpacing ? '\\s+' : '\\s*';
  const regexPattern = new RegExp(
    `^(\\d+)\\s+(.*?)(\\s?-\\s?)(.*?)(${spacingPattern}\\((.*?)\\))?(${spacingPattern}\\[)`,
    'gm'
  );
  
  result = result.replace(
    regexPattern,
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
        // It's a remix - keep parentheses outside quotes and ensure space before bracket
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
 * Parses a text file containing a SoundCloud playlist by detecting patterns
 * Patterns detected:
 * - Lines starting with "http": URL
 * - Lines starting with "Euphonic Sessions": Title (extracts month/year as subtitle)
 * - Lines starting with numbers (01, 02, etc): Playlist items
 * 
 * @param {string} inputFile - Path to input text file
 * @param {string} outputFile - Path to output text file (optional)
 */
function parsePlaylist(inputFile, outputFile = null) {
  if (!fs.existsSync(inputFile)) {
    console.error(`Error: File not found: ${inputFile}`);
    process.exit(1);
  }

  const content = fs.readFileSync(inputFile, 'utf8');
  const lines = content.split('\n').map(line => line.trim());

  let url = '';
  let title = '';
  let subtitle = '';
  const playlistLines = [];

  // Detect patterns
  for (const line of lines) {
    if (!line) continue; // Skip empty lines
    
    // Pattern: URL (starts with http)
    if (line.startsWith('http')) {
      url = line;
    }
    // Pattern: Title (starts with "Euphonic Sessions")
    else if (line.startsWith('Euphonic Sessions')) {
      title = 'Euphonic Sessions with Kyau & Albert';
      
      // Extract month and year from the line
      const monthMatch = line.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
      if (monthMatch) {
        const month = monthMatch[1];
        const year = monthMatch[2];
        subtitle = `${month} ${year} Edition`;
      }
    }
    // Pattern: Playlist items (starts with numbers like 01, 02, 1, 2, etc)
    else if (/^\d+/.test(line)) {
      playlistLines.push(line);
    }
  }

  // Validate we have required data
  if (!url || !title || playlistLines.length === 0) {
    console.error('Error: Could not find required data (URL, title, or playlist items)');
    console.error(`Found - URL: ${!!url}, Title: ${!!title}, Playlist items: ${playlistLines.length}`);
    process.exit(1);
  }

  // Format the playlist with both strict and lenient modes
  const playlistText = playlistLines.join('\n');
  const strictOutput = pretty_playlist(playlistText, true);  // Original strict mode
  const lenientOutput = pretty_playlist(playlistText, false); // Lenient mode
  
  // Compare outputs and generate notes
  let notes = '';
  if (strictOutput !== lenientOutput) {
    notes += '\n\n---\nPARSING NOTES:\n';
    notes += 'The lenient parser fixed spacing issues that the strict parser would reject.\n';
    notes += 'This may indicate data quality issues in the input.\n\n';
    
    // Find specific differences
    const strictLines = strictOutput.split('\n');
    const lenientLines = lenientOutput.split('\n');
    let diffCount = 0;
    
    for (let i = 0; i < Math.max(strictLines.length, lenientLines.length); i++) {
      if (strictLines[i] !== lenientLines[i]) {
        diffCount++;
        if (diffCount <= 5) { // Show max 5 examples
          const lineNum = playlistLines.findIndex(line => 
            lenientLines[i] && line.includes(lenientLines[i].replace(/^\d+\.\s+/, '').replace(/"/g, '').substring(0, 20))
          );
          notes += `Line ${lineNum >= 0 ? lineNum + 1 : '?'}: Fixed spacing issue\n`;
          if (strictLines[i]) notes += `  Strict:  ${strictLines[i]}\n`;
          notes += `  Lenient: ${lenientLines[i]}\n\n`;
        }
      }
    }
    
    if (diffCount > 5) {
      notes += `... and ${diffCount - 5} more differences\n`;
    }
  }
  
  // Use lenient output by default
  const formattedPlaylist = lenientOutput;
  
  // Build output
  const header = subtitle ? `${title}\n${subtitle}\n${url}` : `${title}\n${url}`;
  const output = `${header}\n\n${formattedPlaylist}${notes}`;
  
  // Write to file or print to console
  if (outputFile) {
    fs.writeFileSync(outputFile, output);
    console.log(`✅ Playlist formatted and saved to: ${outputFile}`);
    if (notes) {
      console.log('⚠️  Spacing issues detected - see notes at end of output file');
    }
  } else {
    console.log(output);
  }
}

// Main execution
if (require.main === module) {
  const args = process.argv.slice(2);
  
  let inputFile;
  let outputFile = null;
  
  if (args.length === 0) {
    // No arguments: use entrada.txt as default input
    inputFile = path.resolve(__dirname, 'entrada.txt');
  } else {
    inputFile = path.resolve(args[0]);
    outputFile = args[1] ? path.resolve(args[1]) : null;
  }
  
  parsePlaylist(inputFile, outputFile);
}

module.exports = { parsePlaylist, pretty_playlist };
