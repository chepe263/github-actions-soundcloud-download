# Copilot Context

## Workspace Overview
- Repository: github-actions-soundcloud-download
- Owner: chepe263
- Branch: master
- Main folders: artifact-processing, runner, soundcloud-downloader, artifact-preview

## Recent Changes
- JSON files now live in `artifact-preview/soundcloud-json`.
- `artifact-processing/index.js` reads from `artifact-preview/soundcloud-json`.
- Scripts and workflow updated to use/copy/cleanup the new JSON location.
- Formatting logic improved for:
  - Remix detection ("Straight From DAT", "New V")
  - Parentheses spacing (trims extra space after "DAT")
  - Artist/title splitting (handles cases like `G-Prod - "Moonlight"`)

## Output
- Playlists are generated in `artifact-preview/out-playlists/YYYY/YYYY-MM-MonthName.txt`.
- Zip script packages all playlists into `artifact-preview/playlists.zip`.
- `.gitignore` excludes the zip file.

## Automation
- GitHub Actions workflow processes tracks, copies JSONs, and uploads formatted playlists.
- Local scripts for testing, cleanup, and packaging are in `runner/package.json`.

## User Preferences
- Tags (e.g., [TRACK OF THE MONTH]) appear on their own line before the marked track, with blank lines for readability.
- Manual corrections and typo fixes are handled via regex and `corrections.json`.

---
This file summarizes the current technical and operational context for the workspace as of December 3, 2025.
