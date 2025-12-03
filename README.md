# github-actions-soundcloud-download

Automated SoundCloud song metadata downloader using GitHub Actions. Extracts the SoundCloud API token and downloads song descriptions for a specified user's tracks.

## Overview

This project uses GitHub Actions to:
1. Extract the SoundCloud `client_id` token by monitoring network requests
2. Fetch all tracks from a specified SoundCloud user
3. Download metadata (title, description, etc.) for each track
4. Process and format playlist descriptions into organized text files
5. Upload formatted playlists as a workflow artifact

Perfect for backing up your SoundCloud playlists, creating readable tracklists, or archiving DJ mixes and radio shows.

## Project Structure

```
.
├── .github/workflows/
│   └── main.yml                    # GitHub Actions workflow
├── soundcloud-token-getter/
│   ├── index.js                    # Playwright script to extract client_id
│   ├── package.json                # Node.js dependencies
│   └── client_id.txt               # Output file (generated)
├── soundcloud-downloader/
│   ├── download.js                 # Script to fetch track metadata
│   ├── package.json                # Node.js dependencies
│   └── tracks/                     # Downloaded track data (generated)
├── artifact-processing/
│   ├── index.js                    # Script to format playlists
│   ├── package.json                # Node.js dependencies
│   └── (processed files)           # Generated in workflow
├── artifact-preview/
│   ├── .gitkeep                    # Preserves directory in git
│   ├── (track files)               # Local preview of downloaded tracks
│   └── out-playlists/              # Formatted playlists (generated)
├── runner/
│   └── package.json                # Test and cleanup scripts
├── setup-act/
│   └── setup-act.sh                # Script to install 'act' for local testing
└── README.md                       # This file
```

## Setup

### Prerequisites

- Node.js 20 or higher
- npm

### Installation

1. Clone the repository:
```bash
git clone https://github.com/chepe263/github-actions-soundcloud-download.git
cd github-actions-soundcloud-download
```

2. Install dependencies:
```bash
# Install token getter dependencies
cd soundcloud-token-getter
npm install

# Install downloader dependencies
cd ../soundcloud-downloader
npm install

# Install processing dependencies
cd ../artifact-processing
npm install
```

3. Install Playwright browser (from soundcloud-token-getter directory):
```bash
cd soundcloud-token-getter
npx playwright install webkit --with-deps
```

## Usage

### Run Locally

Extract the SoundCloud client_id:

```bash
cd soundcloud-token-getter
npm run get-token
```

Download track metadata for a SoundCloud user:

```bash
cd ../soundcloud-downloader  # if coming from soundcloud-token-getter
SOUNDCLOUD_USER=username npm run download
# or
node download.js username
```

The track data will be saved to `soundcloud-downloader/tracks/`.

Process playlists into formatted text files:

```bash
cd ../artifact-processing
npm start
```

The formatted playlists will be saved to `artifact-preview/out-playlists/` organized by year and month.

### GitHub Actions

The workflow automatically runs on:
- Push to `master` or `main` branch
- Pull requests to `master` or `main` branch
- Manual trigger via workflow_dispatch

The workflow will:
1. Set up Node.js environment
2. Extract the SoundCloud `client_id` token
3. Download track metadata for the specified SoundCloud user
4. Process playlists into formatted text files organized by year/month
5. Upload formatted playlists as a workflow artifact

You can download the artifact from the Actions tab in your GitHub repository after the workflow completes.

#### Configure SoundCloud User

To specify which SoundCloud user's tracks to download:

**Option 1: Manual workflow trigger with input**
1. Go to Actions tab in GitHub
2. Select "Download SoundCloud Tracks" workflow
3. Click "Run workflow"
4. Enter the SoundCloud username
5. Click "Run workflow"

**Option 2: Set repository variable**
1. Go to Settings → Secrets and variables → Actions → Variables
2. Create a new variable named `SOUNDCLOUD_USER`
3. Set the value to the SoundCloud username
4. The workflow will use this automatically

**Option 3: Hardcode in workflow file**
Edit `.github/workflows/main.yml` and change the default value to the desired username (currently set to `euphonicsessions`).

#### Download the Artifact

After the workflow completes:
1. Go to the Actions tab in your repository
2. Click on the completed workflow run
3. Scroll down to the "Artifacts" section
4. Download the `soundcloud-playlists-*` artifact (ZIP file)
5. Extract the ZIP to access formatted playlist text files organized by year and month

The playlists are formatted with:
- Track numbers followed by artist and title
- Remix/label information in parentheses
- Special tags like [TRACK OF THE MONTH] preserved
- Monthly episodes: `YYYY-MM-MonthName.txt`
- Best Of episodes: `YYYY-13-December (Best of YYYY).txt`

