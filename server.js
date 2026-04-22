const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const QRCode = require('qrcode');
require('dotenv').config();
const storage = require('./storage');
const siteConfig = require('./site.config');
const SITE_DOMAIN = siteConfig.SITE_DOMAIN;
const app = express();

// Middleware
app.use(express.json());
// Must be registered before express.static so raw discount codes are never exposed as static JSON.
app.get('/data/rewards-discounts.json', (_req, res) => {
  res.status(404).send('Not found');
});
app.use(express.static(__dirname));

// Persistent leaderboard file
const LEADERBOARD_FILE = path.join(__dirname, 'data', 'leaderboard.json');
const LOCATION_SCAN_COUNTER_FILE = path.join(__dirname, 'data', 'location-scan-counts.txt');

// Load persisted user accounts on startup (keyed by UUID)
let userAccounts = {};
async function loadLeaderboardData() {
  // 1. Try local file first
  try {
    if (fs.existsSync(LEADERBOARD_FILE)) {
      userAccounts = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
      console.log('📋 Loaded leaderboard from local file');
      return;
    }
  } catch (e) {
    console.warn('Could not load local leaderboard data:', e.message);
  }

  // 2. Fall back to storage when local file is absent (e.g. fresh deploy)
  if (storage.isConfigured()) {
    try {
      const data = await storage.downloadJSON(storage.PUBLIC_IDS.LEADERBOARD);
      if (data) {
        userAccounts = data;
        // Persist locally so future restarts skip the storage round-trip
        saveLeaderboardLocal();
        console.log('☁️  Restored leaderboard from storage');
        return;
      }
    } catch (e) {
      console.warn('Could not restore leaderboard from storage:', e.message);
    }
  }

  console.log('📋 Starting with fresh leaderboard');
  userAccounts = {};
}

// Write leaderboard to local disk (atomic write)
function saveLeaderboardLocal() {
  try {
    const dir = path.dirname(LEADERBOARD_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = LEADERBOARD_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(userAccounts, null, 2));
    try {
      fs.renameSync(tmp, LEADERBOARD_FILE);
    } catch (renameErr) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw renameErr;
    }
  } catch (e) {
    console.error('Failed to save leaderboard locally:', e.message);
  }
}

// Persist user accounts to disk and storage
function saveLeaderboardData() {
  saveLeaderboardLocal();
  // Upload to storage asynchronously so mutations are not blocked
  if (storage.isConfigured()) {
    storage.uploadJSON(storage.PUBLIC_IDS.LEADERBOARD, userAccounts)
      .catch(e => console.error('Failed to upload leaderboard to storage:', e.message));
  }
}
// Validate UUID v4 format
function isValidUUID(str) {
  return typeof str === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
}

// Sanitize display name
function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  return name.trim().substring(0, 30) || null;
}

// User points per location
const POINTS_PER_LOCATION = 10;
const COMPLETION_BONUS = 50;

// ==================== Place Photos Route ====================

const PHOTOS_DIR = path.join(__dirname, 'assets', 'place-photos');
const PLACES_DATA_FILE = path.join(__dirname, 'data', 'places-data.json');
const SAMPLE_DATA_FILE = path.join(__dirname, 'data', 'sample-places-data.json');
const SCAVENGER_DATA_FILE = path.join(__dirname, 'data', 'scavenger-data.json');
const REWARDS_DISCOUNTS_FILE = path.join(__dirname, 'data', 'rewards-discounts.json');
let locationScanCounts = {};
let scavengerLocationKeys = [];
let locationScanSaveTimer = null;
let locationScanSaveDirty = false;

// Load valid QR location keys from scavenger-data.json (falls back to empty set on error)
function loadValidQRLocations() {
  try {
    const data = JSON.parse(fs.readFileSync(SCAVENGER_DATA_FILE, 'utf8'));
    return new Set(Object.keys(data.locations || {}));
  } catch (e) {
    console.warn('Could not load scavenger data for QR validation:', e.message);
    return new Set();
  }
}

