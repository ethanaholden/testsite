# Discover Rasnov -- Site Handoff Guide

This document is a complete reference for maintaining and updating the Discover Rasnov tourist website. It covers every file you may need to change, how the site stays online, and how to make common updates without deep coding knowledge.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Getting the Site Running](#2-getting-the-site-running)
3. [File Reference](#3-file-reference)
4. [Configuration Files](#4-configuration-files)
5. [Managing the Scavenger Hunt](#5-managing-the-scavenger-hunt)
6. [Places Data and Photos](#6-places-data-and-photos)
7. [Translations and Language Files](#7-translations-and-language-files)
8. [Storage Modes -- Cloudinary vs Local](#8-storage-modes----cloudinary-vs-local)
9. [Automated Data Updates -- GitHub Actions](#9-automated-data-updates----github-actions)
10. [API Keys and External Services](#10-api-keys-and-external-services)
11. [Deployment and Hosting](#11-deployment-and-hosting)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Overview

Discover Rasnov is a tourist website for Rasnov, Romania. It has three main parts:

- **Homepage** (`index.html`) -- Displays tourist attractions, restaurants, and accommodations in a tabbed card layout. Data is loaded from a JSON file that is generated from the Google Places API.
- **Treasure Hunt** (`hunt.html`) -- A scavenger hunt where visitors scan QR codes at physical locations around town, answer quiz questions, and earn points. A leaderboard tracks top players.
- **Interactive Map** (embedded on the homepage) -- A Leaflet/OpenStreetMap map showing all places and scavenger hunt locations.

The site runs on a Node.js/Express server. Place data is fetched from Google Places API at build time (not on every page load), which keeps costs at zero within Google's free tier.

---

## 2. Getting the Site Running

### Prerequisites

- Node.js version 14 or higher (download from https://nodejs.org)
- A terminal or command prompt

### Steps

1. Open a terminal and navigate to the project folder:
   ```
   cd testsite
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Start the server:
   ```
   npm start
   ```

4. Open a browser and go to `http://localhost:3000`.

The site will work immediately using sample data. To load real place data from Google, see [Section 6](#6-places-data-and-photos).

### Available Commands

| Command | What it does |
|---|---|
| `npm start` | Starts the server on port 3000. |
| `npm run fetch-data` | Fetches fresh place data from Google Places API. Requires the API key (see [Section 10](#10-api-keys-and-external-services)). |
| `npm run fetch-data-with-images` | Same as above, but also downloads place photos to `assets/place-photos/`. |
| `npm run fetch-and-start` | Checks if data is older than 30 days; fetches only if needed, then starts the server. |
| `npm run force-fetch-and-start` | Always fetches fresh data regardless of age, then starts the server. |
| `npm run download-photos` | Downloads missing place photos without re-fetching all data. |
| `npm run migrate:cloudinary-to-local` | Copies data from Cloudinary cloud storage to a local folder. |
| `npm run migrate:local-to-cloudinary` | Copies data from a local folder to Cloudinary cloud storage. |

---

## 3. File Reference

Below is every file in the project and its purpose. Files you are most likely to edit are marked with **(editable)**.

```
testsite/
|
|-- index.html                  Main homepage (locations, restaurants, accommodations, map)
|-- hunt.html                   Treasure hunt page (QR scanning, progress, leaderboard)
|-- qrcodes.html                Printable QR code cards (access via /qrcodes.html, not linked from site)
|-- styles.css                  All site styling
|-- script.js                   Homepage and hunt interactivity (large file, rarely needs editing)
|-- server.js                   Express server: serves files, handles API routes, leaderboard, QR generation
|-- icon.png                    Site favicon (duplicate of images/icon.png)
|
|-- site.config.js              **(editable)** Site-wide settings: domain URL, storage mode
|-- .env.example                Template for environment variables (API keys)
|-- .env                        Your actual API keys (not committed to git)
|-- package.json                Project dependencies and npm scripts
|
|-- data/
|   |-- scavenger-data.json     **(editable)** All treasure hunt locations, quiz questions, hints
|   |-- sample-places-data.json Fallback place data (auto-updated when real data is fetched)
|   |-- places-data.json        Real place data from Google (generated, not committed to git)
|   |-- leaderboard.json        Player scores (generated at runtime, not committed to git)
|
|-- build-scripts/
|   |-- fetch-places-data.js    Fetches places from Google Places API and saves to JSON
|   |-- conditional-fetch.js    Checks data age; only re-fetches if older than 30 days
|   |-- download-photos.js      Downloads place photos that are missing locally
|
|-- js/
|   |-- data-loader.js          Loads place data and generates cards on the homepage
|   |-- i18n.js                 Language switching logic (English/Romanian)
|
|-- locales/
|   |-- en/translation.json     **(editable)** English text for all site labels and messages
|   |-- ro/translation.json     **(editable)** Romanian text for all site labels and messages
|   |-- translations.csv        Reference spreadsheet of translations
|
|-- assets/
|   |-- place-photos/           Cached place photos (downloaded once, committed to git)
|
|-- images/
|   |-- background.png          Hero section background image
|   |-- icon.png                Site icon/favicon
|   |-- .gitkeep                Keeps the folder in git
|
|-- storage.js                  Routing layer that picks Cloudinary or local storage
|-- cloudinary-storage.js       Cloudinary cloud storage implementation
|-- local-storage.js            Local filesystem storage implementation
|-- migrate-storage.js          Script to copy data between Cloudinary and local storage
|
|-- .github/
|   |-- workflows/
|       |-- update-places-data.yml  GitHub Actions workflow for weekly data refresh
|
|-- .gitignore                  Files excluded from git (API keys, generated data, node_modules)
|-- SETUP_GUIDE.md              Detailed first-time setup instructions for API keys
```

---

## 4. Configuration Files

### site.config.js

This is the main configuration file. Open it in any text editor. Each setting is explained with comments.

| Setting | What it controls | Default value |
|---|---|---|
| `SITE_DOMAIN` | The public URL where the site is hosted. QR codes will point to this address. | `'https://rasnov-site.onrender.com'` |
| `STORAGE_MODE` | Where leaderboard data and photos are stored. Set to `'cloudinary'` for cloud storage or `'local'` for the server filesystem. | `'cloudinary'` |
| `LOCAL_STORAGE_PATH` | The folder used when `STORAGE_MODE` is `'local'`. Can be a relative or absolute path. | `'./local-storage'` |

To change a setting, edit the value inside the quotes and save the file. For example, to update the site domain:

```javascript
SITE_DOMAIN: 'https://your-new-domain.com',
```

### .env (Environment Variables)

This file holds your API keys. It is never committed to git. Create it by copying the template:

```
cp .env.example .env
```

Then open `.env` in a text editor and fill in the values:

```
GOOGLE_PLACES_API_KEY=your_google_api_key_here
CLOUDINARY_URL=cloudinary://your_api_key:your_api_secret@your_cloud_name
UNSPLASH_ACCESS_KEY=your_unsplash_key_here
```

- **GOOGLE_PLACES_API_KEY** -- Required to fetch place data from Google. See [Section 10](#10-api-keys-and-external-services) for how to get one.
- **CLOUDINARY_URL** -- Required only if `STORAGE_MODE` is set to `'cloudinary'` in `site.config.js`. This is provided by Cloudinary when you create an account.
- **UNSPLASH_ACCESS_KEY** -- Optional. Provides fallback photos when Google does not have an image for a place.

### build-scripts/fetch-places-data.js (Search Settings)

Near the top of this file is a `CONFIG` object that controls what the Google data fetch looks for:

```javascript
const CONFIG = {
  CENTER_LAT: 45.5889,      // Latitude of the search center point
  CENTER_LNG: 25.4631,      // Longitude of the search center point
  SEARCH_RADIUS: 3000,      // Search radius in meters (3000 = 3 km)
  MAX_PHOTOS_PER_PLACE: 3,  // Maximum photos to save per place
  MAX_RESULTS_PER_TYPE: 20, // Maximum results per category
};
```

There is also a `PLACE_TYPES` object that defines the three categories of places:

```javascript
const PLACE_TYPES = {
  locations: 'tourist_attraction',
  restaurants: 'restaurant',
  accommodations: 'lodging',
};
```

If you need to change what types of places are fetched, edit these values. A full list of valid types is available at:
https://developers.google.com/maps/documentation/places/web-service/supported_types

There is also a `BLACKLIST` array near the top of the file. Any place name added to this list will be excluded from results.

---

## 5. Managing the Scavenger Hunt

### How the Hunt Works

Visitors open `hunt.html`, start the hunt, and visit physical locations around Rasnov. At each location, a printed QR code is placed. Scanning the QR code with the site's built-in scanner triggers a discovery, shows a quiz question, and awards points.

Visitors can also be auto-discovered when their phone's GPS shows they are within 100 meters of a hunt location.

### The Data File: data/scavenger-data.json

This file defines every treasure hunt location. It has two parts:

1. **`order`** -- An array that controls the sequence in which locations appear to the player. Each entry is a key that matches a location in the `locations` object.

2. **`locations`** -- An object where each key is a location. Each location has these fields:

| Field | Description | Example |
|---|---|---|
| `name` | Display name in English | `"Rasnov Citadel Gate"` |
| `name_ro` | Display name in Romanian | `"Poarta Cetatii Rasnov"` |
| `qr` | The text encoded into the QR code. Must be unique and in ALL CAPS with underscores. | `"RASNOV_FORTRESS_GATE"` |
| `difficulty` | `0` for easy, `2` for hard. Affects point value. | `0` |
| `lat` | Latitude of the location (for the map pin and GPS discovery). | `45.588897` |
| `lng` | Longitude of the location. | `25.470087` |
| `hint` | English text shown after discovery. Tells the player where to go next. | `"Congratulations! You found the Gate, next look for the Garden!"` |
| `hint_ro` | Same hint text in Romanian. | `"Felicitari! Ai gasit Poarta, urmatorul lucru pe care il cauti este Gradina!"` |
| `quiz.question` | A trivia question related to the location. | `"Who captured the Citadel?"` |
| `quiz.answer` | The correct answer. Must also appear in the `options` array. | `"Gabriel Bathory"` |
| `quiz.options` | An array of four choices. The correct answer must be one of them. | `["Gabriel Bathory", "Option 2", "Option 3", "Option 4"]` |

### Adding a New Location

1. Open `data/scavenger-data.json` in a text editor.

2. In the `locations` object, add a new entry after the last location. Use this template, replacing all placeholder values:

   ```json
   "your_key": {
     "name": "Location Name in English",
     "name_ro": "Location Name in Romanian",
     "qr": "YOUR_QR_CODE_TEXT",
     "difficulty": 0,
     "lat": 45.0000,
     "lng": 25.0000,
     "hint": "Congratulations! You found Location Name! Next look for Next Location!",
     "hint_ro": "Felicitari! Ai gasit Locatia! Apoi cauta Urmatoarea Locatie!",
     "quiz": {
       "question": "Your trivia question?",
       "answer": "Correct Answer",
       "options": ["Correct Answer", "Wrong Answer 2", "Wrong Answer 3", "Wrong Answer 4"]
     }
   }
   ```

3. Add `"your_key"` to the `order` array at the position where it should appear in the hunt sequence.

4. Save the file.

To find the latitude and longitude for a location, right-click the spot on Google Maps and select the coordinates.

### Removing a Location

1. Delete the location's entry from the `locations` object.
2. Remove its key from the `order` array.
3. Update the `hint` and `hint_ro` of the previous location in the order so its "next look for" text points to the correct place.

### Changing Quiz Questions

Find the location in `data/scavenger-data.json` and edit the `quiz` object. Make sure the `answer` value exactly matches one of the strings in the `options` array.

### QR Codes

QR codes are generated automatically by the server. To view and print all QR codes, visit `/qrcodes.html` while the server is running. Each QR code encodes a URL that includes the `SITE_DOMAIN` from `site.config.js` plus the location key.

To generate a bonus (off-track) QR code, visit this URL in your browser while the server is running:

```
/api/qrcode-extra?name=Place_Name&points=5
```

Replace `Place_Name` with the name (use underscores for spaces) and `points` with the bonus point value.

### Points and Scoring

The point values are defined in `server.js`:

| Constant | Value | Description |
|---|---|---|
| `POINTS_PER_LOCATION` | 10 | Points awarded for discovering each location. |
| `COMPLETION_BONUS` | 50 | Bonus points awarded for completing the entire hunt. |

To change these values, open `server.js` and find these lines near the top (around line 93):

```javascript
const POINTS_PER_LOCATION = 10;
const COMPLETION_BONUS = 50;
```

Edit the numbers and restart the server.

---

## 6. Places Data and Photos

### How Place Data Works

The homepage displays tourist attractions, restaurants, and accommodations. This data comes from the Google Places API, but it is not fetched live on every page load. Instead:

1. A build script (`build-scripts/fetch-places-data.js`) calls the Google API and saves the results to `data/places-data.json`.
2. The website reads this JSON file and displays the cards.
3. A GitHub Actions workflow runs this script automatically every Sunday to keep data fresh.

This approach keeps API costs at zero because the free tier allows far more calls than the site uses.

### Fetching Fresh Data

Run this command (requires `GOOGLE_PLACES_API_KEY` in your `.env` file):

```
npm run fetch-data
```

To also download photos locally:

```
npm run fetch-data-with-images
```

After downloading photos, commit them so they are included in the deployed site:

```
git add assets/place-photos/
git commit -m "Update place photos"
git push
```

### The Data Caching System

The `npm run fetch-and-start` command checks whether `data/places-data.json` is older than 30 days. If the data is recent, it skips the API call and starts the server immediately. This prevents unnecessary API usage.

Use `npm run force-fetch-and-start` to bypass this check and always fetch fresh data.

### Excluding Places from Results

To hide a place from the website, add its exact name to the `BLACKLIST` array at the top of `build-scripts/fetch-places-data.js`:

```javascript
const BLACKLIST = [
  'Rockstad Extrem Fest',
  'Another Place to Hide',
];
```

Then re-run `npm run fetch-data`.

---

## 7. Translations and Language Files

The site supports English and Romanian. A toggle button in the header switches between languages.

### Translation Files

- `locales/en/translation.json` -- All English text.
- `locales/ro/translation.json` -- All Romanian text.

Both files share the same structure. Each key corresponds to a label, button, or message on the site. To change any text the user sees, find the key in the appropriate file and edit the value.

For example, to change the hero subtitle in English, open `locales/en/translation.json` and find:

```json
"hero": {
  "title": "Welcome to Rasnov",
  "subtitle": "Explore Historic Fortress, Stunning Nature & Romanian Culture",
  "cta": "Start Exploring"
}
```

Change the text inside the quotes and save. No code changes are needed.

### Adding a New Language

1. Create a new folder under `locales/` with the language code (e.g., `locales/de/`).
2. Copy `locales/en/translation.json` into the new folder.
3. Translate all values in the new file.
4. Update `js/i18n.js` to include the new language code in its configuration.

---

## 8. Storage Modes -- Cloudinary vs Local

The site stores two types of persistent data: the leaderboard (player scores) and cached place photos. There are two storage options.

### Cloudinary (Default)

Cloudinary is a cloud image and file hosting service. When `STORAGE_MODE` is set to `'cloudinary'` in `site.config.js`, all leaderboard data and photos are stored in your Cloudinary account. This means data survives server restarts and redeployments.

Requirements:
- A Cloudinary account (free tier is sufficient).
- The `CLOUDINARY_URL` environment variable set in `.env` or in your hosting platform's environment settings.

The format of the Cloudinary URL is:
```
cloudinary://api_key:api_secret@cloud_name
```

You can find this value in your Cloudinary dashboard.

### Local Storage

When `STORAGE_MODE` is set to `'local'`, data is stored on the server's filesystem in the folder specified by `LOCAL_STORAGE_PATH` (defaults to `./local-storage`).

This is simpler to set up but data may be lost if the server is redeployed to a fresh environment (e.g., on platforms like Render or Heroku that wipe the filesystem on each deploy).

### Switching Between Modes

1. Edit `STORAGE_MODE` in `site.config.js`.
2. To carry existing data to the new mode, run the migration script:
   - From Cloudinary to local: `npm run migrate:cloudinary-to-local`
   - From local to Cloudinary: `npm run migrate:local-to-cloudinary`

---

## 9. Automated Data Updates -- GitHub Actions

A GitHub Actions workflow automatically fetches fresh place data every week.

### How It Works

The file `.github/workflows/update-places-data.yml` defines a workflow that:

1. Runs every Sunday at 2:00 AM UTC (or when triggered manually).
2. Checks out the repository.
3. Installs dependencies.
4. Runs `npm run fetch-data` using the API keys stored as GitHub Secrets.
5. If the data has changed, commits the updated `data/places-data.json` and pushes it.

### Changing the Schedule

Open `.github/workflows/update-places-data.yml` and edit the `cron` value:

```yaml
schedule:
  - cron: '0 2 * * 0'   # Every Sunday at 2 AM UTC
```

Common alternatives:
- `'0 2 * * *'` -- Every day at 2 AM UTC
- `'0 2 1 * *'` -- First day of each month at 2 AM UTC

Do not run more frequently than daily to avoid unnecessary API usage.

### Running the Workflow Manually

1. Go to the repository on GitHub.
2. Click the "Actions" tab.
3. Select the "Update Places Data" workflow on the left.
4. Click "Run workflow" and confirm.

### Required GitHub Secrets

For the workflow to run, these secrets must be set in the repository. Go to Settings, then Secrets and variables, then Actions, then New repository secret.

| Secret name | Value |
|---|---|
| `GOOGLE_PLACES_API_KEY` | Your Google Places API key |
| `UNSPLASH_ACCESS_KEY` | Your Unsplash API key (optional but recommended) |

---

## 10. API Keys and External Services

### Google Places API

This is the main data source for attractions, restaurants, and accommodations.

**How to get a key:**

1. Go to https://console.cloud.google.com/ and sign in.
2. Create a new project (or select an existing one).
3. Search for "Places API (new)" and enable it.
4. Go to Credentials and create an API key.
5. Restrict the key to "Places API (new)" only.
6. Enable billing on the project (required even for free tier; you will not be charged if usage stays under $200/month).

**Cost:** Google provides $200/month in free credits. This site uses approximately $5-10/month, so it costs nothing.

**Where to use it:**
- In `.env` as `GOOGLE_PLACES_API_KEY`
- In GitHub Secrets as `GOOGLE_PLACES_API_KEY`

**If the key needs to be rotated:** Generate a new key in Google Cloud Console, then update it in both `.env` (for local use) and GitHub Secrets (for automated updates).

See [SETUP_GUIDE.md](SETUP_GUIDE.md) for step-by-step instructions with more detail.

### Cloudinary

Cloud storage for photos and leaderboard data.

**How to get credentials:**

1. Sign up at https://cloudinary.com/ (free tier is sufficient).
2. In your Cloudinary dashboard, find the "API Environment variable" -- it looks like `cloudinary://123456:abcdef@cloud_name`.
3. Copy this value.

**Where to use it:**
- In `.env` as `CLOUDINARY_URL`
- In your hosting platform's environment variables (e.g., Render dashboard)

### Unsplash (Optional)

Provides fallback photos when Google does not have images for a place.

**How to get a key:**

1. Go to https://unsplash.com/developers and register as a developer.
2. Create a new application.
3. Copy the "Access Key."

**Where to use it:**
- In `.env` as `UNSPLASH_ACCESS_KEY`
- In GitHub Secrets as `UNSPLASH_ACCESS_KEY`

---

## 11. Deployment and Hosting

The site requires a Node.js server (it is not a purely static site because it uses Express for the leaderboard API, QR code generation, and photo proxying).

### Render (Current Setup)

The site is currently hosted on Render. The `SITE_DOMAIN` in `site.config.js` should match the Render URL.

To redeploy, push changes to the main branch. Render will automatically rebuild and restart the server.

Required environment variables in Render's dashboard:
- `CLOUDINARY_URL` (if using Cloudinary storage mode)
- `GOOGLE_PLACES_API_KEY` (if fetching data on deploy)

### Other Node.js Hosts

Any platform that can run `npm install` and `npm start` will work (e.g., Railway, Fly.io, DigitalOcean App Platform). Set the required environment variables in the platform's dashboard.

### Local or VPS

1. Clone the repository on your server.
2. Run `npm install`.
3. Create a `.env` file with your keys.
4. Run `npm start` (or use a process manager like PM2: `pm2 start server.js`).
5. Point your domain to port 3000 (or put a reverse proxy like Nginx in front).

---

## 12. Troubleshooting

### The site shows "Using sample data"

The file `data/places-data.json` does not exist or could not be loaded. Run `npm run fetch-data` to generate it. This requires the `GOOGLE_PLACES_API_KEY` to be set in `.env`.

### Location cards are blank or missing

1. Open the browser developer tools (F12) and check the Console tab for errors.
2. Confirm that `data/sample-places-data.json` exists in the project.
3. Check the Network tab to see if the data file failed to load.

### Photos are not showing

1. Check whether the `assets/place-photos/` folder contains image files.
2. If it is empty, run `npm run fetch-data-with-images` to download photos, then commit and push the folder.
3. If photos exist locally but not on the deployed site, make sure the `assets/place-photos/` folder was committed to git.

### The GitHub Actions workflow fails

1. Go to the Actions tab in the GitHub repository and click on the failed run to see logs.
2. Verify that `GOOGLE_PLACES_API_KEY` is set correctly in Settings > Secrets and variables > Actions.
3. Make sure billing is enabled on your Google Cloud project.

### QR codes do not scan correctly

1. Make sure `SITE_DOMAIN` in `site.config.js` matches the actual URL where the site is hosted.
2. Reprint QR codes after changing the domain (visit `/qrcodes.html` to generate them).

### The leaderboard resets after redeployment

This happens when using `STORAGE_MODE: 'local'` on a hosting platform that wipes the filesystem on each deploy (e.g., Render, Heroku). Switch to `STORAGE_MODE: 'cloudinary'` and set the `CLOUDINARY_URL` environment variable to persist data across deploys.

### Map markers are not appearing

1. Wait a few seconds for data to load after opening the page.
2. Check that the Leaflet CDN (`unpkg.com/leaflet`) is accessible from your network.
3. Open the browser console and look for JavaScript errors.
