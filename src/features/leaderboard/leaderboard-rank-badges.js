/**
 * Leaderboard rank badges
 *
 * A small pill beside a player's name (chat, guild, friends, profiles) showing
 * the skill they rank best in and that rank, when they sit in the top 100 of a
 * player leaderboard.
 *
 * The design — tier bands, the pill, the standard/ironcow board pair and the
 * optional data server — is adapted from the leaderboard overlay in MWITools
 * (CC-BY-NC-SA-4.0, https://greasyfork.org/en/scripts/494467).
 * No code was copied; see docs/THIRD-PARTY-LICENSES.md.
 *
 * One select setting, `leaderboardRankBadges`, default Off:
 * - off: nothing is registered — no listener, no fetch, no badge.
 * - local: rows from boards the player opens (`leaderboard_updated`), cached.
 * - server: also GETs the MWITools data server on enable and every 15 minutes.
 *   The request carries nothing but the board type in the query string, and
 *   the response is parsed as untrusted (see utils/rank-badge-data.js). A newer
 *   snapshot of a board wins, the game's own rows on a tie.
 *
 * The badge shows one entry per player: their best rank across every board.
 * The tooltip lists up to five, each with the age of its snapshot.
 */

import webSocketHook from '../../core/websocket.js';
import config from '../../core/config.js';
import storage from '../../core/storage.js';
import domObserver from '../../core/dom-observer.js';
import { httpRequest } from '../sync/gist-client.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import assetManifest from '../../utils/asset-manifest.js';
import { formatRelativeTime } from '../../utils/formatters.js';
import {
    RANK_BOARD_TYPES,
    bestEntry,
    buildNameIndex,
    categoryLabel,
    mergeBoards,
    normalizeName,
    parseLocalBoard,
    parseServerText,
    sanitizeBoards,
    tierForRank,
} from '../../utils/rank-badge-data.js';

const SETTING_KEY = 'leaderboardRankBadges';
const STORE_NAME = 'leaderboardHistory';
const STORAGE_KEY = 'rankBoards';

/** The third-party data server. GET only; the sole parameter is the board type. */
export const RANK_SERVER_URL = 'https://mwi-guild.43.167.210.211.sslip.io/api/v1/leaderboards';
export const RANK_SERVER_INTERVAL_MS = 15 * 60 * 1000;

const STYLE_ID = 'toolasha-rank-badge-style';
const BADGE_ATTR = 'data-toolasha-rank-badge';
const SVG_NS = 'http://www.w3.org/2000/svg';
const TOOLTIP_ENTRIES = 5;

/** Categories whose icon is in the misc sprite rather than the skills sprite */
const MISC_SYMBOLS = Object.freeze({
    total_level: 'leaderboard',
    task_points: 'tasks',
    labyrinth_depth: 'labyrinth',
    fame_points: 'experience',
});

const STYLE_TEXT = `
[${BADGE_ATTR}]{box-sizing:border-box;display:inline-flex;align-items:center;gap:1px;height:15px;margin-inline-start:4px;padding:0 3px 0 1px;border:1px solid;border-radius:999px;background:rgba(12,16,28,.78);color:#eef2ff;font:600 9px/1 system-ui,sans-serif;white-space:nowrap;vertical-align:middle;position:relative;overflow:hidden}
[${BADGE_ATTR}] svg{display:block;flex:none;width:11px;height:11px}
[${BADGE_ATTR}="rainbow"]{border-color:transparent;background:linear-gradient(rgba(12,16,28,.9),rgba(12,16,28,.9)) padding-box,linear-gradient(105deg,#ff5f6d,#ffd166,#67e8a5,#5cb8ff,#c77dff,#ff6ec7) border-box}
[${BADGE_ATTR}="gold"]{border-color:#d9aa38;color:#ffe8a3}
[${BADGE_ATTR}="silver"]{border-color:#d8dee9;color:#f8fafc}
[${BADGE_ATTR}="bronze"]{border-color:#b87333;color:#f2c49b}
[${BADGE_ATTR}][data-top-five]::after{content:"";position:absolute;top:0;bottom:0;left:-60%;width:40%;pointer-events:none;background:linear-gradient(105deg,transparent,rgba(255,255,255,.7),transparent);animation:toolasha-rank-glint 5s ease-in-out infinite}
@keyframes toolasha-rank-glint{0%{transform:translateX(0)}20%,100%{transform:translateX(450%)}}
@media (prefers-reduced-motion:reduce){[${BADGE_ATTR}][data-top-five]::after{animation:none;display:none}}
`;

registerSyncMerge({ store: STORE_NAME, key: STORAGE_KEY, merge: mergeBoards, label: 'Leaderboard rank badges' });

