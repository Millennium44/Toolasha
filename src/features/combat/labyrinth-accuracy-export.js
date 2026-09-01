/**
 * Labyrinth accuracy export — the record as a file, and a sanitized twin
 *
 * The text report on the Accuracy tab is for a person to read, so it rounds.
 * A bug report needs the numbers as they are: the unrounded probabilities, the
 * raw attempts with their stored predictions and model markers, and enough
 * provenance — script version, host, sim model — to reproduce the arithmetic.
 * This builds that file.
 *
 * The sanitized mode exists because an accuracy file is the natural attachment
 * for a public bug report and character identity is not: names are replaced by
 * a stable hash (so two files from the same character still correlate) and
 * character ids are stripped outright.
 */

import { splitModelCohorts, calibrationReport } from './labyrinth-calibration.js';
import tickCapture from './labyrinth-tick-capture.js';
import { FINGERPRINT_SPEC, FINGERPRINT_VERSION } from './labyrinth-fingerprint.js';

/**
 * Where the sim's stop rule and hour budget are read from at export time.
 *
 * Registered by the sim-cache module rather than imported from it: importing
 * would drag the whole sim/marketplace graph under this small pure module, and
 * this direction keeps the export buildable (with `simConfig: null`) when no
 * sim module is loaded at all.
 */
let simConfigSource = null;

/**
 * Register the callback {@link buildAccuracyExport} reads its `simConfig` from.
 * @param {function(): {stopRule: Object, hours: number}} source
 */
export function setSimConfigSource(source) {
    simConfigSource = typeof source === 'function' ? source : null;
}

/** The registered sim config, or null when no source is registered / it fails. */
function readSimConfig() {
    if (!simConfigSource) return null;
    try {
        return simConfigSource();
    } catch (error) {
        console.error('[LabyrinthAccuracyExport] Reading the sim config failed:', error);
        return null;
    }
}

/** The script version, when the userscript sandbox is there to ask. */
function scriptVersion() {
    try {
        return typeof GM_info !== 'undefined' ? GM_info?.script?.version || null : null;
    } catch {
        return null;
    }
}

/**
 * What produced an export and against which server — live and test do not
 * share balance, so a reader has to know which one a record measured.
 * @returns {{toolashaVersion: string|null, host: string|null, isTestServer: boolean|null,
 *   fullKit: boolean, seedPolicy: string, fingerprintSpec: string,
 *   fingerprintVersion: number}}
 */
export function exportMeta() {
    const host = typeof location !== 'undefined' ? location.hostname || null : null;
    return {
        toolashaVersion: scriptVersion(),
        host,
        isTestServer: host ? host.includes('test.') : null,
        // The sim model this build runs; attempts carry their own marker
        fullKit: true,
        // Replay sims run with no fixed seed, so a re-run will not reproduce
        // the exact trial sequence — only the distribution
        seedPolicy: 'unseeded',
        // How the fingerprints in this file were computed, so a reader knows
        // what a matching pair of them does and does not guarantee, and which
        // definition produced them — attempts carry their own version, and one
        // without the field was fingerprinted under v1 (gear only); the spec
        // string names what the version in force actually hashes
        fingerprintSpec: FINGERPRINT_SPEC,
        fingerprintVersion: FINGERPRINT_VERSION,
    };
}

/**
 * A short stable stand-in for a character name: 'p' plus eight hex characters.
 *
 * FNV-1a over the code units — not secrecy-grade, just stable and collision-shy
 * enough that two exports from the same character correlate while the name
 * itself stays out of a public bug report.
 *
 * @param {string} name - The character name
 * @returns {string} e.g. `p8f2c19ab`
 */
export function hashPlayerName(name) {
    let hash = 0x811c9dc5;
    const text = String(name ?? '');
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `p${hash.toString(16).padStart(8, '0')}`;
}

/** Keys that identify a character outright; the sanitizer drops them */
const CHARACTER_ID_KEY = /^character[_-]?id$/i;
/** Keys that carry a character name; the sanitizer hashes their values */
const CHARACTER_NAME_KEY = /^character[_-]?name$/i;

/**
 * A deep copy of an export with character identity removed: id-shaped keys are
 * stripped and name-shaped string values replaced by {@link hashPlayerName}.
 * Everything else — including monster names, which identify a room and not a
 * person — passes through untouched. The input is never mutated.
 *
 * @param {*} value - Plain JSON data (objects, arrays, primitives)
 * @returns {*} The sanitized copy
 */
export function sanitizeExport(value) {
    if (Array.isArray(value)) return value.map(sanitizeExport);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            if (CHARACTER_ID_KEY.test(key)) continue;
            out[key] =
                CHARACTER_NAME_KEY.test(key) && typeof entry === 'string' && entry
                    ? hashPlayerName(entry)
                    : sanitizeExport(entry);
        }
        return out;
    }
    return value;
}

/**
 * The whole accuracy record as one JSON file.
 *
 * The rows, summary and by-subject groups go in as the raw numbers the panel
 * computes from — the per-result probabilities unrounded, where the text report
 * shows rounded strings. The recorded attempts ride along with their stored
 * predictions and model markers, plus the reliability report over the current
 * cohort, so one file carries the record, the raw material behind it, and the
 * calibration check.
 *
 * @param {Object} input
 * @param {Object} [input.snapshot] - `{rows, summary, bySubject, ...}` from the accuracy source
 * @param {Array<Object>} [input.attempts] - The recorder's pool, markers and all
 * @param {Object} [input.replay] - A calibration replay result, when one was run
 * @param {Object} [input.character] - `{characterId, characterName}`, stripped/hashed in sanitized mode
 * @returns {Object}
 */
export function buildAccuracyExport({ snapshot = null, attempts = [], replay = null, character = null } = {}) {
    const { current, legacy, legacyModel, legacyFingerprint } = splitModelCohorts(attempts);
    return {
        format: 'toolasha-labyrinth-accuracy',
        version: 1,
        exportedAt: Date.now(),
        ...exportMeta(),
        characterId: character?.characterId ?? null,
        characterName: character?.characterName ?? null,
        summary: snapshot?.summary ?? null,
        rows: snapshot?.rows ?? [],
        bySubject: snapshot?.bySubject ?? [],
        // Over the current cohort only; the legacy counts are reported, not
        // pooled, and split by reason — a previous sim model and a previous
        // fingerprint definition exclude an attempt for different causes
        reliability: {
            ...calibrationReport(current),
            legacyExcluded: legacy.length,
            legacyModelExcluded: legacyModel.length,
            legacyFingerprintExcluded: legacyFingerprint.length,
        },
        // The tick-capture file this export can be paired with, when one was
        // saved this session (guarded: test doubles may not carry the accessor)
        capture: typeof tickCapture?.lastCaptureRef === 'function' ? tickCapture.lastCaptureRef() : null,
        // The stop rule and hour budget the replay sims ran under
        simConfig: readSimConfig(),
        attempts,
        replay,
    };
}

/**
 * Write an object out as a JSON download.
 * @param {Object} data - What to write
 * @param {string} baseName - Filename stem; a timestamp is appended
 * @returns {boolean} Whether the download was started
 */
export function downloadJson(data, baseName) {
    try {
        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${baseName}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
        return true;
    } catch (error) {
        console.error('[LabyrinthAccuracyExport] Writing the export failed:', error);
        return false;
    }
}

export default { exportMeta, hashPlayerName, sanitizeExport, buildAccuracyExport, downloadJson, setSimConfigSource };
