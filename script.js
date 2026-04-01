// DOM Elements
const tabButtons = document.querySelectorAll('.tab-button');
const tabContents = document.querySelectorAll('.tab-content');
const navLinks = document.querySelectorAll('.nav-link');
const navToggle = document.querySelector('.nav-toggle');
const navList = document.querySelector('.nav-list');

// Detect which page we are on (hunt.html has the scan-qr button; index.html does not)
const isHuntPage = !!document.getElementById('scan-qr');

// AR Hunt Elements (only present on hunt.html)
const startHuntBtn = document.getElementById('start-hunt');
const scanQrBtn = document.getElementById('scan-qr');
const useLocationBtn = document.getElementById('use-location');
const testLocationBtn = document.getElementById('test-location');
const resetHuntBtn = document.getElementById('reset-hunt');
const progressFill = document.getElementById('progress-fill');
const progressCount = document.getElementById('progress-count');
const progressTotal = document.getElementById('progress-total');
const huntItems = document.querySelectorAll('.hunt-item');

// AR Modal Elements
const arModal = document.getElementById('ar-modal');
const arLoading = document.getElementById('ar-loading');
const arCloseBtn = document.getElementById('ar-close-btn');
const arSceneContainer = document.getElementById('ar-scene-container');
const arOverlayText = document.getElementById('ar-overlay-text');
const arLocationName = document.getElementById('ar-location-name');
const arLocationHint = document.getElementById('ar-location-hint');
const arTestModeIndicator = document.getElementById('ar-test-mode-indicator');
const arCaptureBtn = document.getElementById('ar-capture-btn');
const arHuntBanner = document.getElementById('ar-hunt-banner');
const arHuntText = document.getElementById('ar-hunt-text');
const arFlash = document.getElementById('ar-flash');

// State Management
let huntActive = false;
let testingMode = false;
let foundLocations = new Set();
let foundExtraLocations = new Set(); // keys of found bonus (off-track) locations

// Site configuration – loaded from /api/config on startup; falls back to current origin
let siteDomain = window.location.origin;
(async function loadSiteConfig() {
    try {
        const r = await fetch('/api/config');
        if (r.ok) {
            const cfg = await r.json();
            if (cfg && cfg.siteDomain) siteDomain = cfg.siteDomain;
        }
    } catch (e) { /* use fallback */ }
})();

// Timer state for treasure hunt
let huntStartTime = null; // Absolute time when first location was found
let lastDiscoveryTime = null; // Time when last location was found

// Rasnov geographic coordinates (used for weather API)
const RASNOV_LATITUDE = 45.59;
const RASNOV_LONGITUDE = 25.46;

// Timer handle for the reset-progress confirmation button auto-revert
let resetConfirmTimeout = null;
let userLocation = null;
let arStream = null;
let currentARLocation = null;
let firstDiscoveryPending = false; // true when name prompt should follow discovery modal
let surveyPromptPending = false; // true when survey prompt should follow discovery/name modal

// Three.js / AR 3D state
let arThreeRenderer = null;
let arThreeMixer = null;
let arThreeClock = null;
let arAnimationId = null;
let arBearReady = false;
let arBearOnScreen = false; // true once bear is visible in the viewport (during or after walk-in)

// Camera motion / orientation state (for "move camera to find Grizzly" AR mode)
let arOrientationHandler = null;  // active deviceorientation listener
let arOrientationAbsHandler = null; // absolute (true-north) orientation listener
let arCompassBearing = null;       // current device compass heading (degrees, true north)
let arCompassAbsolute = false;     // whether compass is calibrated to true north
let arBearVisible = false;         // whether bear is currently shown in compass-AR mode
let arTargetBearing = null;        // bearing from user to the target location
let arBearVisibleCheckId = null;   // setInterval ID for emoji-fallback on-screen polling

// WebXR state
let arXRSession = null;        // active XRSession (immersive-ar)
let arXRMode = false;          // true while a WebXR session is active
let arXRScene = null;          // Three.js Scene ref kept for screenshot
let arXRCamera = null;         // Three.js Camera ref kept for screenshot
let arXRBearGroup = null;      // placed bear Group ref kept for screenshot
let arXRCapturePending = false; // signal animation loop to render screenshot next frame

// ==================== Cookie Helpers ====================
function setCookie(name, value, days = 365) {
    const expires = new Date();
    expires.setTime(expires.getTime() + days * 24 * 60 * 60 * 1000);
    const secure = window.location.protocol === 'https:' ? ';Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(value)};expires=${expires.toUTCString()};path=/;SameSite=Strict${secure}`;
}

function getCookie(name) {
    const nameEQ = name + '=';
    const ca = document.cookie.split(';');
    for (let c of ca) {
        c = c.trim();
        if (c.indexOf(nameEQ) === 0) {
            return decodeURIComponent(c.substring(nameEQ.length));
        }
    }
    return null;
}

// ==================== UUID Helper ====================
function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    // Fallback UUID v4
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// ==================== User Account & Points System ====================
let currentUser = null;
const POINTS_PER_LOCATION = 10;
const COMPLETION_BONUS = 50;

// Initialize user from localStorage or cookie or create anonymous session
async function initializeUser() {
    const savedUser = localStorage.getItem('rasnov_user') || getCookie('rasnov_user');
    if (savedUser) {
        try {
            currentUser = JSON.parse(savedUser);
            // Migrate legacy user format (pre-UUID) to UUID-based format
            if (!currentUser.uuid) {
                currentUser.uuid = generateUUID();
                if (currentUser.username && !currentUser.username.startsWith('guest_')) {
                    currentUser.displayName = currentUser.username.substring(0, 30);
                    currentUser.hasSetName = true;
                } else {
                    currentUser.displayName = null;
                    currentUser.hasSetName = false;
                }
                delete currentUser.isAnonymous;
                saveUserToLocalStorage();
            }
        } catch (e) {
            console.error('Failed to load user from storage:', e);
            createAnonymousUser();
        }
    } else {
        createAnonymousUser();
    }
    updateUserDisplayUI();
    // Ensure server has the user record, then background-sync state
    await createOrEnsureServerUser();
    syncWithServer();
}

// Create an anonymous user account with a unique UUID
function createAnonymousUser() {
    currentUser = {
        uuid: generateUUID(),
        displayName: null,
        hasSetName: false,
        totalPoints: 0,
        locationsFound: [],
        completedAt: null,
        createdAt: new Date().toISOString()
    };
    saveUserToLocalStorage();
}

// Save user to localStorage and cookie for device-side persistence
function saveUserToLocalStorage() {
    const data = JSON.stringify(currentUser);
    localStorage.setItem('rasnov_user', data);
    try {
        setCookie('rasnov_user', data);
    } catch (e) {
        console.warn('Could not save progress to cookie:', e);
    }
}

// Ensure server has a corresponding user record (best-effort)
async function createOrEnsureServerUser() {
    if (!currentUser || !currentUser.uuid) return;
    try {
        await fetch('/api/user/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uuid: currentUser.uuid, displayName: currentUser.displayName })
        });
    } catch (e) {
        console.log('Could not create/ensure server user (offline or server unreachable)', e.message || e);
    }
}

// Background-sync local state with server to handle desyncs (e.g. server restart)
async function syncWithServer() {
    if (!currentUser || !currentUser.uuid) return;
    try {
        const response = await fetch(`/api/user/${encodeURIComponent(currentUser.uuid)}`);
        if (response.status === 404) {
            // Server lost our data - re-create user and re-upload all found locations
            await createOrEnsureServerUser();
            for (const locationKey of currentUser.locationsFound) {
                const location = huntLocations[locationKey];
                if (!location) continue;
                fetch(`/api/user/${encodeURIComponent(currentUser.uuid)}/location-found`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ locationKey, locationName: location.name, isCompletion: false })
                }).catch(() => {});
            }
        } else if (response.ok) {
            const serverUser = await response.json();
            // Merge any locations the server has that local doesn't (edge case)
            let changed = false;
            for (const loc of (serverUser.locationsFound || [])) {
                if (!currentUser.locationsFound.includes(loc)) {
                    currentUser.locationsFound.push(loc);
                    changed = true;
                }
            }
            // Adopt server points if higher (server is authoritative after confirmed awards)
            if (serverUser.totalPoints > currentUser.totalPoints) {
                currentUser.totalPoints = serverUser.totalPoints;
                changed = true;
            }
            if (changed) {
                saveUserToLocalStorage();
                updateUserDisplayUI();
            }
        }
    } catch (e) {
        console.log('Background sync skipped (offline):', e.message);
    }
}

// Set a display name for the user and sync to server
function setUsername(username) {
    if (!username || username.trim() === '') {
        showNotification('Please enter a valid name', 'warning');
        return false;
    }

    const trimmed = username.trim().substring(0, 30);
    currentUser.displayName = trimmed;
    currentUser.hasSetName = true;
    saveUserToLocalStorage();
    updateUserDisplayUI();
    showNotification(`Welcome, ${trimmed}!`, 'success');

    // Sync name to server (fire-and-forget)
    if (currentUser.uuid) {
        fetch(`/api/user/${encodeURIComponent(currentUser.uuid)}/set-name`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ displayName: trimmed })
        }).catch(e => console.log('Could not sync name to server:', e.message));
    }
    return true;
}

// Award points for finding a location
async function awardPoints(locationKey, locationName) {
    if (!currentUser) return;
    
    const isAlreadyFound = currentUser.locationsFound.includes(locationKey);
    if (isAlreadyFound) {
        console.log(`Location ${locationKey} already found by user`);
        return;
    }
    
    const isCompletion = foundLocations.size === Object.keys(huntLocations).length;
    
    // Add to user's found locations
    currentUser.locationsFound.push(locationKey);
    
    // Calculate points
    const pointsAwarded = POINTS_PER_LOCATION;
    let bonusPoints = 0;
    
    if (isCompletion) {
        bonusPoints = COMPLETION_BONUS;
        currentUser.completedAt = new Date().toISOString();
    }
    
    currentUser.totalPoints += pointsAwarded + bonusPoints;
    
    // Save to localStorage and cookie
    saveUserToLocalStorage();
    
    // Try to sync with server (optional, non-blocking)
    try {
        const response = await fetch(`/api/user/${encodeURIComponent(currentUser.uuid)}/location-found`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                locationKey,
                locationName,
                isCompletion
            })
        });
        
        if (!response.ok && response.status !== 400) {
            console.warn('Failed to sync points with server:', response.statusText);
        }
    } catch (e) {
        console.log('Server sync unavailable (offline mode):', e.message);
    }
    
    // Update UI
    updateUserDisplayUI();
    
    // Show points notification
    showPointsNotification(pointsAwarded, bonusPoints, locationName);
    
    return {
        pointsAwarded,
        bonusPoints,
        totalPoints: currentUser.totalPoints
    };
}

// Update user display in header
function updateUserDisplayUI() {
    const userElement = document.getElementById('user-points-display');
    if (userElement && currentUser) {
        const name = escapeHtml(currentUser.displayName || 'Explorer');
        userElement.innerHTML = `
            <span class="user-name">${name}</span>
            <span class="user-points">⭐ ${currentUser.totalPoints} pts</span>
        `;
    }
}

// Show a celebration notification when points are earned
function showPointsNotification(points, bonusPoints = 0, locationName = '') {
    let message = `<strong>+${points} points</strong>`;
    if (locationName) {
        message = `<strong>${locationName}</strong><br>+${points} points`;
    }
    if (bonusPoints > 0) {
        message += `<br><strong>🎉 +${bonusPoints} completion bonus!</strong>`;
    }
    
    const notificationEl = document.createElement('div');
    notificationEl.className = 'points-notification';
    notificationEl.innerHTML = message;
    document.body.appendChild(notificationEl);
    
    // Animate in
    setTimeout(() => notificationEl.classList.add('show'), 10);
    
    // Remove after 3 seconds
    setTimeout(() => {
        notificationEl.classList.remove('show');
        setTimeout(() => notificationEl.remove(), 300);
    }, 3000);
}

// Show user profile modal
function showUserProfile() {
    if (!currentUser) return;
    
    const displayName = escapeHtml(currentUser.displayName || 'Anonymous');
    const profileHTML = `
        <div class="user-profile-modal">
            <div class="profile-header">
                <h2>Your Profile</h2>
                <button class="modal-close" onclick="closeModal('user-profile-modal')">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="profile-content">
                <div class="profile-stat">
                    <span class="stat-label">Name</span>
                    <span class="stat-value">${displayName}</span>
                </div>
                <div class="profile-stat">
                    <span class="stat-label">Total Points</span>
                    <span class="stat-value" style="color: #f39c12; font-weight: bold;">⭐ ${currentUser.totalPoints}</span>
                </div>
                <div class="profile-stat">
                    <span class="stat-label">Locations Found</span>
                    <span class="stat-value">${currentUser.locationsFound.length} / 8</span>
                </div>
                <div class="profile-stat">
                    <span class="stat-label">Hunt Status</span>
                    <span class="stat-value">${currentUser.completedAt ? '✅ Completed' : '🔄 In Progress'}</span>
                </div>
                ${currentUser.completedAt ? `
                    <div class="profile-stat">
                        <span class="stat-label">Completed Date</span>
                        <span class="stat-value">${new Date(currentUser.completedAt).toLocaleDateString()}</span>
                    </div>
                ` : ''}
            </div>
            <div class="profile-actions">
                <div style="margin-bottom: 1rem;">
                    <input type="text" id="new-username" placeholder="${currentUser.hasSetName ? 'Change name' : 'Enter your name'}" maxlength="30" style="padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; width: 100%;">
                    <button class="card-button" style="width: 100%; margin-top: 0.5rem;" onclick="updateUsernameInModal()">${currentUser.hasSetName ? 'Update Name' : 'Set Name'}</button>
                </div>
                <button class="card-button reset-progress-btn" id="reset-progress-btn" onclick="resetProgress()">Reset Progress</button>
            </div>
        </div>
    `;
    
    const modal = document.getElementById('user-profile-modal');
    if (modal) {
        modal.querySelector('.modal-content').innerHTML = profileHTML;
    }
}

// Update username from profile modal
function updateUsernameInModal() {
    const input = document.getElementById('new-username');
    if (input && setUsername(input.value)) {
        showUserProfile();
    }
}

// Reset all hunt progress (preserves identity)
function resetProgress() {
    const btn = document.getElementById('reset-progress-btn');
    if (btn && btn.dataset.confirming !== 'true') {
        // First click: switch button to "Are you sure?" state
        btn.dataset.confirming = 'true';
        btn.textContent = 'Are you sure?';
        btn.style.background = 'linear-gradient(135deg, #e74c3c 0%, #c0392b 100%)';
        btn.style.boxShadow = '0 4px 12px rgba(231, 76, 60, 0.4)';
        // Auto-revert after 4 seconds if not confirmed
        clearTimeout(resetConfirmTimeout);
        resetConfirmTimeout = setTimeout(() => {
            if (btn && btn.dataset.confirming === 'true') {
                btn.dataset.confirming = 'false';
                btn.textContent = 'Reset Progress';
                btn.style.background = '';
                btn.style.boxShadow = '';
            }
        }, 4000);
        return;
    }

    // Second click: execute reset
    currentUser.locationsFound = [];
    currentUser.totalPoints = 0;
    currentUser.completedAt = null;
    foundLocations.clear();
    
    // Reset timer state
    huntStartTime = null;
    lastDiscoveryTime = null;
    
    saveUserToLocalStorage();
    updateUserDisplayUI();
    updateProgress();

    // Reset hunt item UI
    huntItems.forEach(item => {
        item.classList.remove('found');
        const icon = item.querySelector('i');
        if (icon) icon.className = 'fas fa-lock';
        const photo = item.querySelector('.hunt-item-photo');
        if (photo) photo.remove();
    });

    // Remove dynamically-added extra location cards
    document.querySelectorAll('.hunt-item.extra-location').forEach(el => el.remove());

    // Clear saved photos
    Object.keys(huntLocations).forEach(key => {
        localStorage.removeItem(`ar_photo_${key}`);
    });

    // Clear collage unlock milestone flags so popups show again on replay
    localStorage.removeItem('rasnov_collage_silver_shown');
    localStorage.removeItem('rasnov_collage_gold_shown');

    // Reset hunt buttons
    huntActive = false;
    if (startHuntBtn) {
        startHuntBtn.innerHTML = '<i class="fas fa-play"></i> Start Hunt';
        startHuntBtn.classList.remove('active-hunt', 'hunt-complete');
        startHuntBtn.style.display = '';
    }
    if (resetHuntBtn) resetHuntBtn.style.display = 'none';
    if (scanQrBtn) scanQrBtn.disabled = true;

    // Hide the Next Site banner
    const nextSiteBanner = document.getElementById('next-site-banner');
    if (nextSiteBanner) nextSiteBanner.style.display = 'none';

    closeModal('user-profile-modal');
    showNotification('Progress reset successfully', 'info');
}

// Add a saved photo thumbnail to a hunt item element
function addPhotoToHuntItem(locationKey, huntItem) {
    if (!huntItem) return;
    const savedPhoto = localStorage.getItem(`ar_photo_${locationKey}`);
    if (savedPhoto && savedPhoto.startsWith('data:image/jpeg;base64,')) {
        const existing = huntItem.querySelector('.hunt-item-photo');
        if (existing) {
            existing.src = savedPhoto;
        } else {
            const photoEl = document.createElement('img');
            photoEl.src = savedPhoto;
            photoEl.className = 'hunt-item-photo';
            photoEl.alt = 'Grizzly bear photo';
            huntItem.appendChild(photoEl);
        }
    }
}

// Restore hunt UI state from saved user data on page load
function restoreHuntState() {
    if (!currentUser || !currentUser.locationsFound) return;

    currentUser.locationsFound.forEach(locationKey => {
        if (huntLocations[locationKey]) {
            // Regular hunt location
            foundLocations.add(locationKey);
            const huntItem = document.querySelector(`.hunt-item[data-location="${locationKey}"]`);
            if (huntItem) {
                huntItem.classList.add('found');
                const icon = huntItem.querySelector('i');
                if (icon) icon.className = 'fas fa-check-circle';
                addPhotoToHuntItem(locationKey, huntItem);
            }
        } else {
            // Extra (bonus) location – restore its card without re-awarding points
            const extraInfo = parseExtraLocation(locationKey);
            if (extraInfo) {
                foundExtraLocations.add(locationKey);
                addExtraHuntItem(extraInfo);
            }
        }
    });

    updateProgress();

    if (foundLocations.size > 0 && foundLocations.size < Object.keys(huntLocations).length) {
        huntActive = true;
        if (startHuntBtn) startHuntBtn.style.display = 'none';
        if (resetHuntBtn) resetHuntBtn.style.display = '';
        if (scanQrBtn) scanQrBtn.disabled = false;
        // Update Next Site banner based on the most recently found regular location
        const lastRegular = [...currentUser.locationsFound].reverse().find(k => huntLocations[k]);
        if (lastRegular) updateNextSiteBanner(lastRegular);
    } else if (foundLocations.size === Object.keys(huntLocations).length) {
        if (startHuntBtn) {
            startHuntBtn.innerHTML = '<i class="fas fa-trophy"></i> Completed!';
            startHuntBtn.classList.remove('active-hunt');
            startHuntBtn.classList.add('hunt-complete');
        }
    }
}