/**
 * Tooltip text for a player's entries.
 * @param {Array<Object>} entries - From the name index, best first
 * @param {number} now - Current time
 * @returns {string} One line per entry
 */
export function describeEntries(entries, now) {
    return entries
        .slice(0, TOOLTIP_ENTRIES)
        .map((entry) => {
            const board = entry.type === 'ironcow' ? 'Ironcow' : 'Standard';
            const age = formatRelativeTime(Math.max(0, now - entry.at));
            const when = age === 'Just now' ? 'as of just now' : `as of ${age} ago`;
            return `${categoryLabel(entry.category)} · ${board} rank ${entry.rank} (${when})`;
        })
        .join('\n');
}

/**
 * Every name element, with or without `data-name`: the profile modal and restored chat
 * history draw the name as plain text inside it. The badge is a sibling, never a child,
 * so a re-scan cannot read it back as part of the name.
 */
const NAME_SELECTOR = '[class*="CharacterName_name"]';

/**
 * The name an element shows: `data-name` when the game sets it, else its visible text.
 * @param {Element} el - A `CharacterName_name` element
 * @returns {string} The trimmed name, empty when there is none
 */
function nameFrom(el) {
    return (el.getAttribute('data-name') || el.textContent || '').trim().replace(/:$/, '').trim();
}

class LeaderboardRankBadges {
    constructor() {
        this.runId = 0;
        this.mode = 'off';
        this.boards = {};
        this.index = new Map();
        this.spriteUrls = { skills: null, misc: null };
        this.timers = createTimerRegistry();
        this.teardown = [];
        this.unwatchSetting = null;
        this.fetching = false;
    }

    /**
     * Start (or re-read the setting of) the feature. The setting watch is
     * registered before the gate so switching the select takes effect live.
     * @returns {Promise<void>}
     */
    async initialize() {
        this.unwatchSetting?.();
        this.unwatchSetting = config.onSettingChange(SETTING_KEY, () => {
            this.restart().catch((error) => console.error('[LeaderboardRankBadges] Restart failed:', error));
        });
        await this.restart();
    }

    /** @returns {'off'|'local'|'server'} */
    readMode() {
        const value = config.getSettingValue(SETTING_KEY, 'off');
        return value === 'local' || value === 'server' ? value : 'off';
    }

    async restart() {
        this.stop();
        this.mode = this.readMode();
        if (this.mode === 'off') return;
        const runId = ++this.runId;

        this.installStyle();
        this.boards = sanitizeBoards(await storage.get(STORAGE_KEY, STORE_NAME, {}));
        if (runId !== this.runId) return;
        this.rebuildIndex();

        const onBoard = (data) => this.onLocalBoard(data);
        webSocketHook.on('leaderboard_updated', onBoard);
        this.teardown.push(() => webSocketHook.off('leaderboard_updated', onBoard));
        this.teardown.push(
            domObserver.onClass('LeaderboardRankBadges', 'CharacterName_name', (el) => this.decorate(el))
        );
        this.decorateAll(false);

        this.loadSprites(runId).catch((error) => console.warn('[LeaderboardRankBadges] Sprites unavailable:', error));

        if (this.mode === 'server') {
            this.refreshFromServer(runId);
            this.timers.registerInterval(
                setInterval(() => this.refreshFromServer(runId), RANK_SERVER_INTERVAL_MS),
                'LeaderboardRankBadges-server'
            );
        }
    }

    /**
     * Resolve the sprite sheets once; badges drawn before they arrive are redrawn.
     * @param {number} runId - The run that asked
     * @returns {Promise<void>}
     */
    async loadSprites(runId) {
        const [skills, misc] = await Promise.all([
            assetManifest.getSpriteUrl('skills'),
            assetManifest.getSpriteUrl('misc'),
        ]);
        if (runId !== this.runId) return;
        this.spriteUrls = { skills, misc };
        this.decorateAll(true);
    }

    /**
     * A board the player opened.
     * @param {Object} data - `leaderboard_updated` message
     */
    onLocalBoard(data) {
        const parsed = parseLocalBoard(data, Date.now());
        if (!parsed) return;
        this.adopt({ [parsed.key]: parsed.board });
    }

    /**
     * One GET per board type. Failures keep whatever is cached; nothing else is sent.
     * @param {number} runId - The run that asked
     * @returns {Promise<void>}
     */
    async refreshFromServer(runId) {
        if (this.fetching || runId !== this.runId) return;
        this.fetching = true;
        try {
            for (const type of RANK_BOARD_TYPES) {
                let text = '';
                try {
                    const response = await httpRequest({
                        method: 'GET',
                        url: `${RANK_SERVER_URL}?leaderboardType=${encodeURIComponent(type)}`,
                    });
                    if (response.status < 200 || response.status >= 300) continue;
                    text = response.text;
                } catch {
                    continue;
                }
                if (runId !== this.runId) return;
                this.adopt(parseServerText(text, type, Date.now()));
            }
        } finally {
            this.fetching = false;
        }
    }

