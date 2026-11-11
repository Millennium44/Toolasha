/**
 * The Combat Sim's Party tab: a saved roster of teammate builds, and a sweep that sims you with every party you
 * could make from it, in the zones you pick, and ranks the parties by what they do for YOU against going solo.
 *
 * Built by `combat-sim-ui.js` into its own tab container (gated by `combatSim_partyFinder`); everything the tab
 * owns — nodes, listeners, timers, the run in flight — is let go by {@link PartyFinderTab#detach}.
 *
 * The run follows the All Zones sweep's rules (see `_onSimulateAllZones`):
 *
 * - Runs through `runAllZonesSimulation`, the same coordinator, worker pool and worker cap (`getMaxWorkers`), one
 *   task per (party × zone/tier), with no early exit and task damage off.
 * - Refuses to start while anything else in the panel runs, and marks the panel busy (`host.isRunning`) while it
 *   runs, so nothing else starts under it. The panel's own Stop (Simulate while running) cancels it too, which
 *   reads as a stop here.
 * - Captures the character before the first await and checks it, and the run's own token, after every await and
 *   in every callback; a run that outlived its character or its panel draws and writes nothing.
 * - Figures are yours (player1) only, priced by `calculateSimRevenue` with one price cache, frozen before the first sim, for both passes; a pricing
 *   change during a run is replayed when it ends.
 * - Stop keeps every finished row and says "stopped early — N of M".
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import storage from '../../core/storage.js';
import { onSyncPullApplied } from '../../utils/sync-merge-registry.js';
import { formatKMB } from '../../utils/formatters.js';
import { createEtaTracker } from '../../utils/progress-eta.js';
import { toCsv, csvFilename, downloadCsv } from '../../utils/csv-export.js';
import {
    buildAllPlayerDTOs,
    buildGameDataPayload,
    buildPlayerDTO,
    getCombatZones,
    getCommunityBuffs,
    getCurrentCombatZone,
    guildBuffsFromExportLevels,
    parseShykaiImport,
} from './combat-sim-adapter.js';
import { runAllZonesSimulation, cancelAllZonesSimulation } from './all-zones-runner.js';
import { saleTaxRateOf } from './upgrade-advisor.js';
import { seedRunPriceCache } from './sim-price-seed.js';
import {
    PARTY_ROSTER_KEY,
    MAX_ROSTER_SIZE,
    MAX_SAVED_BUILDS,
    evictedByCap,
    loadRoster,
    saveBuild,
    renameBuild,
    removeBuild,
    addTeammates,
    renameTeammate,
    removeTeammate,
    replaceTeammateBuild,
    setTeammateAuras,
    normalizeAuraOptions,
    MAX_AURA_OPTIONS,
    buildFingerprint,
} from './party-roster.js';
import {
    SAVED_PARTIES_KEY,
    MAX_SAVED_PARTIES,
    MAX_PARTY_MEMBERS,
    evictedPartiesByCap,
    loadSavedParties,
    saveParty,
    renameParty,
    removeParty,
    usableMembers,
} from './party-saved.js';
import { tuneTemplate, clearTunerCache } from './party-template-tuner.js';
import { BUTTON_LOOK, GAME_COLORS } from '../../utils/game-look.js';
import { PARTY_TEMPLATES, TEMPLATE_ROLE_GROUPS, templatesForGroup, templateTeammateName } from './party-templates.js';
import {
    planSweep,
    buildCompositionParty,
    readResult,
    repriceMetrics,
    shownMetrics,
    soloDelta,
    sortRows,
    pickRerunRows,
    partyLabel,
    memberLabel,
    planPartyLock,
    PARTY_ENTRY_PREFIX,
    sharedAuras,
    checkAuraOption,
    isPlayerSpecialAbility,
    maxAbilityLevel,
    csvRow,
    stoppedSweepText,
    zoneTierKey,
    CSV_COLUMNS,
    CONFIRM_RUNS_ABOVE,
    DEFAULT_QUICK_HOURS,
    DEFAULT_TOP_K,
    RANK_METRICS,
    DUNGEON_MAX_PARTY,
    blendedScore,
    normalizeScoreWeight,
    DEFAULT_SCORE_WEIGHT,
} from './party-finder.js';

const ACCENT = '#4a9eff';
const PROGRESS_FILL_START = 'rgba(74, 158, 255, 0.2)';
const RED = '#f44336';
const GREEN = '#4caf50';

/** Dungeons run T0-T2 where an ordinary zone runs T0-T5 */
const DUNGEON_MAX_TIER = 2;
const ZONE_MAX_TIER = 5;

/**
 * How often the results redraw while a run streams rows in. Each redraw rebuilds the whole table, which on a
 * large sweep is hundreds of rows; once a second is enough to watch it fill. The end of a run draws at once.
 */
const RENDER_THROTTLE_MS = 1000;

const INPUT_STYLE =
    'background:' +
    GAME_COLORS.inputBackground +
    '; color:#e0e0e0; border:1px solid ' +
    GAME_COLORS.inputBorder +
    '; border-radius:4px; padding:3px 6px; font-size:12px; font-family:inherit;';
const BTN_STYLE = `background:${BUTTON_LOOK.primary.rest}; color:${GAME_COLORS.text}; border:none; border-radius:var(--radius-sm, 0.25rem); padding:3px 10px; font-size:12px; font-weight:600; cursor:pointer; font-family:inherit;`;
const SMALL_BTN_STYLE = `background:transparent; color:#aaa; border:1px solid #444; border-radius:3px; padding:1px 6px; font-size:11px; cursor:pointer; font-family:inherit;`;

/**
 * Teammate, saved-build and aura-option rows on a touch screen: their buttons are 18-22px tall, so they get
 * a finger-sized height, and the row wraps instead of squeezing the name to nothing beside five buttons.
 * Desktop (a fine pointer) never matches, so it keeps its inline look exactly.
 */
const TOUCH_CSS = `
@media (pointer: coarse) {
    .mwi-csim-party-finder [data-pf-member] button,
    .mwi-csim-party-finder [data-pf-build] button,
    .mwi-csim-party-finder [data-pf-auras] button { min-height: 32px; }
    .mwi-csim-party-finder [data-pf-member],
    .mwi-csim-party-finder [data-pf-build] { flex-wrap: wrap; }
    .mwi-csim-party-finder [data-pf-name],
    .mwi-csim-party-finder [data-pf-build-name] { flex: 1 1 8em !important; }
}`;

/** What the "Match my build" switch does, for its tooltip */
const MATCH_BUILD_HELP =
    'A template added as a teammate is tuned to your current build. Combat levels: your own for each stat, except ' +
    'the main stat of the template (melee, ranged, magic or defense), which is your highest of melee, ranged, magic and ' +
    'defense. Gear enhancement and ability levels: raised or lowered together until the build score of the template ' +
    '(combat gear plus abilities, the figure on the profile card) is closest to yours. House and shrines are not ' +
    'compared. Without your build score the standard template is added.';

/**
 * A build score in millions of coins, for the template score line: converted to coins and printed compactly
 * ("7.34T", "1.05Q").
 * @param {number} value - Millions of coins
 * @returns {string}
 */
function formatScoreM(value) {
    return formatKMB(Math.round(value) * 1e6, 2);
}

/**
 * The mark beside a profit or Score figure that was built on items nothing priced, counted as 0. A drop left out
 * makes the figure a floor ("≥"); an expense left out (a consumable, a dungeon key) makes it a ceiling ("≤"); both
 * at once leave it neither ("?").
 * @param {Object} metrics - A row's shown metrics (`unpriced`, `unpricedCost`)
 * @returns {string} HTML, empty when everything was priced
 */
export function unpricedMark(metrics) {
    const all = metrics?.unpriced || [];
    if (!all.length) return '';
    const costs = new Set(metrics?.unpricedCost || []);
    const costSide = all.filter((name) => costs.has(name));
    const revenueSide = all.filter((name) => !costs.has(name));
    let mark = '≥';
    let note = 'a lower bound';
    if (costSide.length && revenueSide.length) {
        mark = '?';
        note = 'neither a floor nor a ceiling';
    } else if (costSide.length) {
        mark = '≤';
        note = 'an upper bound';
    }
    const names = [...revenueSide, ...costSide].join(', ');
    return `<span title="No price for ${esc(names)}; counted as 0, so this is ${note}" style="color:#ff9800;">${mark}</span>`;
}

/**
 * The line saying what tuning a template came to. A clamp (the template cannot reach your score) and unpriced gear
 * (the match is approximate) are reported independently, so a clamped match through unpriced gear says both.
 * @param {{status: string, clamp?: 'clampedLow'|'clampedHigh'|null, template?: number|null, own?: number|null}} tuned
 * @returns {string}
 */
function tunedText(tuned) {
    const both = tuned.template != null && tuned.own != null;
    const figures = both ? `score ${formatScoreM(tuned.template)} ≈ yours ${formatScoreM(tuned.own)}` : '';
    const clamp =
        tuned.clamp || (tuned.status === 'clampedLow' || tuned.status === 'clampedHigh' ? tuned.status : null);
    const partial = tuned.status === 'partial';
    if (clamp || partial || tuned.status === 'ok') {
        const sentences = [figures];
        if (clamp === 'clampedLow') {
            sentences.push('Even the lowest setting scores above your build, so the template is stronger than you.');
        } else if (clamp === 'clampedHigh') {
            sentences.push('Even the highest setting scores below your build, so the template is weaker than you.');
        }
        if (partial) sentences.push('Some gear is unpriced, so the match is approximate.');
        return sentences
            .filter(Boolean)
            .map((sentence, index, all) => (index === 0 && all.length > 1 ? `${sentence}.` : sentence))
            .join(' ');
    }
    switch (tuned.status) {
        case 'noScore':
            return 'Your build score is not loaded yet, so the standard template was added (combat levels still match you).';
        case 'aborted':
            return 'The character, its gear or the prices changed while matching, so the standard template was added.';
        default:
            return 'The build could not be scored, so the standard template was added (combat levels still match you).';
    }
}
const STOP_BTN_STYLE = `background:rgba(244, 67, 54, 0.2); border:1px solid rgba(244, 67, 54, 0.4); color:${RED}; border-radius:4px; padding:3px 10px; font-size:12px; font-weight:600; cursor:pointer; font-family:inherit;`;

/**
 * Escape text for HTML.
 * @param {*} value
 * @returns {string}
 */
function esc(value) {
    return String(value ?? '').replace(
        /[&<>"']/g,
        (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
    );
}

/** Two names compared without case or stray spaces */
function sameDisplayName(a, b) {
    return (
        String(a ?? '')
            .trim()
            .toLowerCase() ===
        String(b ?? '')
            .trim()
            .toLowerCase()
    );
}

/**
 * Clamp a number input's value.
 * @param {HTMLInputElement|null} input
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function readInt(input, fallback, min, max) {
    const value = parseInt(input?.value, 10);
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : fallback));
}

/**
 * Names for a note, the first few and how many more.
 * @param {Array<string>} names
 * @returns {string}
 */
function lostNames(names) {
    const shown = names.slice(0, 5).join(', ');
    return names.length > 5 ? `${shown} and ${names.length - 5} more` : shown;
}

/**
 * Format "1m 05s" from seconds.
 * @param {number} seconds
 * @returns {string}
 */
function formatElapsed(seconds) {
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/**
 * Display names that tell same-named teammates apart: "Bob", "Bob #2". A number another teammate already goes by
 * ("Bob #2" saved under that name) is skipped, so no two rows, and no two "replacing" targets, read the same.
 * @param {Array<{id: string, name: string}>} entries
 * @returns {Map<string, string>} id → display name
 */
export function displayNames(entries) {
    const counts = new Map();
    for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) || 0) + 1);
    const taken = new Set(entries.map((entry) => entry.name));
    const seen = new Map();
    const names = new Map();
    for (const entry of entries) {
        if (counts.get(entry.name) === 1) {
            names.set(entry.id, entry.name);
            continue;
        }
        let n = seen.get(entry.name) || 0;
        if (n === 0) {
            n = 1;
            names.set(entry.id, entry.name);
        } else {
            do n += 1;
            while (taken.has(`${entry.name} #${n}`));
            taken.add(`${entry.name} #${n}`);
            names.set(entry.id, `${entry.name} #${n}`);
        }
        seen.set(entry.name, n);
    }
    return names;
}

/**
 * Items, abilities and consumables a build names that this game data does not know, which the engine cannot run.
 * @param {Object} dto
 * @param {Object} gameData
 * @returns {Array<string>} Unknown hrids
 */
export function unknownBuildParts(dto, gameData) {
    const items = gameData?.itemDetailMap || {};
    const abilities = gameData?.abilityDetailMap || {};
    const unknown = [];
    for (const piece of Object.values(dto?.equipment || {})) {
        if (piece?.hrid && !items[piece.hrid]) unknown.push(piece.hrid);
    }
    for (const slot of [...(dto?.food || []), ...(dto?.drinks || [])]) {
        if (slot?.hrid && !items[slot.hrid]) unknown.push(slot.hrid);
    }
    for (const slot of dto?.abilities || []) {
        if (slot?.hrid && !abilities[slot.hrid]) unknown.push(slot.hrid);
    }
    return unknown;
}

/** How long a shared profile is waited for before the Party tab stops looking */
const PROFILE_WAIT_MS = 60000;

export class PartyFinderTab {
    /**
     * @param {Object} host - The Combat Sim panel (`CombatSimUI`)
     */
    constructor(host) {
        this.host = host;
        this.root = null;
        this._roster = { savedAt: 0, entries: [], builds: [] };
        /** Teammate id → 'try' | 'always' | 'never' */
        this._choices = {};
        /**
         * "Include my party": on by default and remembered per character. The members of your in-game party stand
         * in as always-included teammates. They are never written to the saved roster; this is all in memory.
         */
        this._includeParty = true;
        /**
         * What is locked in: 'my' (your in-game party), 'nobody', or `saved:<party id>` (a saved party's members,
         * in place of the in-game party). Stored per character in the old checkbox's key as true / false / the
         * `saved:` string, so a build from before the select reads it as on or off.
         */
        this._lockMode = 'my';
        /** The saved parties, and whether they have been read yet (a stored pick of one waits for the read) */
        this._saved = { savedAt: 0, parties: [], removed: {} };
        this._savedLoaded = false;
        /** Bumped by every read and every write of the saved parties: an older read resolving later is dropped */
        this._savedSeq = 0;
        /** A save is in flight: a second press waits for it */
        this._savingParty = false;
        /** Party member row id (`party:<characterID>`) → 'try' | 'always' | 'never' picked this session */
        this._partyChoices = new Map();
        /** Party row id → aura options to try them with, this session only (never the saved roster) */
        this._partyAuras = new Map();
        this._partyAuraOpen = null;
        /** Your party's other members as last read: {characterID, characterName, dto|null}, and why there are none */
        this._partyMembers = [];
        this._partyNote = '';
        this._partyToken = 0;
        /** The last party read started; {@link PartyFinderTab#start} waits for it */
        this._latestPartyRead = null;
        this._partyUnwatch = null;
        /** Selected zone/tiers: [{zoneHrid, difficultyTier, isDungeon, name}] */
        this._zones = [];
        this._zonesSeeded = false;
        /** Result rows by id (`zoneKey|compKey`) */
        this._rows = new Map();
        this._baselines = new Map();
        this._sortKey = 'xp';
        this._sortAsc = false;
        /** XP per coin in the Score column: "1M profit = X M XP", kept per character */
        this._scoreWeight = DEFAULT_SCORE_WEIGHT;
        this._running = false;
        this._runToken = 0;
        this._repricePending = false;
        this._renderTimer = null;
        this._pendingConfirm = null;
        this._pendingDelete = null;
        this._templatesOpen = false;
        /** "Match my build": on by default, like the finder's other options it is not stored between sessions */
        this._matchBuild = true;
        /** What tuning each template to the character came to, by template id: {ownerId, status, text} */
        this._tuned = new Map();
        this._tuning = false;
        /** Bumped on every match and on detach: a match answers only while its token is still the current one */
        this._matchToken = 0;
        this._pendingDeleteTimer = null;
        /** The teammate whose aura options are open, if any */
        this._auraOpen = null;
        /** "Also try my auras": off by default, since every aura of yours multiplies the sims */
        this._trySelfAuras = false;
        /** Auras picked by hand for an editor-loaded "you" (what they own is unknown), by the picker's value */
        this._selfAuraPicks = new Map();
        this._selfAuraOpen = false;
        this._lastRun = null;
        this._summary = '';
        this._unsubscribePull = null;
        this._elapsedTimer = null;
    }