// ==================== Leaderboard System ====================

// Load and display leaderboard
async function loadLeaderboard() {
    try {
        const response = await fetch('/api/leaderboard');
        if (!response.ok) throw new Error('Failed to fetch leaderboard');
        
        const leaderboard = await response.json();
        displayLeaderboard(leaderboard);
    } catch (error) {
        console.error('Error loading leaderboard:', error);
        showNotification('Failed to load leaderboard', 'warning');
        document.getElementById('leaderboard-body').innerHTML = `
            <tr>
                <td colspan="5" style="text-align: center; padding: 2rem; color: #999;">
                    <i class="fas fa-exclamation-circle"></i> Failed to load leaderboard
                </td>
            </tr>
        `;
    }
}

// Display leaderboard data in table
function displayLeaderboard(leaderboard) {
    const leaderboardBody = document.getElementById('leaderboard-body');
    
    if (!leaderboard || leaderboard.length === 0) {
        leaderboardBody.innerHTML = `
            <tr>
                <td colspan="5" style="text-align: center; padding: 2rem; color: #999;">
                    <i class="fas fa-chart-line"></i> No players on leaderboard yet. Start the hunt to join!
                </td>
            </tr>
        `;
        document.getElementById('total-players').textContent = '0';
        return;
    }
    
    // Generate table rows
    const rows = leaderboard.map((player, index) => {
        const rank = player.rank;
        const isCurrentUser = currentUser && player.uuid && player.uuid === currentUser.uuid;
        const topClass = rank <= 3 ? `top-3 rank-${rank}` : '';
        const medalEmoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
        
        const statusClass = player.completedAt ? 'completed' : 'in-progress';
        const statusIcon = player.completedAt ? '✅' : '🔄';
        const statusText = player.completedAt ? 'Completed' : 'In Progress';
        
        const highlightClass = isCurrentUser ? ' style="background: #e3f2fd; font-weight: 600;"' : '';
        
        return `
            <tr class="${topClass}"${highlightClass}>
                <td class="rank-col">
                    <div class="rank-badge">${medalEmoji || rank}</div>
                </td>
                <td class="name-col">
                    <div class="player-name">
                        <span>${player.username}</span>
                        ${isCurrentUser ? '<span class="player-badge">YOU</span>' : ''}
                    </div>
                </td>
                <td class="points-col">
                    <span class="points-value">⭐ ${player.totalPoints}</span>
                </td>
                <td class="locations-col">
                    ${player.locationsFound} / 8
                </td>
                <td class="status-col">
                    <span class="completion-status ${statusClass}">
                        ${statusIcon} ${statusText}
                    </span>
                </td>
            </tr>
        `;
    }).join('');
    
    leaderboardBody.innerHTML = rows;
    
    // Update user stats
    const userRank = currentUser ? leaderboard.findIndex(p => p.uuid && p.uuid === currentUser.uuid) + 1 : '-';
    document.getElementById('user-rank').textContent = userRank > 0 ? `#${userRank}` : '-';
    document.getElementById('user-leaderboard-points').textContent = currentUser ? `⭐ ${currentUser.totalPoints}` : '-';
    document.getElementById('total-players').textContent = leaderboard.length;
    
    // Add row click event for details (optional)
    document.querySelectorAll('.leaderboard-table tbody tr').forEach((row, index) => {
        row.style.cursor = 'pointer';
        row.addEventListener('mouseenter', function() {
            this.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
        });
        row.addEventListener('mouseleave', function() {
            this.style.boxShadow = 'none';
        });
    });
}

// Auto-load leaderboard when leaderboard tab is clicked
document.addEventListener('DOMContentLoaded', function() {
    // Initialize user session and other startup tasks
    initializeUser();
});

// ==================== Treasure Hunt Locations ====================

// Treasure Hunt Locations (for testing and location-based discovery)
const huntLocations = {
    fortress: { 
        lat: 45.5889, lng: 25.4631, 
        name: 'Rasnov Fortress Gate', 
        qr: 'RASNOV_FORTRESS', 
        fact: 'The fortress was built in 1215 by Teutonic Knights to protect against Mongol invasions.',
        hint: 'Next, discover the legendary source of water that saved the fortress during sieges - the Ancient Well!'
    },
    well: { 
        lat: 45.5892, lng: 25.4635, 
        name: 'Ancient Well', 
        qr: 'RASNOV_WELL', 
        fact: 'This 143-meter deep well was dug by Turkish prisoners and took 17 years to complete.',
        hint: 'Now climb high to the Watch Tower where guards kept lookout for approaching enemies!'
    },
    tower: { 
        lat: 45.5885, lng: 25.4640, 
        name: 'Watch Tower', 
        qr: 'RASNOV_TOWER', 
        fact: 'The watch tower provided 360-degree views to spot approaching enemies from miles away.',
        hint: 'Seek the Old Church where villagers found sanctuary and spiritual guidance for centuries!'
    },
    church: { 
        lat: 45.5890, lng: 25.4638, 
        name: 'Old Church', 
        qr: 'RASNOV_CHURCH', 
        fact: 'This Gothic church dates back to the 14th century and still holds services today.',
        hint: 'Journey to the Village Museum to explore authentic Romanian traditions and artifacts!'
    },
    museum: { 
        lat: 45.5850, lng: 25.4600, 
        name: 'Village Museum', 
        qr: 'RASNOV_MUSEUM', 
        fact: 'The museum houses over 300 artifacts showcasing traditional Romanian village life.',
        hint: 'Adventure awaits at the Mountain Peak - breathtaking views from 1650m elevation!'
    },
    peak: { 
        lat: 45.5700, lng: 25.4500, 
        name: 'Mountain Peak', 
        qr: 'RASNOV_PEAK', 
        fact: 'At 1650m elevation, this peak offers views of the entire Barsa region on clear days.',
        hint: 'Head down to the historic Town Square where markets and festivals have thrived for 600 years!'
    },
    square: { 
        lat: 45.5880, lng: 25.4620, 
        name: 'Town Square', 
        qr: 'RASNOV_SQUARE', 
        fact: 'The town square has been a gathering place for markets and festivals for over 600 years.',
        hint: 'One more adventure awaits - visit the amazing Dino Park with life-size dinosaur replicas!'
    },
    dino: { 
        lat: 45.5895, lng: 25.4625, 
        name: 'Dino Park Entrance', 
        name_ro: 'Intrarea Dino Parc',
        qr: 'RASNOV_DINO', 
        fact: 'Dino Park features over 100 life-size dinosaur replicas in their natural habitat settings.',
        fact_ro: 'Dino Parc are peste 100 de replici de dinozauri la scară naturală în habitat similar.',
        hint: 'Congratulations! You\'ve completed the entire Rasnov treasure hunt! 🎉',
        hint_ro: 'Felicitări! Ai terminat întreaga vânătoare în Râșnov! 🎉'
    }
};

// Circular treasure hunt order: scanning any location points to the next one in this loop
const huntOrder = ['fortress', 'well', 'tower', 'church', 'museum', 'peak', 'square', 'dino'];

// Returns the next unvisited location in the circular order after currentKey.
// Returns null if all locations have been found.
// Note: if currentKey is not in huntOrder (should not happen with valid data), falls back to
// returning the first unvisited location in order to avoid breaking the hunt.
function getNextUnvisitedLocation(currentKey) {
    const currentIndex = huntOrder.indexOf(currentKey);
    if (currentIndex === -1) return huntOrder.find(k => !foundLocations.has(k)) || null;
    for (let i = 1; i <= huntOrder.length; i++) {
        const nextKey = huntOrder[(currentIndex + i) % huntOrder.length];
        if (!foundLocations.has(nextKey)) return nextKey;
    }
    return null; // All locations found
}

// Returns the QR code URL for a given location key (used for printing/displaying QR codes).
// Resolves relative to hunt.html so it works regardless of deployment subdirectory.
function getQRCodeURL(locationKey) {
    const url = new URL('hunt.html', window.location.href);
    url.searchParams.set('location', encodeURIComponent(locationKey));
    return url.href;
}

// Update the "Next Site" banner to show the next location after currentKey
function updateNextSiteBanner(currentKey) {
    const banner = document.getElementById('next-site-banner');
    if (!banner) return;
    const nextKey = getNextUnvisitedLocation(currentKey);
    if (nextKey) {
        const nextLoc = huntLocations[nextKey];
        const nextName = localizedField(nextLoc, 'name') || nextLoc.name;
        banner.querySelector('.next-site-name').textContent = nextName;
        banner.style.display = '';
    } else {
        banner.style.display = 'none';
    }
}

// Show the first-visit welcome popup when arriving via QR code for the first time
function showWelcomeModal(currentLocationKey) {
    const nextKey = getNextUnvisitedLocation(currentLocationKey);
    const nextName = nextKey ? (localizedField(huntLocations[nextKey], 'name') || huntLocations[nextKey].name) : '';

    const msgEl = document.getElementById('welcome-message');
    if (msgEl) {
        msgEl.innerHTML = t('modal.welcome.message', { next: escapeHtml(nextName), interpolation: { escapeValue: false } });
    }

    openModal('welcome-modal');
}

// Callback when welcome modal is closed (proceed to regular discovery modal chain if needed)
let welcomeModalPendingKey = null;
function onWelcomeModalClose() {
    if (welcomeModalPendingKey) {
        welcomeModalPendingKey = null;
        // Show the discovery modal after the welcome modal closes
        setTimeout(() => openModal('discovery-modal'), 200);
    }
}

// Handle the ?location= URL parameter when the page loads (from a scanned QR code URL)
function handleURLParameters() {
    const urlParams = new URLSearchParams(window.location.search);
    const locationParam = urlParams.get('location');
    if (!locationParam) return;

    if (huntLocations[locationParam]) {
        // Regular hunt location
        if (!huntActive) {
            huntActive = true;
            if (startHuntBtn) startHuntBtn.style.display = 'none';
            if (resetHuntBtn) resetHuntBtn.style.display = '';
            if (scanQrBtn) scanQrBtn.disabled = false;
        }

        const isFirstVisit = foundLocations.size === 0 && foundExtraLocations.size === 0;

        if (!foundLocations.has(locationParam)) {
            // Small delay to allow page to finish rendering before showing modal
            setTimeout(() => {
                discoverLocation(locationParam, isFirstVisit);
            }, 600);
        } else {
            // Already found this location — just update the Next Site banner
            updateNextSiteBanner(locationParam);
            showNotification(`You've already visited ${huntLocations[locationParam].name}!`, 'info');
        }
    } else {
        // Check if it's an extra (bonus) location
        const extraInfo = parseExtraLocation(locationParam);
        if (extraInfo) {
            if (!foundExtraLocations.has(extraInfo.key)) {
                setTimeout(() => {
                    discoverExtraLocation(extraInfo);
                }, 600);
            } else {
                showNotification(`You've already found ${extraInfo.name}!`, 'info');
            }
        }
    }

    // Clean up the URL so refreshing doesn't re-trigger the discovery,
    // while preserving any other query parameters (e.g. utm_source).
    const cleanURL = new URL(window.location.href);
    cleanURL.searchParams.delete('location');
    window.history.replaceState({}, document.title, cleanURL.pathname + (cleanURL.search || ''));
}


function localizedField(obj, field) {
    if (currentLang && currentLang !== 'en') {
        const key = `${field}_` + currentLang;
        if (obj[key]) return obj[key];
    }
    return obj[field] || '';
}

// Tab Functionality
tabButtons.forEach(button => {
    button.addEventListener('click', () => {
        const targetTab = button.dataset.tab;
        
        // Remove active class from all buttons and contents
        tabButtons.forEach(btn => btn.classList.remove('active'));
        tabContents.forEach(content => content.classList.remove('active'));
        
        // Add active class to clicked button and corresponding content
        button.classList.add('active');
        document.getElementById(targetTab).classList.add('active');
    });
});

// Hunt Tab Functionality
document.querySelectorAll('.hunt-tab-btn').forEach(button => {
    button.addEventListener('click', () => {
        const targetPane = button.dataset.huntTab;
        
        // Remove active class from all hunt tab buttons and panes
        document.querySelectorAll('.hunt-tab-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.hunt-tab-pane').forEach(pane => pane.classList.remove('active'));
        
        // Add active class to clicked button and corresponding pane
        button.classList.add('active');
        document.getElementById(targetPane).classList.add('active');
        
        // Load data when tabs are opened
        if (targetPane === 'leaderboard-pane') {
            loadLeaderboard();
        }
        if (targetPane === 'unlocks-pane') {
            renderUnlocksTab();
        }
    });
});

// Navigation - dynamically set active class based on current page
(function setActiveNavLink() {
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    navLinks.forEach(link => {
        const href = link.getAttribute('href') || '';
        const linkPage = href.split('/').pop().split('#')[0] || 'index.html';
        // Mark as active if link points to current page (ignoring hash fragments)
        if (linkPage === currentPage) {
            link.classList.add('active');
        } else {
            link.classList.remove('active');
        }
    });
})();

navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
        const href = link.getAttribute('href');
        // Only intercept in-page anchor links (starting with #)
        if (!href || !href.startsWith('#')) return;

        e.preventDefault();
        const targetId = href.substring(1);
        const targetElement = document.getElementById(targetId);
        
        if (targetElement) {
            navLinks.forEach(l => l.classList.remove('active'));
            link.classList.add('active');
            
            targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
            
            // Close mobile menu if open
            if (navList && navList.classList.contains('active')) {
                navList.classList.remove('active');
            }
        }
    });
});

// Mobile Menu Toggle
if (navToggle) {
    navToggle.addEventListener('click', () => {
        navList.classList.toggle('active');
    });
}