    /**
     * Fold boards into the cache, persist, and redraw when anything changed.
     * @param {Object} incoming - Boards keyed "type|category"
     */
    adopt(incoming) {
        if (!Object.keys(incoming).length) return;
        const merged = mergeBoards(this.boards, incoming);
        if (JSON.stringify(merged) === JSON.stringify(this.boards)) return;
        this.boards = merged;
        this.rebuildIndex();
        storage.set(STORAGE_KEY, this.boards, STORE_NAME).catch((error) => {
            console.error('[LeaderboardRankBadges] Saving the rank cache failed:', error);
        });
        this.decorateAll(true);
    }

    rebuildIndex() {
        this.index = buildNameIndex(this.boards);
    }

    installStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = STYLE_TEXT;
        (document.head || document.documentElement).appendChild(style);
    }

    decorateAll(force) {
        for (const el of document.querySelectorAll(NAME_SELECTOR)) this.decorate(el, force);
    }

    /**
     * Put (or refresh, or take down) the badge after one name element.
     * @param {Element} nameEl - A `CharacterName_name` element
     * @param {boolean} [force] - Rebuild even if the badge already matches
     */
    decorate(nameEl, force = false) {
        if (this.mode === 'off' || !nameEl?.isConnected || !nameEl.matches?.(NAME_SELECTOR)) return;
        const existing = nameEl.nextElementSibling?.hasAttribute?.(BADGE_ATTR) ? nameEl.nextElementSibling : null;
        // The leaderboard's own rank column says this already, and the player's
        // own header name is not a place to advertise
        if (nameEl.closest('[class*="LeaderboardPanel_"], [class*="Header_characterInfo"]')) {
            existing?.remove();
            return;
        }
        const name = nameFrom(nameEl);
        if (!name) {
            existing?.remove();
            return;
        }
        const entries = this.index.get(normalizeName(name));
        const best = bestEntry(entries);
        if (!best) {
            existing?.remove();
            return;
        }
        const signature = `${name}|${entries[0].type}|${best.category}|${best.rank}|${best.at}`;
        if (existing && !force && existing.dataset.signature === signature) return;

        const badge = existing || document.createElement('span');
        badge.setAttribute(BADGE_ATTR, tierForRank(best.rank));
        badge.dataset.signature = signature;
        if (best.rank <= 5) badge.setAttribute('data-top-five', '');
        else badge.removeAttribute('data-top-five');
        badge.title = describeEntries(entries, Date.now());
        // textContent and SVG nodes only: nothing from a payload is ever markup
        badge.replaceChildren();
        const icon = this.buildIcon(best.category);
        if (icon) badge.appendChild(icon);
        badge.appendChild(document.createTextNode(String(best.rank)));
        if (!existing) nameEl.insertAdjacentElement('afterend', badge);
    }

    /**
     * The category's icon from the game's own sprite sheet.
     * @param {string} category - A category slug
     * @returns {SVGElement|null} Null until the sprite URL has resolved
     */
    buildIcon(category) {
        const misc = MISC_SYMBOLS[category];
        const sheet = misc ? this.spriteUrls.misc : this.spriteUrls.skills;
        if (!sheet) return null;
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 40 40');
        svg.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS(SVG_NS, 'use');
        use.setAttribute('href', `${sheet}#${misc || category}`);
        svg.appendChild(use);
        return svg;
    }

    /** Stop everything and take the badges down. Safe to call repeatedly. */
    stop() {
        this.runId += 1;
        this.timers.clearAll();
        for (const undo of this.teardown) undo();
        this.teardown = [];
        this.fetching = false;
        document.querySelectorAll(`[${BADGE_ATTR}]`).forEach((el) => el.remove());
        document.getElementById(STYLE_ID)?.remove();
        this.index = new Map();
        this.boards = {};
    }

    cleanup() {
        this.unwatchSetting?.();
        this.unwatchSetting = null;
        this.stop();
        this.mode = 'off';
    }
}

const leaderboardRankBadges = new LeaderboardRankBadges();

export default {
    name: 'Leaderboard Rank Badges',
    initialize: () => leaderboardRankBadges.initialize(),
    cleanup: () => {
        try {
            leaderboardRankBadges.cleanup();
        } catch (error) {
            console.error('[LeaderboardRankBadges] Cleanup failed part-way:', error);
        }
    },
};

export { leaderboardRankBadges };