    /**
     * Whether a sweep is in flight.
     * @returns {boolean}
     */
    isBusy() {
        return this._running;
    }

    /**
     * Build the tab inside its container and load the roster.
     * @param {HTMLElement} container
     */
    mount(container) {
        if (this.root) return;
        this.root = document.createElement('div');
        this.root.className = 'mwi-csim-party-finder';
        this.root.style.cssText = 'display:flex; flex-direction:column; gap:8px; padding:10px 14px;';
        this.root.innerHTML = this._skeletonHtml();
        // Not inline: the media query has to follow the device, and the sheet goes with the root
        const touchSheet = document.createElement('style');
        touchSheet.textContent = TOUCH_CSS;
        this.root.appendChild(touchSheet);
        container.appendChild(this.root);
        this._wire();
        this._unsubscribePull = onSyncPullApplied((written) => {
            if ((written?.settings || []).includes(PARTY_ROSTER_KEY)) this._reloadRoster({ pulled: true });
            if ((written?.settings || []).includes(SAVED_PARTIES_KEY)) this._reloadSaved({ pulled: true });
        });
        this._watchParty();
        this._reloadRoster();
        this._reloadSaved();
        this._loadScoreWeight();
        this._loadIncludeParty();
    }

    /**
     * Let go of everything: the run in flight, the nodes, the listeners, the timers and the results.
     */
    detach() {
        if (this._running) {
            cancelAllZonesSimulation();
            this._setRunningUi(false);
            if (this.host) {
                this.host.isRunning = false;
                // A pricing change the panel held for the end of this run is replayed now, not never
                this.host._flushPendingReprice?.();
            }
        }
        this._runToken++;
        this._matchToken++;
        // A wait begun before the tab closed must not resume against the next opening's root
        this._profileWaits?.clear();
        this._running = false;
        clearTimeout(this._renderTimer);
        clearTimeout(this._pendingDeleteTimer);
        clearInterval(this._elapsedTimer);
        this._renderTimer = null;
        this._pendingDeleteTimer = null;
        this._elapsedTimer = null;
        this._unsubscribePull?.();
        this._unsubscribePull = null;
        this._partyUnwatch?.();
        this._partyUnwatch = null;
        this._partyToken++;
        this._latestPartyRead = null;
        this.root?.remove();
        this.root = null;
        this._rows = new Map();
        this._baselines = new Map();
        this._roster = { savedAt: 0, entries: [], builds: [] };
        this._choices = {};
        this._includeParty = true;
        this._lockMode = 'my';
        this._saved = { savedAt: 0, parties: [], removed: {} };
        this._savedLoaded = false;
        this._partyChoices = new Map();
        /** Party row id → aura options to try them with, this session only (never the saved roster) */
        this._partyAuras = new Map();
        this._partyAuraOpen = null;
        this._partyMembers = [];
        this._partyNote = '';
        this._zones = [];
        this._zonesSeeded = false;
        this._pendingConfirm = null;
        this._pendingDelete = null;
        this._tuned = new Map();
        this._tuning = false;
        this._matchBuild = true;
        this._auraOpen = null;
        this._trySelfAuras = false;
        this._selfAuraPicks = new Map();
        this._selfAuraOpen = false;
        this._lastRun = null;
        this._summary = '';
    }

    /**
     * The tab was opened: follow the editor's players and seed the zone list.
     */
    onShow() {
        if (!this.root) return;
        if (!this._zonesSeeded) this._seedZones();
        this._renderSelfPicker();
        this._renderAddFromEditor();
        this._renderZoneChips();
        this._renderPlan();
        this._refreshParty();
        if (!this.host?._isBusy?.()) this._status('Pick zones and teammates, then click Find parties.');
    }

    /**
     * A pricing setting changed: re-price the rows on screen (after the run, if one is going).
     */
    onPricingChanged() {
        // A solved offset was matched against prices that have moved
        clearTunerCache();
        if (!this.root || !this._rows.size) return;
        if (this._running) {
            this._repricePending = true;
            return;
        }
        const gameData = this._lastRun?.gameData || buildGameDataPayload();
        if (!gameData) return;
        const quickCache = new Map();
        const fullCache = new Map();
        for (const row of this._rows.values()) {
            if (row.quick) row.quick = repriceMetrics(row.quick, gameData, quickCache);
            if (row.full) row.full = repriceMetrics(row.full, gameData, fullCache);
        }
        this._renderResults();
    }

    // ---------------------------------------------------------------- markup

    /**
     * @returns {string}
     * @private
     */
    _skeletonHtml() {
        const allZonesHours = config.getSettingValue('combatSim_allZonesDefaultHours', 10);
        const section = (title, body, id = '') =>
            `<div ${id ? `id="${id}"` : ''} style="border:1px solid #222; border-radius:6px; padding:8px;">
                <div style="color:${ACCENT}; font-size:12px; font-weight:700; margin-bottom:6px;">${title}</div>${body}</div>`;
        return [
            section(
                'You',
                `<div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
                    <select class="toolasha-select" data-pf="self" style="${INPUT_STYLE}"></select>
                    <span style="color:${GAME_COLORS.textDim}; font-size:11px;">This player is in every party tried, and every figure below is theirs.</span>
                </div>
                <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top:6px;">
                    <label style="color:#aaa; font-size:11px; display:flex; gap:4px; align-items:center;" title="Also sim you wearing each aura you own, alone and in every party">
                        <input type="checkbox" data-pf="self-auras"> Also try my auras</label>
                    <span data-pf="self-aura-info" style="color:#888; font-size:11px;"></span>
                    <button data-pf="self-aura-edit" style="${SMALL_BTN_STYLE} display:none;"></button>
                </div>
                <div data-pf="self-aura-editor"></div>
                <div style="color:${GAME_COLORS.textDim}; font-size:11px; margin-top:4px;">With auras on, each aura of yours is tried alone and in every party, so the sims multiply. "vs solo" always compares against you as worn, alone (the baseline row); the solo rows with an aura show whether it helps you alone.</div>`
            ),
            section(
                'Teammates <span data-pf="roster-count" style="color:' +
                    GAME_COLORS.textDim +
                    '; font-weight:400;"></span>',
                `<label style="color:#aaa; font-size:11px; display:flex; gap:6px; align-items:center; margin-bottom:4px;" title="The members of the party you pick are added here as Always, so every party tried already holds them and the search fills only the leftover slots. They are not saved to your roster.">
                    Lock in <select class="toolasha-select" data-pf="lock-party" style="${INPUT_STYLE}"></select></label>
                <div data-pf="party-note" style="color:#888; font-size:11px; margin-bottom:4px;"></div>
                <div data-pf="party-rows" style="display:flex; flex-direction:column; gap:3px; margin-bottom:4px;"></div>
                <div data-pf="roster" style="display:flex; flex-direction:column; gap:3px;"></div>
                <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top:6px;">
                    <label style="color:#888; font-size:11px;">From the editor</label>
                    <select class="toolasha-select" data-pf="editor-player" style="${INPUT_STYLE}"></select>
                    <select class="toolasha-select" data-pf="editor-target" style="${INPUT_STYLE}"></select>
                    <button data-pf="add-editor" style="${BTN_STYLE}">Save</button>
                    <button data-pf="add-self" style="${SMALL_BTN_STYLE}" title="Save a copy of your current build as a teammate you can then edit. Teammates are added to parties beside you, so this puts a second copy of you in them.">Copy my build</button>
                    <button data-pf="toggle-import" style="${SMALL_BTN_STYLE}">Paste import…</button>
                </div>
                <div data-pf="import-box" style="display:none; margin-top:6px;">
                    <textarea data-pf="import-text" rows="3" placeholder="Paste a sim export (one player or a whole party)" style="${INPUT_STYLE} width:100%; box-sizing:border-box;"></textarea>
                    <button data-pf="import" style="${BTN_STYLE} margin-top:4px;">Import to roster</button>
                </div>
                <div data-pf="roster-note" style="color:#888; font-size:11px; margin-top:4px;"></div>`
            ),
            section(
                'Saved builds <span data-pf="build-count" style="color:' +
                    GAME_COLORS.textDim +
                    '; font-weight:400;"></span>',
                `<div data-pf="templates" style="margin-bottom:6px;"></div>
                <div data-pf="builds" style="display:flex; flex-direction:column; gap:3px;"></div>
                <div style="margin-top:6px;">
                    <button data-pf="save-build-open" style="${SMALL_BTN_STYLE}" title="Keep a build under a name, to add as a teammate later">Save build…</button>
                </div>
                <div data-pf="save-build-form" style="display:none; flex-wrap:wrap; gap:6px; align-items:center; margin-top:6px;">
                    <select class="toolasha-select" data-pf="build-source" style="${INPUT_STYLE}"></select>
                    <input data-pf="build-name" type="text" maxlength="40" placeholder="Name" style="${INPUT_STYLE} width:140px;">
                    <button data-pf="save-build" style="${BTN_STYLE}">Save</button>
                    <button data-pf="save-build-cancel" style="${SMALL_BTN_STYLE}">Cancel</button>
                </div>
                <div data-pf="build-note" style="color:#888; font-size:11px; margin-top:4px;"></div>`
            ),
            section(
                'Saved parties <span data-pf="party-saved-count" style="color:' +
                    GAME_COLORS.textDim +
                    '; font-weight:400;"></span>',
                `<div data-pf="saved-parties" style="display:flex; flex-direction:column; gap:3px;"></div>
                <div style="margin-top:6px;">
                    <button data-pf="save-party-open" style="${SMALL_BTN_STYLE}" title="Keep the players in the editor besides you, with their Try/Always/Never and auras, under a name">Save party…</button>
                </div>
                <div data-pf="save-party-form" style="display:none; flex-wrap:wrap; gap:6px; align-items:center; margin-top:6px;">
                    <input type="text" data-pf="party-name" placeholder="Party name" maxlength="40" style="${INPUT_STYLE}">
                    <button data-pf="save-party" style="${BTN_STYLE}">Save</button>
                    <button data-pf="save-party-cancel" style="${SMALL_BTN_STYLE}">Cancel</button>
                </div>
                <div data-pf="saved-party-note" style="color:#888; font-size:11px; margin-top:4px;"></div>`
            ),
            section(
                'Zones',
                `<div data-pf="zone-chips" style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:6px;"></div>
                <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
                    <select class="toolasha-select" data-pf="zone" style="${INPUT_STYLE} max-width:200px;"></select>
                    <select class="toolasha-select" data-pf="tier" style="${INPUT_STYLE}"></select>
                    <button data-pf="add-zone" style="${SMALL_BTN_STYLE}">Add</button>
                </div>`
            ),
            section(
                'Search',
                `<div style="display:flex; flex-wrap:wrap; gap:6px 10px; align-items:center;">
                    <label style="color:#888; font-size:11px;">Max party
                        <select class="toolasha-select" data-pf="max-party" style="${INPUT_STYLE}">
                            ${[2, 3, 4, 5].map((n) => `<option value="${n}">${n}</option>`).join('')}
                        </select></label>
                    <label style="color:#888; font-size:11px;" title="Every party is first simmed this long, to find the promising ones">Quick hours
                        <input data-pf="quick-hours" type="number" min="1" max="100" value="${DEFAULT_QUICK_HOURS}" style="${INPUT_STYLE} width:48px;"></label>
                    <label style="color:#888; font-size:11px;" title="The best parties, and their solo baselines, are simmed again this long">Re-run top
                        <input data-pf="top-k" type="number" min="0" max="20" value="${DEFAULT_TOP_K}" style="${INPUT_STYLE} width:42px;"></label>
                    <label style="color:#888; font-size:11px;">at
                        <input data-pf="full-hours" type="number" min="1" max="10000" value="${allZonesHours}" style="${INPUT_STYLE} width:56px;"> h</label>
                    <label style="color:#888; font-size:11px;">Rank by
                        <select class="toolasha-select" data-pf="metric" style="${INPUT_STYLE}">
                            ${RANK_METRICS.map((m) => `<option value="${m.key}">${m.label}</option>`).join('')}
                        </select></label>
                </div>
                <div data-pf="plan" style="color:#888; font-size:11px; margin-top:6px;"></div>
                <div style="display:flex; gap:6px; margin-top:6px; align-items:center;">
                    <button data-pf="run" style="${BTN_STYLE} padding:5px 14px;">Find parties</button>
                    <button data-pf="stop" style="${STOP_BTN_STYLE} display:none;">Stop</button>
                </div>
                <div data-pf="confirm" style="display:none; margin-top:6px; padding:6px; border:1px solid rgba(255,152,0,0.5); border-radius:4px; font-size:12px; color:#ffb74d;"></div>
                <div data-pf="progress" style="display:none; margin-top:6px;">
                    <div style="background:${GAME_COLORS.raised}; border-radius:4px; height:18px; overflow:hidden; position:relative; border:1px solid ${GAME_COLORS.border};">
                        <div data-pf="progress-fill" style="height:100%; width:0%; background:linear-gradient(90deg, ${PROGRESS_FILL_START}, ${ACCENT}); transition:width 0.2s ease;"></div>
                        <span data-pf="progress-text" style="position:absolute; inset:0; text-align:center; font-size:11px; line-height:18px; color:#e0e0e0; font-weight:600;"></span>
                    </div>
                </div>`
            ),
            `<div data-pf="summary" style="font-size:12px; color:#bbb;"></div>`,
            `<label style="color:#888; font-size:11px;" title="The Score column is EXP/hr plus this much EXP for every coin of profit/hr. 1 is a plain sum.">Score: 1M profit =
                <input data-pf="score-weight" type="number" min="0" step="any" value="${DEFAULT_SCORE_WEIGHT}" style="${INPUT_STYLE} width:64px;"> M XP</label>`,
            `<div data-pf="results" style="overflow-x:auto;"></div>`,
        ].join('');
    }

    /**
     * @param {string} name
     * @returns {HTMLElement|null}
     * @private
     */
    _el(name) {
        return this.root?.querySelector(`[data-pf="${name}"]`) || null;
    }

