# Pending Changes for Final Commit

## Changes Made:

### 1. Trim trailing spaces from track titles
- Added .trim() to first regex for titles with parentheses/brackets
- Removes trailing whitespace from track titles in final output
- Fixes issue like 'LFOcean ' -> 'LFOcean'

### 2. Fix regex to handle tags without space before them
- Changed \s+ to \s* to match zero or more spaces
- Handles cases like [Anjunabeats][TRACK OF THE MONTH]
- Tags are now properly moved to separate lines

### 3. Normalize spaces and standardize ft to ft. in artist names
- Replace multiple spaces with single space
- Convert 'ft' to 'ft.' (featuring abbreviation)
- Applies to both regex patterns
- Fixes issues like 'Above & Beyond  ft' -> 'Above & Beyond ft.'

### 4. Fix inline tags and handle missing spaces before dash
- Move inline [TRACK/CLASSIC OF THE MONTH] tags to separate line before track
- Handle missing spaces around dash (e.g., '14 Artist- Title')
- Normalize all dash spacing to ' - '
- Also handle 'ft.' with or without period in source

### 5. Intelligently handle parentheses in track titles
- Detect remix keywords (remix, mix, rework, edit, version, dub, etc.)
- Keep remix info outside quotes: "Title" (Remix Mix)
- Include non-remix parentheses in title: "Title (Part II)"
- Add [RECORD OF THE MONTH] variant to tag detection
- Maintain proper spacing around parenthetical content

### 6. Add manual corrections system
- Created corrections.json for fixing source data errors
- Corrections applied before formatting (key: wrong text, value: correct text)
- Example: "lArmes" → "L'Armes" 
- Allows fixing typos and formatting issues in source data

### 7. Normalize tag spacing to fix misdetection
- Added regex to normalize "OF THE MONTH" tag spacing first
- Handles multiple spaces in tags (e.g., [TRACK OF  THE MONTH])
- Standardizes all tag variations: TRACK/CLASSIC/RECORD OF THE MONTH
- Ensures tags are properly detected and moved to separate lines

---

## Final Commit Message Template:

```
Improve playlist formatting with multiple fixes

- Trim trailing spaces from track titles
- Handle tags without spaces (e.g., ][TRACK OF THE MONTH])
- Normalize multiple spaces to single space in artist names
- Standardize 'ft' to 'ft.' for featuring abbreviation
- Move inline month tags to separate line before track
- Handle missing spaces around dash in track numbers
- Normalize all dash spacing to ' - '
- Handle 'ft.' with or without period in source data
```
