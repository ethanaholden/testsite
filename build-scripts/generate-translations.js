'use strict';

/**
 * generate-translations.js
 *
 * Reads locales/translations.csv and writes locales/{lang}/translation.json
 * for every language column found in the CSV.
 *
 * CSV format (first row is header):
 *   key,english,romanian[,french,...]
 *
 * Column names are mapped to BCP-47 language codes via LANG_MAP below.
 * Add a new entry there whenever a new language column is added to the CSV.
 *
 * Rules:
 *  - If a non-English translation is missing for a key, the English value is
 *    used as a fallback and a warning is printed (site keeps running).
 *  - If an English value is also missing, the key is omitted and a warning is
 *    printed.
 *  - The script never throws – on unrecoverable errors it logs and returns
 *    false so the caller can decide whether to abort.
 *
 * Usage (standalone):
 *   node build-scripts/generate-translations.js
 *
 * Usage (programmatic):
 *   const generate = require('./build-scripts/generate-translations');
 *   generate(); // returns true on success, false on fatal error
 */

const fs   = require('fs');
const path = require('path');

// Map lowercase CSV column names → BCP-47 language codes
const LANG_MAP = {
    english:   'en',
    romanian:  'ro',
};

const CSV_PATH    = path.join(__dirname, '..', 'locales', 'translations.csv');
const LOCALES_DIR = path.join(__dirname, '..', 'locales');

// ---------------------------------------------------------------------------
// Minimal RFC-4180-compliant CSV parser (no external dependencies)
// ---------------------------------------------------------------------------
function parseCSV(text) {
    const rows = [];
    let row    = [];
    let field  = '';
    let inQuotes = false;
    let i = 0;

    while (i < text.length) {
        const ch = text[i];

        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    // Escaped double-quote inside a quoted field
                    field += '"';
                    i += 2;
                } else {
                    inQuotes = false;
                    i++;
                }
            } else {
                field += ch;
                i++;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
                i++;
            } else if (ch === ',') {
                row.push(field);
                field = '';
                i++;
            } else if (ch === '\r') {
                // Ignore bare CR (Windows line endings handled by \r\n)
                i++;
            } else if (ch === '\n') {
                row.push(field);
                rows.push(row);
                field = '';
                row   = [];
                i++;
            } else {
                field += ch;
                i++;
            }
        }
    }

    // Handle file that doesn't end with a newline
    if (field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
    }

    return rows;
}

// ---------------------------------------------------------------------------
// Set a value in a nested object using a dot-notation key
// ---------------------------------------------------------------------------
function setNestedValue(obj, dottedKey, value) {
    const parts = dottedKey.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') {
            cur[parts[i]] = {};
        }
        cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
}

// ---------------------------------------------------------------------------
// Main generation function
// ---------------------------------------------------------------------------
function generateTranslations() {
    // -- Read CSV -----------------------------------------------------------
    let csvText;
    try {
        csvText = fs.readFileSync(CSV_PATH, 'utf8');
    } catch (e) {
        console.error('[translations] Could not read translations.csv:', e.message);
        return false;
    }

    const rows = parseCSV(csvText);

    if (rows.length < 2) {
        console.error('[translations] translations.csv has no data rows.');
        return false;
    }

    // -- Parse header -------------------------------------------------------
    const header   = rows[0];
    const keyIndex = header.indexOf('key');

    if (keyIndex === -1) {
        console.error('[translations] translations.csv is missing a "key" column.');
        return false;
    }

    const languages = []; // [{colIndex, langCode}]
    for (let c = 0; c < header.length; c++) {
        if (c === keyIndex) continue;
        const colName  = header[c].trim().toLowerCase();
        const langCode = LANG_MAP[colName];
        if (!langCode) {
            console.warn(`[translations] Unrecognized column "${header[c]}" in CSV – skipped. Add it to LANG_MAP if it is a new language.`);
            continue;
        }
        languages.push({ colIndex: c, langCode });
    }

    if (languages.length === 0) {
        console.error('[translations] No recognized language columns found in CSV.');
        return false;
    }

    // -- Build translation objects ------------------------------------------
    const translations = {};
    for (const { langCode } of languages) {
        translations[langCode] = {};
    }

    const englishLang = languages.find(l => l.langCode === 'en');
    let warnCount = 0;

    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row || row.length === 0) continue;

        const key = (row[keyIndex] || '').trim();
        if (!key) continue; // blank separator rows are fine

        // NOTE: values are intentionally NOT trimmed – trailing/leading spaces
        // in some translation strings are meaningful (e.g. "Testing at ").
        const englishVal = englishLang
            ? (row[englishLang.colIndex] || '')
            : '';

        for (const { colIndex, langCode } of languages) {
            const raw = colIndex < row.length ? row[colIndex] : '';
            const val = raw || '';

            if (!val) {
                if (langCode === 'en') {
                    console.warn(`[translations] Missing English value for key "${key}" – key omitted.`);
                    warnCount++;
                } else if (englishVal) {
                    console.warn(`[translations] Missing ${langCode} translation for "${key}" – using English fallback.`);
                    warnCount++;
                    setNestedValue(translations[langCode], key, englishVal);
                }
                // If both are empty, silently skip the key
                continue;
            }

            setNestedValue(translations[langCode], key, val);
        }
    }

    if (warnCount > 0) {
        console.warn(`[translations] Completed with ${warnCount} warning(s).`);
    }

    // -- Write output files -------------------------------------------------
    let allOk = true;
    for (const { langCode } of languages) {
        const langDir = path.join(LOCALES_DIR, langCode);
        try {
            if (!fs.existsSync(langDir)) {
                fs.mkdirSync(langDir, { recursive: true });
            }
            const outPath = path.join(langDir, 'translation.json');
            fs.writeFileSync(outPath, JSON.stringify(translations[langCode], null, 2), 'utf8');
            console.log(`[translations] Wrote ${path.relative(process.cwd(), outPath)}`);
        } catch (e) {
            console.error(`[translations] Could not write locales/${langCode}/translation.json:`, e.message);
            allOk = false;
        }
    }

    if (allOk) {
        console.log(`[translations] Done – languages: ${languages.map(l => l.langCode).join(', ')}`);
    }
    return allOk;
}

// Run when invoked directly (node build-scripts/generate-translations.js)
if (require.main === module) {
    const ok = generateTranslations();
    if (!ok) process.exit(1);
}

module.exports = generateTranslations;