    /** @private */
    _wire() {
        this._el('add-editor').addEventListener('click', () => this._onAddFromEditor());
        this._el('add-self').addEventListener('click', () => this._onCopySelf());
        this._el('save-build-open').addEventListener('click', () => this._openSaveBuild());
        this._el('save-build-cancel').addEventListener('click', () => {
            this._el('save-build-form').style.display = 'none';
        });
        this._el('save-build').addEventListener('click', () => this._onSaveBuild());
        this._el('build-source').addEventListener('change', () => this._defaultBuildName());
        this._el('build-name').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this._onSaveBuild();
        });
        this._el('self-auras').addEventListener('change', (e) => {
            this._trySelfAuras = e.target.checked;
            this._selfAuraOpen = false;
            this._renderSelfAuras();
            this._renderPlan();
        });
        this._el('lock-party').addEventListener('change', (e) => this._onLockMode(e.target.value));
        this._el('save-party-open').addEventListener('click', () => this._openSaveParty());
        this._el('save-party-cancel').addEventListener('click', () => {
            this._el('save-party-form').style.display = 'none';
        });
        this._el('save-party').addEventListener('click', () => this._onSaveParty());
        this._el('party-name').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this._onSaveParty();
        });
        this._el('self-aura-edit').addEventListener('click', () => {
            this._selfAuraOpen = !this._selfAuraOpen;
            this._renderSelfAuras();
        });
        this._el('toggle-import').addEventListener('click', () => {
            const box = this._el('import-box');
            box.style.display = box.style.display === 'none' ? 'block' : 'none';
        });
        this._el('import').addEventListener('click', () => this._onImport());
        this._el('zone').addEventListener('change', () => this._renderTierOptions());
        this._el('add-zone').addEventListener('click', () => this._onAddZone());
        this._el('run').addEventListener('click', () => this.start());
        this._el('stop').addEventListener('click', () => this.stop());
        for (const name of ['max-party', 'top-k', 'quick-hours', 'full-hours']) {
            this._el(name).addEventListener('change', () => this._renderPlan());
        }
        // One listener for the whole table, which is rebuilt on every redraw: sort headers, Load buttons, CSV
        this._el('results').addEventListener('click', (event) => this._onResultsClick(event));
        this._el('metric').addEventListener('change', (e) => {
            this._sortKey = e.target.value;
            this._sortAsc = false;
            this._renderResults();
        });
        this._el('score-weight').addEventListener('change', (e) => this._onScoreWeight(e.target.value));
        // Up to the game's largest party; each zone is still held to its own cap
        this._el('max-party').value = String(DUNGEON_MAX_PARTY);
        this._populateZoneSelect();
    }

    /**
     * @param {string} text
     * @private
     */
    _status(text) {
        this.host?._setStatus?.(text);
    }

    /**
     * @param {string} text
     * @param {boolean} [warn]
     * @private
     */
    _rosterNote(text, warn = false) {
        const note = this._el('roster-note');
        if (!note) return;
        note.textContent = text || '';
        note.style.color = warn ? '#ff9800' : '#888';
    }

    // ---------------------------------------------------------------- roster

    /** The storage key of this character's score weight. @private */
    _scoreWeightKey(characterId) {
        return `combatSimPartyScoreWeight_${characterId}`;
    }

    /**
     * Read this character's saved score weight into the input.
     * @private
     */
    async _loadScoreWeight() {
        const ownerId = dataManager.getCurrentCharacterId();
        if (ownerId == null) return;
        const saved = await storage.get(this._scoreWeightKey(ownerId), 'settings', null);
        if (!this.root || dataManager.getCurrentCharacterId() !== ownerId || saved == null) return;
        this._scoreWeight = normalizeScoreWeight(saved);
        this._el('score-weight').value = String(this._scoreWeight);
        this._renderResults();
    }

    /**
     * The player set the weight: an unusable entry falls back to 1.
     * @param {string} raw
     * @private
     */
    async _onScoreWeight(raw) {
        const ownerId = dataManager.getCurrentCharacterId();
        this._scoreWeight = normalizeScoreWeight(raw);
        this._el('score-weight').value = String(this._scoreWeight);
        this._renderResults();
        if (ownerId == null) return;
        try {
            await storage.set(this._scoreWeightKey(ownerId), this._scoreWeight, 'settings');
        } catch (error) {
            console.error('[PartyFinder] Could not save the score weight:', error);
        }
    }

    // ---------------------------------------------------------------- your party

    /** The storage key of this character's "Include my party" switch. @private */
    _includePartyKey(characterId) {
        return `combatSimPartyIncludeParty_${characterId}`;
    }

    /**
     * What a stored lock-in value means: the old checkbox stored true / false, the select stores `saved:<id>` too.
     * @param {*} saved
     * @returns {string} 'my', 'nobody' or `saved:<id>`
     */
    static lockModeOf(saved) {
        if (saved === false) return 'nobody';
        if (typeof saved === 'string' && saved.startsWith('saved:') && saved.length > 'saved:'.length) return saved;
        return 'my';
    }

    /**
     * Read this character's saved lock-in pick (your party until they change it).
     * @private
     */
    async _loadIncludeParty() {
        const ownerId = dataManager.getCurrentCharacterId();
        if (ownerId == null) return;
        const edits = this._includePartyEdits || 0;
        const saved = await storage.get(this._includePartyKey(ownerId), 'settings', null);
        if (!this.root || dataManager.getCurrentCharacterId() !== ownerId) return;
        // The player changed the pick while this read was out: their choice is newer than what was saved
        if ((this._includePartyEdits || 0) !== edits) return;
        const next = PartyFinderTab.lockModeOf(saved);
        if (next === this._lockMode) return;
        this._lockMode = next;
        this._includeParty = next !== 'nobody';
        this._refreshParty();
    }

    /**
     * The player picked what to lock in.
     * @param {string} mode - 'my', 'nobody' or `saved:<id>`
     * @private
     */
    async _onLockMode(mode) {
        const ownerId = dataManager.getCurrentCharacterId();
        this._includePartyEdits = (this._includePartyEdits || 0) + 1;
        this._lockMode = PartyFinderTab.lockModeOf(mode === 'nobody' ? false : mode);
        this._includeParty = this._lockMode !== 'nobody';
        this._refreshParty();
        if (ownerId == null) return;
        const stored = this._lockMode === 'my' ? true : this._lockMode === 'nobody' ? false : this._lockMode;
        try {
            await storage.set(this._includePartyKey(ownerId), stored, 'settings');
        } catch (error) {
            console.error('[PartyFinder] Could not save the lock-in pick:', error);
        }
    }

    /** The Lock in select: your party, each saved party, nobody. @private */
    _renderLockSelect() {
        const select = this._el('lock-party');
        if (!select) return;
        const options = [
            ['my', 'My party'],
            ...this._saved.parties.map((p) => [`saved:${p.id}`, `Saved: ${p.name}`]),
            ['nobody', 'Nobody'],
        ];
        select.textContent = '';
        for (const [value, label] of options) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            select.appendChild(option);
        }
        // A pick of a saved party not read yet is kept as the value until the read says whether it exists
        if (!options.some(([value]) => value === this._lockMode)) {
            const pending = document.createElement('option');
            pending.value = this._lockMode;
            pending.textContent = 'Saved party…';
            select.insertBefore(pending, select.lastChild);
        }
        select.value = this._lockMode;
    }

    /**
     * Follow the party: a roster change redraws, and so does a profile opening (a member whose profile was not
     * loaded can then join).
     * @private
     */
    _watchParty() {
        const onRoster = () => this._refreshParty();
        const onProfile = (data) => this._onProfileShared(data);
        dataManager.on?.('party_roster_updated', onRoster);
        // Character data arriving ends the "Loading party…" line
        dataManager.on?.('character_initialized', onRoster);
        webSocketHook.on?.('profile_shared', onProfile);
        this._partyUnwatch = () => {
            dataManager.off?.('party_roster_updated', onRoster);
            dataManager.off?.('character_initialized', onRoster);
            webSocketHook.off?.('profile_shared', onProfile);
        };
    }

    /**
     * A profile was opened in game: if a party member was waiting on theirs, look again once it is written. The
     * write lands behind the hook's profile chain at a time of its own, so this keeps looking, a little slower each
     * time, for up to a minute, while the tab is open and that member is still waiting. A newer share for the same
     * member takes over that member's wait; closing the tab or switching character ends it.
     * @param {Object} [data] - The `profile_shared` message
     * @private
     */
    async _onProfileShared(data) {
        if (!this.root || !this._partyMembers.some((m) => !m.dto)) return;
        const profile = data?.profile;
        const sharedId =
            profile?.sharableCharacter?.id || profile?.characterSkills?.[0]?.characterID || profile?.character?.id;
        // The member this profile is for, or any member still waiting when the message does not say
        const waiting = () =>
            this._partyMembers.some((m) => !m.dto && (sharedId == null || String(m.characterID) === String(sharedId)));
        if (!waiting()) return;
        const owner = dataManager.getCurrentCharacterId();
        // One wait per member: a share for B must not end the wait for A. Closing the tab clears them all.
        const waitKey = sharedId == null ? '*' : String(sharedId);
        if (!this._profileWaits) this._profileWaits = new Map();
        const ticket = {};
        this._profileWaits.set(waitKey, ticket);
        // A profile not written within a minute is not coming without a new share, and each look rebuilds the party
        const giveUpAt = Date.now() + PROFILE_WAIT_MS;
        const cancelled = () =>
            !this.root ||
            this._profileWaits.get(waitKey) !== ticket ||
            dataManager.getCurrentCharacterId() !== owner ||
            Date.now() >= giveUpAt;
        for (let delay = 100; ; delay = Math.min(delay * 2, 2000)) {
            try {
                await webSocketHook._profileChain;
            } catch {
                /* a failed write is logged where it happens */
            }
            if (cancelled()) return;
            await this._refreshParty();
            if (cancelled() || !waiting()) return;
            await new Promise((resolve) => setTimeout(resolve, delay));
            if (cancelled()) return;
        }
    }

    /**
     * Read your party again: who is in it now, and each other member's build from their cached profile (the same
     * source "Reset to Party" uses). A member with no cached profile gets no build, never an empty one.
     * @returns {Promise<void>}
     * @private
     */
    _refreshParty() {
        const before = this._partyToken;
        const read = this._readParty();
        // The newest read, so a caller that must act on the party as it is now can wait for the last one started.
        // A read started from inside this one (a listener firing) is newer and has already claimed the slot.
        if (this._partyToken === before + 1) this._latestPartyRead = read;
        return read;
    }

    /**
     * One read of the party; see {@link PartyFinderTab#_refreshParty}.
     * @returns {Promise<void>}
     * @private
     */
    async _readParty() {
        const token = ++this._partyToken;
        if (!this.root) return;
        let prefix = '';
        const settle = (members, note) => {
            this._partyMembers = members;
            this._partyNote = prefix + note;
            // The roster rows too: a saved teammate who is also in your party is shown as replaced
            this._renderRoster();
            this._renderPlan();
        };
        if (!this._includeParty) {
            settle([], '');
            return;
        }
        if (this._lockMode.startsWith('saved:')) {
            // A stored pick waits for the saved parties to be read: a party not read yet is not a party deleted
            if (!this._savedLoaded) await this._reloadSaved({ refresh: false });
            // A newer read or write superseded ours and has not landed: it redraws the party when it does
            if (token !== this._partyToken || !this.root || !this._savedLoaded) return;
            const id = this._lockMode.slice('saved:'.length);
            const party = this._saved.parties.find((p) => p.id === id);
            if (party) {
                const { members, skipped } = usableMembers(party);
                const rows = members.map((member, index) => {
                    const memberId = `${PARTY_ENTRY_PREFIX}saved-${party.id}-${index}`;
                    // Saved picks stand until the player changes them this session
                    if (!this._partyChoices.has(memberId)) this._partyChoices.set(memberId, member.choice);
                    if (!this._partyAuras.has(memberId)) {
                        this._partyAuras.set(memberId, { auras: member.auras, includeAsBuilt: member.includeAsBuilt });
                    }
                    return {
                        characterID: `saved-${party.id}-${index}`,
                        characterName: member.name,
                        dto: member.dto,
                        savedParty: party.name,
                    };
                });
                settle(
                    rows,
                    skipped.length
                        ? `${skipped.join(', ')} in "${party.name}" ${skipped.length === 1 ? 'has' : 'have'} a build this version cannot run, so ${skipped.length === 1 ? 'that member is' : 'those members are'} left out.`
                        : ''
                );
                return;
            }
            // Deleted (here or on another device): back to your in-game party. The stored pick is left alone, so a
            // read that failed is not mistaken for a deletion for good
            this._lockMode = 'my';
            // A deletion someone made leaves a tombstone: only then is the stored pick reset, so a failed or
            // missing read never costs the player their pick
            if (this._saved.removed?.[id]) {
                const ownerId = dataManager.getCurrentCharacterId();
                if (ownerId != null) {
                    try {
                        await storage.set(this._includePartyKey(ownerId), true, 'settings');
                    } catch (error) {
                        console.error('[PartyFinder] Could not reset the lock-in pick:', error);
                    }
                    // The player may have picked another party, or switched character, during the write
                    if (token !== this._partyToken || !this.root || dataManager.getCurrentCharacterId() !== ownerId) {
                        return;
                    }
                }
            }
            prefix = 'The saved party you had locked in is gone, so this is your in-game party again. ';
            this._renderLockSelect();
        }
        const owner = dataManager.getCurrentCharacterId();
        // Character data not in yet: an empty party here means "not read", not "no party"
        if (owner == null || !dataManager.characterData) {
            settle([], 'Loading party…');
            return;
        }
        const partyNow = () => dataManager.getPartyMembers?.().members || [];
        const keyOf = (list) => list.map((m) => String(m.characterID)).join(',');
        const all = partyNow();
        const others = all.filter((m) => String(m.characterID) !== String(owner));
        if (!others.length) {
            settle([], 'You are not in a party.');
            return;
        }
        const self = this._resolveSelf();
        if (self && !self.isLive) {
            settle([], 'Your party joins only while "You" is your live character.');
            return;
        }
        let built = null;
        try {
            built = await buildAllPlayerDTOs();
        } catch (error) {
            console.error('[PartyFinder] Could not read your party:', error);
        }
        if (token !== this._partyToken || !this.root || dataManager.getCurrentCharacterId() !== owner) return;
        // The party moved while the profiles were read: the slots no longer line up, read again
        if (keyOf(partyNow()) !== keyOf(all)) {
            await this._refreshParty();
            return;
        }
        const missing = new Set((built?.missingMemberIds || []).map(String));
        const members = [];
        all.forEach((member, index) => {
            if (String(member.characterID) === String(owner)) return;
            const hrid = `player${index + 1}`;
            const ready = !missing.has(String(member.characterID)) && hrid !== built?.selfHrid;
            const dto = ready ? built?.players?.find((p) => p.hrid === hrid) : null;
            const name = (dto && built?.playerInfo?.find((p) => p.hrid === hrid)?.name) || member.characterName;
            let build = null;
            if (dto) {
                // Per-party fields are worked out for each party tried
                build = structuredClone(dto);
                for (const field of ['hrid', 'debuffOnLevelGap', 'taskMonsterHrids', 'taskMonsterRemaining']) {
                    delete build[field];
                }
            }
            members.push({ characterID: member.characterID, characterName: name, dto: build });
        });
        settle(members, '');
    }

    /**
     * Your party as teammates locked into every party, from what is on screen now.
     * @returns {{rows: Array<Object>, entries: Array<Object>, suppressed: Set<string>}}
     * @private
     */
    _partyLock() {
        return planPartyLock({
            members: this._partyMembers,
            savedEntries: this._roster.entries,
            includeParty: this._includeParty,
            neverIds: new Set([...this._partyChoices].filter(([, choice]) => choice === 'never').map(([id]) => id)),
            auraPicks: this._partyAuras,
        });
    }

    /**
     * Try/Always/Never for the plan: the saved roster's picks, and your party's (Always unless changed this session).
     * @param {{entries: Array<{id: string}>}} lock - From {@link PartyFinderTab#_partyLock}
     * @returns {Object<string, string>}
     * @private
     */
    _effectiveChoices(lock) {
        const choices = { ...this._choices };
        for (const entry of lock.entries) choices[entry.id] = this._partyChoices.get(entry.id) || 'always';
        return choices;
    }

    /**
     * Whether anything can join you: a saved teammate, or a party member whose build is loaded.
     * @returns {boolean}
     * @private
     */
    _hasTeammates() {
        return this._roster.entries.length > 0 || this._partyLock().entries.length > 0;
    }

    /** The party rows above the roster, and the line saying why there are none. @private */
    _renderPartyRows() {
        const list = this._el('party-rows');
        const note = this._el('party-note');
        if (!list || !note) return;
        this._renderLockSelect();
        list.textContent = '';
        note.textContent = this._includeParty ? this._partyNote : '';
        for (const row of this._partyLock().rows) {
            const line = document.createElement('div');
            line.dataset.pfPartyMember = row.id;
            line.style.cssText = 'display:flex; gap:6px; align-items:center; font-size:12px;';
            const name = document.createElement('span');
            name.style.cssText = 'flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
            name.textContent = row.savedParty
                ? `${row.name} (saved party: ${row.savedParty})`
                : `${row.name} (in party)`;
            line.appendChild(name);
            if (row.status === 'missing') {
                const why = document.createElement('span');
                why.dataset.pfPartyMissing = '';
                why.style.cssText = 'color:#e0703a; font-size:11px;';
                why.textContent = 'profile not loaded, left out of the runs (open their profile in game)';
                line.appendChild(why);
            } else {
                const choice = document.createElement('select');
                choice.className = 'toolasha-select';
                choice.dataset.pfPartyChoice = row.id;
                choice.style.cssText = INPUT_STYLE + ' font-size:11px; padding:1px 4px;';
                choice.title =
                    'From the party locked in. Always: every party has them. Try: may join a party. Never: left out. ' +
                    'Kept for this session only, not saved to your roster.';
                for (const [value, label] of [
                    ['always', 'Always'],
                    ['try', 'Try'],
                    ['never', 'Never'],
                ]) {
                    const option = document.createElement('option');
                    option.value = value;
                    option.textContent = label;
                    choice.appendChild(option);
                }
                choice.value = this._partyChoices.get(row.id) || 'always';
                choice.addEventListener('change', () => {
                    this._partyChoices.set(row.id, choice.value);
                    // Never hands the run back to a saved teammate of the same name, so its row changes too
                    this._renderRoster();
                    this._renderPlan();
                });
                line.appendChild(choice);
                const auraCount = this._partyAuras.get(row.id)?.auras?.length || 0;
                const auras = document.createElement('button');
                auras.style.cssText = SMALL_BTN_STYLE;
                auras.dataset.pfPartyAuras = row.id;
                auras.textContent = auraCount ? `Auras (${auraCount})` : 'Auras';
                auras.title = 'Aura options to try this party member with (this session only)';
                auras.addEventListener('click', () => {
                    this._partyAuraOpen = this._partyAuraOpen === row.id ? null : row.id;
                    this._renderPartyRows();
                });
                line.appendChild(auras);
                const edit = document.createElement('button');
                edit.style.cssText = SMALL_BTN_STYLE;
                edit.dataset.pfPartyEdit = row.id;
                edit.textContent = 'Edit';
                edit.title = 'Open them on the Configure tab';
                edit.addEventListener('click', () => {
                    const entry = this._partyLock().entries.find((e) => e.id === row.id);
                    if (entry) this._onEditPartyMember(entry);
                });
                line.appendChild(edit);
                if (row.duplicates.length) {
                    const dup = document.createElement('span');
                    dup.style.cssText = 'color:#888; font-size:11px;';
                    dup.textContent = 'replaces the saved teammate of that name';
                    line.appendChild(dup);
                }
            }
            list.appendChild(line);
            if (this._partyAuraOpen === row.id && row.status === 'ready') {
                const entry = this._partyLock().entries.find((e) => e.id === row.id);
                if (entry) list.appendChild(this._partyAuraEditor(entry));
            }
        }
    }

    /**
     * The aura editor for a party member: the roster's editor, kept in memory for this session instead of saved.
     * @param {Object} entry - The party member's entry from {@link PartyFinderTab#_partyLock}
     * @returns {HTMLElement}
     * @private
     */
    _partyAuraEditor(entry) {
        return this._auraEditor(entry, {
            intro:
                'Try this party member with each aura below as well. An aura takes their special ability slot, ' +
                'replacing the special they wear. Kept for this session only.',
            save: async (change) => {
                const held = this._partyAuras.get(entry.id) || { auras: [] };
                const next = change({ ...held, auras: held.auras.map((o) => ({ ...o })) });
                const auras = normalizeAuraOptions(next?.auras);
                if (auras.length > MAX_AURA_OPTIONS) {
                    this._rosterNote(`At most ${MAX_AURA_OPTIONS} aura options, so that one was not added.`, true);
                    return;
                }
                this._partyAuras.set(entry.id, { auras, includeAsBuilt: next?.includeAsBuilt });
                this._renderPartyRows();
                this._renderPlan();
            },
        });
    }

    /**
     * Read the roster back.
     * @param {{pulled?: boolean}} [options] - `pulled`: a sync pull wrote it, so a fold may have dropped entries for
     *   want of room, and only the player's roster on screen can say which
     * @private
     */
    async _reloadRoster({ pulled = false } = {}) {
        const before = this._roster;
        const roster = await loadRoster();
        if (!this.root) return;
        this._roster = roster;
        this._renderRoster();
        if (!pulled) return;
        const { teammates, builds } = evictedByCap(before, roster);
        const parts = [
            teammates.length ? `${MAX_ROSTER_SIZE} teammates kept, ${lostNames(teammates)} dropped` : '',
            builds.length ? `${MAX_SAVED_BUILDS} saved builds kept, ${lostNames(builds)} dropped` : '',
        ].filter(Boolean);
        if (parts.length) {
            this._rosterNote(
                `Sync joined two full lists and kept the most recently changed: ${parts.join('; ')}.`,
                true
            );
        }
    }

    /**
     * Take a roster a write handed back.
     * @param {{ok: boolean, roster: Object}} result
     * @private
     */
    _adoptRoster(result) {
        if (!this.root) return;
        this._roster = result.roster;
        // Choices for teammates no longer there are dropped
        const ids = new Set(this._roster.entries.map((e) => e.id));
        for (const id of Object.keys(this._choices)) if (!ids.has(id)) delete this._choices[id];
        this._renderRoster();
    }

    /** @private */
    _renderRoster() {
        const list = this._el('roster');
        if (!list) return;
        const entries = this._roster.entries;
        this._renderPartyRows();
        this._el('roster-count').textContent = `(${entries.length}/${MAX_ROSTER_SIZE})`;
        list.textContent = '';
        if (!entries.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'color:' + GAME_COLORS.textDim + '; font-size:11px;';
            empty.textContent =
                'No teammates yet. Load someone in the Configure tab (import, a shared profile, your party), ' +
                'then save them here — or copy your own build and edit it.';
            list.appendChild(empty);
        }
        const names = displayNames(entries);
        const suppressed = this._partyLock().suppressed;
        for (const entry of entries) {
            const row = document.createElement('div');
            row.dataset.pfMember = entry.id;
            row.style.cssText = 'display:flex; gap:6px; align-items:center; font-size:12px;';

            const name = document.createElement('span');
            name.dataset.pfName = '';
            name.style.cssText = 'flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
            name.textContent =
                names.get(entry.id) + (suppressed.has(entry.id) ? ' (your party member is used instead)' : '');
            name.title = `Saved from ${entry.source}`;

            const choice = document.createElement('select');
            choice.className = 'toolasha-select';
            choice.dataset.pfChoice = entry.id;
            choice.style.cssText = INPUT_STYLE + ' font-size:11px; padding:1px 4px;';
            choice.title = 'Try: may join a party. Always: every party has them. Never: left out.';
            for (const [value, label] of [
                ['try', 'Try'],
                ['always', 'Always'],
                ['never', 'Never'],
            ]) {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                choice.appendChild(option);
            }
            choice.value = this._choices[entry.id] || 'try';
            choice.disabled = suppressed.has(entry.id);
            choice.addEventListener('change', () => {
                this._choices[entry.id] = choice.value;
                this._renderPlan();
            });

            const button = (label, title, onClick) => {
                const b = document.createElement('button');
                b.style.cssText = SMALL_BTN_STYLE;
                b.textContent = label;
                b.title = title;
                b.addEventListener('click', onClick);
                return b;
            };
            const deleting = this._pendingDelete === entry.id;
            const auraCount = entry.auras?.length || 0;
            row.append(
                name,
                choice,
                button(auraCount ? `Auras (${auraCount})` : 'Auras', 'Aura options to try this teammate with', () => {
                    this._auraOpen = this._auraOpen === entry.id ? null : entry.id;
                    this._renderRoster();
                }),
                button('Edit', 'Load into the editor (Configure tab) to change, then save back here', () =>
                    this._onEditInEditor(entry)
                ),
                button('Rename', 'Rename', () => this._onRename(entry, row, name)),
                button(deleting ? 'Delete?' : '×', deleting ? 'Click again to delete' : 'Delete', () =>
                    this._onDelete(entry)
                )
            );
            if (deleting) row.lastChild.style.color = RED;
            list.appendChild(row);
            if (this._auraOpen === entry.id) list.appendChild(this._auraEditor(entry));
        }
        this._renderBuilds();
        this._renderSavedParties();
        this._renderAddFromEditor();
        this._renderPlan();
    }

    /**
     * @param {string} text
     * @param {boolean} [warn]
     * @private
     */
    _buildNote(text, warn = false) {
        const note = this._el('build-note');
        if (!note) return;
        note.textContent = text || '';
        note.style.color = warn ? '#ff9800' : '#888';
    }

    /**
     * The read-only Templates group above the saved builds: collapsed by default, grouped by role. Templates ship
     * with the script, so nothing here reads or writes the roster record.
     * @private
     */
    _renderTemplates() {
        const box = this._el('templates');
        if (!box) return;
        box.textContent = '';
        const open = this._templatesOpen;
        const head = document.createElement('button');
        head.dataset.pfTemplatesToggle = '';
        head.style.cssText = `${SMALL_BTN_STYLE} width:100%; text-align:left;`;
        head.textContent = `${open ? '▾' : '▸'} Templates (${PARTY_TEMPLATES.length})`;
        head.title = 'Ready-made builds to add as teammates';
        head.addEventListener('click', () => {
            this._templatesOpen = !this._templatesOpen;
            this._renderTemplates();
        });
        box.appendChild(head);
        const match = document.createElement('label');
        match.style.cssText = 'display:flex; gap:6px; align-items:center; font-size:11px; color:#aaa; margin-top:4px;';
        match.title = MATCH_BUILD_HELP;
        const matchBox = document.createElement('input');
        matchBox.type = 'checkbox';
        matchBox.dataset.pfMatchBuild = '';
        matchBox.checked = this._matchBuild;
        matchBox.addEventListener('change', () => {
            this._matchBuild = matchBox.checked;
            this._renderTemplates();
        });
        match.append(matchBox, document.createTextNode('Match my build'));
        box.appendChild(match);
        if (!open) return;
        const body = document.createElement('div');
        body.dataset.pfTemplatesBody = '';
        body.style.cssText = 'display:flex; flex-direction:column; gap:3px; margin-top:4px;';
        for (const group of TEMPLATE_ROLE_GROUPS) {
            const templates = templatesForGroup(group);
            if (!templates.length) continue;
            const title = document.createElement('div');
            title.style.cssText = 'color:#aaa; font-size:11px; font-weight:700; margin-top:2px;';
            title.textContent = group.label;
            body.appendChild(title);
            for (const template of templates) {
                const row = document.createElement('div');
                row.dataset.pfTemplate = template.id;
                row.style.cssText = 'display:flex; gap:6px; align-items:center; font-size:12px;';
                const name = document.createElement('span');
                name.style.cssText =
                    'flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
                name.textContent = template.label;
                const tuned = this._matchBuild ? this._tuned.get(template.id) : null;
                const tunedLine =
                    tuned && tuned.ownerId === dataManager.getCurrentCharacterId() ? this._tunedLine(tuned) : null;
                const add = document.createElement('button');
                add.style.cssText = SMALL_BTN_STYLE;
                add.textContent = 'Add as teammate';
                add.title = `Add a copy to the roster, then set Try/Always/Never and Auras.`;
                add.addEventListener('click', () => this._onAddTemplateAsTeammate(template));
                row.append(name, add);
                body.appendChild(row);
                if (tunedLine) body.appendChild(tunedLine);
            }
        }
        box.appendChild(body);
    }

    /**
     * @param {Object} template - A built-in template
     * @private
     */
    async _onAddTemplateAsTeammate(template) {
        if (this._tuning) {
            this._rosterNote('Still matching a template to your build. One moment.');
            return;
        }
        let dto = structuredClone(template.playerDto);
        let tuned = null;
        if (this._matchBuild) {
            const ownerId = dataManager.getCurrentCharacterId();
            const levels = buildPlayerDTO();
            const token = ++this._matchToken;
            this._tuning = true;
            this._rosterNote('Matching the template to your build…');
            let result = null;
            try {
                result = levels
                    ? await tuneTemplate(template, levels, undefined, {
                          onProgress: ({ phase, done, max }) => {
                              if (token !== this._matchToken || !this.root) return;
                              this._rosterNote(
                                  phase === 'score'
                                      ? 'Waiting for your build score…'
                                      : `Matching the template to your build… ${done}/${max}`
                              );
                          },
                      })
                    : null;
            } catch (error) {
                console.error('[PartyFinder] Matching a template to the build failed:', error);
            } finally {
                // Only the match that owns the flag clears it: a detach or a newer match has already settled it
                if (token === this._matchToken) this._tuning = false;
            }
            // Closed, or superseded: the newer owner (or nobody) answers, and the note is theirs
            if (token !== this._matchToken || !this.root) return;
            if (dataManager.getCurrentCharacterId() !== ownerId) {
                this._rosterNote('');
                return;
            }
            // Turned off while the build was scored: the standard template, as the option now says
            if (result && this._matchBuild) {
                dto = structuredClone(result.dto);
                tuned = {
                    ownerId,
                    status: result.status,
                    clamp: result.clamp || null,
                    k: result.k,
                    template: result.templateScore,
                    own: result.ownScore,
                };
                this._tuned.set(template.id, tuned);
                this._renderTemplates();
            }
        }
        // The template carries shrine levels as an export does; the game's guild buffs are resolved when it is added
        if (template.guildCombatBuffLevels) {
            const { guildShrineLevels, guildCombatBuffs } = guildBuffsFromExportLevels(template.guildCombatBuffLevels);
            dto.guildShrineLevels = guildShrineLevels;
            dto.guildCombatBuffs = guildCombatBuffs;
        }
        const result = await addTeammates([{ name: templateTeammateName(template), dto, source: 'template' }]);
        this._adoptRoster(result);
        this._reportAdd(result, tuned ? ` ${tunedText(tuned)}` : '');
    }

    /**
     * The score line under a tuned template's row.
     * @param {{status: string}} tuned
     * @returns {HTMLElement}
     * @private
     */
    _tunedLine(tuned) {
        const line = document.createElement('div');
        line.dataset.pfTemplateScore = '';
        line.style.cssText = `font-size:11px; margin:0 0 2px 12px; color:${tuned.status === 'ok' ? '#888' : '#ff9800'};`;
        line.textContent = tunedText(tuned);
        return line;
    }

    /** The saved builds list. @private */
    _renderBuilds() {
        this._renderTemplates();
        const list = this._el('builds');
        if (!list) return;
        const builds = this._roster.builds || [];
        this._el('build-count').textContent = `(${builds.length}/${MAX_SAVED_BUILDS})`;
        list.textContent = '';
        if (!builds.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'color:' + GAME_COLORS.textDim + '; font-size:11px;';
            empty.textContent =
                'No saved builds. "Save build…" keeps your current build, or any player in the editor, under a name.';
            list.appendChild(empty);
        }
        for (const build of builds) {
            const row = document.createElement('div');
            row.dataset.pfBuild = build.id;
            row.style.cssText = 'display:flex; gap:6px; align-items:center; font-size:12px;';
            const name = document.createElement('span');
            name.dataset.pfBuildName = '';
            name.style.cssText = 'flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
            name.textContent = build.name;
            const button = (label, title, onClick) => {
                const b = document.createElement('button');
                b.style.cssText = SMALL_BTN_STYLE;
                b.textContent = label;
                b.title = title;
                b.addEventListener('click', onClick);
                return b;
            };
            const deleting = this._pendingDelete === build.id;
            row.append(
                name,
                button(
                    'Add as teammate',
                    'Add a copy of this build to the roster, then set Try/Always/Never and Auras',
                    () => this._onAddBuildAsTeammate(build)
                ),
                button('Rename', 'Rename', () => this._onRename(build, row, name, renameBuild, '_buildNote')),
                button(deleting ? 'Delete?' : '×', deleting ? 'Click again to delete' : 'Delete', () =>
                    this._onDelete(build, removeBuild, '_buildNote')
                )
            );
            if (deleting) row.lastChild.style.color = RED;
            list.appendChild(row);
        }
    }

    /** Show the save form, with the sources of a build to save. @private */
    _openSaveBuild() {
        const form = this._el('save-build-form');
        if (!form) return;
        this._renderBuildSources();
        form.style.display = 'flex';
        this._el('build-name').focus();
    }

    /** @private */
    _renderBuildSources() {
        const select = this._el('build-source');
        if (!select) return;
        const prior = select.value;
        const options = this._selfOptions();
        select.innerHTML = options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
        select.value = options.some((o) => o.value === prior) ? prior : options[0]?.value || '';
        this._defaultBuildName();
    }

    /** Name the build after its player until the user types a name of their own. @private */
    _defaultBuildName() {
        const input = this._el('build-name');
        const select = this._el('build-source');
        if (!input || !select) return;
        const option = this._selfOptions().find((o) => o.value === select.value);
        if (!input.value || input.dataset.pfAuto === '1') {
            input.value = option?.name || '';
            input.dataset.pfAuto = '1';
        }
        if (!input.dataset.pfBound) {
            input.dataset.pfBound = '1';
            input.addEventListener('input', () => {
                input.dataset.pfAuto = '0';
            });
        }
    }

    /** @private */
    async _onSaveBuild() {
        const choice = this._el('build-source')?.value || 'live';
        const who = this._resolveChoice(choice);
        if (!who) {
            this._buildNote('No character data available.', true);
            return;
        }
        const typed = this._el('build-name')?.value || '';
        const result = await saveBuild(typed || who.name, who.dto, who.gameMode);
        this._adoptRoster(result);
        if (!result.ok) {
            this._buildNote(
                result.reason
                    ? `Not saved: ${result.reason}.`
                    : 'Could not save the build: the roster could not be written.',
                true
            );
            return;
        }
        this._buildNote(
            result.name === typed.trim() || !typed.trim()
                ? `Saved "${result.name}".`
                : `Saved as "${result.name}" (that name was taken).`
        );
        const input = this._el('build-name');
        if (input) {
            input.value = '';
            input.dataset.pfAuto = '1';
        }
        const form = this._el('save-build-form');
        if (form) form.style.display = 'none';
    }

    /**
     * @param {Object} build - A saved build
     * @private
     */
    async _onAddBuildAsTeammate(build) {
        const result = await addTeammates([
            { name: build.name, dto: build.dto, source: 'saved build', gameMode: build.gameMode || undefined },
        ]);
        this._adoptRoster(result);
        this._reportAdd(result);
    }

    // ---------------------------------------------------------------- saved parties

    /**
     * @param {string} text
     * @param {boolean} [warn]
     * @private
     */
    _savedPartyNote(text, warn = false) {
        const note = this._el('saved-party-note');
        if (!note) return;
        note.textContent = text || '';
        note.style.color = warn ? '#ff9800' : '#888';
    }

    /**
     * Read the saved parties back.
     * @param {{pulled?: boolean, refresh?: boolean}} [options] - `pulled`: a sync pull wrote them, so a fold may have
     *   dropped some for want of room; `refresh: false`: the caller is the party refresh itself
     * @private
     */
    async _reloadSaved({ pulled = false, refresh = true } = {}) {
        const before = this._saved;
        const seq = ++this._savedSeq;
        const saved = await loadSavedParties();
        // A newer read, or a write that handed back the list, is fresher than this one
        if (!this.root || seq !== this._savedSeq) return;
        this._saved = saved;
        this._savedLoaded = true;
        this._renderSavedParties();
        this._renderLockSelect();
        if (refresh && this._lockMode.startsWith('saved:')) this._refreshParty();
        if (!pulled) return;
        const lost = evictedPartiesByCap(before, saved);
        if (lost.length) {
            this._savedPartyNote(
                `Sync joined two full lists and kept the ${MAX_SAVED_PARTIES} most recently changed: ${lostNames(lost)} dropped.`,
                true
            );
        }
    }

    /**
     * Take the saved parties a write handed back.
     * @param {{ok: boolean, saved: Object, duplicate?: boolean}} result
     * @private
     */
    _adoptSaved(result) {
        if (!this.root) return;
        this._savedSeq++;
        this._saved = result.saved;
        this._savedLoaded = true;
        this._renderSavedParties();
        this._renderLockSelect();
        // The party locked in may be the one just renamed (its label) or deleted (back to your party)
        if (this._lockMode.startsWith('saved:')) this._refreshParty();
    }

    /** The saved parties list. @private */
    _renderSavedParties() {
        const list = this._el('saved-parties');
        if (!list) return;
        const parties = this._saved.parties;
        this._el('party-saved-count').textContent = `(${parties.length}/${MAX_SAVED_PARTIES})`;
        list.textContent = '';
        if (!parties.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'color:' + GAME_COLORS.textDim + '; font-size:11px;';
            empty.textContent =
                'No saved parties. Load a party in the editor (Reset to Party), then "Save party…" keeps it under a name.';
            list.appendChild(empty);
        }
        for (const party of parties) {
            const row = document.createElement('div');
            row.dataset.pfSavedParty = party.id;
            row.style.cssText = 'display:flex; gap:6px; align-items:center; font-size:12px; flex-wrap:wrap;';
            const name = document.createElement('span');
            name.dataset.pfSavedPartyName = '';
            name.style.cssText = 'flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
            const { members, skipped } = usableMembers(party);
            const who = [...members.map((m) => m.name), ...skipped.map((n) => `${n} (cannot be loaded)`)].join(', ');
            name.textContent = party.name;
            const memberLine = document.createElement('span');
            memberLine.dataset.pfSavedPartyMembers = '';
            memberLine.style.cssText = `color:${GAME_COLORS.textDim}; font-size:11px; flex-basis:100%; order:5;`;
            memberLine.textContent = who || 'no members';
            const button = (label, title, onClick) => {
                const b = document.createElement('button');
                b.style.cssText = SMALL_BTN_STYLE;
                b.textContent = label;
                b.title = title;
                b.addEventListener('click', onClick);
                return b;
            };
            const deleting = this._pendingDelete === party.id;
            const locked = this._lockMode === `saved:${party.id}`;
            const adopt = (result) => {
                this._adoptSaved(result);
                if (result.duplicate) this._savedPartyNote('Another saved party has that name too.');
            };
            const lockButton = button(
                locked ? 'Locked in' : 'Lock in',
                'Lock these members into every party tried, in place of your in-game party',
                () => this._onLockMode(`saved:${party.id}`)
            );
            lockButton.disabled = locked;
            row.append(
                name,
                lockButton,
                button('Load in editor', 'Put you and these members in the editor (Configure tab)', () =>
                    this._loadSavedPartyInEditor(party)
                ),
                button('Rename', 'Rename', () =>
                    this._onRename(party, row, name, renameParty, '_savedPartyNote', adopt)
                ),
                button(deleting ? 'Delete?' : '×', deleting ? 'Click again to delete' : 'Delete', () =>
                    this._onDelete(party, removeParty, '_savedPartyNote', adopt)
                ),
                memberLine
            );
            if (deleting) row.children[4].style.color = RED;
            list.appendChild(row);
        }
    }

    /**
     * The players the editor holds besides you, as saved-party members with the picks this tab holds for any that
     * is also a row in the party locked in (matched by name).
     * @returns {{members: Array<Object>, count: number}}
     * @private
     */
    _partyDraft() {
        const editor = this.host?._editor;
        const players = this._editorPlayers();
        let selfHrid = editor?.getSelfHrid?.() || null;
        const picked = this._el('self')?.value || '';
        if (!selfHrid && picked.startsWith('editor:')) selfHrid = picked.slice('editor:'.length);
        const others = players.filter((p) => p.hrid !== selfHrid);
        const rows = this._partyLock().rows;
        const members = others.map((player) => {
            const row = rows.find((r) => sameDisplayName(r.name, player.name));
            const picks = row ? this._partyAuras.get(row.id) : null;
            return {
                name: player.name,
                dto: player.dto,
                choice: (row && this._partyChoices.get(row.id)) || 'always',
                auras: picks?.auras || [],
                includeAsBuilt: picks ? picks.includeAsBuilt !== false : true,
                gameMode: this._editorPlayerMode(player),
            };
        });
        return { members, count: players.length };
    }

    /** Show the name form, filled with the members' names until the player types their own. @private */
    _openSaveParty() {
        const form = this._el('save-party-form');
        if (!form) return;
        const { members, count } = this._partyDraft();
        if (!count) {
            this._savedPartyNote('Nobody is loaded in the editor. Load a party on the Configure tab first.', true);
            return;
        }
        if (!members.length) {
            this._savedPartyNote('Only you are in the editor, so there is no party to save.', true);
            return;
        }
        const input = this._el('party-name');
        if (input && !input.value)
            input.value = members
                .map((m) => m.name)
                .join(', ')
                .slice(0, 40);
        form.style.display = 'flex';
        input?.focus();
    }

    /** @private */
    async _onSaveParty() {
        if (this._savingParty) return;
        this._savingParty = true;
        try {
            await this._saveParty();
        } finally {
            this._savingParty = false;
        }
    }

    /** @private */
    async _saveParty() {
        const { members, count } = this._partyDraft();
        if (!count) {
            this._savedPartyNote('Nobody is loaded in the editor. Load a party on the Configure tab first.', true);
            return;
        }
        if (!members.length) {
            this._savedPartyNote('Only you are in the editor, so there is no party to save.', true);
            return;
        }
        if (members.length > MAX_PARTY_MEMBERS) {
            this._savedPartyNote(
                `A party holds at most ${MAX_PARTY_MEMBERS} besides you, and the editor holds ${members.length} other players.`,
                true
            );
            return;
        }
        const typed = this._el('party-name')?.value || '';
        const result = await saveParty(typed, members);
        this._adoptSaved(result);
        const skippedText = result.skipped.length
            ? ` ${result.skipped.map((s) => `${s.name} was left out (${s.reason})`).join('; ')}.`
            : '';
        if (!result.ok) {
            this._savedPartyNote(
                result.reason
                    ? `Not saved: ${result.reason}.${skippedText}`
                    : 'Could not save the party: the list could not be written.',
                true
            );
            return;
        }
        this._savedPartyNote(
            `Saved "${result.name}"${result.duplicate ? ' (another saved party already has that name)' : ''}.${skippedText}`,
            result.duplicate || result.skipped.length > 0
        );
        const input = this._el('party-name');
        if (input) input.value = '';
        const form = this._el('save-party-form');
        if (form) form.style.display = 'none';
    }

    /**
     * Put you (live) and a saved party's members in the editor, and show the Configure tab.
     * @param {Object} party - A saved party
     * @returns {boolean} Whether it was loaded
     * @private
     */
    _loadSavedPartyInEditor(party) {
        const editor = this.host?._editor;
        if (!editor?.loadParty) return false;
        const { members, skipped } = usableMembers(party);
        if (!members.length) {
            this._savedPartyNote(`"${party.name}" has no member this version can load.`, true);
            return false;
        }
        if (1 + members.length > DUNGEON_MAX_PARTY) {
            this._savedPartyNote(
                `"${party.name}" and you would be more than ${DUNGEON_MAX_PARTY} players, more than the editor holds.`,
                true
            );
            return false;
        }
        const self = this._resolveChoice('live');
        if (!self) {
            this._savedPartyNote('No character data available.', true);
            return false;
        }
        editor.loadParty(
            [self.dto, ...members.map((m) => this._withAssumedMode(structuredClone(m.dto)))],
            [self.name, ...members.map((m) => m.name)],
            { selfIsLive: true, note: `From the saved party "${party.name}"` }
        );
        this._savedPartyNote(
            `Loaded "${party.name}" into the editor.${skipped.length ? ` ${skipped.join(', ')} could not be loaded.` : ''}`,
            skipped.length > 0
        );
        this.host._switchTab?.('configure');
        return true;
    }

    /**
     * Every special-slot ability the game data knows, by name (the party auras plus Insanity, Invincible,
     * Revive; not monster-only Promote), read from `isPlayerSpecialAbility`, never a list kept here.
     * @param {Object|null} gameData
     * @returns {Array<{hrid: string, name: string}>}
     * @private
     */
    _auraAbilities(gameData) {
        return (
            Object.entries(gameData?.abilityDetailMap || {})
                // Every special-slot ability a player can learn, not only the party auras
                .filter(([hrid]) => isPlayerSpecialAbility(hrid, gameData))
                .map(([hrid, detail]) => ({ hrid, name: detail.name || hrid }))
                .sort((a, b) => a.name.localeCompare(b.name))
        );
    }

    /**
     * The aura options editor under one teammate's row.
     * @param {Object} entry - Roster entry (or, for you, `{id: 'self', dto, auras}`)
     * @param {{save: Function, intro: string, hideAsBuilt: boolean}} [custom] - For anyone but a roster teammate:
     *   how a change is stored, what the editor says, and whether "also try as built" is offered (you as worn
     *   are always tried)
     * @returns {HTMLElement}
     * @private
     */
    _auraEditor(entry, custom = null) {
        const gameData = buildGameDataPayload();
        const maxLevel = maxAbilityLevel(gameData);
        const box = document.createElement('div');
        box.dataset.pfAuras = entry.id;
        box.style.cssText =
            'margin:2px 0 6px 12px; padding:6px; border-left:2px solid #333; display:flex; flex-direction:column; gap:4px; font-size:11px;';

        const intro = document.createElement('div');
        intro.style.color = '#888';
        intro.textContent =
            custom?.intro ||
            'Try this teammate with each aura below as well. An aura takes their special ability slot, ' +
                'replacing the special they wear.';
        box.appendChild(intro);

        // Every edit is a change to the list as stored when it is written, not to the copy this editor was drawn
        // from: another tab (or a pull) may have changed it since
        const save = async (change) => {
            if (custom?.save) {
                await custom.save(change);
                return;
            }
            const result = await setTeammateAuras(entry.id, change);
            this._adoptRoster(result);
            if (!result.ok) this._rosterNote('Could not save the aura options.', true);
            else if (!result.found) this._rosterNote('That teammate is gone (deleted elsewhere?).', true);
            else if (result.capped) {
                this._rosterNote(`At most ${MAX_AURA_OPTIONS} aura options, so that one was not added.`, true);
            }
        };

        const current = entry.dto?.abilities?.[0]?.hrid;
        if (current && gameData?.abilityDetailMap?.[current]) {
            const wears = document.createElement('div');
            wears.style.color = GAME_COLORS.textDim;
            wears.textContent = `As built: ${gameData.abilityDetailMap[current].name || current} ${entry.dto.abilities[0].level || ''}`;
            box.appendChild(wears);
        }

        entry.auras.forEach((option) => {
            const line = document.createElement('div');
            line.dataset.pfAuraOption = option.hrid;
            line.style.cssText = 'display:flex; gap:6px; align-items:center;';
            const check = checkAuraOption(option, gameData);
            const label = document.createElement('span');
            label.style.cssText = `flex:1; color:${check.ok ? '#ccc' : RED};`;
            label.textContent = check.ok ? check.name : `${check.name} (${check.reason}; skipped)`;
            const level = document.createElement('input');
            level.type = 'number';
            level.min = '1';
            level.max = String(maxLevel);
            level.value = String(option.level);
            level.style.cssText = INPUT_STYLE + ' width:52px; font-size:11px; padding:1px 4px;';
            level.addEventListener('change', () => {
                const value = Math.floor(Number(level.value));
                if (!(value >= 1 && value <= maxLevel)) {
                    this._rosterNote(`Aura level must be 1-${maxLevel}.`, true);
                    level.value = String(option.level);
                    return;
                }
                save((stored) => ({
                    ...stored,
                    auras: stored.auras.map((o) => (o.hrid === option.hrid ? { ...o, level: value } : o)),
                }));
            });
            const remove = document.createElement('button');
            remove.style.cssText = SMALL_BTN_STYLE;
            remove.textContent = '×';
            remove.title = 'Remove this aura option';
            remove.addEventListener('click', () =>
                save((stored) => ({ ...stored, auras: stored.auras.filter((o) => o.hrid !== option.hrid) }))
            );
            line.append(label, document.createTextNode('Lv'), level, remove);
            box.appendChild(line);
        });

        const auras = this._auraAbilities(gameData);
        const add = document.createElement('div');
        add.style.cssText = 'display:flex; gap:6px; align-items:center; flex-wrap:wrap;';
        if (!auras.length) {
            const none = document.createElement('span');
            none.style.color = GAME_COLORS.textDim;
            none.textContent = 'No auras in the game data yet.';
            add.appendChild(none);
        } else if (entry.auras.length >= MAX_AURA_OPTIONS) {
            const full = document.createElement('span');
            full.style.color = GAME_COLORS.textDim;
            full.textContent = `At most ${MAX_AURA_OPTIONS} aura options.`;
            add.appendChild(full);
        } else {
            const select = document.createElement('select');
            select.className = 'toolasha-select';
            select.dataset.pfAuraPick = entry.id;
            select.style.cssText = INPUT_STYLE + ' font-size:11px; padding:1px 4px;';
            for (const aura of auras) {
                const option = document.createElement('option');
                option.value = aura.hrid;
                option.textContent = aura.name;
                select.appendChild(option);
            }
            const level = document.createElement('input');
            level.type = 'number';
            level.min = '1';
            level.max = String(maxLevel);
            level.dataset.pfAuraLevel = entry.id;
            level.value = String(entry.dto?.abilities?.[0]?.level || 1);
            level.style.cssText = INPUT_STYLE + ' width:52px; font-size:11px; padding:1px 4px;';
            const button = document.createElement('button');
            button.style.cssText = SMALL_BTN_STYLE;
            button.dataset.pfAuraAdd = entry.id;
            button.textContent = 'Add aura';
            button.addEventListener('click', () => {
                const value = Math.floor(Number(level.value));
                if (!(value >= 1 && value <= maxLevel)) {
                    this._rosterNote(`Aura level must be 1-${maxLevel}.`, true);
                    return;
                }
                const hrid = select.value;
                save((stored) => ({
                    ...stored,
                    auras: [...stored.auras.filter((o) => o.hrid !== hrid), { hrid, level: value }],
                }));
            });
            add.append(select, document.createTextNode('Lv'), level, button);
        }
        box.appendChild(add);

        const asBuilt = document.createElement('label');
        asBuilt.style.cssText = 'display:flex; gap:4px; align-items:center; color:#aaa;';
        const tick = document.createElement('input');
        tick.type = 'checkbox';
        tick.dataset.pfAsBuilt = entry.id;
        tick.checked = entry.includeAsBuilt !== false;
        tick.disabled = !entry.auras.length;
        tick.addEventListener('change', () => save((stored) => ({ ...stored, includeAsBuilt: tick.checked })));
        asBuilt.append(tick, document.createTextNode('Also try them as built'));
        if (!custom?.hideAsBuilt) box.appendChild(asBuilt);
        return box;
    }

    /** @private */
    _editorPlayers() {
        const editor = this.host?._editor;
        if (!editor?.isInitialized?.()) return [];
        const dtos = editor.getEditedDTOs?.() || {};
        return (editor.getPlayerInfo?.() || []).filter((p) => dtos[p.hrid]).map((p) => ({ ...p, dto: dtos[p.hrid] }));
    }

    /** @private */
    _renderAddFromEditor() {
        const playerSelect = this._el('editor-player');
        const targetSelect = this._el('editor-target');
        if (!playerSelect || !targetSelect) return;
        const players = this._editorPlayers();
        const prior = playerSelect.value;
        playerSelect.innerHTML = players.length
            ? players.map((p) => `<option value="${esc(p.hrid)}">${esc(p.name)}</option>`).join('')
            : '<option value="">(no one loaded)</option>';
        if (players.some((p) => p.hrid === prior)) playerSelect.value = prior;
        const names = displayNames(this._roster.entries);
        const priorTarget = targetSelect.value;
        targetSelect.innerHTML =
            '<option value="">as a new teammate</option>' +
            this._roster.entries
                .map((e) => `<option value="${esc(e.id)}">replacing ${esc(names.get(e.id))}</option>`)
                .join('');
        if (this._roster.entries.some((e) => e.id === priorTarget)) targetSelect.value = priorTarget;
    }

    /** @private */
    async _onAddFromEditor() {
        const hrid = this._el('editor-player')?.value;
        const player = this._editorPlayers().find((p) => p.hrid === hrid);
        if (!player) {
            this._rosterNote('Nobody is loaded in the editor. Load a player on the Configure tab first.', true);
            return;
        }
        const target = this._el('editor-target')?.value;
        if (target) {
            const result = await replaceTeammateBuild(target, player.dto, this._editorPlayerMode(player));
            this._adoptRoster(result);
            this._rosterNote(
                !result.ok
                    ? `Could not save: ${result.reason || 'the roster could not be written'}.`
                    : result.found
                      ? `Saved ${player.name}'s build over that teammate.`
                      : 'That teammate is gone (deleted elsewhere?). Nothing saved.',
                !result.ok || !result.found
            );
            return;
        }
        const result = await addTeammates([
            { name: player.name, dto: player.dto, source: 'editor', gameMode: this._editorPlayerMode(player) },
        ]);
        this._adoptRoster(result);
        this._reportAdd(result);
    }

    /** @private */
    async _onCopySelf() {
        const dto = buildPlayerDTO();
        if (!dto) {
            this._rosterNote('No character data available.', true);
            return;
        }
        const name = `${dataManager.characterData?.character?.name || 'Me'} (copy)`;
        const result = await addTeammates([
            { name, dto, source: 'your build', gameMode: dataManager.getCurrentCharacterGameMode?.() || undefined },
        ]);
        this._adoptRoster(result);
        this._reportAdd(result);
    }

    /** @private */
    async _onImport() {
        const text = this._el('import-text')?.value?.trim();
        if (!text) {
            this._rosterNote('Paste a sim export first.', true);
            return;
        }
        let parsed = null;
        try {
            parsed = parseShykaiImport(text);
        } catch (error) {
            console.error('[PartyFinder] Import failed:', error);
        }
        if (!parsed?.players?.length) {
            this._rosterNote('That text is not a sim export this can read.', true);
            return;
        }
        const result = await addTeammates(
            parsed.players.map((dto, i) => ({ name: parsed.names?.[i] || `Imported ${i + 1}`, dto, source: 'import' }))
        );
        this._adoptRoster(result);
        this._reportAdd(
            result,
            parsed.skipped?.length ? ` ${parsed.skipped.length} gear item(s) could not be placed.` : ''
        );
        if (result.ok && result.added.length) this._el('import-text').value = '';
    }

    /**
     * @param {{ok: boolean, added: Array, rejected: Array}} result
     * @param {string} [extra]
     * @private
     */
    _reportAdd(result, extra = '') {
        if (!result.ok) {
            this._rosterNote('Could not save the roster. Nothing was added.', true);
            return;
        }
        const parts = [];
        if (result.added.length) parts.push(`Added ${result.added.length}.`);
        for (const r of result.rejected) parts.push(`${r.name} not added: ${r.reason}.`);
        this._rosterNote(parts.join(' ') + extra, result.rejected.length > 0);
    }

    /**
     * @param {Object} entry
     * @private
     */
    _onEditInEditor(entry) {
        const editor = this.host?._editor;
        if (!editor) return;
        if ((editor.playerCount?.() || 0) >= DUNGEON_MAX_PARTY) {
            this._rosterNote('The editor already holds 5 players. Remove one on the Configure tab first.', true);
            return;
        }
        if (!editor.isInitialized?.()) editor.resetToSelf?.();
        const dto = structuredClone(entry.dto);
        // Taken to be of the live character's mode, whatever was saved with it
        editor.importPlayers([this._withAssumedMode(dto)], [entry.name]);
        this._rosterNote(`${entry.name} is in the editor. Change them there, then save back here with "replacing".`);
        this.host._switchTab?.('configure');
    }

    /**
     * Open a party member on the Configure tab: their tab if the editor already holds them (Reset to Party puts them
     * there), else a copy of the build this tab uses for them. The party row keeps using their live build.
     * @param {Object} entry - The party member's entry from {@link PartyFinderTab#_partyLock}
     * @private
     */
    _onEditPartyMember(entry) {
        const editor = this.host?._editor;
        if (!editor) return;
        const tip =
            'The party search keeps using their live build; to try your changes, save them back here as a new ' +
            'teammate.';
        const held = (editor.isInitialized?.() ? editor.getPlayerInfo?.() || [] : []).find(
            (p) =>
                String(p?.name || '')
                    .trim()
                    .toLowerCase() === entry.name.trim().toLowerCase()
        );
        if (held && editor.showPlayer?.(held.hrid)) {
            this._rosterNote(`${entry.name} is open on the Configure tab. ${tip}`);
            this.host._switchTab?.('configure');
            return;
        }
        if ((editor.playerCount?.() || 0) >= DUNGEON_MAX_PARTY) {
            this._rosterNote('The editor already holds 5 players. Remove one on the Configure tab first.', true);
            return;
        }
        if (!editor.isInitialized?.()) editor.resetToSelf?.();
        editor.importPlayers([this._withAssumedMode(structuredClone(entry.dto))], [entry.name]);
        this._rosterNote(`${entry.name} is in the editor. ${tip}`);
        this.host._switchTab?.('configure');
    }

    /**
     * @param {Object} entry - A teammate, or a saved build
     * @param {HTMLElement} row
     * @param {HTMLElement} nameEl
     * @param {Function} [rename] - `renameTeammate`, or `renameBuild` for a saved build
     * @param {string} [note] - The note method that reports a failure
     * @private
     */
    _onRename(entry, row, nameEl, rename = renameTeammate, note = '_rosterNote', adopt = null) {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = entry.name;
        input.style.cssText = INPUT_STYLE + ' flex:1; min-width:0;';
        nameEl.replaceWith(input);
        input.focus();
        let done = false;
        const commit = async (save) => {
            if (done) return;
            done = true;
            if (!save || !input.value.trim() || input.value.trim() === entry.name) {
                this._renderRoster();
                return;
            }
            const result = await rename(entry.id, input.value);
            if (adopt) adopt(result);
            else this._adoptRoster(result);
            if (!result.ok) this[note]('Could not save the new name.', true);
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') commit(true);
            else if (e.key === 'Escape') commit(false);
        });
        input.addEventListener('blur', () => commit(true));
    }

    /**
     * @param {Object} entry - A teammate, or a saved build
     * @param {Function} [remove] - `removeTeammate`, or `removeBuild` for a saved build
     * @param {string} [note] - The note method that reports a failure
     * @private
     */
    async _onDelete(entry, remove = removeTeammate, note = '_rosterNote', adopt = null) {
        if (this._pendingDelete !== entry.id) {
            this._pendingDelete = entry.id;
            clearTimeout(this._pendingDeleteTimer);
            this._pendingDeleteTimer = setTimeout(() => {
                this._pendingDelete = null;
                this._renderRoster();
            }, 3000);
            this._renderRoster();
            return;
        }
        this._pendingDelete = null;
        clearTimeout(this._pendingDeleteTimer);
        const result = await remove(entry.id);
        if (adopt) adopt(result);
        else this._adoptRoster(result);
        if (!result.ok) this[note]('Could not delete: the list could not be written.', true);
    }

    // ---------------------------------------------------------------- you

    /**
     * Who "you" can be: your live build, or any player loaded in the editor (the editor's own you first).
     * @returns {Array<{value: string, label: string}>}
     * @private
     */
    _selfOptions() {
        const editor = this.host?._editor;
        const selfHrid = editor?.isInitialized?.() ? editor.getSelfHrid?.() : null;
        const options = [];
        const players = this._editorPlayers();
        const self = players.find((p) => p.hrid === selfHrid);
        if (self)
            options.push({ value: `editor:${self.hrid}`, label: `${self.name} (as in the editor)`, name: self.name });
        options.push({
            value: 'live',
            label: 'My current build',
            name: dataManager.characterData?.character?.name || 'Me',
        });
        for (const p of players) {
            if (p.hrid !== selfHrid) {
                options.push({ value: `editor:${p.hrid}`, label: `${p.name} (from the editor)`, name: p.name });
            }
        }
        return options;
    }

    /**
     * The auras the search tries YOU with, when "Also try my auras" is on: every aura the live character has
     * learned (at its level), or for an editor-loaded player whose learned abilities are unknown the ones picked by
     * hand in {@link PartyFinderTab#_renderSelfAuras}.
     * @param {Object|null} gameData
     * @returns {{on: boolean, auras: Array<{hrid: string, level: number}>, dto: Object|null, manual: boolean,
     *   key: string, self: Object|null}}
     * @private
     */
    _selfAuraInfo(gameData) {
        const key = this._el('self')?.value || 'live';
        const none = { on: this._trySelfAuras, auras: [], dto: null, manual: false, key, self: null };
        if (!this._trySelfAuras) return none;
        const self = this._resolveSelf();
        if (!self) return none;
        if (self.isLive) {
            const details = gameData?.abilityDetailMap || {};
            const auras = (dataManager.characterData?.characterAbilities || [])
                .filter((a) => a?.abilityHrid && details[a.abilityHrid]?.isSpecialAbility === true)
                .map((a) => ({ hrid: a.abilityHrid, level: Math.max(1, Math.floor(Number(a.level)) || 1) }));
            return { ...none, auras, dto: self.dto, self };
        }
        // Picks belong to the build, not the picker slot: another build loaded into the same editor slot, or
        // another character, starts from none
        const pickKey = buildFingerprint(self.dto);
        return {
            ...none,
            key: pickKey,
            auras: this._selfAuraPicks.get(pickKey) || [],
            dto: self.dto,
            manual: true,
            self,
        };
    }

    /** The switch, what it will try, and for a player not the live character the by-hand aura list. @private */
    _renderSelfAuras() {
        const tick = this._el('self-auras');
        const info = this._el('self-aura-info');
        const edit = this._el('self-aura-edit');
        const holder = this._el('self-aura-editor');
        if (!tick || !info || !edit || !holder) return;
        tick.checked = this._trySelfAuras;
        holder.textContent = '';
        edit.style.display = 'none';
        info.textContent = '';
        if (!this._trySelfAuras) return;
        const gameData = buildGameDataPayload();
        const state = this._selfAuraInfo(gameData);
        if (!state.manual) {
            info.textContent = state.auras.length
                ? `${state.auras.length} aura${state.auras.length === 1 ? '' : 's'} you own`
                : 'no auras learned yet';
            return;
        }
        const count = state.auras.length;
        info.textContent = 'What this player owns is unknown: pick the auras to try.';
        edit.style.display = '';
        edit.textContent = count ? `You — Auras (${count}) ${this._selfAuraOpen ? 'Close' : 'Edit'}` : 'You — Auras';
        if (!this._selfAuraOpen) return;
        const key = state.key;
        holder.appendChild(
            this._auraEditor(
                { id: 'self', dto: state.dto, auras: state.auras, includeAsBuilt: true },
                {
                    intro:
                        'Try you with each aura below as well, alone and in every party. An aura takes your ' +
                        'special ability slot, replacing the special you wear; you as built are always tried.',
                    hideAsBuilt: true,
                    save: async (change) => {
                        const next = change({ auras: (this._selfAuraPicks.get(key) || []).map((o) => ({ ...o })) });
                        this._selfAuraPicks.set(key, normalizeAuraOptions(next?.auras));
                        this._renderSelfAuras();
                        this._renderPlan();
                    },
                }
            )
        );
    }

    /** @private */
    _renderSelfPicker() {
        const select = this._el('self');
        if (!select) return;
        const prior = select.value;
        const options = this._selfOptions();
        select.innerHTML = options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
        if (options.some((o) => o.value === prior)) select.value = prior;
        if (this._el('save-build-form')?.style.display !== 'none') this._renderBuildSources();
        if (!select.dataset.pfModeBound) {
            select.dataset.pfModeBound = '1';
            // Who "you" are decides which teammates can party with you
            select.addEventListener('change', () => {
                this._selfAuraOpen = false;
                this._renderSelfAuras();
                this._renderRoster();
                this._refreshParty();
            });
        }
        this._renderSelfAuras();
    }

    /**
     * The game mode every teammate and template is taken to have: the live character's own. The game parties only
     * characters of one mode, so a teammate's stored mode is never read to include or leave anyone out or to price
     * them.
     * @returns {string|undefined}
     * @private
     */
    _assumedMode() {
        return dataManager.getCurrentCharacterGameMode?.() || undefined;
    }

    /**
     * A copy of a teammate's build carrying the assumed game mode in place of any other it came with, so whatever
     * prices or taxes them later reads the live character's mode.
     * @param {Object} dto
     * @returns {Object}
     * @private
     */
    _withAssumedMode(dto) {
        const copy = { ...dto };
        const mode = this._assumedMode();
        if (mode) copy.gameMode = mode;
        else delete copy.gameMode;
        return copy;
    }

    /**
     * The game mode a player loaded in the editor is saved with: the one their build carries, else the live
     * character's when it is the live character.
     * @param {{hrid: string, dto: Object}} player
     * @returns {string|undefined}
     * @private
     */
    _editorPlayerMode(player) {
        if (player.dto?.gameMode) return player.dto.gameMode;
        const isSelf = player.hrid === this.host?._editor?.getSelfHrid?.();
        return (isSelf && dataManager.getCurrentCharacterGameMode?.()) || undefined;
    }

    /**
     * The build to sim as you, read now.
     * @returns {{dto: Object, name: string, isLive: boolean}|null}
     * @private
     */
    _resolveSelf() {
        return this._resolveChoice(this._el('self')?.value || 'live');
    }

    /**
     * A build named by a picker value (`live`, or `editor:<hrid>`), read now; a player gone from the editor reads
     * as the live build.
     * @param {string} choice
     * @returns {{dto: Object, name: string, isLive: boolean, gameMode: string|undefined}|null}
     * @private
     */
    _resolveChoice(choice) {
        if (choice.startsWith('editor:')) {
            const hrid = choice.slice('editor:'.length);
            const player = this._editorPlayers().find((p) => p.hrid === hrid);
            if (player) {
                const isLive = hrid === this.host?._editor?.getSelfHrid?.();
                return {
                    dto: structuredClone(player.dto),
                    name: player.name,
                    isLive,
                    gameMode: this._editorPlayerMode(player),
                };
            }
        }
        const dto = buildPlayerDTO();
        if (!dto) return null;
        return {
            dto,
            name: dataManager.characterData?.character?.name || 'You',
            isLive: true,
            gameMode: dto.gameMode || dataManager.getCurrentCharacterGameMode?.() || undefined,
        };
    }

    // ---------------------------------------------------------------- zones

    /** @private */
    _populateZoneSelect() {
        const select = this._el('zone');
        if (!select) return;
        select.innerHTML = getCombatZones()
            .map((z) => `<option value="${esc(z.hrid)}">${esc(z.isDungeon ? `[D] ${z.name}` : z.name)}</option>`)
            .join('');
        this._renderTierOptions();
    }

    /** @private */
    _renderTierOptions() {
        const zone = getCombatZones().find((z) => z.hrid === this._el('zone')?.value);
        const maxTier = zone?.isDungeon ? DUNGEON_MAX_TIER : ZONE_MAX_TIER;
        this._el('tier').innerHTML =
            Array.from({ length: maxTier + 1 }, (_, i) => `<option value="${i}">T${i}</option>`).join('') +
            '<option value="all">All tiers</option>';
    }

    /**
     * Start from the zone the Configure tab has picked, else where the character is fighting.
     * @private
     */
    _seedZones() {
        this._zonesSeeded = true;
        const panel = this.host?.panel;
        const zoneHrid = panel?.querySelector('#mwi-csim-zone')?.value || getCurrentCombatZone()?.zoneHrid;
        const tierValue = panel?.querySelector('#mwi-csim-tier')?.value;
        const tier =
            tierValue != null && tierValue !== ''
                ? parseInt(tierValue, 10) || 0
                : getCurrentCombatZone()?.difficultyTier || 0;
        if (zoneHrid) this._addZone(zoneHrid, tier);
    }

    /**
     * @param {string} zoneHrid
     * @param {number} tier
     * @returns {boolean} Whether it was added
     * @private
     */
    _addZone(zoneHrid, tier) {
        const zone = getCombatZones().find((z) => z.hrid === zoneHrid);
        if (!zone) return false;
        const maxTier = zone.isDungeon ? DUNGEON_MAX_TIER : ZONE_MAX_TIER;
        const difficultyTier = Math.min(Math.max(0, tier), maxTier);
        const entry = { zoneHrid, difficultyTier, isDungeon: zone.isDungeon, name: zone.name };
        if (this._zones.some((z) => zoneTierKey(z) === zoneTierKey(entry))) return false;
        this._zones.push(entry);
        return true;
    }

    /** @private */
    _onAddZone() {
        const zoneHrid = this._el('zone')?.value;
        const tierValue = this._el('tier')?.value;
        const zone = getCombatZones().find((z) => z.hrid === zoneHrid);
        if (!zone) return;
        if (tierValue === 'all') {
            const maxTier = zone.isDungeon ? DUNGEON_MAX_TIER : ZONE_MAX_TIER;
            for (let t = 0; t <= maxTier; t++) this._addZone(zoneHrid, t);
        } else {
            this._addZone(zoneHrid, parseInt(tierValue, 10) || 0);
        }
        this._renderZoneChips();
        this._renderPlan();
    }

    /** @private */
    _renderZoneChips() {
        const chips = this._el('zone-chips');
        if (!chips) return;
        chips.textContent = '';
        if (!this._zones.length) {
            const none = document.createElement('span');
            none.style.cssText = 'color:' + GAME_COLORS.textDim + '; font-size:11px;';
            none.textContent = 'No zones picked.';
            chips.appendChild(none);
        }
        this._zones.forEach((zone, index) => {
            const chip = document.createElement('span');
            chip.dataset.pfZone = zoneTierKey(zone);
            chip.style.cssText =
                'display:inline-flex; gap:4px; align-items:center; background:' +
                GAME_COLORS.raised +
                '; border:1px solid ' +
                GAME_COLORS.border +
                '; border-radius:10px; padding:1px 8px; font-size:11px;';
            const label = document.createElement('span');
            label.textContent = `${zone.isDungeon ? '[D] ' : ''}${zone.name} T${zone.difficultyTier}`;
            const remove = document.createElement('button');
            remove.textContent = '×';
            remove.title = 'Remove';
            remove.style.cssText =
                'background:none; border:none; color:#888; cursor:pointer; padding:0; font-size:12px;';
            remove.addEventListener('click', () => {
                this._zones.splice(index, 1);
                this._renderZoneChips();
                this._renderPlan();
            });
            chip.append(label, remove);
            chips.appendChild(chip);
        });
    }

    // ---------------------------------------------------------------- plan

    /**
     * The search settings as they stand.
     * @returns {{maxPartySize: number, quickHours: number, fullHours: number, topK: number, metric: string}}
     * @private
     */
    _settings() {
        return {
            maxPartySize: readInt(this._el('max-party'), DUNGEON_MAX_PARTY, 2, DUNGEON_MAX_PARTY),
            quickHours: readInt(this._el('quick-hours'), DEFAULT_QUICK_HOURS, 1, 100),
            fullHours: readInt(
                this._el('full-hours'),
                config.getSettingValue('combatSim_allZonesDefaultHours', 10),
                1,
                10000
            ),
            topK: readInt(this._el('top-k'), DEFAULT_TOP_K, 0, 20),
            metric: this._el('metric')?.value || 'xp',
        };
    }

    /**
     * The roster as the plan sees it: display names, and teammates whose builds this game data cannot run left out.
     * @param {Object|null} gameData
     * @returns {{roster: Array<Object>, skipped: Array<string>}}
     * @private
     */
    _planRoster(gameData) {
        const lock = this._partyLock();
        // A saved teammate who is also in your party is run once, as the party member
        const entries = [...this._roster.entries.filter((e) => !lock.suppressed.has(e.id)), ...lock.entries];
        const names = displayNames(entries);
        const skipped = [];
        const roster = [];
        for (const entry of entries) {
            const unknown = gameData ? unknownBuildParts(entry.dto, gameData) : [];
            if (unknown.length) {
                skipped.push(`${names.get(entry.id)} (unknown ${unknown.slice(0, 2).join(', ')})`);
                continue;
            }
            // Every teammate is taken to be of the live character's game mode, whatever was saved with them
            const dto = this._withAssumedMode(entry.dto);
            roster.push({ ...entry, name: names.get(entry.id), dto });
        }
        return { roster, skipped };
    }

    /**
     * The plan for what is picked now.
     * @param {Object|null} gameData
     * @returns {Object}
     * @private
     */
    _plan(gameData) {
        const settings = this._settings();
        const { roster, skipped } = this._planRoster(gameData);
        const mine = this._selfAuraInfo(gameData);
        const plan = planSweep({
            zones: this._zones,
            roster,
            choices: this._effectiveChoices(this._partyLock()),
            maxPartySize: settings.maxPartySize,
            gameData,
            selfAuras: mine.auras,
            selfDto: mine.dto,
        });
        const zoneCount = plan.perZone.filter((z) => z.count > 0).length;
        const rerunMax = settings.topK > 0 ? Math.min(settings.topK, Math.max(0, plan.total - zoneCount)) : 0;
        // The best K, plus the solo baseline of each zone/tier they are in (at most one per zone, at most K)
        const rerunBaselines = Math.min(rerunMax, zoneCount);
        return {
            ...plan,
            settings,
            skipped,
            rerunMax: rerunMax + rerunBaselines,
            grandTotal: plan.total + rerunMax + rerunBaselines,
        };
    }

    /** @private */
    _renderPlan() {
        const el = this._el('plan');
        if (!el) return;
        const plan = this._plan(buildGameDataPayload());
        const notes = [];
        if (!this._zones.length) notes.push('Pick at least one zone.');
        else if (!this._hasTeammates() && !(this._trySelfAuras && plan.selfAuraCount)) {
            notes.push('Add teammates to the roster first.');
        } else if (plan.refused) notes.push(plan.refused);
        else {
            const { quickHours, fullHours } = plan.settings;
            notes.push(
                `${plan.total} quick sim${plan.total === 1 ? '' : 's'} at ${quickHours} h` +
                    (plan.rerunMax ? `, then up to ${plan.rerunMax} re-run at ${fullHours} h.` : '.')
            );
        }
        for (const zone of plan.perZone) {
            if (zone.note) notes.push(`${zone.zone.name} T${zone.zone.difficultyTier}: ${zone.note}.`);
        }
        if (plan.skipped.length) notes.push(`Left out, not runnable here: ${plan.skipped.join('; ')}.`);
        for (const row of this._partyLock().rows) {
            if (row.status === 'missing') {
                notes.push(`${row.name} is in your party but their profile is not loaded, so they are left out.`);
            }
        }
        for (const note of plan.notes || []) notes.push(`${note}.`);
        if (this._trySelfAuras && !plan.refused) {
            notes.push(
                plan.selfAuraCount
                    ? `Trying ${plan.selfAuraCount} aura variant${plan.selfAuraCount === 1 ? '' : 's'} of you beside as worn.`
                    : 'Also try my auras: no aura of yours to try here, so you are only tried as worn.'
            );
        }
        el.textContent = notes.join(' ');
    }

    // ---------------------------------------------------------------- run

    /**
     * Start a sweep (or ask first, when it is large).
     * @param {Object} [options]
     * @param {boolean} [options.confirmed=false]
     * @returns {Promise<void>}
     */
    async start({ confirmed = false } = {}) {
        if (!this.root || this._running) return;
        if (this.host?._isBusy?.()) {
            this._status('A simulation is already running.');
            return;
        }
        this._hideConfirm();
        if (!this._zones.length) {
            this._status('Pick at least one zone first.');
            return;
        }
        // The party as it is now, not as it was when the tab last looked
        if (this._includeParty) {
            // A party change during the read starts a newer one; run on the party the last read found
            let awaited = this._refreshParty();
            await awaited;
            while (this.root && this._latestPartyRead !== awaited) {
                awaited = this._latestPartyRead;
                await awaited;
            }
            if (!this.root || this._running) return;
            // Another simulation may have started on another tab during the read; starting now would cancel it
            if (this.host?._isBusy?.()) {
                this._status('A simulation is already running.');
                return;
            }
        }
        const gameData = buildGameDataPayload();
        if (!gameData) {
            this._status('No game data available.');
            return;
        }
        const plan = this._plan(gameData);
        // With no teammates, your own aura variants alone are still worth a run (each aura solo)
        if (!this._hasTeammates() && !(this._trySelfAuras && plan.selfAuraCount)) {
            this._status('Add teammates to the roster first.');
            return;
        }
        if (plan.refused) {
            this._status(plan.refused);
            return;
        }
        if (!plan.total) {
            this._status('Nothing to run: no party fits these zones and choices.');
            this._renderPlan();
            return;
        }
        const self = this._resolveSelf();
        if (!self) {
            this._status('No character data available.');
            return;
        }
        const unknownSelf = unknownBuildParts(self.dto, gameData);
        if (unknownSelf.length) {
            this._status(`Your build names something this game data does not know: ${unknownSelf.join(', ')}.`);
            return;
        }
        if (!confirmed && plan.grandTotal > CONFIRM_RUNS_ABOVE) {
            this._showConfirm(plan);
            return;
        }
        await this._run(plan, self, gameData);
    }

    /**
     * Stop the sweep, keeping what finished.
     */
    stop() {
        if (!this._running) return;
        cancelAllZonesSimulation();
    }

    /**
     * @param {Object} plan
     * @private
     */
    _showConfirm(plan) {
        const bar = this._el('confirm');
        if (!bar) return;
        this._pendingConfirm = plan.grandTotal;
        bar.innerHTML = `This will run up to ${plan.grandTotal} sims (${plan.total} quick, up to ${plan.rerunMax} re-run). Continue?
            <button data-pf="confirm-yes" style="${BTN_STYLE} margin-left:6px;">Run ${plan.grandTotal}</button>
            <button data-pf="confirm-no" style="${SMALL_BTN_STYLE} margin-left:4px;">Cancel</button>`;
        bar.style.display = 'block';
        this._el('confirm-yes').addEventListener('click', () => {
            const asked = this._pendingConfirm;
            this._hideConfirm();
            // Picked again on the way in: if the roster or choices moved since, the count asked about is not this one
            const now = this._plan(buildGameDataPayload());
            if (now.grandTotal !== asked) {
                this._showConfirm(now);
                return;
            }
            this.start({ confirmed: true });
        });
        this._el('confirm-no').addEventListener('click', () => {
            this._hideConfirm();
            this._status('Party search not started.');
        });
    }

    /** @private */
    _hideConfirm() {
        const bar = this._el('confirm');
        if (bar) {
            bar.style.display = 'none';
            bar.textContent = '';
        }
        this._pendingConfirm = null;
    }

    /**
     * Run both passes.
     * @param {Object} plan
     * @param {{dto: Object, name: string, isLive: boolean}} self
     * @param {Object} gameData
     * @private
     */
    async _run(plan, self, gameData) {
        const ownerId = dataManager.getCurrentCharacterId();
        const token = ++this._runToken;
        const current = () =>
            token === this._runToken && Boolean(this.root) && dataManager.getCurrentCharacterId() === ownerId;
        const { quickHours, fullHours, topK, metric } = plan.settings;
        const communityBuffs = getCommunityBuffs();
        // Your sale tax: the live character's own status, or for anyone else the game mode their DTO carries (an
        // Iron Cow pays none), as the Upgrade tab prices a player who is not you
        const saleTaxRate = saleTaxRateOf(self.dto, self.isLive);

        this._running = true;
        this._repricePending = false;
        this.host.isRunning = true;
        this._rows = new Map();
        this._baselines = new Map();
        this._sortKey = metric;
        this._sortAsc = false;
        this._lastRun = { self, gameData, quickHours, fullHours };
        this._summary = '';
        this._setRunningUi(true);
        this._renderResults();

        const started = Date.now();
        let stage = 1;
        let done = 0;
        let total = plan.total;
        this._elapsedTimer = setInterval(() => {
            if (!current()) return;
            this._status(
                `Party search, ${stage === 1 ? 'quick pass' : 'full re-run'}: ${done} of ${total} sims… ` +
                    formatElapsed((Date.now() - started) / 1000)
            );
        }, 250);

        let outcome = 'done';
        let errorText = '';
        try {
            // Stage 1: every party, short
            // One set of quotes for the whole search, frozen now: the quick pass ranks the parties, the rerun pass
            // re-measures the best, and a refresh between them must not read as one party beating another
            const quickCache = new Map();
            const fullCache = quickCache;
            for (const zoneHrid of new Set(plan.tasks.map((task) => task.zone?.zoneHrid).filter(Boolean))) {
                seedRunPriceCache(quickCache, gameData, {
                    zoneHrid,
                    playerDTOs: [self.dto],
                    saleTaxRates: { [self.dto?.hrid]: saleTaxRate },
                });
            }
            const stage1 = plan.tasks.map((task) => ({
                ...task,
                id: `${task.zoneKey}|${task.comp.key}`,
                party: buildCompositionParty(self.dto, task.comp.members, task.comp.selfAura),
            }));
            const finished1 = await this._runPass(
                stage1,
                quickHours,
                gameData,
                communityBuffs,
                current,
                (task, sim) => {
                    const row = this._rowFor(task);
                    row.quick = readResult(sim, gameData, quickHours, { priceCache: quickCache, saleTaxRate });
                    done += 1;
                }
            );
            if (!current()) return;
            if (finished1 === 'stopped') {
                outcome = 'stopped';
            } else if (topK > 0) {
                // Stage 2: the best K parties and their baselines, at full hours
                const rerun = pickRerunRows([...this._rows.values()], this._baselines, metric, topK);
                if (rerun.length) {
                    stage = 2;
                    done = 0;
                    total = rerun.length;
                    const stage2 = rerun.map((row) => ({
                        zone: row.zone,
                        zoneKey: row.zoneKey,
                        comp: row.comp,
                        id: row.id,
                        party: buildCompositionParty(self.dto, row.comp.members, row.comp.selfAura),
                    }));
                    const finished2 = await this._runPass(
                        stage2,
                        fullHours,
                        gameData,
                        communityBuffs,
                        current,
                        (task, sim) => {
                            const row = this._rows.get(task.id);
                            if (row)
                                row.full = readResult(sim, gameData, fullHours, { priceCache: fullCache, saleTaxRate });
                            done += 1;
                        }
                    );
                    if (!current()) return;
                    if (finished2 === 'stopped') outcome = 'stopped';
                }
            }
        } catch (error) {
            if (!current()) return;
            console.error('[PartyFinder] Party search failed:', error);
            outcome = 'error';
            errorText = error?.message || 'Unknown error';
        } finally {
            clearInterval(this._elapsedTimer);
            this._elapsedTimer = null;
            if (token === this._runToken) {
                this._running = false;
                if (this.host) this.host.isRunning = false;
                this._setRunningUi(false);
                // A run that outlived its character draws nothing below, but the panel's held reprice is still owed
                if (!current()) this.host?._flushPendingReprice?.();
            }
        }
        if (!current()) return;

        const elapsed = formatElapsed((Date.now() - started) / 1000);
        const failed = [...this._rows.values()].filter((r) => !shownMetrics(r)).length;
        const parts = [];
        if (outcome === 'stopped') {
            parts.push(`Party search ${stoppedSweepText(done, total)}${stage === 2 ? ' (full re-run)' : ''}.`);
        } else if (outcome === 'error') {
            parts.push(`Party search error: ${errorText}. Rows that finished are kept.`);
        } else {
            parts.push(`Party search done in ${elapsed}: ${this._rows.size} parties.`);
        }
        if (failed) parts.push(`${failed} sim${failed === 1 ? '' : 's'} failed.`);
        this._summary = parts.join(' ');
        this._status(this._summary);
        // One reprice, not two. A pricing change during the run reached this tab through the panel's
        // `_redisplayLastResults`, which held its own replay too; when the panel replays, that replay reprices this
        // table (through the same hook), so it is left to the panel. Only a change the panel did not hold is
        // replayed here.
        const replay = this._repricePending;
        this._repricePending = false;
        const panelReplays = Boolean(this.host?._repricePending);
        this.host?._flushPendingReprice?.();
        if (replay && !panelReplays) this.onPricingChanged();
        else this._renderResults();
    }

    /**
     * One pass through the coordinator, rows landing as they finish.
     * @returns {Promise<'done'|'stopped'>}
     * @private
     */
    async _runPass(tasks, hours, gameData, communityBuffs, current, onTask) {
        const eta = createEtaTracker();
        try {
            await runAllZonesSimulation(
                {
                    gameData,
                    playerDTOs: [],
                    zones: tasks.map((task) => ({
                        zoneHrid: task.zone.zoneHrid,
                        difficultyTier: task.zone.difficultyTier,
                        playerDTOs: task.party,
                    })),
                    hours,
                    communityBuffs,
                    useEarlyExit: false,
                    onResult: (index, simResult) => {
                        if (!current() || !tasks[index]) return;
                        onTask(tasks[index], simResult);
                        this._scheduleRender();
                    },
                },
                (percent) => {
                    if (!current()) return;
                    const fill = this._el('progress-fill');
                    const text = this._el('progress-text');
                    const { text: remaining } = eta.update(percent / 100);
                    if (fill) fill.style.width = `${percent}%`;
                    if (text) text.textContent = remaining ? `${percent}% · ${remaining}` : `${percent}%`;
                }
            );
            return 'done';
        } catch (error) {
            if (error?.message === 'Cancelled') return 'stopped';
            throw error;
        }
    }

    /**
     * The row a task fills, created on its first result.
     * @param {Object} task
     * @returns {Object}
     * @private
     */
    _rowFor(task) {
        let row = this._rows.get(task.id);
        if (!row) {
            row = {
                id: task.id,
                zoneKey: task.zoneKey,
                zone: task.zone,
                comp: task.comp,
                isBaseline: task.comp.isBaseline,
                // Two players on one aura is allowed (the engine decides whether it stacks), and said
                shared: task.party ? sharedAuras(task.party, this._lastRun?.gameData) : [],
                quick: null,
                full: null,
            };
            this._rows.set(task.id, row);
            if (row.isBaseline) this._baselines.set(task.zoneKey, row);
        }
        return row;
    }

    /**
     * @param {boolean} running
     * @private
     */
    _setRunningUi(running) {
        const run = this._el('run');
        const stop = this._el('stop');
        const progress = this._el('progress');
        if (run) {
            run.disabled = running;
            run.style.opacity = running ? '0.5' : '1';
        }
        if (stop) stop.style.display = running ? '' : 'none';
        if (progress) progress.style.display = running ? 'block' : 'none';
        // The Configure tab's Simulate, as the panel's own runs leave it while they go
        const simulate = this.host?.panel?.querySelector('#mwi-csim-run');
        if (simulate) {
            simulate.disabled = running;
            simulate.style.opacity = running ? '0.5' : '1';
            simulate.style.cursor = running ? 'not-allowed' : 'pointer';
        }
        if (running) {
            const fill = this._el('progress-fill');
            if (fill) fill.style.width = '0%';
        }
    }

    /**
     * @param {MouseEvent} event
     * @private
     */
    _onResultsClick(event) {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const sort = target.closest('[data-pf-sort]');
        if (sort) {
            const key = sort.dataset.pfSort;
            if (this._sortKey === key) this._sortAsc = !this._sortAsc;
            else {
                this._sortKey = key;
                // Fewer deaths is better
                this._sortAsc = key === 'deaths';
            }
            this._renderResults();
            return;
        }
        const load = target.closest('[data-pf-load]');
        if (load) {
            this.loadRowIntoEditor(load.dataset.pfLoad);
            return;
        }
        if (target.closest('[data-pf="csv"]')) this.exportCsv();
    }

    /** @private */
    _scheduleRender() {
        if (this._renderTimer) return;
        this._renderTimer = setTimeout(() => {
            this._renderTimer = null;
            this._renderResults();
        }, RENDER_THROTTLE_MS);
    }

    // ---------------------------------------------------------------- results

    /**
     * The rows in table order.
     * @returns {Array<Object>}
     */
    sortedRows() {
        return sortRows([...this._rows.values()], this._baselines, this._sortKey, this._sortAsc, this._scoreWeight);
    }

    /** @private */
    _renderResults() {
        // Whatever redraw was waiting is this one
        clearTimeout(this._renderTimer);
        this._renderTimer = null;
        const container = this._el('results');
        const summary = this._el('summary');
        if (!container) return;
        if (summary) summary.textContent = this._summary;
        if (!this._rows.size) {
            container.innerHTML = this._running
                ? '<div style="color:' + GAME_COLORS.textDim + '; font-size:12px;">Waiting for the first results…</div>'
                : '';
            return;
        }
        const rows = this.sortedRows();
        const arrow = (key) => (this._sortKey === key ? (this._sortAsc ? ' ▲' : ' ▼') : '');
        const th = (key, label, title = '') =>
            `<th ${key ? `data-pf-sort="${key}"` : ''} title="${esc(title)}" style="padding:3px 4px; ${key ? 'cursor:pointer;' : ''} white-space:nowrap; font-size:10px; font-weight:600; color:#888; border-bottom:1px solid #333; text-align:left;">${label}${key ? arrow(key) : ''}</th>`;
        const td = (html, style = '', title = '') =>
            `<td${title ? ` title="${esc(title)}"` : ''} style="padding:2px 4px; font-size:11px; white-space:nowrap; ${style}">${html}</td>`;
        const signed = (value, text) => {
            if (value == null || !Number.isFinite(value)) return td('—', 'color:#555;');
            const color = value < 0 ? RED : value > 0 ? GREEN : '#888';
            return td(`${value > 0 ? '+' : ''}${text}`, `color:${color};`);
        };

        let html = `<table style="border-collapse:collapse; width:100%;"><thead><tr>
            ${th('', 'Zone')}${th('', 'Party', 'Teammates beside you')}
            ${th('xp', 'EXP/hr', 'Your EXP per hour')}${th('profit', 'Profit/hr', 'Your profit per hour')}
            ${th('score', 'Score', `EXP/hr + ${this._scoreWeight} × Profit/hr (1M profit = ${this._scoreWeight}M XP). Set the weight above the table. A party whose profit could not be priced has no score and sorts last.`)}
            ${th('deaths', 'Deaths/hr', 'Your deaths per hour')}
            ${th('xpVsSolo', 'EXP vs solo', 'Your EXP against you alone in the same zone and tier')}
            ${th('profitVsSolo', 'Profit vs solo', 'Your profit against you alone in the same zone and tier')}
            ${th('', '')}</tr></thead><tbody>`;
        for (const row of rows) {
            const shown = shownMetrics(row);
            const baseline = this._baselines.get(row.zoneKey) || null;
            const zoneLabel = `${row.zone.isDungeon ? '[D] ' : ''}${esc(row.zone.name)} T${row.zone.difficultyTier}`;
            const aliases = row.comp.aliases?.length
                ? ` title="Same builds as: ${esc(row.comp.aliases.map((a) => ['You', ...a].join(' + ')).join('; '))}"`
                : '';
            const party = `<span${aliases} style="${row.isBaseline ? 'font-weight:700; color:#ccc;' : ''}">${esc(partyLabel(row.comp))}</span>`;
            const replaced = row.comp.members
                .filter((m) => m.aura && m.replaced)
                .map((m) => `${m.name}: ${m.aura.name} replaces ${m.replaced}`);
            if (row.comp.selfAura?.replaced) {
                replaced.unshift(`You: ${row.comp.selfAura.name} replaces ${row.comp.selfAura.replaced}`);
            }
            const sharedChip = row.shared?.length
                ? ` <span style="color:#ffb74d; font-size:9px;" title="Two or more players run this aura">${esc(
                      row.shared.map((a) => `${a.name} ×${a.count}`).join(', ')
                  )}</span>`
                : '';
            const replacedChip = replaced.length
                ? ` <span style="color:#888; font-size:9px;" title="${esc(replaced.join('; '))}">(swaps special)</span>`
                : '';
            const hoursTag = shown
                ? ` <span style="color:${GAME_COLORS.textDim}; font-size:9px;" title="${shown === row.full ? 'Re-run at full hours' : 'Quick pass'}">${shown.hours}h</span>`
                : '';
            html += `<tr data-pf-row="${esc(row.id)}" style="border-bottom:1px solid #1a1a1a;">${td(zoneLabel)}${td(party + sharedChip + replacedChip + hoursTag)}`;
            if (!shown) {
                html += `${td('sim failed', `color:${RED};`)}${td('')}${td('')}${td('')}${td('')}${td('')}`;
            } else {
                const unpriced = unpricedMark(shown);
                const capped =
                    shown.uncappedProfit != null
                        ? ` <span title="Limited by market volume (uncapped ${esc(formatKMB(shown.uncappedProfit))})" style="color:#ff9800;">*</span>`
                        : '';
                const profit =
                    shown.profitPerHour == null
                        ? td('—', 'color:#555;', 'Could not be priced')
                        : td(`${unpriced}${esc(formatKMB(shown.profitPerHour))}${capped}`);
                const score = blendedScore(shown, this._scoreWeight);
                const scoreCell =
                    score == null
                        ? td('—', 'color:#555;', 'No score: the profit could not be priced')
                        : td(`${unpriced}${esc(formatKMB(score))}`);
                const delta = row.isBaseline ? { xpPct: null, profitDelta: null } : soloDelta(row, baseline);
                html +=
                    td(esc(formatKMB(shown.xpPerHour))) +
                    profit +
                    scoreCell +
                    td(shown.deathsPerHour.toFixed(3)) +
                    (row.isBaseline
                        ? td('baseline', 'color:' + GAME_COLORS.textDim + ';') + td('', '')
                        : signed(delta.xpPct, `${delta.xpPct?.toFixed(1)}%`) +
                          signed(
                              delta.profitDelta,
                              esc(formatKMB(delta.profitDelta)) +
                                  (delta.unpriced?.length
                                      ? `<span data-pf-delta-unpriced title="No price for ${esc(delta.unpriced.join(', '))} (this party or solo); counted as 0 on that side" style="color:#ff9800;">~</span>`
                                      : '')
                          ));
            }
            html += td(
                `<button data-pf-load="${esc(row.id)}" style="${SMALL_BTN_STYLE}" title="Load this party into the editor">Load</button>`
            );
            html += '</tr>';
        }
        html += '</tbody></table>';
        html += `<div style="margin-top:6px; display:flex; gap:6px; align-items:center;">
            <button data-pf="csv" style="${SMALL_BTN_STYLE}">Export CSV</button>
            <span style="color:${GAME_COLORS.textDim}; font-size:10px;">Rows marked with hours were simmed that long; "vs solo" compares like with like.</span></div>`;
        container.innerHTML = html;
    }

    /**
     * Put a row's party into the editor, and its zone/tier on the Configure tab.
     * @param {string} rowId
     * @returns {boolean}
     */
    loadRowIntoEditor(rowId) {
        const row = this._rows.get(rowId);
        const self = this._lastRun?.self;
        const editor = this.host?._editor;
        if (!row || !self || !editor?.loadParty) return false;
        const party = buildCompositionParty(self.dto, row.comp.members, row.comp.selfAura);
        editor.loadParty(party, [self.name, ...row.comp.members.map((m) => m.name)], {
            selfIsLive: self.isLive,
            note: `From the party finder: ${partyLabel(row.comp)}`,
        });
        const panel = this.host.panel;
        const zoneSelect = panel?.querySelector('#mwi-csim-zone');
        if (zoneSelect) {
            zoneSelect.value = row.zone.zoneHrid;
            this.host._updateTierDropdown?.();
            const tierSelect = panel.querySelector('#mwi-csim-tier');
            if (tierSelect) tierSelect.value = String(row.zone.difficultyTier);
        }
        this.host._switchTab?.('configure');
        this._status(`Loaded ${[self.name, ...row.comp.members.map(memberLabel)].join(' + ')} into the editor.`);
        return true;
    }

    /**
     * Download the table as CSV, in table order.
     * @returns {boolean}
     */
    exportCsv() {
        const rows = this.sortedRows().map((row) => csvRow(row, this._baselines.get(row.zoneKey) || null));
        if (!rows.length) return false;
        return downloadCsv(csvFilename('party-finder'), toCsv(rows, CSV_COLUMNS));
    }
}