// Scroll to Section Function
function scrollToSection(sectionId) {
    const section = document.getElementById(sectionId);
    if (section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

// Weather Widget
async function updateWeather() {
    const tempElement = document.getElementById('temp');
    try {
        // Open-Meteo: free, no API key required. Rasnov coords: 45.59°N, 25.46°E
        const response = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${RASNOV_LATITUDE}&longitude=${RASNOV_LONGITUDE}&current=temperature_2m`
        );
        if (!response.ok) throw new Error('Weather fetch failed');
        const data = await response.json();
        const temp = Math.round(data.current.temperature_2m);
        tempElement.textContent = `${temp}°C`;
    } catch {
        // Fallback: keep existing display unchanged
    }
}

updateWeather();
setInterval(updateWeather, 300000); // Update every 5 minutes

// AR Treasure Hunt Functions
if (startHuntBtn) startHuntBtn.addEventListener('click', () => {
    if (!huntActive) {
        huntActive = true;
        startHuntBtn.style.display = 'none';
        resetHuntBtn.style.display = '';
        showNotification('Treasure hunt started! Find all 8 locations.', 'success');
        
        // Enable other buttons
        if (scanQrBtn) scanQrBtn.disabled = false;
    }
});

// Timer for reset-hunt confirmation button auto-revert
let resetHuntConfirmTimeout = null;

if (resetHuntBtn) resetHuntBtn.addEventListener('click', () => {
    if (resetHuntBtn.dataset.confirming !== 'true') {
        // First click: switch to "Are you sure?" state
        resetHuntBtn.dataset.confirming = 'true';
        resetHuntBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Are you sure?';
        resetHuntBtn.style.background = 'linear-gradient(135deg, #e74c3c 0%, #c0392b 100%)';
        resetHuntBtn.style.color = 'white';
        resetHuntBtn.style.borderColor = '#e74c3c';
        clearTimeout(resetHuntConfirmTimeout);
        resetHuntConfirmTimeout = setTimeout(() => {
            if (resetHuntBtn.dataset.confirming === 'true') {
                resetHuntBtn.dataset.confirming = 'false';
                resetHuntBtn.innerHTML = '<i class="fas fa-redo"></i> Reset Hunt';
                resetHuntBtn.style.background = '';
                resetHuntBtn.style.color = '';
                resetHuntBtn.style.borderColor = '';
            }
        }, 4000);
        return;
    }

    // Second click: execute reset
    resetHuntBtn.dataset.confirming = 'false';
    resetHuntBtn.innerHTML = '<i class="fas fa-redo"></i> Reset Hunt';
    resetHuntBtn.style.background = '';
    resetHuntBtn.style.color = '';
    resetHuntBtn.style.borderColor = '';
    clearTimeout(resetHuntConfirmTimeout);
    resetProgress();
});

if (scanQrBtn) scanQrBtn.addEventListener('click', () => {
    if (!huntActive) {
        showNotification('Please start the hunt first!', 'warning');
        return;
    }
    openModal('qr-modal');
    startQRScanner();
});

// ==================== LOCATION-BASED DISCOVERY (Commented out for now) ====================
// NOTE: The GPS/geolocation feature is preserved here for potential future reimplementation.
// To re-enable it, uncomment the useLocationBtn event listener below and the
// checkNearbyLocations() and calculateDistance() functions further in this file.
// Also restore the "Use Location" button visibility in hunt.html.
// ========================================================================================

/* --- useLocationBtn click handler (geolocation disabled) ---
useLocationBtn.addEventListener('click', () => {
    if (!huntActive) {
        showNotification('Please start the hunt first!', 'warning');
        return;
    }
    
    if ('geolocation' in navigator) {
        showNotification('Getting your location...', 'info');
        navigator.geolocation.getCurrentPosition(
            position => {
                userLocation = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude
                };
                checkNearbyLocations();
            },
            error => {
                showNotification('Could not get your location. Please enable location services.', 'error');
            }
        );
    } else {
        showNotification('Geolocation is not supported by your browser.', 'error');
    }
});
--- end geolocation handler --- */

/* TEST LOCATION BUTTON – handler commented out intentionally.
   The button is also commented out in hunt.html (search for "TEST LOCATION BUTTON").
   Kept here in case it needs to be restored in a future revision.
   To re-enable: uncomment this block and re-enable the button in hunt.html.

// Test Location Button - Launch AR for first unfound location
if (testLocationBtn) testLocationBtn.addEventListener('click', () => {
    // Find first unfound location
    const locationKeys = Object.keys(huntLocations);
    let targetLocation = locationKeys[0]; // Default to fortress
    
    for (const key of locationKeys) {
        if (!foundLocations.has(key)) {
            targetLocation = key;
            break;
        }
    }
    
    // Check if browser supports getUserMedia
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showNotification('Camera access is not supported on this browser. Please use a modern browser with HTTPS.', 'error');
        return;
    }
    
    showNotification(`Testing at ${huntLocations[targetLocation].name}...`, 'info');
    launchARExperience(targetLocation, true);
});
*/

// AR Close Button
if (arCloseBtn) arCloseBtn.addEventListener('click', () => {
    closeARView();
});

// AR Capture Button – take photo of the bear
if (arCaptureBtn) arCaptureBtn.addEventListener('click', () => {
    captureARPhoto();
});

function handleTestingModeClick(e) {
    if (testingMode && huntActive) {
        const locationKey = this.dataset.location;
        if (!foundLocations.has(locationKey)) {
            discoverLocation(locationKey);
        }
    }
}

let qrScannerActive = false;
let qrScannerCanvas = null;
let qrScannerContext = null;

// Simple photo capture (no AR) — used after QR code discovery
let photoCaptureStream = null;
let photoCaptureLocationKey = null;
let photoCaptureQueuedKey = null; // queued key to auto-open camera after modal chain

function triggerQueuedPhotoCapture() {
    if (photoCaptureQueuedKey) {
        const key = photoCaptureQueuedKey;
        photoCaptureQueuedKey = null;
        setTimeout(() => startPhotoCapture(key), MODAL_TRANSITION_DELAY);
    }
}

function startPhotoCapture(locationKey) {
    photoCaptureLocationKey = locationKey;
    const loc = huntLocations[locationKey];
    const localizedName = loc ? (localizedField(loc, 'name') || loc.name) : 'Location';
    const titleEl = document.getElementById('photo-capture-title');
    if (titleEl) titleEl.textContent = `📸 ${localizedName}`;

    const helpEl = document.getElementById('photo-capture-help');
    if (helpEl) helpEl.textContent = 'Now take a picture of this site!';

    // Reset capture button state
    const btn = document.getElementById('photo-capture-btn');
    if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-camera"></i>';
        btn.classList.remove('captured');
    }

    openModal('photo-capture-modal');

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
            .then(stream => {
                photoCaptureStream = stream;
                const video = document.getElementById('photo-capture-video');
                if (video) {
                    video.srcObject = stream;
                    video.play();
                }
            })
            .catch(err => {
                console.error('Camera error for photo capture:', err);
                showNotification('Could not access camera.', 'warning');
                closePhotoCapture();
            });
    } else {
        showNotification('Camera not supported on this device.', 'warning');
        closePhotoCapture();
    }
}

function captureLocationPhoto() {
    const video = document.getElementById('photo-capture-video');
    if (!video || !photoCaptureLocationKey) return;

    const cw = video.videoWidth || 640;
    const ch = video.videoHeight || 480;

    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, cw, ch);

    // Watermark
    ctx.font = `bold ${Math.round(cw * 0.033)}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('📍 Rasnov Treasure Hunt', 10, ch - 8);

    // Flash effect
    const flash = document.getElementById('photo-capture-flash');
    if (flash) {
        flash.classList.add('flashing');
        flash.addEventListener('animationend', () => flash.classList.remove('flashing'), { once: true });
    }

    // Disable button to prevent double-tap
    const captureBtn = document.getElementById('photo-capture-btn');
    if (captureBtn) {
        captureBtn.disabled = true;
        captureBtn.innerHTML = '<i class="fas fa-check"></i>';
        captureBtn.classList.add('captured');
    }

    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    try {
        localStorage.setItem(`ar_photo_${photoCaptureLocationKey}`, dataUrl);
    } catch (e) {
        console.warn('Could not save photo to localStorage:', e);
        showNotification('📸 Photo taken! (Could not save – storage full)', 'warning');
        setTimeout(() => closePhotoCapture(), 600);
        return;
    }

    const locKey = photoCaptureLocationKey;
    const loc = huntLocations[locKey];
    const localizedName = loc ? (localizedField(loc, 'name') || loc.name) : 'Location';

    setTimeout(() => {
        closePhotoCapture();

        // Update hunt item thumbnail
        const huntItem = document.querySelector(`.hunt-item[data-location="${locKey}"]`);
        if (huntItem) addPhotoToHuntItem(locKey, huntItem);

        // Update discovery modal photo section if still open
        const photoSection = document.getElementById('discovery-photo-section');
        if (photoSection) {
            photoSection.innerHTML = `<p class="ar-photo-label">📸 Your photo:</p>
                <img src="${dataUrl}" class="ar-captured-photo" alt="Your photo at ${escapeHtml(localizedName)}">`;
        }

        showNotification('📸 Photo saved to your collage!', 'success');
        renderUnlocksTab();
    }, 600);
}

function closePhotoCapture() {
    if (photoCaptureStream) {
        photoCaptureStream.getTracks().forEach(t => t.stop());
        photoCaptureStream = null;
    }
    const video = document.getElementById('photo-capture-video');
    if (video) video.srcObject = null;
    closeModal('photo-capture-modal');
}

function startQRScanner() {
    const video = document.getElementById('qr-video');
    
    // Check if browser supports getUserMedia
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
            .then(stream => {
                video.srcObject = stream;
                video.play();
                qrScannerActive = true;
                
                // Create canvas for QR code detection
                if (!qrScannerCanvas) {
                    qrScannerCanvas = document.createElement('canvas');
                    qrScannerContext = qrScannerCanvas.getContext('2d');
                }
                
                // Start scanning for QR codes
                requestAnimationFrame(scanQRCode);
                
                // Simulate QR code detection in testing mode
                if (testingMode) {
                    setTimeout(() => {
                        const randomLocation = Object.keys(huntLocations)[Math.floor(Math.random() * Object.keys(huntLocations).length)];
                        simulateQRScan(randomLocation);
                    }, 2000);
                }
            })
            .catch(err => {
                console.error('Error accessing camera:', err);
                showNotification('Could not access camera. Testing mode allows manual selection.', 'warning');
                
                // In testing mode or if camera fails, show QR code options
                showQRCodeOptions();
            });
    } else {
        showQRCodeOptions();
    }
}

function scanQRCode() {
    const video = document.getElementById('qr-video');
    
    if (!qrScannerActive || !video || video.readyState !== video.HAVE_ENOUGH_DATA) {
        if (qrScannerActive) {
            requestAnimationFrame(scanQRCode);
        }
        return;
    }
    
    // Set canvas size to match video
    qrScannerCanvas.width = video.videoWidth;
    qrScannerCanvas.height = video.videoHeight;
    
    // Draw current video frame to canvas
    qrScannerContext.drawImage(video, 0, 0, qrScannerCanvas.width, qrScannerCanvas.height);
    
    // Get image data and scan for QR code
    const imageData = qrScannerContext.getImageData(0, 0, qrScannerCanvas.width, qrScannerCanvas.height);
    
    // Use jsQR library to decode QR code (if available)
    if (typeof jsQR !== 'undefined') {
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: "attemptBoth",
        });
        
        if (code && code.data) {
            // QR code detected! Process it
            processQRCode(code.data);
            return; // Stop scanning
        }
    }
    
    // Continue scanning
    if (qrScannerActive) {
        requestAnimationFrame(scanQRCode);
    }
}

// Regex for the extra location key format: alphanumerics/underscores/spaces/hyphens/apostrophes then -<1-3 digit points>
const EXTRA_LOCATION_RE = /^([A-Za-z0-9][A-Za-z0-9_ '-]{0,49})-(\d{1,3})$/;

// Parse a location parameter as an extra bonus location.
// Returns { key, name, points } or null if the format does not match.
function parseExtraLocation(locationParam) {
    const m = EXTRA_LOCATION_RE.exec(locationParam);
    if (!m) return null;
    const points = parseInt(m[2], 10);
    if (points < 1 || points > 999) return null;
    return { key: locationParam, name: m[1].replace(/_/g, ' '), points };
}

function processQRCode(qrData) {
    // First try to parse as a URL with a 'location' parameter (new URL-based QR code format)
    let foundLocationKey = null;
    let extraLocationInfo = null;
    try {
        const url = new URL(qrData);
        // Only accept QR codes from our own site domain to avoid accepting random URLs
        const expectedHost = new URL(siteDomain).host;
        if (url.host === expectedHost) {
            const locationParam = url.searchParams.get('location');
            if (locationParam) {
                if (huntLocations[locationParam]) {
                    foundLocationKey = locationParam;
                } else {
                    extraLocationInfo = parseExtraLocation(locationParam);
                }
            }
        }
    } catch (e) {
        // Not a valid URL — fall through to legacy matching below
    }

    // Fall back to legacy QR string matching (e.g. 'RASNOV_FORTRESS')
    if (!foundLocationKey && !extraLocationInfo) {
        for (const [key, location] of Object.entries(huntLocations)) {
            if (location.qr === qrData) {
                foundLocationKey = key;
                break;
            }
        }
    }

    if (foundLocationKey) {
        if (!foundLocations.has(foundLocationKey)) {
            qrScannerActive = false;
            const isFirstVisit = foundLocations.size === 0 && foundExtraLocations.size === 0;
            discoverLocation(foundLocationKey, isFirstVisit);
            closeModal('qr-modal');
            showNotification('QR Code scanned successfully!', 'success');
        } else {
            showNotification('You already found this location!', 'info');
        }
    } else if (extraLocationInfo) {
        if (!foundExtraLocations.has(extraLocationInfo.key)) {
            qrScannerActive = false;
            discoverExtraLocation(extraLocationInfo);
            closeModal('qr-modal');
            showNotification('QR Code scanned successfully!', 'success');
        } else {
            showNotification('You already found this location!', 'info');
        }
    } else {
        showNotification('QR code not recognized. Make sure you\'re at a treasure hunt location.', 'warning');
    }
}

function showQRCodeOptions() {
    const qrScanner = document.getElementById('qr-scanner');
    const header = translateMessage('Select a QR Code to Scan:');
    qrScanner.innerHTML = `
        <div style="text-align: center; padding: 2rem;">
            <h4>${header}</h4>
            <div style="display: grid; gap: 1rem; margin-top: 1rem;">
                ${Object.entries(huntLocations).map(([key, loc]) => `
                    <button class="card-button" onclick="simulateQRScan('${key}')">${localizedField(loc, 'name') || loc.name}</button>
                `).join('')}
            </div>
        </div>
    `;
}

// Add a dynamically-created hunt item card for a bonus location
function addExtraHuntItem(info) {
    const huntItemsContainer = document.querySelector('.hunt-items');
    if (!huntItemsContainer) return;
    // Avoid duplicates by comparing the data attribute via the DOM dataset property
    const duplicate = Array.from(huntItemsContainer.querySelectorAll('.hunt-item.extra-location'))
        .find(el => el.dataset.extraLocation === info.key);
    if (duplicate) return;
    const item = document.createElement('div');
    item.className = 'hunt-item found extra-location';
    item.dataset.extraLocation = info.key;
    item.innerHTML = `
        <i class="fas fa-star"></i>
        <span>${escapeHtml(info.name)}</span>
        <span class="extra-pts-badge">+${info.points} pts</span>
    `;
    huntItemsContainer.appendChild(item);
}

// Discover and award points for a bonus (off-track) location
async function discoverExtraLocation(info) {
    // info: { key: string, name: string, points: number }
    foundExtraLocations.add(info.key);

    // Award points locally
    if (currentUser) {
        currentUser.totalPoints += info.points;
        saveUserToLocalStorage();
        updateUserDisplayUI();
        showPointsNotification(info.points, 0, info.name);

        // Sync to server (non-blocking)
        try {
            await fetch(`/api/user/${encodeURIComponent(currentUser.uuid)}/extra-found`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ locationKey: info.key })
            });
        } catch (e) {
            console.log('Server sync unavailable (offline mode):', e.message);
        }
    }

    // Add the new hunt item card below the regular places
    addExtraHuntItem(info);

    // Show discovery modal
    const discoveryTitleEl = document.getElementById('discovery-title');
    const discoveryMsgEl = document.getElementById('discovery-message');
    const discoveryFactEl = document.getElementById('discovery-fact');

    if (discoveryTitleEl) discoveryTitleEl.textContent = `You found ${info.name}!`;
    if (discoveryMsgEl) discoveryMsgEl.textContent = 'Bonus location discovered!';
    if (discoveryFactEl) discoveryFactEl.innerHTML = `<strong>Bonus Points: +${info.points}</strong>`;

    openModal('discovery-modal');
    loadLeaderboard();
    checkCollageUnlocks();
}

function simulateQRScan(locationKey) {
    if (huntLocations[locationKey] && !foundLocations.has(locationKey)) {
        const isFirstVisit = foundLocations.size === 0;
        discoverLocation(locationKey, isFirstVisit);
        closeModal('qr-modal');
    } else if (foundLocations.has(locationKey)) {
        showNotification('You already found this location!', 'info');
    }
}

/* ==================== LOCATION-BASED DISCOVERY FUNCTIONS (Commented out) ====================
 * NOTE: These GPS/geolocation functions are preserved for potential future reimplementation.
 * To re-enable, uncomment both functions below and restore the useLocationBtn handler above.
 * ========================================================================================= */

/* --- checkNearbyLocations (geolocation disabled) ---
function checkNearbyLocations() {
    if (!userLocation) return;
    
    let foundNearby = false;
    
    Object.entries(huntLocations).forEach(([key, location]) => {
        if (!foundLocations.has(key)) {
            const distance = calculateDistance(
                userLocation.lat, userLocation.lng,
                location.lat, location.lng
            );
            
            // Within 100 meters (or 50km in testing mode for easier testing)
            const threshold = testingMode ? 50000 : 100;
            
            if (distance < threshold) {
                // Launch AR experience instead of just discovering
                launchARExperience(key, false);
                foundNearby = true;
            }
        }
    });
    
    if (!foundNearby) {
        showNotification('No locations nearby. Keep exploring!', 'info');
    }
}
--- end checkNearbyLocations --- */

/* --- calculateDistance (geolocation disabled) ---
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}
--- end calculateDistance --- */

async function discoverLocation(locationKey, isFirstVisit = false) {
    foundLocations.add(locationKey);
    
    // Update UI
    const huntItem = document.querySelector(`.hunt-item[data-location="${locationKey}"]`);
    if (huntItem) {
        huntItem.classList.add('found');
        huntItem.querySelector('i').className = 'fas fa-check-circle';
        // Add photo thumbnail below the hunt item
        addPhotoToHuntItem(locationKey, huntItem);
    }
    
    // Award points to user (await so pointsResult is available for modal display)
    const location = huntLocations[locationKey];
    const localizedName = localizedField(location, 'name') || location.name;
    const isCompletion = foundLocations.size === Object.keys(huntLocations).length;
    const pointsResult = await awardPoints(locationKey, localizedName);
    
    // Update progress
    updateProgress();

    // Update the "Next Site" banner with the next location in the circular order
    updateNextSiteBanner(locationKey);
    
    // Handle timer logic
    const currentTime = Date.now();
    let timerText = '';
    
    if (foundLocations.size === 1) {
        // First location found - start the hunt timer
        huntStartTime = currentTime;
        lastDiscoveryTime = currentTime;
        timerText = `<br><br><strong>⏱️ ${t('dynamic.hunt_started')}</strong>`;
    } else {
        // Subsequent locations - show time since last discovery
        const timeSinceLast = Math.floor((currentTime - lastDiscoveryTime) / 1000); // seconds
        const minutes = Math.floor(timeSinceLast / 60);
        const seconds = timeSinceLast % 60;
        const timeString = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
        timerText = `<br><br><strong>⏱️ ${t('dynamic.time_to_find')}: ${timeString}</strong>`;
        lastDiscoveryTime = currentTime;
    }
    
    // Show discovery modal with points
    const localizedFact = localizedField(location, 'fact') || location.fact || '';
    const discoveryMsg = t('dynamic.discovery_msg');

    const discoveryTitleEl = document.getElementById('discovery-title');
    const discoveryMsgEl = document.getElementById('discovery-message');
    const discoveryFactEl = document.getElementById('discovery-fact');

    if (discoveryTitleEl) discoveryTitleEl.textContent = t('dynamic.you_found_name', { name: localizedName });
    if (discoveryMsgEl) discoveryMsgEl.textContent = discoveryMsg;
    
    let factHTML = `<strong>${t('dynamic.fun_fact')}:</strong> ${localizedFact}`;
    if (pointsResult) {
        let pointsText = `<br><br><strong>Points Earned: +${pointsResult.pointsAwarded}</strong>`;
        if (pointsResult.bonusPoints > 0) {
            pointsText += `<br><strong>🎉 Completion Bonus: +${pointsResult.bonusPoints}</strong>`;
            pointsText += `<br><strong>Total Points: ${pointsResult.totalPoints}</strong>`;
        }
        factHTML += pointsText;
    }
    
    // Add timer information
    factHTML += timerText;
    
    if (discoveryFactEl) discoveryFactEl.innerHTML = factHTML;

    // Show saved photo or queue auto camera open
    const savedPhoto = localStorage.getItem(`ar_photo_${locationKey}`);
    const photoSection = document.getElementById('discovery-photo-section');
    if (photoSection) {
        if (savedPhoto && savedPhoto.startsWith('data:image/jpeg;base64,')) {
            photoSection.innerHTML = `<p class="ar-photo-label">📸 Your photo:</p><img src="${savedPhoto}" class="ar-captured-photo" alt="Your photo at ${escapeHtml(localizedName)}">`;
        } else {
            photoCaptureQueuedKey = locationKey;
            photoSection.innerHTML = '';
        }
    }

    // After any location found, queue a name prompt if user hasn't set one yet
    if (currentUser && !currentUser.hasSetName) {
        firstDiscoveryPending = true;
    }

    // Queue survey prompt after 2nd location, if not shown before
    if (foundLocations.size === 2 && !localStorage.getItem('rasnov_survey_shown')) {
        surveyPromptPending = true;
    }

    // Show welcome modal for first-time QR scan, then chain to discovery/name modals
    if (isFirstVisit) {
        welcomeModalPendingKey = locationKey;
        showWelcomeModal(locationKey);
        // discovery modal will be shown after welcome modal is closed (via onWelcomeModalClose)
    } else {
        openModal('discovery-modal');
    }

    // Refresh leaderboard data in the background after finding a location
    loadLeaderboard();

    // Check if a new collage tier has been unlocked
    checkCollageUnlocks();
    
    // Check if hunt is complete
    if (foundLocations.size === Object.keys(huntLocations).length) {
        setTimeout(() => {
            const celebrationMsg = t('dynamic.celebration_all', { total: Object.keys(huntLocations).length, points: currentUser.totalPoints });
            showNotification(celebrationMsg, 'success');
            huntActive = false;
            if (startHuntBtn) {
                startHuntBtn.innerHTML = '<i class="fas fa-trophy"></i> Completed!';
                startHuntBtn.classList.remove('active-hunt');
                startHuntBtn.classList.add('hunt-complete');
                startHuntBtn.style.display = '';
            }
            if (resetHuntBtn) resetHuntBtn.style.display = 'none';
        }, 2000);
    }
}

function updateProgress() {
    const total = Object.keys(huntLocations).length;
    const found = foundLocations.size;
    const percentage = (found / total) * 100;
    
    if (progressFill) progressFill.style.width = `${percentage}%`;
    if (progressCount) progressCount.textContent = found;
    if (progressTotal) progressTotal.textContent = total;
}

// Delay (ms) between closing discovery modal and opening name prompt
const MODAL_TRANSITION_DELAY = 200;

// Called when the user clicks "Continue Hunt" in the discovery modal
function onDiscoveryModalContinue() {
    closeModal('discovery-modal');
    if (firstDiscoveryPending) {
        firstDiscoveryPending = false;
        setTimeout(() => openModal('first-discovery-modal'), MODAL_TRANSITION_DELAY);
    } else if (surveyPromptPending) {
        surveyPromptPending = false;
        localStorage.setItem('rasnov_survey_shown', '1');
        setTimeout(() => openSurveyPromptModal(), MODAL_TRANSITION_DELAY);
    } else {
        triggerQueuedPhotoCapture();
    }
}

