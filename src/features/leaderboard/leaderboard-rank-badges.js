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
 * In local mode the game's leaderboard panel also gets a "Next board" button: each real click
 * makes exactly one click on the game's own tab for the next uncached category (on the standard/
 * ironcow board already showing), so the cache can be filled by pressing it repeatedly. Nothing
 * advances on its own. On a Steam tab the button cycles that Steam board's categories instead,
 * judged by what the leaderboard XP tracker has recorded across sessions (this session's opens when it has nothing).
 *
 * A second setting, `leaderboardRankBadgesSteam` (default off, Local only), files Steam boards
 * under their own slots (`steam_standard`, `steam_ironcow`) and lets badges use them, labelled Steam.
 *
 * Two more settings (both default off, live, no restart) refine Steam badges: `leaderboardRankBadgesSteamMark`
 * puts an S on a pill whose rank is a Steam one, and `leaderboardRankBadgesPreferStandard` shows the best
 * non-Steam rank instead of a better Steam one. Both are inert while Steam boards are not included.
 *
 * The badge shows one entry per player: their best rank across every board.
 * The tooltip lists up to five, each with the age of its snapshot.
 */

import webSocketHook from '../../core/websocket.js';
import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { httpRequest } from '../sync/gist-client.js';
import { createPersistedRecord } from '../../utils/persisted-record.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import assetManifest from '../../utils/asset-manifest.js';
import { formatRelativeTime } from '../../utils/formatters.js';
import { leaderboardXPTracker } from './leaderboard-xp-tracker.js';
import {
    RANK_BADGE_ATTR,
    RANK_BOARD_TYPES,
    RANK_CATEGORIES,
    bestEntry,
    boardKey,
    boardTypeLabel,
    boardViewOf,
    buildNameIndex,
    categoryLabel,
    isNarrowedBoard,
    isSteamBoardType,
    mergeBoards,
    nextBoardCategory,
    normalizeName,
    parseLocalBoard,
    parseServerText,
    tierForRank,
} from '../../utils/rank-badge-data.js';

const SETTING_KEY = 'leaderboardRankBadges';
const XP_TRACKER_KEY = 'leaderboardXPTracker';
const STEAM_SETTING_KEY = 'leaderboardRankBadgesSteam';
const STEAM_MARK_KEY = 'leaderboardRankBadgesSteamMark';
const PREFER_STANDARD_KEY = 'leaderboardRankBadgesPreferStandard';
const STORE_NAME = 'leaderboardHistory';
const STORAGE_KEY = 'rankBoards';

/** The third-party data server. GET only; the sole parameter is the board type. */
export const RANK_SERVER_URL = 'https://mwi-guild.43.167.210.211.sslip.io/api/v1/leaderboards';
export const RANK_SERVER_INTERVAL_MS = 15 * 60 * 1000;

const STYLE_ID = 'toolasha-rank-badge-style';
const BADGE_ATTR = RANK_BADGE_ATTR;
// The "S" inside a pill whose rank is a Steam one: a letter and a divider, so it reads without relying on color
const STEAM_MARK_ATTR = 'data-steam-mark';
const SVG_NS = 'http://www.w3.org/2000/svg';
const TOOLTIP_ENTRIES = 5;
const BAR_ATTR = 'data-toolasha-rank-cycle';
const PANEL_CLASS = 'LeaderboardPanel_content';
// Every category mounts its own TabPanel (and content) inside this one container, which persists across tabs
const PANELS_CLASS = 'TabsComponent_tabPanelsContainer';

/** Tab labels that differ from the category's display label; matched case-insensitively and exactly */
const TAB_ALIASES = Object.freeze({
    fame_points: ['fame points'],
    labyrinth_depth: ['labyrinth depth', 'labyrinth'],
    collection_points: ['collection', 'collections'],
    bestiary_points: ['bestiary'],
    task_points: ['tasks'],
    defense: ['defence'],
});
/** Top-level type tab labels (the game's leaderboardTypeNames) -> board slot; `guilds` is not a player board */
const TYPE_TAB_LABELS = Object.freeze({
    standard: 'standard',
    ironcow: 'ironcow',
    'standard (steam)': 'steam_standard',
    'ironcow (steam)': 'steam_ironcow',
    guilds: 'guilds',
});
const SELECTED_TAB_SELECTOR = '[role="tab"][aria-selected="true"]';
const TAB_SELECTOR = '[role="tab"], [class*="MuiTab-root"], [role="option"], [role="menuitem"]';

/** Categories whose icon is in the misc sprite rather than the skills sprite */
const MISC_SYMBOLS = Object.freeze({
    total_level: 'leaderboard',
    task_points: 'tasks',
    // Blue maze for points and the orange flag for depth, so the two labyrinth boards' badges differ. Both
    // carry color: the all-white glyphs (item_category_labyrinth, labyrinth_end, inventory_all) drew blank for a
    // player whose browser hides pure-white SVG paint
    labyrinth_points: 'labyrinth',
    labyrinth_depth: 'flag',
    // The misc sprite has no collection or bestiary glyph (checked against the live sheet); closest stand-ins.
    // Collection's badge icon comes from the chat icons instead (CHAT_SYMBOLS); this entry is the tab match only
    collection_points: 'inventory_all',
    bestiary_points: 'combat',
    fame_points: 'experience',
});

/**
 * Badge icons taken from the game's chat icon sprite, which wins over MISC_SYMBOLS for the badge. The misc
 * sheet's four-square inventory glyph read as no icon at all at badge size; the blue book is the game's own
 * and reads as a collection log. Fame takes the holy supporter mark.
 */
const CHAT_SYMBOLS = Object.freeze({
    collection_points: 'book',
    fame_points: 'holy_supporter',
});

const STYLE_TEXT = `
[${BADGE_ATTR}]{box-sizing:border-box;display:inline-flex;align-items:center;gap:1px;height:15px;margin-inline-start:4px;padding:0 3px 0 1px;border:1px solid;border-radius:999px;background:rgba(12,16,28,.78);color:#eef2ff;font:600 9px/1 system-ui,sans-serif;white-space:nowrap;vertical-align:middle;position:relative;overflow:hidden}
[${BADGE_ATTR}] [${STEAM_MARK_ATTR}]{flex:none;margin-inline:1px;padding-inline-end:2px;border-inline-end:1px solid currentColor;font-size:8px;font-weight:700;opacity:.85}
[${BADGE_ATTR}] svg{display:block;flex:none;width:11px;height:11px}
[${BADGE_ATTR}="rainbow"]{border-color:transparent;background:linear-gradient(rgba(12,16,28,.9),rgba(12,16,28,.9)) padding-box,linear-gradient(105deg,#ff5f6d,#ffd166,#67e8a5,#5cb8ff,#c77dff,#ff6ec7) border-box}
[${BADGE_ATTR}="gold"]{border-color:#d9aa38;color:#ffe8a3}
[${BADGE_ATTR}="silver"]{border-color:#d8dee9;color:#f8fafc}
[${BADGE_ATTR}="bronze"]{border-color:#b87333;color:#f2c49b}
[${BADGE_ATTR}][data-top-five]::after{content:"";position:absolute;top:0;bottom:0;left:-60%;width:40%;pointer-events:none;background:linear-gradient(105deg,transparent,rgba(255,255,255,.7),transparent);animation:toolasha-rank-glint 5s ease-in-out infinite}
@keyframes toolasha-rank-glint{0%{transform:translateX(0)}20%,100%{transform:translateX(450%)}}
@media (prefers-reduced-motion:reduce){[${BADGE_ATTR}][data-top-five]::after{animation:none;display:none}}
`;

/**
 * @param {*} stored - A cache as read from storage
 * @returns {boolean} Whether any board is stamped later than now
 */
function hasFutureBoard(stored) {
    if (!stored || typeof stored !== 'object') return false;
    const now = Date.now();
    return Object.values(stored).some((board) => Number.isFinite(board?.at) && board.at > now);
}

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
            const board = boardTypeLabel(entry.type);
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

/**
 * The sprite symbols a control's icons point at, e.g. `milking` from `.../skills_sprite.svg#milking`.
 * @param {Element} el - A tab or menu entry
 * @returns {string[]} Every symbol id its icons reference
 */
function iconSymbols(el) {
    return [...el.querySelectorAll('use')]
        .map((use) => (use.getAttribute('href') || use.getAttribute('xlink:href') || '').split('#')[1])
        .filter(Boolean);
}

/**
 * The game's own control for a category. The icon's sprite symbol is matched first because it does not
 * depend on the UI language; the English label is the fallback for a control without an icon. The live
 * category tabs carry no icons, so a non-English UI relies on the icon path only if the game adds icons.
 * Looked up from the anchor outward, because the tab strip is a sibling of the table, not a child.
 * @param {Element} anchor - The `LeaderboardPanel_content` element, or anything beside it in the panel
 * @param {string} category - A category slug
 * @returns {Element|null} Null when the panel shows no such control
 */
export function findCategoryTab(anchor, category) {
    const symbol = MISC_SYMBOLS[category] || category;
    const wanted = new Set([categoryLabel(category), ...(TAB_ALIASES[category] || [])].map((t) => t.toLowerCase()));
    let scope = anchor;
    for (let depth = 0; depth < 6 && scope; depth++, scope = scope.parentElement) {
        const tabs = [...scope.querySelectorAll(TAB_SELECTOR)].filter((el) => !el.closest(`[${BAR_ATTR}]`));
        if (!tabs.length) continue;
        return (
            tabs.find((el) => iconSymbols(el).includes(symbol)) ||
            tabs.find((el) => wanted.has((el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase())) ||
            null
        );
    }
    return null;
}

/**
 * The open leaderboard view read off the selected tabs, for when no `leaderboard_updated` has been seen (Local only
 * switched on while a board was already showing; the game does not resend it). English labels only: a
 * non-English UI infers nothing and the view stays as it was until a board message arrives.
 * @param {Element} anchor - The `LeaderboardPanel_content` element, or anything beside it in the panel
 * @returns {{type: string, category: string|null}|null} `type` is a board slot or `guilds`; null when unreadable
 */
export function inferOpenView(anchor) {
    const norm = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    let scope = anchor;
    for (let depth = 0; depth < 6 && scope; depth++, scope = scope.parentElement) {
        const selected = [...scope.querySelectorAll(SELECTED_TAB_SELECTOR)].filter(
            (el) => !el.closest(`[${BAR_ATTR}]`)
        );
        const typeTab = selected.find((el) => TYPE_TAB_LABELS[norm(el)]);
        if (!typeTab) continue;
        const type = TYPE_TAB_LABELS[norm(typeTab)];
        let category = null;
        if (type !== 'guilds') {
            for (const el of selected) {
                const text = norm(el);
                category =
                    RANK_CATEGORIES.find(
                        (c) => categoryLabel(c).toLowerCase() === text || (TAB_ALIASES[c] || []).includes(text)
                    ) || category;
            }
        }
        return { type, category };
    }
    return null;
}

/**
 * Whether two caches hold the same snapshots. A board's rows only change with its capture time.
 * @param {Object} a - A cache
 * @param {Object} b - A cache
 * @returns {boolean}
 */
function sameBoards(a, b) {
    const keys = Object.keys(a);
    return (
        keys.length === Object.keys(b).length &&
        keys.every((key) => b[key]?.at === a[key].at && b[key].source === a[key].source)
    );
}

class LeaderboardRankBadges {
    constructor() {
        this.boardType = 'standard';
        this.boardCategory = null;
        // False once the open board is one the skill categories do not cover (the Guilds tab's boards)
        this.playerBoardOpen = true;
        // Categories opened per Steam view this session, keyed like boards ("steam_standard|milking" -> {at})
        this.opened = {};
        // Whether any leaderboard_updated arrived: a message always outranks inferring the view from the tabs
        this.messageSeen = false;
        this.includeSteam = false;
        this.markSteam = false;
        this.preferStandard = false;
        this.runId = 0;
        this.mode = 'off';
        this.boards = {};
        // One record for the account. Saves fold what is stored (another tab, a sync pull) under memory, and an
        // unreadable store is never taken for an empty cache and written over
        this.record = createPersistedRecord({
            base: STORAGE_KEY,
            store: STORE_NAME,
            scoped: false,
            empty: () => ({}),
            merge: (stored, memory) => {
                if (hasFutureBoard(stored)) this.storedFuture = true;
                return mergeBoards(stored, memory);
            },
            label: 'LeaderboardRankBadges',
        });
        // Set when a fold read a board stamped in the future; see restart()
        this.storedFuture = false;
        this.index = new Map();
        this.spriteUrls = { skills: null, misc: null, chatIcons: null };
        this.timers = createTimerRegistry();
        this.teardown = [];
        this.unwatchSetting = null;
        this.fetching = false;
        this.nameWatcher = null;
    }

    /**
     * Watch one decorated name element. React reuses these elements across players (a profile switching
     * characters rewrites the text or `data-name` in place), and the class observer only sees insertions.
     * One shared observer, scoped to the name elements themselves.
     * @param {Element} nameEl - A `CharacterName_name` element
     */
    watchName(nameEl) {
        if (typeof MutationObserver === 'undefined') return;
        if (!this.nameWatcher) {
            this.nameWatcher = new MutationObserver((records) => {
                const seen = new Set();
                for (const record of records) {
                    const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
                    const el = target?.closest?.(NAME_SELECTOR);
                    if (el && !seen.has(el)) {
                        seen.add(el);
                        this.decorate(el);
                    }
                }
            });
        }
        // Re-observing an element already watched just replaces its options
        this.nameWatcher.observe(nameEl, {
            characterData: true,
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-name'],
        });
    }

    /**
     * Start (or re-read the setting of) the feature. The setting watch is
     * registered before the gate so switching the select takes effect live.
     * @returns {Promise<void>}
     */
    async initialize() {
        this.unwatchSetting?.();
        const onChange = () => {
            this.restart().catch((error) => console.error('[LeaderboardRankBadges] Restart failed:', error));
        };
        const unwatch = [
            config.onSettingChange(SETTING_KEY, onChange),
            config.onSettingChange(STEAM_SETTING_KEY, onChange),
            // Presentation only: no restart, so no badge blinks out and no board load races a save
            config.onSettingChange(STEAM_MARK_KEY, () => this.applyPresentation()),
            config.onSettingChange(PREFER_STANDARD_KEY, () => this.applyPresentation()),
            // Only the Steam status wording depends on it
            config.onSettingChange(XP_TRACKER_KEY, () => this.refreshCycleBars()),
        ];
        this.unwatchSetting = () => unwatch.forEach((undo) => undo?.());
        await this.restart();
    }

    /** @returns {'off'|'local'|'server'} */
    readMode() {
        const value = config.getSettingValue(SETTING_KEY, 'off');
        return value === 'local' || value === 'server' ? value : 'off';
    }

    /** Reads the two Steam presentation options; both are inert unless Steam boards are included. */
    readPresentation() {
        this.markSteam = this.includeSteam && config.getSettingValue(STEAM_MARK_KEY, false) === true;
        this.preferStandard = this.includeSteam && config.getSettingValue(PREFER_STANDARD_KEY, false) === true;
    }

    /** Applies a changed presentation option to the badges already drawn. */
    applyPresentation() {
        if (this.mode === 'off') return;
        this.readPresentation();
        this.decorateAll(true);
    }

    /**
     * The entry the pill shows and the tooltip order: the shown entry leads, so the tooltip's first line is
     * always the pill's own rank. Without prefer-standard this is the list unchanged.
     * @param {Array<Object>} entries - From the name index, best first
     * @returns {{best: Object|null, ordered: Array<Object>}}
     */
    pickEntry(entries) {
        const best = bestEntry(entries, { preferStandard: this.preferStandard });
        if (!best) return { best: null, ordered: [] };
        return { best, ordered: [best, ...entries.filter((entry) => entry !== best)] };
    }

    async restart() {
        this.stop();
        this.mode = this.readMode();
        this.includeSteam = this.mode === 'local' && config.getSettingValue(STEAM_SETTING_KEY, false) === true;
        this.readPresentation();
        if (this.mode === 'off') return;
        const runId = ++this.runId;

        this.installStyle();
        // Not reset: the record is the account's, and a settings restart can land while a save is awaiting its
        // storage read. A reset would make that save stand down and drop the board it was writing.
        const readable = await this.record.load();
        if (runId !== this.runId) return;
        // The load capped a future-dated board in memory only. Left stored, every later save re-reads the raw stamp,
        // caps it to a later "now" and lets it overwrite a board captured in between.
        if (readable && this.storedFuture) {
            this.storedFuture = false;
            await this.record.save({ overwrite: true });
            if (runId !== this.runId) return;
        }
        this.boards = this.record.get();
        this.rebuildIndex();

        const onBoard = (data) => this.onLocalBoard(data);
        webSocketHook.on('leaderboard_updated', onBoard);
        this.teardown.push(() => webSocketHook.off('leaderboard_updated', onBoard));
        this.teardown.push(
            domObserver.onClass('LeaderboardRankBadges', 'CharacterName_name', (el) => this.decorate(el))
        );
        if (this.mode === 'local') {
            this.teardown.push(
                domObserver.onClass('LeaderboardRankBadges-cycle', PANEL_CLASS, (el) => this.insertCycleBar(el))
            );
            for (const el of document.querySelectorAll(`[class*="${PANEL_CLASS}"]`)) this.insertCycleBar(el);
        }
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
        const [skills, misc, chatIcons] = await Promise.all([
            assetManifest.getSpriteUrl('skills'),
            assetManifest.getSpriteUrl('misc'),
            assetManifest.getSpriteUrl('chatIcons'),
        ]);
        if (runId !== this.runId) return;
        this.spriteUrls = { skills, misc, chatIcons };
        this.decorateAll(true);
    }

    /**
     * A board the player opened.
     * @param {Object} data - `leaderboard_updated` message
     */
    onLocalBoard(data) {
        this.messageSeen = true;
        // Judged before parsing: a guild board never parses, yet it is what decides whether the bar applies
        if (typeof data?.leaderboardCategory === 'string') {
            // The view covers Standard/Ironcow and their Steam types; a filtered view has no tab to cycle
            const view = boardViewOf(data);
            this.playerBoardOpen = RANK_CATEGORIES.includes(data.leaderboardCategory) && !isNarrowedBoard(data);
            if (view) {
                this.boardType = view;
                this.boardCategory = data.leaderboardCategory;
                if (isSteamBoardType(view)) {
                    this.opened[boardKey(view, data.leaderboardCategory)] = { at: Date.now() };
                }
            }
            this.refreshCycleBars();
        }
        const parsed = parseLocalBoard(data, Date.now(), { includeSteam: this.includeSteam });
        if (!parsed) return;
        this.adopt({ [parsed.key]: parsed.board });
        this.refreshCycleBars();
    }

    /**
     * Put the "Next board" bar above the leaderboard's tab panels. Each category tab mounts its own panel
     * content, so a bar beside the content would stay behind on the panel that was left; the panels
     * container survives tab switches, so the one bar stays with whatever is visible. Without that
     * container the bar falls back to sitting before the content. Idempotent. The guild panel is skipped.
     * @param {Element} host - A `LeaderboardPanel_content` element
     */
    insertCycleBar(host) {
        if (this.mode !== 'local' || !host?.isConnected || !host.matches?.(`[class*="${PANEL_CLASS}"]`)) return;
        if (host.closest('[class*="GuildPanel"]')) return;
        const container = host.closest(`[class*="${PANELS_CLASS}"]`);
        if (container) {
            if (container.firstElementChild?.hasAttribute?.(BAR_ATTR)) return;
            // A bar left beside a panel content, from before the container existed or on another panel
            for (const stale of document.querySelectorAll(`[${BAR_ATTR}]`)) {
                if (stale.parentElement !== container) stale.remove();
            }
            if (container.querySelector(`:scope > [${BAR_ATTR}]`)) return;
        } else if (host.previousElementSibling?.hasAttribute?.(BAR_ATTR)) return;
        const bar = document.createElement('div');
        bar.setAttribute(BAR_ATTR, '');
        bar.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:4px 0;font-size:12px';
        const button = document.createElement('button');
        button.type = 'button';
        button.style.cssText = 'padding:2px 10px;cursor:pointer';
        const status = document.createElement('span');
        const note = document.createElement('span');
        note.style.opacity = '0.8';
        bar.append(button, status, note);
        this.inferView(host);
        // One real click, one game click: no timer, no loop, nothing queued behind it. The bar is the search
        // anchor: a re-render can replace the panel content while keeping the bar, so `host` may be detached
        button.addEventListener('click', () => this.openNextBoard(bar, note));
        if (container) container.prepend(bar);
        else host.insertAdjacentElement('beforebegin', bar);
        this.refreshCycleBars();
    }

    /**
     * Adopt the view showing in the tabs when no board message has said otherwise.
     * @param {Element} anchor - The leaderboard panel content
     */
    inferView(anchor) {
        if (this.messageSeen) return;
        const view = inferOpenView(anchor);
        if (!view) return;
        this.playerBoardOpen = view.type !== 'guilds';
        if (!this.playerBoardOpen) return;
        this.boardType = view.type;
        this.boardCategory = view.category;
    }

    /**
     * What "next board" is judged against: the badge cache on a global view, but on a Steam view (Steam boards
     * feed EXP history, not the global cache) the times the leaderboard XP tracker recorded across sessions,
     * merged with this session's opened map.
     * @returns {{source: Object, recorded: boolean}} Boards keyed "type|category" with an `at`; `recorded` is
     *   true when the tracker's history contributed (so the count is "recorded", not "opened this session")
     */
    cycleSourceInfo() {
        if (!isSteamBoardType(this.boardType)) return { source: this.boards, recorded: false };
        let times = {};
        if (config.getSettingValue(XP_TRACKER_KEY, true) !== false) {
            try {
                times = leaderboardXPTracker.getBoardRecordTimes(this.boardType) || {};
            } catch (error) {
                console.error('[LeaderboardRankBadges] Reading recorded Steam boards failed:', error);
            }
        }
        const recorded = Object.keys(times).length > 0;
        if (!recorded) return { source: this.opened, recorded: false };
        const source = {};
        for (const category of RANK_CATEGORIES) {
            const key = boardKey(this.boardType, category);
            const at = Math.max(times[category] ?? 0, this.opened[key]?.at ?? 0);
            if (at) source[key] = { at };
        }
        return { source, recorded: true };
    }

    /** @returns {Object} The boards "next board" is judged against */
    cycleSource() {
        return this.cycleSourceInfo().source;
    }

    /** Redraw the label and the cached count of every bar. */
    refreshCycleBars() {
        const { source, recorded } = this.cycleSourceInfo();
        const steam = isSteamBoardType(this.boardType);
        const target = nextBoardCategory(source, this.boardType, this.boardCategory);
        const cached = RANK_CATEGORIES.filter((c) => source[boardKey(this.boardType, c)]);
        const oldest = Math.min(...cached.map((c) => source[boardKey(this.boardType, c)].at));
        const age = cached.length ? formatRelativeTime(Math.max(0, Date.now() - oldest)) : null;
        const oldestText = age ? ` · oldest ${age === 'Just now' ? '<1m' : age}` : '';
        for (const bar of document.querySelectorAll(`[${BAR_ATTR}]`)) {
            // Player skill boards do not exist on the Guilds tab, so the button would hunt for a missing tab
            bar.style.display = this.playerBoardOpen ? 'flex' : 'none';
            const [button, status] = bar.children;
            button.textContent = `Next board ▸ ${target ? categoryLabel(target) : '-'}`;
            if (steam) {
                const tracking = config.getSettingValue(XP_TRACKER_KEY, true) !== false;
                status.textContent =
                    `${cached.length}/${RANK_CATEGORIES.length} Steam boards ${recorded ? 'recorded' : 'opened'}` +
                    (recorded ? oldestText : '') +
                    (tracking ? '' : ' (EXP tracking is off)');
                status.title = recorded
                    ? `${boardTypeLabel(this.boardType)} boards the leaderboard XP tracker has recorded, including ` +
                      'earlier sessions; each one feeds EXP history. Next board goes to the missing or oldest ' +
                      `one first.${age ? ` The oldest was recorded ${age} ago.` : ''}`
                    : `${boardTypeLabel(this.boardType)} boards opened since the game loaded. ` +
                      (tracking
                          ? 'Each one you open is recorded by the leaderboard XP tracker, so this feeds EXP history.'
                          : 'The leaderboard XP tracker setting is off, so opening them records no EXP history; ' +
                            'they are only kept for badges when Steam badges are on.');
                continue;
            }
            status.textContent = `${cached.length}/${RANK_CATEGORIES.length} boards cached${oldestText}`;
            status.title = cached.length
                ? `Oldest ${this.boardType} board: ${age} ago. Next board goes to the missing or oldest one first, ` +
                  'so pressing it repeatedly brings every board current.'
                : 'Nothing cached yet';
        }
    }

    /**
     * The single game click behind one press of the button.
     * @param {Element} anchor - The bar, which stays in the panel across content re-renders
     * @param {Element} note - Where a failure is said
     */
    openNextBoard(anchor, note) {
        const target = nextBoardCategory(this.cycleSource(), this.boardType, this.boardCategory);
        note.textContent = '';
        if (!target) return;
        const tab = findCategoryTab(anchor, target);
        if (!tab) {
            note.textContent = `Could not find the ${categoryLabel(target)} tab`;
            return;
        }
        // Assume it lands; the board's own message corrects this if it did not
        this.boardCategory = target;
        tab.click();
        this.refreshCycleBars();
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
                        // Third-party host: it must not set or receive cookies on the poll
                        anonymous: true,
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
        this.record.set(merged);
        this.rebuildIndex();
        this.persist().catch((error) => console.error('[LeaderboardRankBadges] Saving the rank cache failed:', error));
        this.decorateAll(true);
    }

    /**
     * Save the cache, and take back whatever the save found stored beside it (another tab's boards, a sync pull)
     * so the next save does not write the stale copy over them.
     * @returns {Promise<void>}
     */
    async persist() {
        const runId = this.runId;
        if (!(await this.record.save()) || runId !== this.runId) return;
        const folded = this.record.get();
        if (sameBoards(folded, this.boards)) return;
        this.boards = folded;
        this.rebuildIndex();
        this.decorateAll(true);
    }

    rebuildIndex() {
        this.index = buildNameIndex(this.boards, { includeSteam: this.includeSteam });
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
        this.watchName(nameEl);
        const name = nameFrom(nameEl);
        if (!name) {
            existing?.remove();
            return;
        }
        const entries = this.index.get(normalizeName(name));
        const { best, ordered } = this.pickEntry(entries);
        if (!best) {
            existing?.remove();
            return;
        }
        const marked = this.markSteam && isSteamBoardType(best.type);
        const signature = `${name}|${best.type}|${best.category}|${best.rank}|${best.at}|${marked}`;
        if (existing && !force && existing.dataset.signature === signature) return;

        const badge = existing || document.createElement('span');
        badge.setAttribute(BADGE_ATTR, tierForRank(best.rank));
        badge.dataset.signature = signature;
        if (best.rank <= 5) badge.setAttribute('data-top-five', '');
        else badge.removeAttribute('data-top-five');
        badge.title = describeEntries(ordered, Date.now());
        badge.dataset.nameKey = normalizeName(name);
        if (!existing) {
            // The age in the tooltip is read at inspection, not baked in at decoration
            const refresh = () => {
                const current = this.index.get(badge.dataset.nameKey);
                if (current?.length) badge.title = describeEntries(this.pickEntry(current).ordered, Date.now());
            };
            badge.addEventListener('mouseenter', refresh);
            badge.addEventListener('focus', refresh);
        }
        // textContent and SVG nodes only: nothing from a payload is ever markup
        badge.replaceChildren();
        const icon = this.buildIcon(best.category);
        if (icon) badge.appendChild(icon);
        if (marked) {
            // aria-hidden: the tooltip already names the board, and a lone "S" read aloud says nothing
            const mark = document.createElement('span');
            mark.setAttribute(STEAM_MARK_ATTR, '');
            mark.setAttribute('aria-hidden', 'true');
            mark.textContent = 'S';
            badge.appendChild(mark);
        }
        badge.appendChild(document.createTextNode(String(best.rank)));
        if (!existing) nameEl.insertAdjacentElement('afterend', badge);
    }

    /**
     * The category's icon from the game's own sprite sheet.
     * @param {string} category - A category slug
     * @returns {SVGElement|null} Null until the sprite URL has resolved
     */
    buildIcon(category) {
        const chat = CHAT_SYMBOLS[category];
        const misc = chat ? null : MISC_SYMBOLS[category];
        const sheet = chat ? this.spriteUrls.chatIcons : misc ? this.spriteUrls.misc : this.spriteUrls.skills;
        if (!sheet) return null;
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 40 40');
        svg.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS(SVG_NS, 'use');
        use.setAttribute('href', `${sheet}#${chat || misc || category}`);
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
        this.nameWatcher?.disconnect();
        this.nameWatcher = null;
        document.querySelectorAll(`[${BADGE_ATTR}], [${BAR_ATTR}]`).forEach((el) => el.remove());
        document.getElementById(STYLE_ID)?.remove();
        this.index = new Map();
        this.boards = {};
    }

    /** Test-only: drops the account-wide record from memory so cases stay isolated. */
    resetRecordForTests() {
        this.record.reset();
    }

    cleanup() {
        this.unwatchSetting?.();
        this.unwatchSetting = null;
        this.stop();
        // The open view survives a settings restart (the game does not resend the board it is showing)
        // and is forgotten only here
        this.opened = {};
        // The record is account-wide and survives a character switch: resetting it here would drop a save still
        // awaiting its read (storage.flushAll cannot see it). The next initialize folds storage under memory.
        this.storedFuture = false;
        this.messageSeen = false;
        this.boardType = 'standard';
        this.boardCategory = null;
        this.playerBoardOpen = true;
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