### Test Workflow Locally with act

To test the GitHub Actions workflow locally before pushing:

1. Install and run via the runner scripts:
```bash
cd runner
npm run cleanup      # Clean previous test files
npm test            # Run workflow locally with act (--bind mode)
```

2. Or manually install `act`:
```bash
./setup-act/setup-act.sh
```

3. Run the workflow with bind mount:
```bash
act workflow_dispatch --bind --container-architecture linux/amd64
```

The `--bind` flag ensures files created in the Docker container persist to your local filesystem in `artifact-preview/` and `soundcloud-downloader/tracks/`.

**Note:** The artifact upload step will fail in local testing (expected behavior), but all track files will still be downloaded and available locally.

## Runner Scripts

The `runner/` directory contains helpful npm scripts for local development and testing:

```bash
cd runner

# Run full workflow locally (with Docker/act)
npm test

# Run workflow steps directly (without Docker)
npm run test:local

# Clean generated files (keeps .gitkeep)
npm run cleanup

# Clean everything including node_modules
npm run cleanup:all
```

### Available Scripts

- **`npm test`** - Runs the GitHub Actions workflow locally using act with bind mount
- **`npm run test:push`** - Tests the workflow with push trigger
- **`npm run test:local`** - Executes workflow steps directly on host (no Docker)
- **`npm run cleanup`** - Removes client_id.txt, tracks/, and artifact-preview/* files
- **`npm run cleanup:all`** - Full cleanup including all node_modules directories

## How It Works

1. **Token Extraction**: The script launches a headless WebKit browser using Playwright, navigates to https://soundcloud.com/, monitors network requests, and extracts the `client_id` parameter from API calls
2. **User Resolution**: Uses the SoundCloud API with the extracted token to resolve the username to a user ID
3. **Track Fetching**: Fetches all tracks for the specified user via the SoundCloud API v2
4. **Metadata Download**: For each track, downloads the title, description, artwork URL, duration, play count, and other metadata
5. **File Creation**: Saves each track as an individual JSON file plus a `_summary.json` index file
6. **Playlist Processing**: Parses track descriptions, formats tracklists, and organizes into year/month text files
7. **Artifact Upload**: In GitHub Actions, packages formatted playlists as a downloadable artifact

### Performance Optimizations

- **Apt Package Caching**: System dependencies are cached to speed up Playwright browser installation
- **Bind Mounting**: When testing locally with act, `--bind` mode ensures files persist to the host filesystem
- **Artifact Preview**: Files are copied to `artifact-preview/` directory for local inspection before upload

## Scripts

### soundcloud-token-getter/package.json

- `npm start` - Run the token extraction script
- `npm run get-token` - Alias for npm start

### soundcloud-downloader/package.json

- `npm run download` - Download track metadata (requires SOUNDCLOUD_USER env variable)

### artifact-processing/package.json

- `npm start` - Process playlists from JSON files into formatted text files
- `npm run cleanup` - Remove generated out-playlists/ directory

### runner/package.json

- `npm test` - Run workflow locally with act (bind mount mode)
- `npm run test:push` - Test workflow with push trigger
- `npm run test:local` - Run workflow steps directly without Docker
- `npm run cleanup` - Remove generated files
- `npm run cleanup:all` - Full cleanup including node_modules

## Output Format

### JSON Metadata Files

Each track is saved as a JSON file containing:
- `id` - SoundCloud track ID
- `title` - Track title
- `description` - Track description text
- `permalink_url` - Full SoundCloud URL
- `duration` - Duration in milliseconds
- `playback_count` - Number of plays
- `likes_count` - Number of likes
- `comment_count` - Number of comments
- `created_at` - Upload date
- `genre` - Genre tag
- `tag_list` - Space-separated tags
- `artwork_url` - Cover art URL

A `_summary.json` file is also created with an index of all downloaded tracks.

### Formatted Playlist Files

Playlists are organized by year and month in `out-playlists/`:

```
out-playlists/
├── 2015/
│   ├── 2015-01-January.txt
│   ├── 2015-02-February.txt
│   └── 2015-13-December (Best of 2015).txt
├── 2016/
│   └── ...
└── ...
```

Each playlist file contains:
- Header with episode title and SoundCloud URL
- Formatted tracklist with proper numbering
- Artist names and track titles
- Remix/label information in parentheses
- Special tags preserved (e.g., [TRACK OF THE MONTH])

**Best Of Episodes:**
- Use month number `13` to sort after December
- Filename format: `YYYY-13-December (Best of YYYY).txt`
- Separate header format for "Best Of" compilations

## License

ISC