// Submit name entered in the first-discovery modal
function submitFirstDiscoveryName() {
    const input = document.getElementById('first-discovery-name');
    const name = input ? input.value.trim() : '';
    if (!name) {
        showNotification('Please enter a name', 'warning');
        return;
    }
    setUsername(name);
    closeModal('first-discovery-modal');
    if (surveyPromptPending) {
        surveyPromptPending = false;
        localStorage.setItem('rasnov_survey_shown', '1');
        setTimeout(() => openSurveyPromptModal(), MODAL_TRANSITION_DELAY);
    } else {
        triggerQueuedPhotoCapture();
    }
}

// Skip setting a name for now
function skipFirstDiscoveryName() {
    closeModal('first-discovery-modal');
    if (surveyPromptPending) {
        surveyPromptPending = false;
        localStorage.setItem('rasnov_survey_shown', '1');
        setTimeout(() => openSurveyPromptModal(), MODAL_TRANSITION_DELAY);
    } else {
        triggerQueuedPhotoCapture();
    }
}

// Survey Functions
function openSurveyPromptModal() {
    openModal('survey-modal');
}

function startSurvey() {
    localStorage.setItem('rasnov_survey_started', '1');
    renderUnlocksTab();
    closeModal('survey-modal');
    setTimeout(() => openModal('survey-form-modal'), MODAL_TRANSITION_DELAY);
}

function dismissSurvey() {
    closeModal('survey-modal');
    triggerQueuedPhotoCapture();
}

function closeSurveyForm() {
    closeModal('survey-form-modal');
    triggerQueuedPhotoCapture();
}

// AR Camera Functions
async function launchARExperience(locationKey, isTestMode = false) {
    currentARLocation = locationKey;
    const location = huntLocations[locationKey];
    
    // Check if HTTPS (required for camera access in production)
    const isSecure = window.location.protocol === 'https:';
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    
    if (!isSecure && !isLocalhost) {
        showNotification('Camera requires HTTPS. Please access the site via https://.', 'error');
        // Fallback to regular discovery for non-HTTPS production
        setTimeout(() => {
            discoverLocation(locationKey);
        }, 500);
        return;
    }
    
    // Show AR modal
    arModal.classList.add('active');
    arLoading.classList.remove('hidden');
    arOverlayText.classList.add('hidden');
    arBearReady = false;
    arBearOnScreen = false;
    
    // Update hunt instruction banner – invite user to move the camera
    const locName = localizedField(location, 'name') || location.name;
    arHuntText.textContent = t('dynamic.ar_move_camera', { name: locName });
    arHuntBanner.style.display = 'flex';

    // Pre-compute compass bearing to target (used for anchored AR if orientation available)
    arTargetBearing = null;
    if (userLocation && location.lat && location.lng) {
        arTargetBearing = _bearingTo(userLocation.lat, userLocation.lng, location.lat, location.lng);
    }
    arBearVisible = false;

    // Start lightweight orientation tracking (no image processing – just sensor polling)
    _startOrientationTracking();
    
    // Show test mode indicator if applicable
    if (isTestMode) {
        arTestModeIndicator.style.display = 'flex';
    } else {
        arTestModeIndicator.style.display = 'none';
    }

    // ── Try WebXR immersive-ar first (Android Chrome + ARCore) ────────────────
    // WebXR gives true ground-plane hit testing and 6DoF pose – Pokémon GO style.
    // Falls back to the existing getUserMedia + Three.js overlay approach if not available.
    if (typeof navigator.xr !== 'undefined') {
        const xrSupported = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
        if (xrSupported) {
            await _setupWebXRAR(locationKey);
            return; // _setupWebXRAR owns the rest of the lifecycle from here
        }
    }
    
    try {
        // Request camera permission and initialize
        await initializeARCamera();
        
        // Setup AR scene with 3D bear
        setupARScene(locationKey);
        
        // Hide loading indicator
        arLoading.classList.add('hidden');
        
    } catch (error) {
        console.error('AR Camera Error:', error);
        
        // In test mode, show demo view even without camera
        if (isTestMode) {
            arLoading.classList.add('hidden');
            
            // Setup AR scene without camera (will show placeholder)
            setupARScene(locationKey);
            
            return;
        }
        
        arLoading.classList.add('hidden');
        
        // Show user-friendly error message
        let errorMessage = 'Unable to access camera. ';
        if (error.name === 'NotAllowedError') {
            errorMessage += 'Please allow camera access to proceed.';
        } else if (error.name === 'NotFoundError') {
            errorMessage += 'No camera found on this device.';
        } else if (error.name === 'NotSupportedError') {
            errorMessage += 'Camera not supported on this browser. Please use HTTPS.';
        } else {
            errorMessage += 'Please check your camera settings.';
        }
        
        showNotification(errorMessage, 'error');
        
        // Close AR modal and fallback to regular discovery
        closeARView();
        setTimeout(() => {
            discoverLocation(locationKey);
        }, 500);
    }
}

async function initializeARCamera() {
    try {
        // Request camera access
        const constraints = {
            video: {
                facingMode: 'environment', // Use back camera on mobile
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: false
        };
        
        arStream = await navigator.mediaDevices.getUserMedia(constraints);
        return arStream;
    } catch (error) {
        throw error;
    }
}

// ── WebXR AR – Pokémon GO style bear placement ────────────────────────────────
//
// This function is called when navigator.xr reports immersive-ar support
// (Android Chrome 81+ with ARCore).  It creates a real WebXR session that:
//   • Provides camera passthrough (no video element needed)
//   • Casts hit-test rays so the user can place the bear on a real surface
//   • Renders the 3D bear at the chosen real-world position (6DoF anchored)
//   • Shows all existing HTML UI via the dom-overlay feature
//
// On devices / browsers without WebXR the caller falls back to the existing
// getUserMedia + Three.js overlay approach automatically.
//
// ── Free 3D bear model options (for a higher-quality "Pokémon GO" look) ──────
//   1. Quaternius Ultimate Animals (current, CC0, ~1 MB GLTF):
//      https://quaternius.com/packs/ultimateanimals.html
//   2. Poly Pizza (free CC0 GLBs, searchable, CDN-friendly):
//      https://poly.pizza/search/bear
//   3. Sketchfab free/CC models (download as GLB, self-host or CORS CDN):
//      https://sketchfab.com/search?q=bear&licenses=7&type=models
//   4. Mixamo (free animated characters, requires account, export as GLB):
//      https://www.mixamo.com/#/?type=Character
//   5. glTF Sample Assets (Khronos Group, CC0, for testing):
//      https://github.com/KhronosGroup/glTF-Sample-Assets
// ─────────────────────────────────────────────────────────────────────────────
async function _setupWebXRAR(locationKey) {
    const container = arSceneContainer;
    const w = container.offsetWidth || window.innerWidth;
    const h = container.offsetHeight || window.innerHeight;

    // Three.js renderer – alpha:true lets the XR camera passthrough show through.
    // preserveDrawingBuffer is needed for readRenderTargetPixels screenshot.
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(w, h);
    renderer.xr.enabled = true;
    renderer.domElement.className = 'ar-three-canvas';
    container.appendChild(renderer.domElement);
    arThreeRenderer = renderer;

    const scene = new THREE.Scene();
    arXRScene = scene;

    // Camera – Three.js/WebXR manager overwrites its view/projection matrices each frame.
    const camera = new THREE.PerspectiveCamera(70, w / h, 0.01, 20);
    arXRCamera = camera;

    // Lighting for realistic bear appearance
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(2, 6, 3);
    scene.add(dirLight);

    const clock = new THREE.Clock();
    arThreeClock = clock;

    // ── Pokémon GO-style placement reticle (double ring on detected surface) ──
    // The group's matrix is replaced each frame with the hit-test surface pose.
    const reticleGroup = new THREE.Group();
    reticleGroup.matrixAutoUpdate = false;
    reticleGroup.visible = false;
    scene.add(reticleGroup);

    const innerRing = new THREE.Mesh(
        new THREE.RingGeometry(0.07, 0.10, 32).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x00ff88, side: THREE.DoubleSide })
    );
    reticleGroup.add(innerRing);

    // Outer ring spins (set rotation.y each frame; world pose comes from parent group)
    const outerRing = new THREE.Mesh(
        new THREE.RingGeometry(0.13, 0.155, 32).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.55 })
    );
    reticleGroup.add(outerRing);

    // ── Contact shadow rendered beneath the bear (like Pokémon GO) ────────────
    const shadowMesh = new THREE.Mesh(
        new THREE.CircleGeometry(0.35, 32),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false })
    );
    shadowMesh.rotation.x = -Math.PI / 2;
    shadowMesh.renderOrder = -1;
    shadowMesh.visible = false;
    scene.add(shadowMesh);

    // ── Bear state ─────────────────────────────────────────────────────────────
    let bearGroup = null;
    arXRBearGroup = null;
    let bearPlaced = false;
    let bearPhase = 'unplaced'; // unplaced | walkin | idle
    let phaseTimer = 0;
    const bearAnchorPos = new THREE.Vector3();
    let walkOffset = 1.5;                // metres from anchor at walk-in start
    const BEAR_SCALE = 0.014;            // scale GLTF model to ~1.4 m tall (1 unit = 1 m in WebXR)
    const WALK_SPEED = 0.9;              // m/s walk-in speed
    const HOP_HEIGHT_METERS = 0.12;      // max vertical displacement during hop animation
    const IDLE_BOB_FREQUENCY = 1.5;      // radians/s of idle breathing oscillation
    const IDLE_BOB_AMPLITUDE = 0.008;    // metres of idle vertical displacement
    const RETICLE_SPIN_SPEED = 1.4;      // radians/s outer ring rotation

    // ── Load bear model (async; placement waits for it) ────────────────────────
    const LoaderClass = (typeof THREE.GLTFLoader !== 'undefined') ? THREE.GLTFLoader : GLTFLoader;
    let gltfLoaded = null;
    new LoaderClass().load(
        BEAR_MODEL_URL,
        (gltf) => { gltfLoaded = gltf; },
        undefined,
        (err) => { console.warn('Bear model failed to load:', err); }
    );

    // ── Request WebXR session ─────────────────────────────────────────────────
    // hit-test is in optionalFeatures so devices that support immersive-ar but
    // lack ARCore hit-testing can still start a session (bear placement falls
    // back to a timed auto-place in front of the user in that case).
    let session;
    try {
        session = await navigator.xr.requestSession('immersive-ar', {
            optionalFeatures: ['hit-test', 'dom-overlay'],
            domOverlay: { root: arModal }
        });
    } catch (sessionErr) {
        console.warn('WebXR session start failed, falling back to video AR:', sessionErr);
        if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
        renderer.dispose();
        arThreeRenderer = null;
        arXRMode = false;
        arXRScene = null;
        arXRCamera = null;
        try {
            await initializeARCamera();
            setupARScene(locationKey);
        } catch (camErr) {
            showNotification('Unable to start camera.', 'error');
            closeARView();
        }
        arLoading.classList.add('hidden');
        return;
    }

    arXRSession = session;
    arXRMode = true;
    await renderer.xr.setSession(session);

    const localSpace = await session.requestReferenceSpace('local');

    // Request hit-test source asynchronously (surface detection)
    let hitTestSource = null;
    session.requestReferenceSpace('viewer')
        .then(vs => session.requestHitTestSource({ space: vs }))
        .then(src => { hitTestSource = src; })
        .catch(e => console.warn('Hit-test source unavailable:', e));

    // Update UI
    arLoading.classList.add('hidden');
    arHuntText.textContent = t('dynamic.ar_place_grizzly');
    const placeHint = document.getElementById('ar-xr-place-hint');
    if (placeHint) placeHint.classList.remove('hidden');

    // ── Tap-to-place handler ──────────────────────────────────────────────────
    function placeBear() {
        if (bearPlaced) return;
        if (!gltfLoaded) {
            showNotification('🐻 Bear model is still loading, tap again in a moment!', 'info');
            return;
        }
        if (!reticleGroup.visible) {
            showNotification('Point the camera at a flat surface first.', 'info');
            return;
        }

        bearPlaced = true;
        if (placeHint) placeHint.classList.add('hidden');

        // Anchor position is the current reticle world position
        bearAnchorPos.setFromMatrixPosition(reticleGroup.matrix);

        // Clone so the loaded GLTF can be reused across session resets
        bearGroup = gltfLoaded.scene.clone();
        arXRBearGroup = bearGroup;
        bearGroup.scale.setScalar(BEAR_SCALE);
        // Start 1.5 m to the right, will walk left to anchor
        bearGroup.position.set(bearAnchorPos.x + walkOffset, bearAnchorPos.y, bearAnchorPos.z);
        bearGroup.rotation.y = Math.PI; // face toward anchor
        scene.add(bearGroup);

        // Shadow sits just above the anchor surface to avoid z-fighting
        shadowMesh.position.set(bearAnchorPos.x, bearAnchorPos.y + 0.002, bearAnchorPos.z);
        shadowMesh.visible = true;

        if (gltfLoaded.animations && gltfLoaded.animations.length) {
            arThreeMixer = new THREE.AnimationMixer(bearGroup);
            arThreeMixer.clipAction(gltfLoaded.animations[0]).play();
        }

        bearPhase = 'walkin';
        reticleGroup.visible = false;
        arHuntText.textContent = t('dynamic.ar_grizzly_walking');
    }

    function onTap(e) {
        // Ignore clicks on the close/capture buttons (they have their own handlers)
        if (e.target.closest('.ar-close-btn') || e.target.closest('.ar-capture-btn')) return;
        placeBear();
    }

    container.addEventListener('click', onTap);
    session.addEventListener('end', () => {
        container.removeEventListener('click', onTap);
        if (hitTestSource) { try { hitTestSource.cancel(); } catch (_) {} hitTestSource = null; }
        arXRSession = null;
        arXRMode = false;
    });

    // ── WebXR render loop ─────────────────────────────────────────────────────
    // renderer.setAnimationLoop is the WebXR-aware replacement for rAF.
    // Three.js automatically updates the camera pose from the XR frame.
    let outerAngle = 0;
    renderer.domElement.style.transition = 'opacity 0.4s ease';

    renderer.setAnimationLoop((timestamp, frame) => {
        if (!frame) return;
        const delta = clock.getDelta();
        if (arThreeMixer) arThreeMixer.update(delta);

        // ── Hit-test → reticle ──────────────────────────────────────────────
        if (!bearPlaced && hitTestSource) {
            const hits = frame.getHitTestResults(hitTestSource);
            if (hits.length > 0) {
                const pose = hits[0].getPose(localSpace);
                if (pose) {
                    reticleGroup.visible = true;
                    reticleGroup.matrix.fromArray(pose.transform.matrix);
                    // Spin the outer ring in the reticle's local space
                    outerAngle += delta * RETICLE_SPIN_SPEED;
                    outerRing.rotation.y = outerAngle;
                } else {
                    reticleGroup.visible = false;
                }
            } else {
                reticleGroup.visible = false;
            }
        }

        // ── Bear walk-in animation ───────────────────────────────────────────
        if (bearGroup) {
            phaseTimer += delta;
            if (bearPhase === 'walkin') {
                walkOffset -= delta * WALK_SPEED;
                if (walkOffset > 0) {
                    bearGroup.position.x = bearAnchorPos.x + walkOffset;
                    // Hopping arc: 3 hops over 1.5 m
                    const progress = 1 - (walkOffset / 1.5);
                    bearGroup.position.y = bearAnchorPos.y + Math.max(0, Math.sin(progress * Math.PI * 3)) * HOP_HEIGHT_METERS;
                } else {
                    walkOffset = 0;
                    bearGroup.position.copy(bearAnchorPos);
                    if (!arBearReady) {
                        arBearReady = true;
                        arBearOnScreen = true;
                        bearPhase = 'idle';
                        phaseTimer = 0;
                        arHuntText.textContent = t('dynamic.ar_grizzly_here');
                        showNotification('🐻 Grizzly is here! Take a photo!', 'info');
                    }
                }
            } else if (bearPhase === 'idle') {
                // Subtle idle breath bob
                bearGroup.position.y = bearAnchorPos.y + Math.sin(phaseTimer * IDLE_BOB_FREQUENCY) * IDLE_BOB_AMPLITUDE;
            }
        }

        // ── Screenshot (triggered by captureARPhoto) ─────────────────────────
        // We do it inside the animation loop so the GL context is in the right state.
        if (arXRCapturePending && bearGroup) {
            arXRCapturePending = false;
            _doXRScreenshot(renderer, scene, bearGroup);
        }

        renderer.render(scene, camera);
    });
}