function loadScavengerLocationKeys() {
  try {
    const data = JSON.parse(fs.readFileSync(SCAVENGER_DATA_FILE, 'utf8'));
    const locations = data.locations || {};
    const order = Array.isArray(data.order) ? data.order : [];
    const allKeys = Object.keys(locations);
    if (!allKeys.length) return [];

    const ordered = order.filter(k => Object.prototype.hasOwnProperty.call(locations, k));
    const remaining = allKeys.filter(k => !ordered.includes(k));
    return [...ordered, ...remaining];
  } catch (e) {
    console.warn('Could not load scavenger locations for scan counters:', e.message);
    return [];
  }
}

function createZeroScanCounts(keys) {
  return keys.reduce((acc, key) => {
    acc[key] = 0;
    return acc;
  }, {});
}

function parseLocationScanCounterFile(content) {
  const lines = String(content || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return null;
  const parsed = {};
  for (const line of lines) {
    const m = /^\(([^:]+):\s*(\d+)\)$/.exec(line);
    if (!m) return null;
    parsed[m[1]] = parseInt(m[2], 10);
  }
  return parsed;
}

function formatLocationScanCounterFile(keys, counts) {
  return keys.map(key => `(${key}: ${counts[key] || 0})`).join('\n') + '\n';
}

function saveLocationScanCountersLocal() {
  try {
    const dir = path.dirname(LOCATION_SCAN_COUNTER_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = LOCATION_SCAN_COUNTER_FILE + '.tmp';
    fs.writeFileSync(tmp, formatLocationScanCounterFile(scavengerLocationKeys, locationScanCounts));
    try {
      fs.renameSync(tmp, LOCATION_SCAN_COUNTER_FILE);
    } catch (renameErr) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw renameErr;
    }
  } catch (e) {
    console.error('Failed to save location scan counters locally:', e.message);
  }
}

function queueLocationScanCounterSave() {
  locationScanSaveDirty = true;
  if (locationScanSaveTimer) return;
  locationScanSaveTimer = setTimeout(() => {
    locationScanSaveTimer = null;
    if (!locationScanSaveDirty) return;
    locationScanSaveDirty = false;
    saveLocationScanCountersLocal();
  }, 250);
}

function flushPendingLocationScanCounterSave() {
  if (!locationScanSaveDirty) return;
  locationScanSaveDirty = false;
  if (locationScanSaveTimer) {
    clearTimeout(locationScanSaveTimer);
    locationScanSaveTimer = null;
  }
  saveLocationScanCountersLocal();
}

function initializeLocationScanCounters() {
  scavengerLocationKeys = loadScavengerLocationKeys();
  if (!scavengerLocationKeys.length) {
    locationScanCounts = {};
    return;
  }

  let shouldRecreate = !fs.existsSync(LOCATION_SCAN_COUNTER_FILE);
  let parsed = null;

  if (!shouldRecreate) {
    try {
      parsed = parseLocationScanCounterFile(fs.readFileSync(LOCATION_SCAN_COUNTER_FILE, 'utf8'));
      if (!parsed) {
        shouldRecreate = true;
      } else {
        const parsedKeys = Object.keys(parsed);
        const hasSameCount = parsedKeys.length === scavengerLocationKeys.length;
        const hasSameKeys = scavengerLocationKeys.every(k => Object.prototype.hasOwnProperty.call(parsed, k));
        shouldRecreate = !hasSameCount || !hasSameKeys;
      }
    } catch (e) {
      console.warn('Could not load location scan counters:', e.message);
      shouldRecreate = true;
    }
  }

  if (shouldRecreate) {
    locationScanCounts = createZeroScanCounts(scavengerLocationKeys);
    saveLocationScanCountersLocal();
    console.log('📍 Recreated location scan counters from scavenger data');
    return;
  }

  locationScanCounts = {};
  for (const key of scavengerLocationKeys) {
    locationScanCounts[key] = Number.isFinite(parsed[key]) ? parsed[key] : 0;
  }
  console.log('📍 Loaded location scan counters from local file');
}

function incrementLocationScanCounter(locationKey) {
  if (!locationKey || !Object.prototype.hasOwnProperty.call(locationScanCounts, locationKey)) {
    console.warn('Skipping scan counter increment for unknown location key:', locationKey);
    return;
  }
  locationScanCounts[locationKey] += 1;
  queueLocationScanCounterSave();
}

/**
 * Load places data, reloading from disk whenever the source file changes.
 * This ensures that manually copying a new places-data.json is picked up
 * without restarting the server.
 */
let placesDataCache = null;
let placesDataFile = null;
let placesDataMtime = null;
function getPlacesData() {
  for (const file of [PLACES_DATA_FILE, SAMPLE_DATA_FILE]) {
    if (fs.existsSync(file)) {
      try {
        const stat = fs.statSync(file);
        if (placesDataCache && placesDataFile === file && placesDataMtime === stat.mtimeMs) {
          return placesDataCache;
        }
        const newData = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (placesDataCache) {
          console.log(`📄 Reloaded places data from ${path.basename(file)}`);
        }
        placesDataCache = newData;
        placesDataFile = file;
        placesDataMtime = stat.mtimeMs;
        return placesDataCache;
      } catch (e) {
        console.warn(`Could not parse ${file}:`, e.message);
      }
    }
  }
  return null;
}

let rewardsDiscountsCache = null;
let rewardsDiscountsMtime = null;
function getRewardsDiscountsData() {
  try {
    if (!fs.existsSync(REWARDS_DISCOUNTS_FILE)) return null;
    const stat = fs.statSync(REWARDS_DISCOUNTS_FILE);
    if (rewardsDiscountsCache && rewardsDiscountsMtime === stat.mtimeMs) {
      return rewardsDiscountsCache;
    }
    const parsed = JSON.parse(fs.readFileSync(REWARDS_DISCOUNTS_FILE, 'utf8'));
    const rawDiscounts = (parsed && typeof parsed.discounts === 'object' && parsed.discounts) || {};
    const normalizedDiscounts = {};
    for (const [id, discount] of Object.entries(rawDiscounts)) {
      if (!discount || typeof discount !== 'object') continue;
      normalizedDiscounts[id] = {
        emoji: typeof discount.emoji === 'string' ? discount.emoji : '🎁',
        pointsRequired: Number.isFinite(discount.pointsRequired) ? Math.max(0, Math.floor(discount.pointsRequired)) : 0,
        name: typeof discount.name === 'string' ? discount.name : '',
        name_ro: typeof discount.name_ro === 'string' ? discount.name_ro : '',
        description: typeof discount.description === 'string' ? discount.description : '',
        description_ro: typeof discount.description_ro === 'string' ? discount.description_ro : '',
        code: typeof discount.code === 'string' ? discount.code.trim() : ''
      };
    }
    const order = Array.isArray(parsed.order)
      ? parsed.order.filter(id => Object.hasOwn(normalizedDiscounts, id))
      : [];
    rewardsDiscountsCache = { order, discounts: normalizedDiscounts };
    rewardsDiscountsMtime = stat.mtimeMs;
    return rewardsDiscountsCache;
  } catch (e) {
    console.warn('Could not load rewards discounts data:', e.message);
    return null;
  }
}

/**
 * Return the path of the sidecar file that records which photoReference
 * was used to populate a cached photo file.
 */
function getRefPath(imagePath) {
  return imagePath.replace(/\.(jpg|png)$/i, '.ref');
}

/**
 * Read the photoReference stored in a sidecar .ref file, or null if absent.
 */
function readCachedPhotoRef(imagePath) {
  try {
    const refPath = getRefPath(imagePath);
    if (fs.existsSync(refPath)) {
      return fs.readFileSync(refPath, 'utf8').trim() || null;
    }
  } catch (e) {
    console.warn(`Could not read ref file for ${path.basename(imagePath)}:`, e.message);
  }
  return null;
}

/**
 * Write the photoReference used for a cached photo to its sidecar .ref file.
 */
function writeCachedPhotoRef(imagePath, photoReference) {
  try {
    fs.writeFileSync(getRefPath(imagePath), photoReference);
  } catch (e) {
    console.warn(`Could not write ref file for ${path.basename(imagePath)}:`, e.message);
  }
}

/**
 * Find the photoReference stored in places data for a given filename.
 * Filename format: {placeId}_{index}.jpg  or  {placeId}_{index}.png
 */
function findPhotoReference(filename) {
  const data = getPlacesData();
  if (!data) return null;

  const allPlaces = [
    ...(data.locations || []),
    ...(data.restaurants || []),
    ...(data.accommodations || []),
  ];

  for (const place of allPlaces) {
    const photos = place.photos || [];
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      // Match by expected filename for both jpg and png
      const expectedJpg = `${place.id}_${i}.jpg`;
      const expectedPng = `${place.id}_${i}.png`;
      if (filename === expectedJpg || filename === expectedPng) {
        return photo.photoReference || null;
      }
    }
  }
  return null;
}

