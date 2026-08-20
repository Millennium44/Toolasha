/**
 * Update Check
 *
 * Tells the player when a newer Toolasha release exists. Off by default: the
 * userscript manager already updates on its own schedule, so this is for
 * whoever wants to hear about a release the moment they next refresh instead.
 *
 * The check itself is rate-limited by a second setting (hours between checks),
 * with the last answer cached — so a refresh inside the window costs no
 * request, only a cache read, and still surfaces a known-newer version. The
 * release feed is the fork's own GitHub releases endpoint, reached through the
 * same transport the sync feature already uses (GM_xmlhttpRequest, with a
 * fetch fallback outside the sandbox).
 *
 * Never notifies a dev build: the dev loader pins its version far above any
 * release, so the comparison keeps it silent by construction.
 */

import config from '../../core/config.js';
import storage from '../../core/storage.js';
import { httpRequest } from '../sync/gist-client.js';
import { scriptVersion } from '../../utils/script-version.js';
import { showToast } from '../../utils/toast.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';

const RELEASES_URL = 'https://api.github.com/repos/Millennium44/Toolasha/releases/latest';
const GREASYFORK_URL = 'https://greasyfork.org/en/scripts/589090-toolasha-millennium44';
const STORAGE_KEY = 'updateCheckState';
const STORE_NAME = 'settings';

/** Let the game (and the toast container's page) finish drawing first */
const STARTUP_DELAY_MS = 8 * 1000;

/**
 * Compare two dotted version strings numerically.
 * @param {string} a - One version, e.g. `3.17.0`
 * @param {string} b - Another
 * @returns {number} Negative when a < b, positive when a > b, 0 when equal
 */
export function compareVersions(a, b) {
    const left = String(a).split('.').map(Number);
    const right = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const diff = (left[i] || 0) - (right[i] || 0);
        if (diff) return diff;
    }
    return 0;
}

/**
 * The latest release version according to GitHub, or null.
 * @returns {Promise<string|null>} A version like `3.17.0`, without the tag's `v`
 */
async function fetchLatestVersion() {
    const response = await httpRequest({
        method: 'GET',
        url: RELEASES_URL,
        headers: { Accept: 'application/vnd.github+json' },
    });
    if (response.status !== 200) return null;
    const tag = JSON.parse(response.text)?.tag_name || '';
    const version = tag.replace(/^v/, '');
    return /^\d+(\.\d+)*$/.test(version) ? version : null;
}

class UpdateCheck {
    constructor() {
        this.isInitialized = false;
        this.timerRegistry = createTimerRegistry();
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('updateCheck', false)) return;
        this.isInitialized = true;

        const timeout = setTimeout(() => {
            this._check().catch((error) => {
                console.error('[UpdateCheck] Check failed:', error);
            });
        }, STARTUP_DELAY_MS);
        this.timerRegistry.registerTimeout(timeout);
    }

    /**
     * One check: read the cache, refresh it over the network when it has gone
     * stale, and say something only when what is known is newer than what is
     * running.
     * @private
     */
    async _check() {
        const current = scriptVersion();
        if (!current) return; // Outside the userscript sandbox there is nothing to compare

        const hours = Math.max(1, Number(config.getSettingValue('updateCheckHours', 6)) || 6);
        const state = (await storage.getJSON(STORAGE_KEY, STORE_NAME, null)) || {};

        let latest = state.latestVersion || null;
        const stale = !state.checkedAt || Date.now() - state.checkedAt > hours * 60 * 60 * 1000;
        if (stale) {
            const fetched = await fetchLatestVersion();
            if (fetched) {
                latest = fetched;
                await storage.setJSON(STORAGE_KEY, { checkedAt: Date.now(), latestVersion: fetched }, STORE_NAME);
            }
        }

        if (latest && compareVersions(latest, current) > 0) {
            this._notify(latest, current);
        }
    }

    /**
     * The one thing this feature says.
     * @param {string} latest - The release version available
     * @param {string} current - The version running
     * @private
     */
    _notify(latest, current) {
        showToast(`Toolasha v${latest} is out (you have v${current}). Click to open GreasyFork.`, {
            kind: 'info',
            duration: 15 * 1000,
            action: {
                label: 'Open GreasyFork',
                onClick: () => window.open(GREASYFORK_URL, '_blank', 'noopener'),
            },
        });
    }

    cleanup() {
        this.timerRegistry.clearAll();
        this.isInitialized = false;
    }
}

const updateCheck = new UpdateCheck();

export default {
    name: 'Update Check',
    initialize: async () => updateCheck.initialize(),
    cleanup: () => {
        try {
            updateCheck.cleanup();
        } catch (error) {
            console.warn('[UpdateCheck] Disable failed part-way:', error);
        }
    },
};

export { updateCheck };