// ── WebXR screenshot: render bear from a nice angle to an offscreen target ───
// In WebXR immersive-ar mode the XR framebuffer is separate from the canvas
// default framebuffer, so toDataURL() returns blank.  Instead we render to a
// WebGLRenderTarget with a snapshot camera and read pixels back via readRenderTargetPixels.
function _doXRScreenshot(renderer, scene, bearGroup) {
    const W = 640, H = 480;

    // Snapshot camera: position slightly to the side and above, looking at bear
    const snapCam = new THREE.PerspectiveCamera(55, W / H, 0.01, 20);
    const bPos = bearGroup.position;
    snapCam.position.set(bPos.x + 1.0, bPos.y + 0.5, bPos.z + 1.5);
    snapCam.lookAt(bPos.x, bPos.y + 0.3, bPos.z);

    // Render bear onto a dark AR-style background
    const rt = new THREE.WebGLRenderTarget(W, H);
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x1a1a2e, 1);
    renderer.clear();
    renderer.render(scene, snapCam);
    renderer.setRenderTarget(null);
    renderer.setClearColor(0x000000, 0); // restore transparent clear

    // Read raw RGBA pixels from the render target
    const buf = new Uint8Array(W * H * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    rt.dispose();

    // WebGL framebuffer is bottom-up; flip vertically to get a normal image
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(W, H);
    for (let row = 0; row < H; row++) {
        const srcOff = (H - 1 - row) * W * 4;
        const dstOff = row * W * 4;
        imgData.data.set(buf.subarray(srcOff, srcOff + W * 4), dstOff);
    }
    ctx.putImageData(imgData, 0, 0);

    // Watermark – font size is 3.3% of image width for legibility
    const wmFontSizeRatio = 0.033;
    ctx.font = `bold ${Math.round(W * wmFontSizeRatio)}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(AR_WATERMARK_TEXT, 10, H - 8);

    _processCapture(canvas.toDataURL('image/jpeg', 0.82));
}

// ── Compass / Orientation helpers ─────────────────────────────────────────────
//
// Current AR approach: GPS bearing + DeviceOrientation compass.
// No heavy libraries – just lightweight sensor math.
//
// Potential enhancements to make AR even better on mobile (feasibility notes):
//
//  1. DeviceMotionEvent (accelerometer) – already fires freely; could measure
//     "shake" for a fun "shake to summon Grizzly" mechanic.  Zero extra deps.
//
//  2. Pitch-aware anchoring – use DeviceOrientation beta (tilt up/down) alongside
//     alpha (compass) so bear only shows when camera is at the right angle.
//     Single extra trig check, no libraries needed.
//
//  3. WebXR Device API – browser-native AR (Chrome 81+ on Android).  Gives real
//     camera pose without A-Frame.  ~0 extra weight if already using Three.js.
//     Best for true 3-DoF/6-DoF anchoring.  Requires HTTPS + user gesture.
//
//  4. GPS geofencing – already have user GPS; trigger bear only when user is
//     within ~20 m of the target coordinate.  Pure distance math, no new deps.
//
//  5. Magnetometer calibration banner – show a "figure-8 to calibrate compass"
//     prompt when absolute orientation is unavailable (helps accuracy of #1/#2).
//
// ─────────────────────────────────────────────────────────────────────────────

// Calculate bearing (degrees, 0–360 clockwise from north) from one GPS point to another.
function _bearingTo(lat1, lng1, lat2, lng2) {
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lng2 - lng1) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Smallest angular difference between two headings (0–180).
function _angleDelta(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

// Start listening to deviceorientation.  On iOS 13+ permission must be requested
// explicitly; on Android the event fires without a prompt.  We try the absolute
// variant first (true-north compass), falling back to the relative variant.
// This is intentionally lightweight – no image processing, just sensor data.
function _startOrientationTracking() {
    _stopOrientationTracking(); // clean up any previous listener

    function handleOrientation(event) {
        // `alpha` is the compass heading: degrees clockwise from north when
        // the phone is held flat.  Some browsers expose a `webkitCompassHeading`
        // property on iOS which already accounts for magnetic declination.
        let heading = null;
        if (typeof event.webkitCompassHeading === 'number') {
            heading = event.webkitCompassHeading; // iOS true-north heading
            arCompassAbsolute = true;
        } else if (event.absolute && typeof event.alpha === 'number') {
            // Android absolute orientation (true north) – alpha is CCW from north, so invert.
            heading = (360 - event.alpha) % 360;
            arCompassAbsolute = true;
        } else if (typeof event.alpha === 'number') {
            // Relative heading – useful for detecting movement even without true north.
            heading = (360 - event.alpha) % 360;
            arCompassAbsolute = false;
        }

        if (heading === null) return;
        arCompassBearing = heading;

        // ── Compass-anchored bear visibility ──────────────────────────────────
        // If we have a true-north compass AND a target bearing, show/hide the
        // bear based on whether the user is pointing the camera at the target.
        if (arCompassAbsolute && arTargetBearing !== null) {
            const delta = _angleDelta(heading, arTargetBearing);
            const TOLERANCE_DEG = 30; // ±30° window to see Grizzly
            const shouldShow = delta <= TOLERANCE_DEG;

            if (shouldShow && !arBearVisible) {
                arBearVisible = true;
                _triggerBearAppearance();
            } else if (!shouldShow && arBearVisible) {
                arBearVisible = false;
                _hideBear();
            }
        }
    }

    // Absolute-orientation handler (Android `deviceorientationabsolute`).
    // When this fires we know we have true-north data, so we suppress the
    // relative `deviceorientation` fallback to avoid double processing.
    function handleAbsoluteOrientation(event) {
        handleOrientation(event);
    }

    function _addListeners() {
        // Use absolute event (true north) when available, relative as fallback.
        // Storing handlers separately so we can remove them precisely.
        arOrientationAbsHandler = handleAbsoluteOrientation;
        arOrientationHandler = handleOrientation;
        window.addEventListener('deviceorientationabsolute', arOrientationAbsHandler, { passive: true });
        // Only add relative listener on devices that don't fire the absolute event
        // (checked by inspecting whether deviceorientationabsolute is supported).
        if (typeof window.ondeviceorientationabsolute === 'undefined') {
            window.addEventListener('deviceorientation', arOrientationHandler, { passive: true });
        }
    }

    // Try to request permission on iOS 13+ before adding the listener.
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission()
            .then(state => {
                if (state === 'granted') {
                    // iOS only fires `deviceorientation` (with webkitCompassHeading)
                    arOrientationHandler = handleOrientation;
                    window.addEventListener('deviceorientation', arOrientationHandler, { passive: true });
                }
            })
            .catch(() => { /* permission denied – no orientation tracking */ });
    } else if (typeof DeviceOrientationEvent !== 'undefined') {
        _addListeners();
    }
}

function _stopOrientationTracking() {
    if (arOrientationAbsHandler) {
        window.removeEventListener('deviceorientationabsolute', arOrientationAbsHandler);
        arOrientationAbsHandler = null;
    }
    if (arOrientationHandler) {
        window.removeEventListener('deviceorientation', arOrientationHandler);
        arOrientationHandler = null;
    }
    arCompassBearing = null;
    arCompassAbsolute = false;
    arBearVisible = false;
}

// Called when compass says the camera is pointed at the target – trigger bear entry.
function _triggerBearAppearance() {
    // Only trigger if a bear isn't already on screen or in walk-in
    if (arBearReady || arBearOnScreen) return;
    // Signal bear animation to begin (it may already be running with a delay;
    // here we just set a flag that the animation loop respects).
    arBearVisible = true;
}

// Called when compass says camera moved away – hide bear.
function _hideBear() {
    const bearEl = document.getElementById('ar-bear-placeholder');
    if (bearEl) {
        bearEl.style.opacity = '0';
        bearEl.style.transition = 'opacity 0.4s ease';
        setTimeout(() => {
            if (!arBearVisible) {
                // Reset so bear can reappear when camera swings back
                bearEl.style.opacity = '';
                bearEl.style.transition = '';
                bearEl.classList.remove('idle', 'ar-bear-walkin');
                arBearReady = false;
                arBearOnScreen = false;
            }
        }, 450);
    }
    // For 3D bear, the animate loop checks arBearVisible
}

function setupARScene(locationKey) {
    const location = huntLocations[locationKey];
    
    // Clear previous scene
    arSceneContainer.innerHTML = '';
    
    // Create video element for camera feed
    const video = document.createElement('video');
    video.setAttribute('autoplay', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.id = 'ar-camera-feed';
    video.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        z-index: 1;
    `;
    
    // Attach camera stream to video or show placeholder
    if (arStream) {
        video.srcObject = arStream;
        video.play().catch(err => console.warn('Video autoplay failed:', err));
    } else {
        // Show placeholder when camera is not available (for demo/testing)
        video.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
        const placeholder = document.createElement('div');
        placeholder.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            color: white;
            font-size: 24px;
            text-align: center;
            z-index: 2;
        `;
        placeholder.textContent = '📷';
        const lineBreak1 = document.createElement('br');
        const cameraText = document.createTextNode('Camera View');
        const lineBreak2 = document.createElement('br');
        const smallText = document.createElement('small');
        smallText.style.fontSize = '14px';
        smallText.textContent = '(Placeholder)';
        
        placeholder.appendChild(lineBreak1);
        placeholder.appendChild(cameraText);
        placeholder.appendChild(lineBreak2);
        placeholder.appendChild(smallText);
        arSceneContainer.appendChild(placeholder);
    }
    
    arSceneContainer.appendChild(video);
    
    // Setup 3D bear (Three.js) or walking bear fallback
    setupBearAR(locationKey);
}

// ── Public bear GLTF model (Quaternius free CC0 bear via public CDN) ──────────
// If the 3D model fails to load, we fall back to an animated bear emoji overlay.
// To use a local model instead: download the bear.glb from
//   https://quaternius.com/packs/ultimateanimals.html (free CC0)
// place it at /assets/bear.glb and change the URL below.
const BEAR_MODEL_URL = 'https://vazxmixjsiawhamofees.supabase.co/storage/v1/object/public/models/bear/model.gltf';
const AR_WATERMARK_TEXT = '📍 Rasnov Treasure Hunt';

function setupBearAR(locationKey) {
    // Try Three.js 3D bear first.
    // The legacy examples/js GLTFLoader registers itself as THREE.GLTFLoader.
    // Also check the global GLTFLoader as a fallback for environments where
    // it doesn't attach to the THREE namespace.
    const hasThree = typeof THREE !== 'undefined';
    const hasGLTFLoader = hasThree && (typeof THREE.GLTFLoader !== 'undefined' || typeof GLTFLoader !== 'undefined');
    if (hasThree && hasGLTFLoader) {
        _setup3DBear(locationKey);
    } else {
        _setupBearFallback();
    }
}

function _setup3DBear(locationKey) {
    const container = arSceneContainer;
    const w = container.offsetWidth || window.innerWidth;
    const h = container.offsetHeight || window.innerHeight;

    // Three.js renderer (transparent background so camera shows through)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(w, h);
    renderer.domElement.className = 'ar-three-canvas';
    container.appendChild(renderer.domElement);
    arThreeRenderer = renderer;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100);
    camera.position.set(0, 1.5, 6);

    // Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(5, 10, 5);
    scene.add(sun);

    const clock = new THREE.Clock();
    arThreeClock = clock;

    // ── Randomize entry side & timing ────────────────────────────────────────
    const sides = ['right', 'left'];
    const entrySide = sides[Math.floor(Math.random() * sides.length)];
    const BEAR_BASE_Y = -1;        // resting vertical position
    const HOP_COUNT = 4;
    const HOP_HEIGHT = 0.6;
    const FAKEOUT_SPEED = 9.0;     // faster pop-in
    const WALKIN_SPEED = 3.2;      // slightly faster walk-in

    // Side-specific parameters
    const startX = entrySide === 'right' ? 6 : -6;
    const fakeStopX = entrySide === 'right' ? 3.2 : -3.2;
    const faceDir = entrySide === 'right' ? -Math.PI / 2 : Math.PI / 2;

    // Random delay: 0.3–1.8 s before bear appears
    const initialDelay = 0.3 + Math.random() * 1.5;

    // Load GLTF bear
    const LoaderClass = (typeof THREE.GLTFLoader !== 'undefined') ? THREE.GLTFLoader : GLTFLoader;
    const loader = new LoaderClass();
    let bearGroup = null;
    let walkX = startX;

    // Phases: 'waiting' -> 'fakeout_in' -> 'fakeout_bob' -> 'fakeout_out' -> 'pause' -> 'walkin'
    let bearPhase = 'waiting';
    let phaseTimer = 0;

    loader.load(
        BEAR_MODEL_URL,
        (gltf) => {
            bearGroup = gltf.scene;
            bearGroup.scale.set(1.2, 1.2, 1.2);
            bearGroup.position.set(startX, BEAR_BASE_Y, 0);
            bearGroup.rotation.y = faceDir;
            scene.add(bearGroup);

            if (gltf.animations && gltf.animations.length) {
                arThreeMixer = new THREE.AnimationMixer(bearGroup);
                arThreeMixer.clipAction(gltf.animations[0]).play();
            }
        },
        undefined,
        (err) => {
            console.warn('3D bear model failed to load, using fallback.', err);
            if (renderer.domElement.parentNode) {
                renderer.domElement.parentNode.removeChild(renderer.domElement);
            }
            renderer.dispose();
            arThreeRenderer = null;
            _setupBearFallback();
        }
    );

    // Helper: project bear's world position to NDC and return true if on screen.
    function isBearOnScreen() {
        if (!bearGroup) return false;
        const pos = new THREE.Vector3();
        bearGroup.getWorldPosition(pos);
        pos.project(camera);
        return pos.x >= -1 && pos.x <= 1 && pos.y >= -1 && pos.y <= 1;
    }

    // Animation loop
    // Set the canvas opacity transition once so we don't touch the style every frame.
    renderer.domElement.style.transition = 'opacity 0.4s ease';
    let lastCompassVisible = true; // tracks previous compass visibility state

    function animate() {
        arAnimationId = requestAnimationFrame(animate);
        const delta = clock.getDelta();

        if (arThreeMixer) arThreeMixer.update(delta);

        if (bearGroup) {
            phaseTimer += delta;

            // ── Compass-anchored visibility: hide bear when camera points away ──
            if (arCompassAbsolute && arTargetBearing !== null) {
                const visible = arBearVisible;
                if (visible !== lastCompassVisible) {
                    renderer.domElement.style.opacity = visible ? '1' : '0';
                    lastCompassVisible = visible;
                }
                if (!visible) {
                    renderer.render(scene, camera);
                    return; // skip position updates while hidden
                }
            }

            if (bearPhase === 'waiting') {
                // Hold off-screen until initial delay passes
                bearGroup.position.set(startX, BEAR_BASE_Y, 0);
                if (phaseTimer >= initialDelay) {
                    bearPhase = 'fakeout_in';
                    phaseTimer = 0;
                }

            } else if (bearPhase === 'fakeout_in') {
                // Fast peek toward center
                const dir = entrySide === 'right' ? -1 : 1;
                walkX += dir * delta * FAKEOUT_SPEED;
                const peaked = entrySide === 'right' ? walkX <= fakeStopX : walkX >= fakeStopX;
                if (peaked) {
                    walkX = fakeStopX;
                    bearPhase = 'fakeout_bob';
                    phaseTimer = 0;
                }
                bearGroup.position.x = walkX;
                bearGroup.position.y = BEAR_BASE_Y;

            } else if (bearPhase === 'fakeout_bob') {
                bearGroup.position.x = fakeStopX;
                bearGroup.position.y = BEAR_BASE_Y + Math.sin(phaseTimer * Math.PI * 3) * 0.25;
                if (phaseTimer > 0.4) {   // quicker bob
                    bearPhase = 'fakeout_out';
                    phaseTimer = 0;
                }

            } else if (bearPhase === 'fakeout_out') {
                const dir = entrySide === 'right' ? 1 : -1;
                walkX += dir * delta * (FAKEOUT_SPEED * 1.5);
                const escaped = entrySide === 'right' ? walkX >= startX : walkX <= startX;
                if (escaped) {
                    walkX = startX;
                    bearPhase = 'pause';
                    phaseTimer = 0;
                }
                bearGroup.position.x = walkX;
                bearGroup.position.y = BEAR_BASE_Y;

            } else if (bearPhase === 'pause') {
                bearGroup.position.x = startX;
                bearGroup.position.y = BEAR_BASE_Y;
                if (phaseTimer > 0.6) {  // shorter pause
                    bearPhase = 'walkin';
                    phaseTimer = 0;
                    walkX = startX;
                }

            } else if (bearPhase === 'walkin') {
                const dir = entrySide === 'right' ? -1 : 1;
                walkX += dir * delta * WALKIN_SPEED;
                const clampedX = entrySide === 'right' ? Math.max(walkX, 0) : Math.min(walkX, 0);
                bearGroup.position.x = clampedX;
                const progress = Math.abs(startX - clampedX) / Math.abs(startX);
                bearGroup.position.y = BEAR_BASE_Y + Math.max(0, Math.sin(progress * Math.PI * HOP_COUNT)) * HOP_HEIGHT;

                // Use projected NDC coordinates to determine if bear is on screen
                if (!arBearOnScreen && isBearOnScreen()) {
                    arBearOnScreen = true;
                }

                const arrived = entrySide === 'right' ? walkX <= 0 : walkX >= 0;
                if (arrived) {
                    walkX = 0;
                    bearGroup.position.x = 0;
                    bearGroup.position.y = BEAR_BASE_Y;
                    if (!arBearReady) {
                        arBearReady = true;
                        arBearOnScreen = true;
                        showNotification('🐻 Grizzly is here! Take a photo!', 'info');
                    }
                }
            }
        }

        renderer.render(scene, camera);
    }
    animate();
}

function _setupBearFallback() {
    // Randomize entry side and timing
    const sides = ['right', 'left', 'bottom'];
    const entrySide = sides[Math.floor(Math.random() * sides.length)];
    const initialDelayMs = 300 + Math.floor(Math.random() * 1500); // 0.3–1.8 s

    const FAKEOUT_DURATION_MS = 1200;  // faster pop-in (was 2000)
    const WALKIN_DELAY_MS = 800;       // shorter pause (was 1200)
    const WALKIN_DURATION_MS = 1800;   // walk-in duration (was 2000)
    const BEAR_VISIBLE_DELAY_MS = 900; // ms into walk-in when bear enters visible area

    const bear = document.createElement('div');
    // Pick animation class based on entry side
    const fakeoutClass = entrySide === 'left'   ? 'ar-bear-fakeout-left'
                       : entrySide === 'bottom' ? 'ar-bear-fakeout-bottom'
                       :                          'ar-bear-fakeout';
    const walkinClass  = entrySide === 'left'   ? 'ar-bear-walkin-left'
                       : entrySide === 'bottom' ? 'ar-bear-walkin-bottom'
                       :                          'ar-bear-walkin';

    bear.className = `ar-bear-placeholder`;
    bear.id = 'ar-bear-placeholder';
    bear.textContent = '🐻';
    bear.setAttribute('role', 'img');
    bear.setAttribute('aria-label', 'Grizzly Bear');
    arSceneContainer.appendChild(bear);

    setTimeout(() => {
        bear.classList.add(fakeoutClass);

        setTimeout(() => {
            bear.classList.remove(fakeoutClass);
            bear.classList.add(walkinClass);

            // Use getBoundingClientRect to detect on-screen via coordinates.
            // Store the interval ID so closeARView can cancel it if needed.
            arBearVisibleCheckId = setInterval(() => {
                const rect = bear.getBoundingClientRect();
                if (rect.right > 0 && rect.left < window.innerWidth &&
                    rect.bottom > 0 && rect.top < window.innerHeight) {
                    arBearOnScreen = true;
                    clearInterval(arBearVisibleCheckId);
                    arBearVisibleCheckId = null;
                }
            }, 100);

            setTimeout(() => {
                if (arBearVisibleCheckId !== null) {
                    clearInterval(arBearVisibleCheckId);
                    arBearVisibleCheckId = null;
                }
                bear.classList.remove(walkinClass);
                bear.classList.add('idle');
                arBearReady = true;
                arBearOnScreen = true;
                showNotification('🐻 Grizzly is here! Take a photo!', 'info');
            }, WALKIN_DELAY_MS + WALKIN_DURATION_MS);
        }, FAKEOUT_DURATION_MS);
    }, initialDelayMs);
}

function captureARPhoto() {
    if (!currentARLocation) return;

    // Require bear to be on screen before taking a photo
    if (!arBearOnScreen) {
        showNotification('🐻 Wait for Grizzly to arrive first!', 'warning');
        return;
    }

    // ── WebXR mode: screenshot is rendered inside the animation loop ──────────
    // We can't use toDataURL() on the WebXR canvas (it writes to the XR framebuffer,
    // not the canvas default framebuffer).  Instead we set a flag and let the next
    // animation frame render to an offscreen render target.
    if (arXRMode) {
        arXRCapturePending = true;
        // Flash + button feedback immediately so the UX feels responsive
        arFlash.classList.add('flashing');
        arFlash.addEventListener('animationend', () => arFlash.classList.remove('flashing'), { once: true });
        arCaptureBtn.classList.add('captured');
        arCaptureBtn.innerHTML = '<i class="fas fa-check"></i>';
        return;
    }

    // ── Non-WebXR mode: composite video frame + Three.js/emoji canvas ─────────
    const video = document.getElementById('ar-camera-feed');
    const captureCanvas = document.createElement('canvas');
    const cw = video ? video.videoWidth || 640 : 640;
    const ch = video ? video.videoHeight || 480 : 480;
    captureCanvas.width = cw;
    captureCanvas.height = ch;
    const ctx = captureCanvas.getContext('2d');

    // Draw camera frame (or solid bg if no camera)
    if (video && video.readyState >= 2) {
        ctx.drawImage(video, 0, 0, cw, ch);
    } else {
        ctx.fillStyle = '#334';
        ctx.fillRect(0, 0, cw, ch);
    }

    // Overlay bear at its actual on-screen position
    if (arThreeRenderer) {
        // Composite the Three.js WebGL canvas on top of the camera frame
        ctx.drawImage(arThreeRenderer.domElement, 0, 0, cw, ch);
    } else {
        // Emoji fallback – calculate real rendered position of bear element
        const bearEl = document.getElementById('ar-bear-placeholder');
        if (bearEl) {
            const containerRect = arSceneContainer.getBoundingClientRect();
            const bearRect = bearEl.getBoundingClientRect();
            const scaleX = cw / containerRect.width;
            const scaleY = ch / containerRect.height;
            const bearCenterX = (bearRect.left + bearRect.width / 2 - containerRect.left) * scaleX;
            const bearCenterY = (bearRect.top + bearRect.height / 2 - containerRect.top) * scaleY;
            const bearFontSize = Math.round(bearRect.height * scaleY);
            ctx.font = `${bearFontSize}px 'Apple Color Emoji', 'Noto Color Emoji', sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 16;
            ctx.fillText('🐻', bearCenterX, bearCenterY);
        } else {
            // Final fallback to fixed position
            ctx.font = `${Math.round(ch * 0.2)}px 'Apple Color Emoji', 'Noto Color Emoji', sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 16;
            ctx.fillText('🐻', cw * 0.65, ch * 0.85);
        }
    }

    // Timestamp watermark
    ctx.shadowBlur = 0;
    ctx.font = `bold ${Math.round(cw * 0.03)}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(AR_WATERMARK_TEXT, 10, ch - 8);

    _processCapture(captureCanvas.toDataURL('image/jpeg', 0.82));
}

// ── Shared save / flash / close logic used by both capture paths ──────────────
function _processCapture(dataUrl) {
    // Save photo to localStorage under location key
    try {
        localStorage.setItem(`ar_photo_${currentARLocation}`, dataUrl);
    } catch (e) {
        console.warn('Could not save photo to localStorage (storage full?)', e);
        showNotification('📸 Photo taken! (Could not save – storage full)', 'warning');
    }

    // Flash effect (WebXR path already triggered it, but adding class again is harmless)
    if (!arXRMode) {
        arFlash.classList.add('flashing');
        arFlash.addEventListener('animationend', () => arFlash.classList.remove('flashing'), { once: true });
        arCaptureBtn.classList.add('captured');
        arCaptureBtn.innerHTML = '<i class="fas fa-check"></i>';
    }

    // Award points and show discovery after a short delay
    setTimeout(() => {
        const locKey = currentARLocation;
        closeARView();
        if (!foundLocations.has(locKey)) {
            discoverLocation(locKey);
        } else {
            showNotification('📸 Photo saved! You already found this location.', 'info');
        }
    }, 600);
}

function discoverLocationQuietly(locationKey) {
    // Same as discoverLocation but without showing the modal
    foundLocations.add(locationKey);
    
    // Update UI
    const huntItem = document.querySelector(`.hunt-item[data-location="${locationKey}"]`);
    if (huntItem) {
        huntItem.classList.add('found');
        huntItem.querySelector('i').className = 'fas fa-check-circle';
    }
    
    // Update progress
    updateProgress();
    
    // Check if hunt is complete
    if (foundLocations.size === Object.keys(huntLocations).length) {
        setTimeout(() => {
            showNotification('🎉 Congratulations! You completed the treasure hunt!', 'success');
            huntActive = false;
            startHuntBtn.innerHTML = '<i class="fas fa-trophy"></i> Completed!';
            startHuntBtn.classList.remove('active-hunt');
            startHuntBtn.classList.add('hunt-complete');
            startHuntBtn.style.display = '';
            resetHuntBtn.style.display = 'none';
        }, 1000);
    }
}

function closeARView() {
    // Hide AR modal
    arModal.classList.remove('active');

    // ── End WebXR session (if active) ─────────────────────────────────────────
    if (arXRSession) {
        arXRSession.end().catch(() => {});
        arXRSession = null;
    }
    // Stop the WebXR/Three.js animation loop
    if (arThreeRenderer) {
        arThreeRenderer.setAnimationLoop(null);
    }
    arXRMode = false;
    arXRCapturePending = false;
    arXRScene = null;
    arXRCamera = null;
    arXRBearGroup = null;

    // Hide WebXR place hint if shown
    const placeHint = document.getElementById('ar-xr-place-hint');
    if (placeHint) placeHint.classList.add('hidden');
    
    // Cancel rAF-based Three.js animation loop (non-WebXR path)
    if (arAnimationId !== null) {
        cancelAnimationFrame(arAnimationId);
        arAnimationId = null;
    }
    
    // Dispose Three.js renderer
    if (arThreeRenderer) {
        arThreeRenderer.dispose();
        arThreeRenderer = null;
    }
    arThreeMixer = null;
    arThreeClock = null;
    arBearReady = false;
    arBearOnScreen = false;

    // Stop orientation/compass tracking
    _stopOrientationTracking();
    arTargetBearing = null;

    // Cancel emoji-fallback visibility polling interval
    if (arBearVisibleCheckId !== null) {
        clearInterval(arBearVisibleCheckId);
        arBearVisibleCheckId = null;
    }
    
    // Stop all video tracks from the camera stream
    if (arStream) {
        arStream.getTracks().forEach(track => {
            track.stop();
            console.log('Stopped camera track:', track.label);
        });
        arStream = null;
    }
    
    // Find and stop any video elements in the AR scene
    const videoElements = arSceneContainer.querySelectorAll('video');
    videoElements.forEach(video => {
        video.pause();
        video.srcObject = null;
        video.load(); // Reset video element
    });
    
    // Clear AR scene completely
    arSceneContainer.innerHTML = '';
    
    // Reset capture button
    arCaptureBtn.classList.remove('captured');
    arCaptureBtn.innerHTML = '<i class="fas fa-camera"></i>';
    
    // Reset overlay
    arOverlayText.classList.add('hidden');
    
    // Reset state
    currentARLocation = null;
    arTestModeIndicator.style.display = 'none';
    
    console.log('AR view closed');
}

// Modal Functions
function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('active');
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('active');
        
        // Stop video if QR modal
        if (modalId === 'qr-modal') {
            qrScannerActive = false;
            const video = document.getElementById('qr-video');
            if (video.srcObject) {
                video.srcObject.getTracks().forEach(track => track.stop());
                video.srcObject = null;
            }
        }

        // Clear reset-progress confirmation timer if profile modal is closed
        if (modalId === 'user-profile-modal') {
            clearTimeout(resetConfirmTimeout);
        }
    }
}