/**
 * Simple in-memory rate limiter for the photo proxy route.
 * Allows up to MAX_REQUESTS per IP within WINDOW_MS.
 */
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 60;     // max requests per IP per window
const rateLimitMap = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  entry.count += 1;
  rateLimitMap.set(ip, entry);
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

/**
 * Serve place photos from local cache.
 * On a cache miss — or when the cached file was built from a different
 * photoReference than the one in the current data — download the image from
 * Google Places API, save it locally with a sidecar .ref file, then serve it.
 */
app.get('/assets/place-photos/:filename', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).send('Too many requests');
  }

  const filename = req.params.filename;

  // Reject filenames that could escape the photos directory
  if (!/^[A-Za-z0-9_-]+\.(jpg|png)$/i.test(filename)) {
    return res.status(400).send('Invalid filename');
  }

  const filepath = path.join(PHOTOS_DIR, filename);

  // Serve from local cache if the cached file is still valid.
  // A cached file is considered current only when its sidecar .ref file records
  // the same photoReference that is in the current places data.
  // Files with no sidecar (e.g. committed before this feature was added) or
  // with a mismatched reference are treated as unverified and will be
  // re-downloaded when the API key is available.
  if (fs.existsSync(filepath)) {
    const currentRef = findPhotoReference(filename);
    const cachedRef = readCachedPhotoRef(filepath);
    if (cachedRef !== null && cachedRef === currentRef) {
      // Sidecar confirms the cached file matches current data — serve it.
      return res.sendFile(filepath);
    }
    // Unverified or stale: attempt re-download if we have an API key and a ref.
    const apiKeyCheck = process.env.GOOGLE_PLACES_API_KEY;
    if (!currentRef || !apiKeyCheck || apiKeyCheck.startsWith('your_')) {
      // Cannot re-download — serve existing file rather than returning an error.
      return res.sendFile(filepath);
    }
    console.log(`🔄 Refreshing unverified/stale cache for ${filename}`);
    try { fs.unlinkSync(filepath); } catch (_) {}
    try { fs.unlinkSync(getRefPath(filepath)); } catch (_) {}
  }

  // Attempt to restore from storage before hitting the Google Places API
  if (storage.isConfigured()) {
    try {
      const baseName = filename.replace(/\.(jpg|png)$/i, '');
      const storageId = storage.PUBLIC_IDS.photoId(baseName);
      const downloaded = await storage.downloadImage(storageId, filepath);
      if (downloaded) {
        // Write a sidecar .ref file so the cache is considered valid next time
        const photoRef = findPhotoReference(filename);
        if (photoRef) writeCachedPhotoRef(filepath, photoRef);
        console.log(`☁️  Served photo from storage: ${filename}`);
        return res.sendFile(filepath);
      }
    } catch (e) {
      console.warn(`Could not fetch photo ${filename} from storage:`, e.message);
    }
  }

  // Attempt on-demand download using stored photo reference
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey || apiKey.startsWith('your_')) {
    return res.status(404).send('Image not found and API key not configured');
  }

  const photoReference = findPhotoReference(filename);
  if (!photoReference) {
    return res.status(404).send('Image not found');
  }

  try {
    const photoUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=${encodeURIComponent(photoReference)}&key=${apiKey}`;
    const response = await axios.get(photoUrl, { responseType: 'arraybuffer' });
    const contentType = (response.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
    const imageData = Buffer.from(response.data);

    // Cache the image for future requests
    if (!fs.existsSync(PHOTOS_DIR)) {
      fs.mkdirSync(PHOTOS_DIR, { recursive: true });
    }
    fs.writeFileSync(filepath, imageData);
    writeCachedPhotoRef(filepath, photoReference);
    console.log(`📸 Cached photo: ${filename}`);

    // Upload to storage for persistence across deploys
    if (storage.isConfigured()) {
      const baseName = filename.replace(/\.(jpg|png)$/i, '');
      storage.uploadImageBuffer(storage.PUBLIC_IDS.photoId(baseName), imageData)
        .then(() => console.log(`☁️  Uploaded photo to storage: ${filename}`))
        .catch(e => console.warn(`Could not upload photo ${filename} to storage:`, e.message));
    }

    res.setHeader('Content-Type', contentType);
    res.send(imageData);
  } catch (error) {
    console.error(`Could not fetch photo ${filename}:`, error.message);
    res.status(500).send('Could not fetch image');
  }
});

// ==================== API Routes ====================

// Create or update user account (idempotent, keyed by UUID)
app.post('/api/user/create', (req, res) => {
  const { uuid, displayName } = req.body;

  if (!isValidUUID(uuid)) {
    return res.status(400).json({ error: 'Valid UUID v4 is required' });
  }

  if (userAccounts[uuid]) {
    // Update displayName only if not yet set
    if (displayName && !userAccounts[uuid].displayName) {
      userAccounts[uuid].displayName = sanitizeName(displayName);
      saveLeaderboardData();
    }
    return res.status(200).json(userAccounts[uuid]);
  }

  const newUser = {
    uuid,
    displayName: sanitizeName(displayName),
    totalPoints: 0,
    locationsFound: [],
    completedAt: null,
    firstScanAt: null,
    createdAt: new Date().toISOString()
  };

  userAccounts[uuid] = newUser;
  saveLeaderboardData();
  res.status(201).json(newUser);
});

// Get user account by UUID
app.get('/api/user/:uuid', (req, res) => {
  const { uuid } = req.params;

  if (!isValidUUID(uuid)) {
    return res.status(400).json({ error: 'Invalid UUID format' });
  }

  const user = userAccounts[uuid];
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json(user);
});

// Set or update display name for a user
app.post('/api/user/:uuid/set-name', (req, res) => {
  const { uuid } = req.params;
  const { displayName } = req.body;

  if (!isValidUUID(uuid)) {
    return res.status(400).json({ error: 'Invalid UUID format' });
  }

  const name = sanitizeName(displayName);
  if (!name) {
    return res.status(400).json({ error: 'A valid display name is required' });
  }

  if (!userAccounts[uuid]) {
    return res.status(404).json({ error: 'User not found' });
  }

  userAccounts[uuid].displayName = name;
  saveLeaderboardData();
  res.json(userAccounts[uuid]);
});

// Award points for finding a location
app.post('/api/user/:uuid/location-found', (req, res) => {
  const { uuid } = req.params;
  const { locationKey, locationName, isCompletion, scanSource } = req.body;
  const normalizedScanSource = scanSource === 'sync' ? 'sync' : 'scan';

  if (!isValidUUID(uuid)) {
    return res.status(400).json({ error: 'Invalid UUID format' });
  }

  if (!userAccounts[uuid]) {
    return res.status(404).json({ error: 'User not found' });
  }

  const user = userAccounts[uuid];

  // Prevent duplicate points for same location (idempotent)
  if (user.locationsFound.includes(locationKey)) {
    return res.status(400).json({
      error: 'Location already found',
      user: user
    });
  }

  // Add location to found list
  user.locationsFound.push(locationKey);
  if (normalizedScanSource !== 'sync') {
    incrementLocationScanCounter(locationKey);
  }

  // Award points
  const points = POINTS_PER_LOCATION;
  user.totalPoints += points;
  const now = new Date().toISOString();
  if (!user.firstScanAt) user.firstScanAt = now;
  user.lastLocationAt = now;

  // Award completion bonus if hunt is complete
  if (isCompletion) {
    user.totalPoints += COMPLETION_BONUS;
    user.completedAt = new Date().toISOString();
  }

  saveLeaderboardData();

  res.json({
    success: true,
    pointsAwarded: points,
    completionBonus: isCompletion ? COMPLETION_BONUS : 0,
    user: user
  });
});

// Award points for finding an extra (bonus, off-track) location.
// locationKey format: "Name_With_Underscores-<points>" e.g. "Local_Bakery-5"
const EXTRA_LOCATION_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_ '-]{0,49}-(\d{1,3})$/;
app.post('/api/user/:uuid/extra-found', (req, res) => {
  const { uuid } = req.params;
  const { locationKey } = req.body;

  if (!isValidUUID(uuid)) {
    return res.status(400).json({ error: 'Invalid UUID format' });
  }

  const match = EXTRA_LOCATION_KEY_RE.exec(locationKey || '');
  if (!match) {
    return res.status(400).json({ error: 'Invalid extra location key format' });
  }
  const points = parseInt(match[1], 10);
  if (points < 1 || points > 999) {
    return res.status(400).json({ error: 'Points out of range' });
  }

  if (!userAccounts[uuid]) {
    return res.status(404).json({ error: 'User not found' });
  }

  const user = userAccounts[uuid];

  // Idempotent: do not award duplicate points
  if (user.locationsFound.includes(locationKey)) {
    return res.status(400).json({ error: 'Location already found', user });
  }

  user.locationsFound.push(locationKey);
  user.totalPoints += points;
  const now = new Date().toISOString();
  if (!user.firstScanAt) user.firstScanAt = now;
  user.lastLocationAt = now;

  saveLeaderboardData();

  res.json({ success: true, pointsAwarded: points, user });
});

// Reset a user's hunt progress (clears all found locations and points)
app.post('/api/user/:uuid/reset', (req, res) => {
  const { uuid } = req.params;

  if (!isValidUUID(uuid)) {
    return res.status(400).json({ error: 'Invalid UUID format' });
  }

  if (!userAccounts[uuid]) {
    return res.status(404).json({ error: 'User not found' });
  }

  const user = userAccounts[uuid];

  // Reset hunt progress while preserving user identity
  user.locationsFound = [];
  user.totalPoints = 0;
  user.completedAt = null;
  user.firstScanAt = null;
  user.lastLocationAt = null;

  saveLeaderboardData();

  res.json({ success: true, message: 'Hunt progress reset', user });
});

// Get leaderboard (top 50 users who have made progress)
app.get('/api/leaderboard', (req, res) => {
  const leaderboard = Object.values(userAccounts)
    .filter(u => u.totalPoints > 0 || u.locationsFound.length > 0)
    .sort((a, b) => {
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
      // Tie-break: faster elapsed time ranks higher; no-time ranks last
      const elapsedA = a.firstScanAt && a.lastLocationAt ? new Date(a.lastLocationAt) - new Date(a.firstScanAt) : Infinity;
      const elapsedB = b.firstScanAt && b.lastLocationAt ? new Date(b.lastLocationAt) - new Date(b.firstScanAt) : Infinity;
      return elapsedA - elapsedB;
    })
    .slice(0, 50)
    .map((user, index) => ({
      rank: index + 1,
      uuid: user.uuid,
      username: user.displayName || `Explorer_${user.uuid.substring(0, 6)}`,
      totalPoints: user.totalPoints,
      locationsFound: user.locationsFound.length,
      completedAt: user.completedAt,
      firstScanAt: user.firstScanAt || null,
      lastLocationAt: user.lastLocationAt || null
    }));

  res.json(leaderboard);
});

app.get('/api/rewards/discounts', (_req, res) => {
  const discountsData = getRewardsDiscountsData();
  if (!discountsData) {
    return res.json({ order: [], discounts: {} });
  }
  const publicDiscounts = {};
  for (const [id, d] of Object.entries(discountsData.discounts)) {
    publicDiscounts[id] = {
      emoji: d.emoji,
      pointsRequired: d.pointsRequired,
      name: d.name,
      name_ro: d.name_ro,
      description: d.description,
      description_ro: d.description_ro
    };
  }
  res.json({
    order: discountsData.order,
    discounts: publicDiscounts
  });
});

app.post('/api/rewards/discounts/:discountId/reveal', (req, res) => {
  const { discountId } = req.params;
  const { uuid } = req.body || {};
  if (!isValidUUID(uuid)) {
    return res.status(400).json({ error: 'Invalid UUID format' });
  }
  const user = userAccounts[uuid];
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  const discountsData = getRewardsDiscountsData();
  if (!discountsData || !discountsData.order.length) {
    return res.status(404).json({ error: 'Discounts not available' });
  }
  const discount = discountsData.discounts[discountId];
  if (!discount || !discount.code) {
    return res.status(404).json({ error: 'Discount code not configured' });
  }
  if (user.totalPoints < discount.pointsRequired) {
    return res.status(403).json({ error: 'Discount is still locked' });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ discountId, code: discount.code });
});

// ==================== Static Routes ====================

// Expose site configuration to the client (domain only – no secrets)
app.get('/api/config', (req, res) => {
  res.json({ siteDomain: SITE_DOMAIN });
});

// QR code image endpoint – used by the /qrcodes debug page.
// Generates a PNG QR code for the given absolute URL query parameter.
const VALID_QR_LOCATIONS = loadValidQRLocations();
// Validate an optional domain override for QR code generation.
// Accepts only http/https URLs without path, query, or fragment.
const DOMAIN_RE = /^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?$/;
function resolveQRDomain(queryDomain) {
  if (queryDomain && DOMAIN_RE.test(queryDomain)) {
    return queryDomain.replace(/\/+$/, '');
  }
  return SITE_DOMAIN;
}

app.get('/api/qrcode', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).send('Too many requests');
  }

  const location = req.query.location;
  if (!location || !VALID_QR_LOCATIONS.has(location)) {
    return res.status(400).send('Invalid location');
  }

  // Build the canonical hunt URL using the configured site domain or an override.
  const domain = resolveQRDomain(req.query.domain);
  const huntUrl = `${domain}/hunt.html?location=${encodeURIComponent(location)}`;

  QRCode.toBuffer(huntUrl, { width: 200, margin: 2, errorCorrectionLevel: 'H' }, (err, buf) => {
    if (err) {
      console.error('QR generation error:', err.message);
      return res.status(500).send('QR generation failed');
    }
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  });
});

// Extra (bonus) QR code endpoint – generates a QR code for an off-track location.
// Usage: /api/qrcode-extra?name=Coffee_Shop&points=5
// The resulting QR encodes: {SITE_DOMAIN}/hunt.html?location=Coffee_Shop-5
const EXTRA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_ '-]{0,49}$/;
app.get('/api/qrcode-extra', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).send('Too many requests');
  }

  const { name, points } = req.query;
  if (!name || !EXTRA_NAME_RE.test(name)) {
    return res.status(400).send('Invalid name: use letters, numbers, underscores, spaces, hyphens or apostrophes (max 50 chars)');
  }
  const pts = parseInt(points, 10);
  if (!points || isNaN(pts) || pts < 1 || pts > 999) {
    return res.status(400).send('Invalid points: must be a number between 1 and 999');
  }

  // Encode name: spaces become underscores, then append -<pts>
  const encodedName = name.replace(/ /g, '_');
  const locationParam = `${encodedName}-${pts}`;
  const domain = resolveQRDomain(req.query.domain);
  const huntUrl = `${domain}/hunt.html?location=${encodeURIComponent(locationParam)}`;

  QRCode.toBuffer(huntUrl, { width: 200, margin: 2, errorCorrectionLevel: 'H' }, (err, buf) => {
    if (err) {
      console.error('QR generation error:', err.message);
      return res.status(500).send('QR generation failed');
    }
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  });
});

// Serve index.html for root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// QR codes debug/print page – accessible by URL only, not linked from the site
app.get('/qrcodes', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).send('Too many requests');
  }
  return res.sendFile(path.join(__dirname, 'qrcodes.html'));
});

// Handle all other routes by serving index.html (for single-page app behavior)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
initializeLocationScanCounters();
function shutdownWithCounterFlush() {
  flushPendingLocationScanCounterSave();
  process.exit(0);
}
process.on('SIGINT', shutdownWithCounterFlush);
process.on('SIGTERM', shutdownWithCounterFlush);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Points system: ${POINTS_PER_LOCATION} points per location, ${COMPLETION_BONUS} point completion bonus`);
  if (storage.isConfigured()) {
    console.log('☁️  Persistent storage configured');
  }
  loadLeaderboardData().catch(e => console.error('Failed to initialize leaderboard:', e.message));
});
