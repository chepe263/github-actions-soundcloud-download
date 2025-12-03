# github-actions-soundcloud-download

Automated SoundCloud song metadata downloader using GitHub Actions. Extracts the SoundCloud API token and downloads song descriptions for a specified user's tracks.

## Overview

This project uses GitHub Actions to:
1. Extract the SoundCloud `client_id` token by monitoring network requests
2. Fetch all tracks from a specified SoundCloud user
3. Download metadata (title, description, etc.) for each track
4. Save the data as a workflow artifact for easy download

Perfect for backing up your SoundCloud descriptions, analyzing track metadata, or archiving content.

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

### GitHub Actions

The workflow automatically runs on:
- Push to `master` or `main` branch
- Pull requests to `master` or `main` branch
- Manual trigger via workflow_dispatch

The workflow will:
1. Set up Node.js environment
2. Extract the SoundCloud `client_id` token
3. Download track metadata for the specified SoundCloud user
4. Upload the data as a workflow artifact

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
Edit `.github/workflows/main.yml` and replace `YOUR_USERNAME_HERE` with the desired username.

#### Download the Artifact

After the workflow completes:
1. Go to the Actions tab in your repository
2. Click on the completed workflow run
3. Scroll down to the "Artifacts" section
4. Download the `soundcloud-tracks-*` artifact (ZIP file)
5. Extract the ZIP to access all track JSON files

### Test Workflow Locally with act

To test the GitHub Actions workflow locally before pushing:

1. Install `act`:
```bash
./setup-act/setup-act.sh
```

2. Run the workflow:
```bash
act
```

3. List available workflows:
```bash
act -l
```

4. Run specific job:
```bash
act -j download
```

## How It Works

1. **Token Extraction**: The script launches a headless WebKit browser using Playwright, navigates to https://soundcloud.com/, monitors network requests, and extracts the `client_id` parameter
2. **User Track Fetching**: Uses the SoundCloud API with the extracted token to fetch all tracks for a specified user
3. **Metadata Download**: For each track, downloads the title, description, artwork URL, duration, play count, and other metadata
4. **Artifact Creation**: Saves all track data as JSON files and packages them as a GitHub Actions artifact for download

## Scripts

### soundcloud-token-getter/package.json

- `npm start` - Run the token extraction script
- `npm run get-token` - Alias for npm start

### soundcloud-downloader/package.json

- `npm run download` - Download track metadata (requires SOUNDCLOUD_USER env variable)

## Output Format

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

## License

ISC