// Close modals on outside click
document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeModal(modal.id);
        }
    });
});

// Notification System
function showNotification(message, type = 'info') {
    // Translate notifications if needed
    message = translateMessage(message);

    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.innerHTML = `
        <i class="fas fa-${getIconForType(type)}"></i>
        <span>${message}</span>
    `;
    
    notification.style.cssText = `
        position: fixed;
        top: 80px;
        right: 20px;
        background: ${getColorForType(type)};
        color: white;
        padding: 1rem 1.5rem;
        border-radius: 12px;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        z-index: 3000;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        animation: slideInRight 0.3s ease;
        max-width: 400px;
    `;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.animation = 'slideOutRight 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

function getIconForType(type) {
    const icons = {
        success: 'check-circle',
        error: 'exclamation-circle',
        warning: 'exclamation-triangle',
        info: 'info-circle'
    };
    return icons[type] || 'info-circle';
}

function getColorForType(type) {
    const colors = {
        success: '#4caf50',
        error: '#f44336',
        warning: '#ff9800',
        info: '#2196f3'
    };
    return colors[type] || '#2196f3';
}

// Add notification animations to CSS
const style = document.createElement('style');
style.textContent = `
    @keyframes slideInRight {
        from {
            transform: translateX(400px);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    @keyframes slideOutRight {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(400px);
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);

// Location/Restaurant/Accommodation Details Functions
function showLocationDetails(locationId) {
    const details = {
        fortress: {
            title: 'Rasnov Fortress',
            title_ro: 'Cetatea Râșnov',
            description: 'Built in the 13th century by Teutonic Knights, Rasnov Fortress is a stunning example of medieval defensive architecture. The fortress sits atop a rocky hilltop and offers breathtaking panoramic views of the surrounding Carpathian Mountains and Barsa Valley.',
            description_ro: 'Construită în secolul al XIII-lea de Cavalerii Teutoni, Cetatea Râșnov este un exemplu impresionant de arhitectură defensivă medievală. Aflată pe un deal stâncos, oferă priveliști panoramice spectaculoase ale Munților Carpați și ale Văii Bârsei.',
            hours: 'Daily: 9:00 AM - 6:00 PM (Summer), 9:00 AM - 5:00 PM (Winter)',
            hours_ro: 'Zilnic: 9:00 AM - 6:00 PM (Vară), 9:00 AM - 5:00 PM (Iarnă)',
            price: 'Adults: 20 RON, Children: 10 RON, Students: 15 RON',
            price_ro: 'Adulți: 20 RON, Copii: 10 RON, Studenți: 15 RON',
            tips: 'Wear comfortable shoes for climbing. Visit early morning for best photos. Allow 2-3 hours for full exploration.',
            tips_ro: 'Purtați pantofi confortabili pentru urcare. Vizitați dimineață devreme pentru cele mai bune fotografii. Acordați 2-3 ore pentru explorare completă.'
        },
        dinoparc: {
            title: 'Dino Parc',
            title_ro: 'Dino Parc',
            description: 'The largest dinosaur park in Southeast Europe featuring over 100 life-size animatronic dinosaurs. An educational and entertaining experience for the whole family with interactive exhibits and fossil displays.',
            description_ro: 'Cel mai mare parc cu dinozauri din Europa de Sud-Est, cu peste 100 de replici animatronice la scară naturală. Experiență educațională și distractivă pentru întreaga familie cu expozițiile interactive și colecția de fosile.',
            hours: 'Daily: 10:00 AM - 7:00 PM (April-October)',
            hours_ro: 'Zilnic: 10:00 AM - 7:00 PM (Aprilie-Octombrie)',
            price: 'Adults: 40 RON, Children (3-14): 30 RON, Family pass: 120 RON',
            price_ro: 'Adulți: 40 RON, Copii (3-14): 30 RON, Abonament familial: 120 RON',
            tips: 'Perfect for families with children. Best visited in good weather. Combined tickets with fortress available.',
            tips_ro: 'Perfect pentru familii cu copii. Best vizitat în vreme bună. Bilete combinate cu cetatea disponibile.'
        },
        peak: {
            title: 'Piatra Mica Peak',
            title_ro: 'Piatra Mică',
            description: 'A stunning mountain peak accessible by cable car or hiking trail. The peak offers spectacular 360-degree views of the Carpathian Mountains, Bucegi Plateau, and surrounding valleys.',
            description_ro: 'Un vârf montan impresionant accesibil cu telescaunul sau pe traseu de drumeție. Vârful oferă priveliști spectaculoase de 360 de grade ale Munților Carpați, Platoul Bucegi și ale văilor înconjurătoare.',
            hours: 'Cable car: 9:00 AM - 5:00 PM (Weather dependent)',
            hours_ro: 'Telescaun: 9:00 AM - 5:00 PM (În funcție de vreme)',
            price: 'Cable car round trip: 30 RON, Hiking: Free',
            price_ro: 'Telescaun dus-întors: 30 RON, Drumeție: Gratuit',
            tips: 'Check weather before going. Bring warm layers as it can be windy. Hiking takes 3-4 hours up.',
            tips_ro: 'Verificați vremea înainte de plecare. Duceți straturi calde deoarece poate fi vântos. Drumeția durează 3-4 ore în sus.'
        },
        museum: {
            title: 'Village Museum',
            title_ro: 'Muzeul Satului',
            description: 'An authentic collection of traditional Romanian rural houses, tools, and artifacts. Learn about the rich cultural heritage and daily life of Transylvanian villages through the centuries.',
            description_ro: 'O colecție autentică de case tradiționale românești, unelte și artefacte. Aflați despre moștenirea culturală bogată și viața cotidiană a satelor transilvane de-a lungul secolelor.',
            hours: 'Tuesday-Sunday: 10:00 AM - 5:00 PM (Closed Mondays)',
            hours_ro: 'Marți-Duminică: 10:00 AM - 5:00 PM (Închis luni)',
            price: 'Adults: 10 RON, Children: 5 RON, Guided tours: +15 RON',
            price_ro: 'Adulți: 10 RON, Copii: 5 RON, Ture ghidate: +15 RON',
            tips: 'Guided tours available in English. Photography allowed. Visit local craft demonstrations on weekends.',
            tips_ro: 'Ture ghidate disponibile în limba engleză. Fotografia este permisă. Vizitați demonstrații locale de meșteșuguri în weekend.'
        },
        bran: {
            title: 'Bran Castle',
            title_ro: 'Castelul Bran',
            description: 'Famous as "Dracula\'s Castle", this Gothic fortress is steeped in legend and history. The castle offers fascinating exhibits about medieval life and the region\'s royal history.',
            description_ro: 'Faimos ca "Castelul lui Dracula", această fortăreață gotică este plinul de legendă și istorie. Castelul oferă expozițiile fascinante despre viața medievală și istoria regală a regiunii.',
            hours: 'Monday: 12:00 PM - 6:00 PM, Tuesday-Sunday: 9:00 AM - 6:00 PM',
            hours_ro: 'Luni: 12:00 PM - 6:00 PM, Marți-Duminică: 9:00 AM - 6:00 PM',
            price: 'Adults: 45 RON, Students: 25 RON, Children: 10 RON',
            price_ro: 'Adulți: 45 RON, Studenți: 25 RON, Copii: 10 RON',
            tips: 'Very popular - arrive early or late to avoid crowds. Allow 1.5-2 hours. Combined tickets with Peles available.',
            tips_ro: 'Foarte popular - sosire devreme sau târziu pentru a evita aglomerația. Acordați 1,5-2 ore. Bilete combinate cu Peleș disponibile.'
        },
        poiana: {
            title: 'Poiana Brasov Ski Resort',
            title_ro: 'Stațiunea Poiana Brașov',
            description: 'Premier ski resort with 23km of slopes for all skill levels. In summer, offers hiking, mountain biking, and stunning alpine scenery.',
            description_ro: 'Stațiune de schi de primă clasă cu 23 km de pârtii pentru toate nivelurile de abilitate. În vară, oferă drumeții, mountain biking și peisaje alpine impresionante.',
            hours: 'Ski Season: December-March, 8:00 AM - 4:00 PM. Summer activities: May-October',
            hours_ro: 'Sezonul de schi: Decembrie-Martie, 8:00 AM - 4:00 PM. Activități de vară: Mai-Octombrie',
            price: 'Ski pass: 150 RON/day, Equipment rental: 80 RON/day',
            price_ro: 'Pasul de schi: 150 RON/zi, Închiriere echipament: 80 RON/zi',
            tips: 'Book lessons in advance. Multiple difficulty levels available. Great apres-ski scene.',
            tips_ro: 'Rezervați lecții în avans. Niveluri de dificultate multiple disponibile. Scenă apres-ski grozavă.'
        },
        brasov: {
            title: 'Brasov Old Town',
            title_ro: 'Centrul Istoric Brașov',
            description: 'Medieval city center featuring the impressive Black Church, colorful baroque buildings, and the famous Council Square. Charming cobblestone streets perfect for walking.',
            description_ro: 'Centru medieval cu Biserica Neagră impresionantă, clădiri baroc colorate și Piața Sfatului faimoasă. Străzi pietruite fermecătoare, perfect pentru plimbări.',
            hours: 'Always accessible (individual attractions vary)',
            hours_ro: 'Întotdeauna accesibil (atracciile individuale variază)',
            price: 'Free to walk around, Black Church: 10 RON',
            price_ro: 'Gratuit pentru a merge pe jos, Biserica Neagră: 10 RON',
            tips: 'Don\'t miss Council Square and Rope Street (narrowest street). Great shopping and dining options.',
            tips_ro: 'Nu pierdeți Piața Sfatului și Strada Șnurului (cea mai îngustă stradă). Opțiuni minunate de cumpărături și mâncare.'
        },
        peles: {
            title: 'Peles Castle',
            title_ro: 'Castelul Peleș',
            description: 'One of Europe\'s most beautiful castles, this Neo-Renaissance masterpiece features 160 rooms with stunning art, furniture, and architecture. Former royal summer residence.',
            description_ro: 'Unul dintre cele mai frumoase castele ale Europei, această capodoperă neo-renascentistă are 160 de camere cu artă, mobilă și arhitectură impresionante. Foste reședință de vară regală.',
            hours: 'Wednesday-Sunday: 9:15 AM - 5:00 PM (Closed Monday-Tuesday)',
            hours_ro: 'Miercuri-Duminică: 9:15 AM - 5:00 PM (Închis luni-marți)',
            price: 'Adults: 50 RON, Students: 12.5 RON. Photo permit: 35 RON',
            price_ro: 'Adulți: 50 RON, Studenți: 12,5 RON. Permis foto: 35 RON',
            tips: 'Book online to skip lines. Guided tours mandatory. Photography not allowed inside without permit.',
            tips_ro: 'Rezervați online pentru a sări peste cozi. Ture ghidate obligatorii. Fotografia nu este permisă în interior fără permis.'
        },
        'national-park': {
            title: 'Piatra Craiului National Park',
            title_ro: 'Parcul Național Piatra Craiului',
            description: 'Protected mountain range with dramatic limestone ridge. Home to rare wildlife including chamois, lynx, and brown bears. Pristine alpine meadows and forests.',
            description_ro: 'Lanț montan protejat cu creastă calcaroasă dramatică. Acasă pentru faunul rar, inclusiv chamois, lincele și ursul brun. Pajiști și păduri alpine neîntinse.',
            hours: 'Always open (visitor center: 9:00 AM - 5:00 PM)',
            hours_ro: 'Întotdeauna deschis (centrul de vizitatori: 9:00 AM - 5:00 PM)',
            price: 'Free entry, Guided tours: 100-200 RON',
            price_ro: 'Intrare gratuită, Ture ghidate: 100-200 RON',
            tips: 'Stay on marked trails. Bring proper hiking gear. Best months: June-September. Bear-safe practices required.',
            tips_ro: 'Rămâneți pe traseele marcate. Duceți echipamentul de drumeție adecvat. Luni optime: iunie-septembrie. Practici sigure cu ursul necesare.'
        },
        'bear-sanctuary': {
            title: 'Libearty Bear Sanctuary',
            title_ro: 'Sanctuarul pentru Urși Libearty',
            description: 'Europe\'s largest brown bear sanctuary, home to over 100 rescued bears. Ethical tourism supporting bear conservation and welfare in natural forest habitat.',
            description_ro: 'Cel mai mare sanctuar pentru ursul brun din Europa, gazda pentru peste 100 de urși salvați. Turism etic care să susțină conservarea și bunăstarea ursului în habitat forestier natural.',
            hours: 'Daily: 9:00 AM - 7:00 PM (April-October), 9:00 AM - 5:00 PM (November-March)',
            hours_ro: 'Zilnic: 9:00 AM - 7:00 PM (Aprilie-Octombrie), 9:00 AM - 5:00 PM (Noiembrie-martie)',
            price: 'Adults: 25 RON, Children: 15 RON, Family: 60 RON',
            price_ro: 'Adulți: 25 RON, Copii: 15 RON, Familie: 60 RON',
            tips: 'Allow 1.5 hours. Bears most active in morning/evening. Support conservation by not feeding wildlife.',
            tips_ro: 'Acordați 1,5 ore. Urșii sunt cei mai activi dimineață/seară. Susțineți conservarea prin a nu hrăni fauna sălbatică.'
        }
    };
    
    const detail = details[locationId];
    if (detail) {
        const title = (currentLang === 'ro' && detail.title_ro) ? detail.title_ro : detail.title;
        const description = (currentLang === 'ro' && detail.description_ro) ? detail.description_ro : detail.description;
        const hours = (currentLang === 'ro' && detail.hours_ro) ? detail.hours_ro : detail.hours;
        const price = (currentLang === 'ro' && detail.price_ro) ? detail.price_ro : detail.price;
        const tips = (currentLang === 'ro' && detail.tips_ro) ? detail.tips_ro : detail.tips;

        document.getElementById('details-title').textContent = title;
        document.getElementById('details-content').innerHTML = `
            <p><strong>${t('dynamic.about')}:</strong> ${description}</p>
            <p><strong>${t('dynamic.hours')}:</strong> ${hours}</p>
            <p><strong>${t('dynamic.price')}:</strong> ${price}</p>
            <p><strong>${t('dynamic.tips')}:</strong> ${tips}</p>
        `;
        openModal('details-modal');
    }
}

function showRestaurantDetails(restaurantId) {
    const details = {
        cetate: {
            title: 'Cetate Restaurant',
            title_ro: 'Restaurant Cetate',
            menu: 'Sarmale (stuffed cabbage rolls), Mici (grilled meat rolls), Polenta with cheese and sour cream, Traditional soups',
            menu_ro: 'Sarmale, Mici, Mămăligă cu brânză și smântână, supe tradiționale',
            hours: '11:00 AM - 11:00 PM',
            notes: 'Reservations recommended for groups.',
            notes_ro: 'Rezervări recomandate pentru grupuri.'
        },
        ceaun: {
            title: 'La Ceaun',
            title_ro: 'La Ceaun',
            menu: 'Ciorbă (sour soup), Grilled trout, Pork steak with mushrooms, Homemade desserts',
            menu_ro: 'Ciorbă, păstrăv la grătar, friptură de porc cu ciuperci, deserturi de casă',
            hours: '12:00 PM - 10:00 PM',
            notes: 'Cozy atmosphere with fireplace.',
            notes_ro: 'Atmosferă confortabilă cu șemineu.'
        },
        pizzeria: {
            title: 'Pizzeria Castello',
            title_ro: 'Pizzeria Castello',
            menu: 'Wood-fired pizzas, Fresh pasta, Romanian-Italian fusion dishes, Tiramisu',
            menu_ro: 'Pizza la cuptorul din lemn, paste proaspete, fusion romano-italian, Tiramisu',
            hours: '11:00 AM - 11:00 PM',
            hours_ro: '11:00 AM - 11:00 PM',
            notes: 'Delivery available.',
            notes_ro: 'Livrare disponibilă.'
        },
        cafe: {
            title: 'Cafe Central',
            title_ro: 'Cafe Central',
            menu: 'Specialty coffee, Fresh pastries, Breakfast menu, Sandwiches and salads',
            menu_ro: 'Cafea de specialitate, patiserie proaspătă, meniu de micul dejun, sandwich-uri și salate',
            hours: '7:00 AM - 8:00 PM',
            hours_ro: '7:00 AM - 8:00 PM',
            notes: 'Free WiFi available.',
            notes_ro: 'WiFi gratuit disponibil.'
        },
        'belvedere-terrace': {
            title: 'Belvedere Terrace',
            title_ro: 'Terasă Belvedere',
            menu: 'International cuisine, Steaks, Seafood, Fine wines, Gourmet desserts',
            menu_ro: 'Bucătărie internațională, Friptură, Fructe de mare, Vinuri fine, Deserturi gourmet',
            hours: '12:00 PM - 11:00 PM (Kitchen closes at 10:00 PM)',
            hours_ro: '12:00 PM - 11:00 PM (Bucătăria se închide la 10:00 PM)',
            notes: 'Reservations essential for sunset dining. Dress code: Smart casual.',
            notes_ro: 'Rezervări esențiale pentru cina la apus. Cod de îmbrăcăminte: Smart casual.'
        },
        'grill-house': {
            title: 'Grill House Rasnov',
            title_ro: 'Grill House Rasnov',
            menu: 'Mixed grills, BBQ ribs, Chicken skewers, Fresh salads, Local wines and craft beers',
            menu_ro: 'Grătar mixt, Coaste BBQ, Frigărui de pui, Salate proaspete, Vinuri locale și bere artizanală',
            hours: '12:00 PM - 11:00 PM',
            hours_ro: '12:00 PM - 11:00 PM',
            notes: 'Outdoor seating available. Great for groups.',
            notes_ro: 'Locuri de ședere în aer liber. Perfect pentru grupuri.'
        },
        bistro: {
            title: 'Bistro Rasnoveana',
            title_ro: 'Bistro Rasnoveana',
            menu: 'Daily specials, Soups, Burgers, Pasta, Homemade cakes and desserts',
            menu_ro: 'Ofertele zilei, Supe, Hamburgeri, Paste, Prăjituri și deserturi de casă',
            hours: '10:00 AM - 10:00 PM',
            hours_ro: '10:00 AM - 10:00 PM',
            notes: 'Budget-friendly. Quick service. Lunch specials 11:00 AM - 2:00 PM.',
            notes_ro: 'Buget-friendly. Serviciu rapid. Oferte speciale la prânz 11:00 AM - 2:00 PM.'
        },
        vegetarian: {
            title: 'Vegetarian Haven',
            title_ro: 'Vegetarian Haven',
            menu: 'Buddha bowls, Vegan burgers, Fresh juices, Smoothies, Plant-based desserts',
            menu_ro: 'Boluri Buddha, Hamburgeri vegani, Sucuri proaspete, Smoothies, Deserturi pe bază de plante',
            hours: '9:00 AM - 9:00 PM',
            hours_ro: '9:00 AM - 9:00 PM',
            notes: 'All organic ingredients. Gluten-free options available.',
            notes_ro: 'Toate ingredientele sunt ecologice. Opțiuni fără gluten disponibile.'
        }
    };
    
    const detail = details[restaurantId];
    if (detail) {
        const title = (currentLang === 'ro' && detail.title_ro) ? detail.title_ro : detail.title;
        const menu = (currentLang === 'ro' && detail.menu_ro) ? detail.menu_ro : detail.menu;
        const notes = (currentLang === 'ro' && detail.notes_ro) ? detail.notes_ro : detail.notes;

        document.getElementById('details-title').textContent = title;
        document.getElementById('details-content').innerHTML = `
            <p><strong>${t('dynamic.menu_highlights')}:</strong> ${menu}</p>
            <p><strong>${currentLang === 'ro' ? 'Ore' : 'Hours'}:</strong> ${detail.hours}</p>
            <p><strong>${t('dynamic.note')}:</strong> ${notes}</p>
        `;
        openModal('details-modal');
    }
}

function showAccommodationDetails(accommodationId) {
    const details = {
        ambient: {
            title: 'Hotel Ambient',
            title_ro: 'Hotel Ambient',
            description: '4-star hotel with spa, indoor pool, restaurant, and mountain-view rooms.',
            description_ro: 'Hotel de 4 stele cu spa, piscină interioară, restaurant și camere cu vedere la munte.',
            amenities: 'Free WiFi, parking, breakfast included',
            amenities_ro: 'WiFi gratuit, parcare, mic dejun inclus',
            price: 'From €80/night',
            contact: '+40 268 234 567'
        },
        belvedere: {
            title: 'Pension Belvedere',
            title_ro: 'Pensiunea Belvedere',
            description: 'Family-run guesthouse with traditional rooms and homemade breakfast.',
            description_ro: 'Pensiune de familie cu camere tradiționale și mic dejun de casă.',
            amenities: 'Free WiFi, parking, garden',
            amenities_ro: 'WiFi gratuit, parcare, grădină',
            price: 'From €40/night',
            contact: '+40 268 234 568'
        },
        petre: {
            title: 'Casa Petre',
            title_ro: 'Casa Petre',
            description: 'Fully equipped apartments in old town. Perfect for families or longer stays.',
            description_ro: 'Apartamente complet echipate în centrul vechi. Perfect pentru familii sau sejururi mai lungi.',
            amenities: 'Kitchen, WiFi, parking',
            amenities_ro: 'Bucătărie, WiFi, parcare',
            price: 'From €50/night',
            contact: '+40 268 234 569'
        },
        hostel: {
            title: 'Mountain Hostel',
            title_ro: 'Hostel Montan',
            description: 'Budget-friendly with dorms and private rooms.',
            description_ro: 'Economic cu dormitoare și camere private.',
            amenities: 'Shared kitchen, common area, organized trips',
            amenities_ro: 'Bucătărie comună, sufragerie, excursii organizate',
            price: 'From €15/night',
            contact: '+40 268 234 570'
        },
        villa: {
            title: 'Villa Carpathia',
            title_ro: 'Villa Carpathia',
            description: 'Luxury villa with 5 bedrooms, private garden, outdoor pool, and jacuzzi.',
            description_ro: 'Vilă de lux cu 5 dormitoare, grădină privată, piscină în aer liber și jacuzzi.',
            amenities: 'Private pool, garden, BBQ area, full kitchen, parking',
            amenities_ro: 'Piscină privată, grădină, zonă BBQ, bucătărie complet echipată, parcare',
            price: 'From €300/night (sleeps 10)',
            contact: '+40 268 234 571'
        },
        boutique: {
            title: 'Boutique Hotel Residence',
            title_ro: 'Boutique Hotel Residence',
            description: 'Contemporary 4-star boutique hotel with rooftop bar and fitness center.',
            description_ro: 'Hotel boutique contemporan de 4 stele cu bar pe acoperiș și centru de fitness.',
            amenities: 'Rooftop bar, gym, restaurant, spa treatments, free WiFi',
            amenities_ro: 'Bar pe acoperiș, sală de sport, restaurant, tratamente spa, WiFi gratuit',
            price: 'From €90/night',
            contact: '+40 268 234 572'
        },
        cabins: {
            title: 'Mountain Cabins',
            title_ro: 'Căsuțe Montane',
            description: 'Rustic wooden cabins with modern amenities. Each with fireplace and private terrace.',
            description_ro: 'Căsuțe din lemn rustic cu facilități moderne. Fiecare cu șemineu și terasă privată.',
            amenities: 'Fireplace, terrace, kitchenette, WiFi',
            amenities_ro: 'Șemineu, terasă, bucătărie mică, WiFi',
            price: 'From €60/night (2 persons)',
            contact: '+40 268 234 573'
        },
        'casa-maria': {
            title: 'Casa Maria B&B',
            title_ro: 'Casa Maria B&B',
            description: 'Traditional bed and breakfast run by local family. Authentic experience with homemade meals.',
            description_ro: 'Pensiune tradițională de mic dejun și masă administrată de o familie locală. Experiență autentică cu mâncăruri de casă.',
            amenities: 'Breakfast included, shared lounge, garden, WiFi',
            amenities_ro: 'Mic dejun inclus, sufragerie comună, grădină, WiFi',
            price: 'From €35/night',
            contact: '+40 268 234 574'
        }
    };
    
    const detail = details[accommodationId];
    if (detail) {
        const title = (currentLang === 'ro' && detail.title_ro) ? detail.title_ro : detail.title;
        const description = (currentLang === 'ro' && detail.description_ro) ? detail.description_ro : detail.description;
        const amenities = (currentLang === 'ro' && detail.amenities_ro) ? detail.amenities_ro : detail.amenities;

        document.getElementById('details-title').textContent = title;
        document.getElementById('details-content').innerHTML = `
            <p><strong>${t('dynamic.description')}:</strong> ${description}</p>
            <p><strong>${t('dynamic.amenities')}:</strong> ${amenities}</p>
            <p><strong>${currentLang === 'ro' ? 'Preț' : 'Price'}:</strong> ${detail.price}</p>
            <p><strong>${t('dynamic.book')}:</strong> ${detail.contact}</p>
        `;
        openModal('details-modal');
    }
}

// Map Loading Function
let map = null;

function loadMap() {
    const mapDiv = document.getElementById('interactive-map');
    
    // Check if Leaflet library is available
    if (typeof L === 'undefined') {
        // Fallback for when Leaflet is not available (CDN blocked or offline)
        const title = translateMessage('Interactive map showing all locations, restaurants, and accommodations');
        const locationsLabel = translateMessage('📍 Locations');
        const restaurantsLabel = translateMessage('🍽️ Restaurants');
        const accommodationsLabel = translateMessage('🏨 Accommodations');
        const infoLine = translateMessage('In production, this displays a fully interactive map powered by OpenStreetMap/Leaflet');

        mapDiv.innerHTML = `
            <div id="map-fallback" style="width: 100%; height: 100%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center; flex-direction: column; padding: 2rem; color: white; border-radius: 12px;">
                <i class="fas fa-map-marked-alt" style="font-size: 5rem; margin-bottom: 2rem; opacity: 0.9;"></i>
                <h3 style="color: white; margin-bottom: 1.5rem; font-size: 1.8rem;">${translateMessage('Interactive Map')}</h3>
                <p style="color: rgba(255,255,255,0.9); text-align: center; margin-bottom: 2rem; max-width: 600px;">
                    ${title}
                </p>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1.5rem; margin-top: 2rem; width: 100%; max-width: 900px;">
                    <div style="background: rgba(255,255,255,0.95); padding: 1.5rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); color: #333;">
                        <strong style="color: #2c5f8d; font-size: 1.1rem; display: block; margin-bottom: 0.5rem;">${locationsLabel}</strong>
                        <small style="color: #666;">Rasnov Fortress, Dino Parc, Piatra Mica Peak, Village Museum, Bran Castle, Poiana Brasov, Brasov Old Town, Peles Castle, National Park, Bear Sanctuary</small>
                    </div>
                    <div style="background: rgba(255,255,255,0.95); padding: 1.5rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); color: #333;">
                        <strong style="color: #e8734e; font-size: 1.1rem; display: block; margin-bottom: 0.5rem;">${restaurantsLabel}</strong>
                        <small style="color: #666;">Cetate Restaurant, La Ceaun, Pizzeria Castello, Cafe Central, Belvedere Terrace, Grill House, Bistro Rasnoveana, Vegetarian Haven</small>
                    </div>
                    <div style="background: rgba(255,255,255,0.95); padding: 1.5rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); color: #333;">
                        <strong style="color: #4caf50; font-size: 1.1rem; display: block; margin-bottom: 0.5rem;">${accommodationsLabel}</strong>
                        <small style="color: #666;">Hotel Ambient, Pension Belvedere, Casa Petre, Mountain Hostel, Villa Carpathia, Boutique Hotel Residence, Mountain Cabins, Casa Maria B&B</small>
                    </div>
                </div>
                <p style="margin-top: 2rem; color: rgba(255,255,255,0.7); font-size: 0.95rem; text-align: center;">
                    <i class="fas fa-info-circle"></i> ${infoLine}
                </p>
            </div>
        `;
        mapDiv.classList.add('loaded');
        showNotification('Map loaded with all locations!', 'success');
        return;
    }
    
    // Clear placeholder content
    mapDiv.innerHTML = '<div id="map-display" style="width: 100%; height: 100%;"></div>';
    
    // Initialize Leaflet map
    window.map = L.map('map-display').setView([45.5889, 25.4631], 14);
    
    // Add OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19
    }).addTo(window.map);
    
    // Define custom icons
    const locationIcon = L.icon({
        iconUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDMyIDQwIj48cGF0aCBmaWxsPSIjMmM1ZjhkIiBkPSJNMTYgMEMxMC40ODYgMCA2IDQuNDg2IDYgMTBjMCA3LjUgMTAgMTcuNSAxMCAzMCAwIDAgMTAtMjIuNSAxMC0zMCAwLTUuNTE0LTQuNDg2LTEwLTEwLTEwem0wIDE1Yy0yLjc2MSAwLTUtMi4yMzktNS01czIuMjM5LTUgNS01IDUgMi4yMzkgNSA1LTIuMjM5IDUtNSA1eiIvPjwvc3ZnPg==',
        iconSize: [32, 40],
        iconAnchor: [16, 40],
        popupAnchor: [0, -40]
    });
    
    const restaurantIcon = L.icon({
        iconUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDMyIDQwIj48cGF0aCBmaWxsPSIjZTg3MzRlIiBkPSJNMTYgMEMxMC40ODYgMCA2IDQuNDg2IDYgMTBjMCA3LjUgMTAgMTcuNSAxMCAzMCAwIDAgMTAtMjIuNSAxMC0zMCAwLTUuNTE0LTQuNDg2LTEwLTEwLTEwem0wIDE1Yy0yLjc2MSAwLTUtMi4yMzktNS01czIuMjM5LTUgNS01IDUgMi4yMzkgNSA1LTIuMjM5IDUtNSA1eiIvPjwvc3ZnPg==',
        iconSize: [32, 40],
        iconAnchor: [16, 40],
        popupAnchor: [0, -40]
    });
    
    const accommodationIcon = L.icon({
        iconUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDMyIDQwIj48cGF0aCBmaWxsPSIjNGNhZjUwIiBkPSJNMTYgMEMxMC40ODYgMCA2IDQuNDg2IDYgMTBjMCA3LjUgMTAgMTcuNSAxMCAzMCAwIDAgMTAtMjIuNSAxMC0zMCAwLTUuNTE0LTQuNDg2LTEwLTEwLTEwem0wIDE1Yy0yLjc2MSAwLTUtMi4yMzktNS01czIuMjM5LTUgNS01IDUgMi4yMzkgNSA1LTIuMjM5IDUtNSA1eiIvPjwvc3ZnPg==',
        iconSize: [32, 40],
        iconAnchor: [16, 40],
        popupAnchor: [0, -40]
    });

    // Hunt destination icons: green question mark (difficulty 1) and red (difficulty 2)
    const makeHuntIcon = (color) => L.divIcon({
        className: '',
        html: `<div style="width:32px;height:40px;display:flex;align-items:flex-start;justify-content:center;"><svg xmlns="http://www.w3.org/2000/svg" width="32" height="40" viewBox="0 0 32 40"><path fill="${color}" d="M16 0C10.486 0 6 4.486 6 10c0 7.5 10 17.5 10 30 0 0 10-22.5 10-30 0-5.514-4.486-10-10-10z"/><text x="16" y="16" text-anchor="middle" dominant-baseline="middle" fill="white" font-size="13" font-weight="bold" font-family="Arial,sans-serif">?</text></svg></div>`,
        iconSize: [32, 40],
        iconAnchor: [16, 40],
        popupAnchor: [0, -40]
    });
    const huntEasyIcon = makeHuntIcon('#27ae60'); // green – difficulty 1
    const huntHardIcon = makeHuntIcon('#e74c3c'); // red   – difficulty 2
    
    // Load markers from places data
    loadMapMarkers(locationIcon, restaurantIcon, accommodationIcon, huntEasyIcon, huntHardIcon);
    
    mapDiv.classList.add('loaded');
    showNotification('Map loaded successfully!', 'success');
}

/**
 * Load map markers from places data
 */
async function loadMapMarkers(locationIcon, restaurantIcon, accommodationIcon, huntEasyIcon, huntHardIcon) {
    // Use event-based approach to wait for data
    const placesData = await waitForPlacesData();
    
    if (!placesData) {
        console.error('❌ Could not load places data for map');
        return;
    }
    
    console.log('📍 Loading map markers from places data...');
    
    // Add locations – use hunt destination icons for tagged places
    if (placesData.locations) {
        placesData.locations.forEach(place => {
            if (place.huntDestination && huntEasyIcon && huntHardIcon) {
                const huntIcon = place.difficulty === 2 ? huntHardIcon : huntEasyIcon;
                addMarkerToMap(place, 'location', huntIcon);
            } else {
                addMarkerToMap(place, 'location', locationIcon);
            }
        });
    }
    
    // Add restaurants
    if (placesData.restaurants) {
        placesData.restaurants.forEach(place => {
            addMarkerToMap(place, 'restaurant', restaurantIcon);
        });
    }
    
    // Add accommodations
    if (placesData.accommodations) {
        placesData.accommodations.forEach(place => {
            addMarkerToMap(place, 'accommodation', accommodationIcon);
        });
    }
    
    console.log('✅ Map markers loaded successfully');
}

/**
 * Wait for places data to be loaded with retry logic
 */
async function waitForPlacesData(maxAttempts = 10, delayMs = 500) {
    for (let i = 0; i < maxAttempts; i++) {
        const placesData = window.getPlacesData ? window.getPlacesData() : null;
        if (placesData) {
            return placesData;
        }
        if (i < maxAttempts - 1) {
            console.log(`⏳ Waiting for places data (attempt ${i + 1}/${maxAttempts})...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    return null;
}

