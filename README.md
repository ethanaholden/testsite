# Discover Rasnov

A Node.js + Express tourism site for Rasnov, Romania with:
- dynamic places content (attractions, restaurants, accommodations)
- an interactive map
- a QR-based treasure hunt with points, leaderboard, and rewards
- English/Romanian localization

For full operational details and deep-dive documentation, see [`manual.md`](./manual.md) and [`SETUP_GUIDE.md`](./SETUP_GUIDE.md).

## Core Features

- **Homepage experience** (`index.html`)
  - category tabs for locations/restaurants/accommodations
  - cards loaded from JSON data
  - featured place and weather info
- **Interactive map**
  - Leaflet map with place markers and scavenger-hunt markers
- **Treasure hunt** (`hunt.html`)
  - QR/location discovery, quiz prompts, progress tracking
  - points and completion bonus
  - bonus locations and reward/collage flow
- **User progress + leaderboard**
  - UUID-based user identity
  - server-backed points and ranking APIs
- **Localization**
  - i18next-powered EN/RO translations via `locales/*/translation.json`
- **Data and media pipeline**
  - Google Places fetch scripts
  - optional image caching into `assets/place-photos/`
  - storage abstraction for local or Cloudinary persistence

## How the Site Runs

### Runtime flow

1. `server.js` starts an Express app and serves static files.
2. Frontend pages (`index.html`, `hunt.html`) load shared logic from `script.js`.
3. Place cards are populated by `js/data-loader.js` from:
   - `data/places-data.json` (preferred)
   - `data/sample-places-data.json` (fallback)
4. Hunt state and scoring use server APIs in `server.js`.
5. Leaderboard data persists via `storage.js` using:
   - **Cloudinary** (`cloudinary-storage.js`), or
   - **Local filesystem** (`local-storage.js`), selected in `site.config.js`.

### Main API routes

- `POST /api/user/create`
- `GET /api/user/:uuid`
- `POST /api/user/:uuid/set-name`
- `POST /api/user/:uuid/location-found`
- `POST /api/user/:uuid/extra-found`
- `POST /api/user/:uuid/reset`
- `GET /api/leaderboard`
- `GET /api/config`
- `GET /api/qrcode`
- `GET /api/qrcode-extra`

## Project Structure

```text
testsite/
├── index.html                     # Main tourism page
├── hunt.html                      # Treasure hunt page
├── qrcodes.html                   # QR listing/debug page
├── script.js                      # Main client behavior (UI, hunt, map interactions)
├── styles.css                     # Styling
├── server.js                      # Express server + API routes
├── site.config.js                 # Site domain and storage mode config
├── js/
│   ├── data-loader.js             # Loads/renders place data cards
│   └── i18n.js                    # Language loading and switching
├── data/
│   ├── scavenger-data.json        # Hunt locations, order, quiz content
│   └── sample-places-data.json    # Fallback place dataset
├── locales/
│   ├── en/translation.json        # English text
│   └── ro/translation.json        # Romanian text
├── build-scripts/
│   ├── fetch-places-data.js       # Fetches places data
│   ├── conditional-fetch.js       # Age-based data refresh logic
│   └── download-photos.js         # Fetches missing cached photos
├── assets/place-photos/           # Locally cached place images
├── storage.js                     # Storage mode switch layer
├── cloudinary-storage.js          # Cloudinary storage implementation
├── local-storage.js               # Local storage implementation
├── migrate-storage.js             # Data migration between storage modes
├── manual.md                      # Full handoff/manual (copied from previous README)
└── SETUP_GUIDE.md                 # Detailed setup and API onboarding
```

## Basic Editing Instructions

### 1) Update hunt content

Edit `data/scavenger-data.json`:
- `order`: hunt sequence
- `locations`: name, QR token, coordinates, hints, and quiz content

Keep location keys aligned between `order` and `locations`.

### 2) Update visible site text

- English: `locales/en/translation.json`
- Romanian: `locales/ro/translation.json`

Keep translation keys consistent across languages.

### 3) Change global site settings

Edit `site.config.js`:
- `SITE_DOMAIN` for QR/API domain consistency
- `STORAGE_MODE` (`cloudinary` or `local`)
- `LOCAL_STORAGE_PATH` when using local mode

### 4) Update fetched place data

Use existing scripts from `package.json`:
- `npm run fetch-data`
- `npm run fetch-data-with-images`
- `npm run download-photos`
- `npm run fetch-and-start`

## NPM Scripts

- `npm start` / `npm run dev` — run the server
- `npm run fetch-data` — refresh places dataset
- `npm run fetch-data-with-images` — refresh data + download photos
- `npm run download-photos` — fetch missing photos only
- `npm run fetch-and-start` — conditional refresh then run
- `npm run force-fetch-and-start` — force refresh then run
- `npm run migrate:cloudinary-to-local` — migrate persisted data
- `npm run migrate:local-to-cloudinary` — migrate persisted data
