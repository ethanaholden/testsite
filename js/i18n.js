(function () {
    'use strict';

    var DEFAULT_LANG = 'en';

    var FALLBACK_EN = {
        nav: { home: 'Discover Rasnov', hunt: 'Treasure Hunt', map: 'Map', info: 'Info' },
        header: { guest: 'Guest', points: 'pts', langLabel: 'EN' },
        map: {
            title: 'Interactive Map',
            subtitle: 'Interactive map showing all locations, restaurants, and accommodations',
            cta: 'Load Map',
            locations: '📍 Locations',
            restaurants: '🍽️ Restaurants',
            accommodations: '🏨 Accommodations',
            scavenger: {
                discovered: 'Discovered!',
                upNext: "You're up next!",
                findQr: 'Find the QR code near {{name}} to unlock it!',
                goToHunt: 'Go to Hunt →',
                mystery: 'Find a mystery location here!',
                easy: 'Easy',
                medium: 'Medium',
                hard: 'Hard',
                foundCount: '{{found}}/{{total}} found'
            }
        },
        footer: {
            aboutTitle: 'About Rasnov',
            aboutText: 'Historic town in Transylvania, Romania, known for its medieval fortress and stunning mountain scenery.',
            quickLinksTitle: 'Quick Links', contactTitle: 'Contact',
            home: 'Home', hunt: 'Treasure Hunt', map: 'Map', infoLink: 'Info',
            copyright: '© 2026 Discover Rasnov. Made with ❤ for tourists.'
        },
        messages: {
            startHuntFirst: 'Please start the hunt first!',
            gettingLocation: 'Getting your location...',
            locationError: 'Could not get your location. Please enable location services.',
            geolocationNotSupported: 'Geolocation is not supported by your browser.',
            cameraNotSupported: 'Camera access is not supported on this browser. Please use a modern browser with HTTPS.',
            cameraError: 'Could not access camera.',
            qrSuccess: 'QR Code scanned successfully!',
            alreadyFound: 'You already found this location!',
            qrUnrecognized: "QR code not recognized. Make sure you're at a treasure hunt location.",
            noLocationsNearby: 'No locations nearby. Keep exploring!',
            cameraBlockedTitle: 'Camera Access Required',
            cameraBlockedMessage: 'Please allow camera access in your browser settings to scan QR codes.',
            initializingCamera: 'Initializing Camera...',
            huntStarted: 'Treasure hunt started! Find all 8 locations.',
            huntStopped: 'Treasure hunt stopped.',
            huntStartedTimer: 'Hunt Started!',
            timeToFind: 'Time to find this location',
            greatJob: 'Great job exploring Rasnov!',
            youFound: 'You found {{name}}!',
            funFact: 'Fun Fact',
            takePhoto: '📸 Take a Photo Here',
            huntComplete: '🎉 Congratulations! You completed the treasure hunt! Total points: {{points}}',
            bonusLocationsPrompt: 'Now find the bonus locations hidden around town!',
            bearWalking: '🐻 Grizzly is walking toward you!',
            bearHere: '🐻 Grizzly is here! Take a photo!',
            moveCamera: 'Move the camera around and find Grizzly!',
            pointAtGround: 'Point at the ground, then tap to place Grizzly!',
            findGrizzly: 'Find Grizzly and take a picture!',
            langChangedRo: 'Limba a fost schimbată în Română',
            langChangedEn: 'Language changed to English'
        },
        details: {
            about: 'About', hours: 'Hours', price: 'Price', tips: 'Tips',
            menuHighlights: 'Menu Highlights', note: 'Note', description: 'Description',
            amenities: 'Amenities', book: 'Book'
        },
        cards: {
            learnMore: 'Learn More',
            ratedBy: 'Rated {{rating}}/5 by {{count}} visitors.',
            reviews: '{{count}} reviews',
            openNow: 'Open now',
            closed: 'Closed',
            defaultDesc: 'A wonderful place to visit in Rasnov',
            lastUpdated: 'Data last updated: {{date}}',
            loading: 'Loading amazing places...',
            featuredPlace: 'Featured Place of the Day',
            address: 'Address',
            phone: 'Phone',
            website: 'Website',
            openingHours: 'Opening Hours',
            priceLevel: 'Price Level',
            visitWebsite: 'Visit website',
            viewOnMap: 'View on Map',
            callNow: 'Call Now',
            price: {
                inexpensive: 'Inexpensive',
                moderate: 'Moderate',
                expensive: 'Expensive',
                veryExpensive: 'Very Expensive'
            }
        },
        rewards: {
            title: 'Rewards',
            themeUnlocks: 'Theme Unlocks',
            discounts: 'Discounts',
            collageTitle: 'Your Rasnov Collage',
            collageIntro: 'Your memories from exploring Rasnov. Earn a silver frame at 6 places and a gold frame at 10.',
            apply: 'Apply',
            unlocked: '✓ Unlocked!',
            findPlaces: '🔒 Find {{count}} places',
            goldCollage: 'Gold Collage',
            silverCollage: 'Silver Collage',
            collageEmpty: 'Scan a location QR code and take your first photo to start building your collage!',
            collageFooter: '📷 {{photos}} photo · {{found}} / {{total}} places explored',
            collageFooterPlural: '📷 {{photos}} photos · {{found}} / {{total}} places explored',
            collageTip: '— find {{silver}} for a silver collage, {{gold}} for gold',
            polaroid: '📌 Polaroid',
            hexagon: '⬡ Hexagon',
            grid: '▦ Grid',
            download: '📥 Download',
            share: '📤 Share',
            journeyTitle: '🗺️ My Rasnov Journey',
            photoSaved: 'Photo saved to your collage!'
        }
    };

    function applyI18n() {
        var lang = i18next.language || DEFAULT_LANG;
        document.documentElement.lang = lang;

        document.querySelectorAll('[data-i18n]').forEach(function (el) {
            var key = el.dataset.i18n;
            var translated = i18next.t(key);
            if (translated && translated !== key) {
                el.textContent = translated;
            }
        });

        document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
            var key = el.dataset.i18nHtml;
            var translated = i18next.t(key);
            if (translated && translated !== key) {
                el.innerHTML = translated;
            }
        });

        document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
            var key = el.dataset.i18nPlaceholder;
            var translated = i18next.t(key);
            if (translated && translated !== key) {
                el.placeholder = translated;
            }
        });
    }

    function interpolate(str, vars) {
        if (!vars) return str;
        return str.replace(/\{\{(\w+)\}\}/g, function (_, k) {
            return vars[k] !== undefined ? vars[k] : '{{' + k + '}}';
        });
    }

    function resolveFallback(key, vars) {
        var parts = key.split('.');
        var obj = FALLBACK_EN;
        for (var i = 0; i < parts.length; i++) {
            if (obj == null || typeof obj !== 'object') return key;
            obj = obj[parts[i]];
        }
        if (typeof obj === 'string') return interpolate(obj, vars);
        return key;
    }

    window.t = function (key, vars) {
        var result = i18next.t(key, vars);
        if (!result || result === key) {
            return resolveFallback(key, vars);
        }
        return result;
    };

    window.switchLanguage = function (lang) {
        i18next.changeLanguage(lang, function () {
            applyI18n();
            try { localStorage.setItem('rasnov_lang', lang); } catch (e) { /* ignore */ }
            document.dispatchEvent(new CustomEvent('languageChanged', { detail: { lang: lang } }));
        });
    };

    window.getCurrentLang = function () {
        return i18next.language || DEFAULT_LANG;
    };

    document.addEventListener('DOMContentLoaded', function () {
        var savedLang = DEFAULT_LANG;
        try { savedLang = localStorage.getItem('rasnov_lang') || DEFAULT_LANG; } catch (e) { /* ignore */ }

        var i18nConfig = {
            lng: savedLang,
            fallbackLng: DEFAULT_LANG,
            debug: false,
            interpolation: { escapeValue: false },
            backend: {
                loadPath: '/locales/{{lng}}/translation.json'
            }
        };

        var backends = typeof i18nextHttpBackend !== 'undefined'
            ? [i18nextHttpBackend]
            : [];

        var initFn = backends.length
            ? i18next.use(backends[0]).init.bind(i18next)
            : i18next.init.bind(i18next);

        initFn(i18nConfig, function (err) {
            if (err) {
                console.warn('i18next backend failed, using fallback strings.', err);
            }
            applyI18n();
            var lang = i18next.language || savedLang;
            document.dispatchEvent(new CustomEvent('languageChanged', { detail: { lang: lang } }));
        });
    });
}());