/**
 * Add a marker to the map
 */
function addMarkerToMap(place, type, icon) {
    if (!window.map || !place.coordinates) return;
    
    const { lat, lng } = place.coordinates;
    
    // Create popup content with enhanced information
    const popupContent = `
        <div class="map-popup">
            <h3 style="margin: 0 0 0.5rem 0; font-size: 1.1rem; color: #2c3e50;">
                ${escapeHtml(place.name)}
            </h3>
            ${place.rating ? `
                <div style="margin-bottom: 0.5rem;">
                    <span style="color: #f39c12;">⭐ ${place.rating.toFixed(1)}</span>
                    <span style="color: #666; font-size: 0.9rem;"> (${place.userRatingsTotal} reviews)</span>
                </div>
            ` : ''}
            ${place.address ? `
                <p style="margin: 0.3rem 0; font-size: 0.9rem; color: #666;">
                    📍 ${escapeHtml(place.address)}
                </p>
            ` : ''}
            ${place.phone ? `
                <p style="margin: 0.3rem 0; font-size: 0.9rem; color: #666;">
                    📞 ${escapeHtml(place.phone)}
                </p>
            ` : ''}
            ${place.openingHours ? `
                <p style="margin: 0.3rem 0; font-size: 0.9rem; color: ${place.openingHours.openNow ? '#27ae60' : '#e74c3c'};">
                    ${place.openingHours.openNow ? '✅ Open now' : '❌ Closed'}
                </p>
            ` : ''}
        </div>
    `;
    
    const marker = L.marker([lat, lng], { icon: icon })
        .addTo(window.map)
        .bindPopup(popupContent);
    
    // Add click handler to marker to show details
    marker.on('popupopen', () => {
        // Add event listener to the popup after it opens
        setTimeout(() => {
            const popup = marker.getPopup();
            const popupElement = popup.getElement();
            if (popupElement) {
                const button = document.createElement('button');
                button.textContent = 'View Details';
                button.style.cssText = `
                    margin-top: 0.8rem;
                    padding: 0.5rem 1rem;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 0.9rem;
                    width: 100%;
                `;
                button.addEventListener('click', () => {
                    showDynamicDetails(place.id, type === 'location' ? 'locations' : type + 's');
                });
                const popupContent = popupElement.querySelector('.map-popup');
                if (popupContent) {
                    popupContent.appendChild(button);
                }
            }
        }, 50);
    });
}

/**
 * Helper function to escape HTML (avoid XSS)
 */
function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Language Toggle (powered by i18next – see js/i18n.js)
const langToggle = document.querySelector('.lang-toggle');

// currentLang mirrors i18next.language and is updated via the 'languageChanged' event.
// It is kept as a module-level variable so the rest of the file can reference it unchanged.
let currentLang = (typeof window.getCurrentLang === 'function') ? window.getCurrentLang() : 'en';

document.addEventListener('languageChanged', (e) => {
    currentLang = e.detail.lng;
    if (langToggle) {
        langToggle.innerHTML = `<i class="fas fa-globe"></i> ${currentLang.toUpperCase()}`;
    }
    refreshDynamicTranslations();
});

if (langToggle) {
    langToggle.addEventListener('click', () => {
        const newLang = currentLang === 'en' ? 'ro' : 'en';
        if (typeof window.switchLanguage === 'function') {
            window.switchLanguage(newLang).then(() => {
                showNotification(t('dynamic.lang_changed_' + newLang), 'info');
            });
        }
    });
}

/**
 * Refreshes UI elements whose text was set dynamically (not via data-i18n).
 * Called whenever the active language changes.
 */
function refreshDynamicTranslations() {
    // Progress text (contains live-updating count spans, so handled manually)
    const progressCountEl = document.getElementById('progress-count');
    const progressTotalEl = document.getElementById('progress-total');
    const progressTextEl  = document.querySelector('.progress-text');
    if (progressTextEl && progressCountEl && progressTotalEl) {
        const found = progressCountEl.textContent;
        const total = progressTotalEl.textContent;
        progressTextEl.innerHTML =
            `<span id="progress-count">${found}</span> / <span id="progress-total">${total}</span> ${t('hunt.progress_suffix')}`;
    }
}

// ==================== Initialization ====================

// ==================== Theme Unlocks System ====================
const THEMES = [
    {
        id: 'default',
        name: 'Mountain Blue',
        emoji: '🏔️',
        description: 'The classic Rasnov look.',
        pointsRequired: 0,
        vars: {
            '--primary-color': '#2c5f8d',
            '--secondary-color': '#e8734e',
            '--accent-color': '#f4a460'
        }
    },
    {
        id: 'forest',
        name: 'Forest Green',
        emoji: '🌲',
        description: 'Deep Carpathian forest vibes.',
        pointsRequired: 30,
        vars: {
            '--primary-color': '#2e7d32',
            '--secondary-color': '#ff8f00',
            '--accent-color': '#66bb6a'
        }
    },
    {
        id: 'sunset',
        name: 'Sunset Glow',
        emoji: '🌅',
        description: 'Warm glow of a Rasnov sunset.',
        pointsRequired: 80,
        vars: {
            '--primary-color': '#bf360c',
            '--secondary-color': '#fdd835',
            '--accent-color': '#ff7043'
        }
    },
    {
        id: 'survey',
        name: 'Survey Supporter',
        emoji: '📋',
        description: 'Unlocked by starting the Rasnov survey. Thank you for your feedback!',
        pointsRequired: 0,
        surveyRequired: true,
        vars: {
            '--primary-color': '#6a1b9a',
            '--secondary-color': '#f06292',
            '--accent-color': '#ce93d8'
        }
    }
];

// ==================== Discounts System ====================
const DISCOUNTS = [
    {
        emoji: '☕',
        name: '10% off at local cafés',
        description: 'Show your progress to any participating café in Rasnov old town.',
        placesRequired: 2
    },
    {
        emoji: '🦕',
        name: 'Free Dino Park upgrade',
        description: 'Upgrade your Dino Park ticket to premium for free.',
        placesRequired: 4
    },
    {
        emoji: '🏰',
        name: 'Free fortress audio guide',
        description: 'Download the Rasnov Fortress audio guide at no charge.',
        placesRequired: 6
    },
    {
        emoji: '🎁',
        name: 'Rasnov explorer souvenir',
        description: 'Collect a free Rasnov explorer pin from the tourism office.',
        placesRequired: 8
    }
];

function applyTheme(themeId) {
    const theme = THEMES.find(t => t.id === themeId);
    if (!theme) return;
    const root = document.documentElement;
    Object.entries(theme.vars).forEach(([prop, val]) => {
        root.style.setProperty(prop, val);
    });
    localStorage.setItem('rasnov_theme', themeId);
    renderUnlocksTab();
}

// Check if a new collage tier has been unlocked and show the popup
function checkCollageUnlocks() {
    const total = foundLocations.size + foundExtraLocations.size;
    if (total >= 10 && !localStorage.getItem('rasnov_collage_gold_shown')) {
        localStorage.setItem('rasnov_collage_gold_shown', '1');
        setTimeout(() => showCollageUnlockModal('gold'), 2500);
    } else if (total >= 6 && !localStorage.getItem('rasnov_collage_silver_shown')) {
        localStorage.setItem('rasnov_collage_silver_shown', '1');
        setTimeout(() => showCollageUnlockModal('silver'), 2500);
    }
}

function showCollageUnlockModal(tier) {
    const isGold = tier === 'gold';
    const modal = document.getElementById('collage-unlock-modal');
    if (!modal) return;
    const badgeEl = document.getElementById('collage-unlock-badge');
    const titleEl = document.getElementById('collage-unlock-title');
    const msgEl = document.getElementById('collage-unlock-msg');
    if (badgeEl) badgeEl.textContent = isGold ? '🥇' : '🥈';
    if (titleEl) titleEl.textContent = isGold ? 'Gold Collage Unlocked!' : 'Silver Collage Unlocked!';
    if (msgEl) msgEl.textContent = isGold
        ? "You've visited 10 places — your collage now has a golden frame. Share your Rasnov adventure!"
        : "You've visited 6 places — your collage now has a silver frame. Keep exploring for gold!";
    openModal('collage-unlock-modal');
}

function setCollageStyle(style) {
    localStorage.setItem('rasnov_collage_style', style);
    renderUnlocksTab();
}

function buildCollageHTML(totalFound) {
    const locationKeys = Object.keys(huntLocations);
    const tier = totalFound >= 10 ? 'gold' : (totalFound >= 6 ? 'silver' : '');
    const borderClass = tier === 'gold' ? 'gold-border' : (tier === 'silver' ? 'silver-border' : '');
    const tierLabelHTML = tier
        ? `<div class="collage-tier-label ${tier}">${tier === 'gold' ? '🥇 Gold Collage' : '🥈 Silver Collage'}</div>`
        : '';

    const collageStyle = localStorage.getItem('rasnov_collage_style') || 'postit';
    const styleClass = collageStyle === 'hex' ? 'style-hex' : (collageStyle === 'grid' ? 'style-grid' : 'style-postit');

    // Pre-defined rotations and tape colours for a natural scattered/polaroid look
    const cellMeta = [
        { rot: -3, tape: '#ffd966' },
        { rot:  2, tape: '#b6d7a8' },
        { rot: -1, tape: '#9fc5e8' },
        { rot:  4, tape: '#f9cb9c' },
        { rot: -2, tape: '#ead1dc' },
        { rot:  1, tape: '#ffd966' },
        { rot:  3, tape: '#b6d7a8' },
        { rot: -4, tape: '#9fc5e8' },
    ];

    // Only include cells that have a photo (dynamic — no empty placeholders)
    const photoCells = locationKeys.filter(key => {
        const p = localStorage.getItem(`ar_photo_${key}`);
        return p && p.startsWith('data:image/jpeg;base64,');
    });

    let cellsHTML = '';
    if (photoCells.length === 0) {
        cellsHTML = `<div class="collage-empty-state">
            <span class="collage-empty-icon">📷</span>
            <p>Your photos will appear here as you explore Rasnov!</p>
        </div>`;
    } else {
        cellsHTML = photoCells.map((key, i) => {
            const savedPhoto = localStorage.getItem(`ar_photo_${key}`);
            const loc = huntLocations[key];
            const label = escapeHtml(localizedField(loc, 'name') || loc.name);
            const meta = cellMeta[i % cellMeta.length];
            const style = `--cell-rot: ${meta.rot}deg; --tape-color: ${meta.tape};`;
            return `<div class="collage-cell" style="${style}"><img src="${savedPhoto}" alt="${label}"><span class="collage-cell-label">${label}</span></div>`;
        }).join('');
    }

    // Style toggle buttons
    const styleToggleHTML = `
        <div class="collage-style-toggle">
            <button class="collage-style-btn ${collageStyle === 'postit' ? 'active' : ''}" onclick="setCollageStyle('postit')">📌 Post-it</button>
            <button class="collage-style-btn ${collageStyle === 'hex' ? 'active' : ''}" onclick="setCollageStyle('hex')">⬡ Hexagons</button>
            <button class="collage-style-btn ${collageStyle === 'grid' ? 'active' : ''}" onclick="setCollageStyle('grid')">⊞ Grid</button>
        </div>`;

    const shareText = encodeURIComponent('Check out my Rasnov exploration! #discoverrasnov');
    const shareUrl = encodeURIComponent('https://discoverrasnov.com');
    const shareHTML = tier ? `
        <div class="social-share-row">
            <a href="https://twitter.com/intent/tweet?text=${shareText}&url=${shareUrl}" target="_blank" rel="noopener noreferrer" class="share-btn twitter"><i class="fab fa-twitter"></i> X / Twitter</a>
            <a href="https://www.facebook.com/sharer/sharer.php?u=${shareUrl}&quote=${shareText}" target="_blank" rel="noopener noreferrer" class="share-btn facebook"><i class="fab fa-facebook-f"></i> Facebook</a>
            <a href="https://wa.me/?text=${shareText}%20${shareUrl}" target="_blank" rel="noopener noreferrer" class="share-btn whatsapp"><i class="fab fa-whatsapp"></i> WhatsApp</a>
            <span class="share-btn instagram" title="Open Instagram and post manually with #discoverrasnov"><i class="fab fa-instagram"></i> Instagram*</span>
        </div>
        <p class="collage-instagram-note">*Instagram does not support direct web sharing. Open Instagram and post with <strong>#discoverrasnov</strong>.</p>
    ` : '';

    return `<div class="collage-wrapper ${borderClass} ${styleClass}">
        ${tierLabelHTML}
        <div class="collage-title-row">
            <span class="collage-board-title">📍 My Rasnov Memories</span>
        </div>
        ${styleToggleHTML}
        <div class="collage-grid">${cellsHTML}</div>
        <div class="collage-footer">${photoCells.length} photo${photoCells.length !== 1 ? 's' : ''} · ${totalFound} / 10 places explored${tier ? '' : ' — find 6 for a silver collage, 10 for gold'}</div>
        ${shareHTML}
    </div>`;
}

function renderUnlocksTab() {
    const container = document.getElementById('unlocks');
    if (!container) return;
    const userPoints = (currentUser && currentUser.totalPoints) || 0;
    const savedTheme = localStorage.getItem('rasnov_theme') || 'default';
    const surveyStarted = localStorage.getItem('rasnov_survey_started') === '1';
    const totalFound = foundLocations.size + foundExtraLocations.size;

    // Compact one-line theme badges
    const themeBadgesHTML = THEMES.map(theme => {
        const unlocked = theme.surveyRequired ? surveyStarted : userPoints >= theme.pointsRequired;
        const active = savedTheme === theme.id;
        const ptsLabel = theme.surveyRequired
            ? translateMessage('Survey')
            : (theme.pointsRequired === 0 ? '🔓' : `${theme.pointsRequired} pts`);
        const applyBtn = (unlocked && !active)
            ? `<button class="theme-badge-apply" onclick="applyTheme('${theme.id}')">Apply</button>`
            : '';
        return `<div class="theme-badge ${unlocked ? 'unlocked' : 'locked'} ${active ? 'active-theme' : ''}">
            <span class="theme-badge-emoji">${theme.emoji}</span>
            <span class="theme-badge-name">${theme.name}${active ? ' ✓' : ''}</span>
            <span class="theme-badge-pts">${ptsLabel}</span>
            ${applyBtn}
        </div>`;
    }).join('');

    // Discounts
    const discountsHTML = DISCOUNTS.map(d => {
        const unlocked = totalFound >= d.placesRequired;
        return `<div class="discount-card ${unlocked ? 'unlocked' : 'locked'}">
            <div class="discount-emoji">${d.emoji}</div>
            <div class="discount-name">${d.name}</div>
            <div class="discount-desc">${d.description}</div>
            <div class="discount-req">${unlocked ? '✓ Unlocked!' : `🔒 Find ${d.placesRequired} places`}</div>
        </div>`;
    }).join('');

    container.innerHTML = `
        <h2 class="section-title">🎁 Rewards</h2>

        <div class="rewards-section">
            <div class="rewards-section-title">🎨 Theme Unlocks</div>
            <div class="theme-unlocks-row">${themeBadgesHTML}</div>
        </div>

        <div class="rewards-section">
            <div class="rewards-section-title">🏷️ Discounts</div>
            <div class="discounts-grid">${discountsHTML}</div>
        </div>

        <div class="rewards-section">
            <div class="rewards-section-title">🖼️ Your Rasnov Collage</div>
            <p class="collage-intro">Your memories from exploring Rasnov. Earn a silver frame at 6 places and a gold frame at 10.</p>
            ${buildCollageHTML(totalFound)}
        </div>`;
}

// Initialize user account system
initializeUser();

// Load saved theme (after user is initialized so points are available)
(function loadSavedTheme() {
    const saved = localStorage.getItem('rasnov_theme');
    if (saved && saved !== 'default') applyTheme(saved);
})();

// Hunt-page-only initialization
if (isHuntPage) {
    // Initialize button states (before restoreHuntState which may re-enable them)
    if (scanQrBtn) scanQrBtn.disabled = true;

    // Restore hunt state (found locations, photos, button states) from saved data
    restoreHuntState();

    // Initialize progress display
    updateProgress();

    // Handle QR code URL parameters (?location=...) from scanned QR codes
    handleURLParameters();
}

// Add smooth scroll behavior
document.documentElement.style.scrollBehavior = 'smooth';

console.log('Discover Rasnov - Tourist Website Initialized');
console.log('Testing mode available for treasure hunt');
console.log('User Points System Active - Points saved to account');
