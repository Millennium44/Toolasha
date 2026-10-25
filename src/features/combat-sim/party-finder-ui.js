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
 * - Figures are yours (player1) only, priced by `calculateSimRevenue` with one price cache per pass; a pricing
 *   change during a run is replayed when it ends.
 * - Stop keeps every finished row and says "stopped early — N of M".
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { onSyncPullApplied } from '../../utils/sync-merge-registry.js';
import { formatKMB } from '../../utils/formatters.js';
import { createEtaTracker } from '../../utils/progress-eta.js';
import { toCsv, csvFilename, downloadCsv } from '../../utils/csv-export.js';
import {
    buildGameDataPayload,
    buildPlayerDTO,
    getCombatZones,
    getCommunityBuffs,
    getCurrentCombatZone,
    parseShykaiImport,
} from './combat-sim-adapter.js';
import { runAllZonesSimulation, cancelAllZonesSimulation } from './all-zones-runner.js';
import {
    PARTY_ROSTER_KEY,
    MAX_ROSTER_SIZE,
    loadRoster,
    addTeammates,
    renameTeammate,
    removeTeammate,
    replaceTeammateBuild,
} from './party-roster.js';
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
    csvRow,
    stoppedSweepText,
    zoneTierKey,
    CSV_COLUMNS,
    CONFIRM_RUNS_ABOVE,
    DEFAULT_QUICK_HOURS,
    DEFAULT_TOP_K,
    RANK_METRICS,
    DUNGEON_MAX_PARTY,
} from './party-finder.js';

const ACCENT = '#4a9eff';
const ACCENT_BTN_BG = 'rgba(74, 158, 255, 0.2)';
const ACCENT_BTN_BORDER = 'rgba(74, 158, 255, 0.4)';
const RED = '#f44336';
const GREEN = '#4caf50';

/** Dungeons run T0-T2 where an ordinary zone runs T0-T5 */
const DUNGEON_MAX_TIER = 2;
const ZONE_MAX_TIER = 5;

/** How often the results redraw while a run streams rows in */
const RENDER_THROTTLE_MS = 250;

const INPUT_STYLE =
    'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 6px; font-size:12px; font-family:inherit;';
const BTN_STYLE = `background:${ACCENT_BTN_BG}; color:${ACCENT}; border:1px solid ${ACCENT_BTN_BORDER}; border-radius:4px; padding:3px 10px; font-size:12px; font-weight:600; cursor:pointer; font-family:inherit;`;
const SMALL_BTN_STYLE = `background:transparent; color:#aaa; border:1px solid #444; border-radius:3px; padding:1px 6px; font-size:11px; cursor:pointer; font-family:inherit;`;
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
 * Format "1m 05s" from seconds.
 * @param {number} seconds
 * @returns {string}
 */
function formatElapsed(seconds) {
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/**
 * Display names that tell same-named teammates apart: "Bob", "Bob #2".
 * @param {Array<{id: string, name: string}>} entries
 * @returns {Map<string, string>} id → display name
 */
export function displayNames(entries) {
    const counts = new Map();
    for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) || 0) + 1);
    const seen = new Map();
    const names = new Map();
    for (const entry of entries) {
        if (counts.get(entry.name) === 1) {
            names.set(entry.id, entry.name);
            continue;
        }
        const n = (seen.get(entry.name) || 0) + 1;
        seen.set(entry.name, n);
        names.set(entry.id, n === 1 ? entry.name : `${entry.name} #${n}`);
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

export class PartyFinderTab {
    /**
     * @param {Object} host - The Combat Sim panel (`CombatSimUI`)
     */
    constructor(host) {
        this.host = host;
        this.root = null;
        this._roster = { savedAt: 0, entries: [] };
        /** Teammate id → 'try' | 'always' | 'never' */
        this._choices = {};
        /** Selected zone/tiers: [{zoneHrid, difficultyTier, isDungeon, name}] */
        this._zones = [];
        this._zonesSeeded = false;
        /** Result rows by id (`zoneKey|compKey`) */
        this._rows = new Map();
        this._baselines = new Map();
        this._sortKey = 'xp';
        this._sortAsc = false;
        this._running = false;
        this._runToken = 0;
        this._stopRequested = false;
        this._repricePending = false;
        this._renderTimer = null;
        this._pendingConfirm = null;
        this._pendingDelete = null;
        this._pendingDeleteTimer = null;
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
        container.appendChild(this.root);
        this._wire();
        this._unsubscribePull = onSyncPullApplied((written) => {
            if ((written?.settings || []).includes(PARTY_ROSTER_KEY)) this._reloadRoster();
        });
        this._reloadRoster();
    }

    /**
     * Let go of everything: the run in flight, the nodes, the listeners, the timers and the results.
     */
    detach() {
        if (this._running) {
            this._stopRequested = true;
            cancelAllZonesSimulation();
            if (this.host) this.host.isRunning = false;
        }
        this._runToken++;
        this._running = false;
        clearTimeout(this._renderTimer);
        clearTimeout(this._pendingDeleteTimer);
        clearInterval(this._elapsedTimer);
        this._renderTimer = null;
        this._pendingDeleteTimer = null;
        this._elapsedTimer = null;
        this._unsubscribePull?.();
        this._unsubscribePull = null;
        this.root?.remove();
        this.root = null;
        this._rows = new Map();
        this._baselines = new Map();
        this._roster = { savedAt: 0, entries: [] };
        this._choices = {};
        this._zones = [];
        this._zonesSeeded = false;
        this._pendingConfirm = null;
        this._pendingDelete = null;
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
        if (!this.host?._isBusy?.()) this._status('Pick zones and teammates, then click Find parties.');
    }

    /**
     * A pricing setting changed: re-price the rows on screen (after the run, if one is going).
     */
    onPricingChanged() {
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
                    <span style="color:#666; font-size:11px;">Every figure below is this player's own.</span>
                </div>`
            ),
            section(
                'Teammates <span data-pf="roster-count" style="color:#666; font-weight:400;"></span>',
                `<div data-pf="roster" style="display:flex; flex-direction:column; gap:3px;"></div>
                <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top:6px;">
                    <label style="color:#888; font-size:11px;">From the editor</label>
                    <select class="toolasha-select" data-pf="editor-player" style="${INPUT_STYLE}"></select>
                    <select class="toolasha-select" data-pf="editor-target" style="${INPUT_STYLE}"></select>
                    <button data-pf="add-editor" style="${BTN_STYLE}">Save</button>
                    <button data-pf="add-self" style="${SMALL_BTN_STYLE}" title="Save a copy of your current build as a teammate you can then edit">Copy my build</button>
                    <button data-pf="toggle-import" style="${SMALL_BTN_STYLE}">Paste import…</button>
                </div>
                <div data-pf="import-box" style="display:none; margin-top:6px;">
                    <textarea data-pf="import-text" rows="3" placeholder="Paste a sim export (one player or a whole party)" style="${INPUT_STYLE} width:100%; box-sizing:border-box;"></textarea>
                    <button data-pf="import" style="${BTN_STYLE} margin-top:4px;">Import to roster</button>
                </div>
                <div data-pf="roster-note" style="color:#888; font-size:11px; margin-top:4px;"></div>`
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
                    <div style="background:#1a1a2e; border-radius:4px; height:18px; overflow:hidden; position:relative; border:1px solid #333;">
                        <div data-pf="progress-fill" style="height:100%; width:0%; background:linear-gradient(90deg, ${ACCENT_BTN_BG}, ${ACCENT}); transition:width 0.2s ease;"></div>
                        <span data-pf="progress-text" style="position:absolute; inset:0; text-align:center; font-size:11px; line-height:18px; color:#e0e0e0; font-weight:600;"></span>
                    </div>
                </div>`
            ),
            `<div data-pf="summary" style="font-size:12px; color:#bbb;"></div>`,
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
        this._el('metric').addEventListener('change', (e) => {
            this._sortKey = e.target.value;
            this._sortAsc = false;
            this._renderResults();
        });
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

    /** @private */
    async _reloadRoster() {
        const roster = await loadRoster();
        if (!this.root) return;
        this._roster = roster;
        this._renderRoster();
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
        this._el('roster-count').textContent = `(${entries.length}/${MAX_ROSTER_SIZE})`;
        list.textContent = '';
        if (!entries.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'color:#666; font-size:11px;';
            empty.textContent =
                'No teammates yet. Load someone in the Configure tab (import, a shared profile, your party), ' +
                'then save them here — or copy your own build and edit it.';
            list.appendChild(empty);
        }
        const names = displayNames(entries);
        for (const entry of entries) {
            const row = document.createElement('div');
            row.dataset.pfMember = entry.id;
            row.style.cssText = 'display:flex; gap:6px; align-items:center; font-size:12px;';

            const name = document.createElement('span');
            name.dataset.pfName = '';
            name.style.cssText = 'flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
            name.textContent = names.get(entry.id);
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
            row.append(
                name,
                choice,
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
        }
        this._renderAddFromEditor();
        this._renderPlan();
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
            const result = await replaceTeammateBuild(target, player.dto);
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
        const result = await addTeammates([{ name: player.name, dto: player.dto, source: 'editor' }]);
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
        const result = await addTeammates([{ name, dto, source: 'your build' }]);
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
        editor.importPlayers([structuredClone(entry.dto)], [entry.name]);
        this._rosterNote(`${entry.name} is in the editor. Change them there, then save back here with "replacing".`);
        this.host._switchTab?.('configure');
    }

    /**
     * @param {Object} entry
     * @param {HTMLElement} row
     * @param {HTMLElement} nameEl
     * @private
     */
    _onRename(entry, row, nameEl) {
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
            const result = await renameTeammate(entry.id, input.value);
            this._adoptRoster(result);
            if (!result.ok) this._rosterNote('Could not save the new name.', true);
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') commit(true);
            else if (e.key === 'Escape') commit(false);
        });
        input.addEventListener('blur', () => commit(true));
    }

    /**
     * @param {Object} entry
     * @private
     */
    async _onDelete(entry) {
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
        const result = await removeTeammate(entry.id);
        this._adoptRoster(result);
        if (!result.ok) this._rosterNote('Could not delete: the roster could not be written.', true);
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
        if (self) options.push({ value: `editor:${self.hrid}`, label: `${self.name} (as in the editor)` });
        options.push({ value: 'live', label: 'My current build' });
        for (const p of players) {
            if (p.hrid !== selfHrid) options.push({ value: `editor:${p.hrid}`, label: `${p.name} (from the editor)` });
        }
        return options;
    }

    /** @private */
    _renderSelfPicker() {
        const select = this._el('self');
        if (!select) return;
        const prior = select.value;
        const options = this._selfOptions();
        select.innerHTML = options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
        if (options.some((o) => o.value === prior)) select.value = prior;
    }

    /**
     * The build to sim as you, read now.
     * @returns {{dto: Object, name: string, isLive: boolean}|null}
     * @private
     */
    _resolveSelf() {
        const choice = this._el('self')?.value || 'live';
        if (choice.startsWith('editor:')) {
            const hrid = choice.slice('editor:'.length);
            const player = this._editorPlayers().find((p) => p.hrid === hrid);
            if (player) {
                const isLive = hrid === this.host?._editor?.getSelfHrid?.();
                return { dto: structuredClone(player.dto), name: player.name, isLive };
            }
        }
        const dto = buildPlayerDTO();
        if (!dto) return null;
        return { dto, name: dataManager.characterData?.character?.name || 'You', isLive: true };
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
            none.style.cssText = 'color:#666; font-size:11px;';
            none.textContent = 'No zones picked.';
            chips.appendChild(none);
        }
        this._zones.forEach((zone, index) => {
            const chip = document.createElement('span');
            chip.dataset.pfZone = zoneTierKey(zone);
            chip.style.cssText =
                'display:inline-flex; gap:4px; align-items:center; background:#1a1a2e; border:1px solid #333; border-radius:10px; padding:1px 8px; font-size:11px;';
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
        const names = displayNames(this._roster.entries);
        const skipped = [];
        const roster = [];
        for (const entry of this._roster.entries) {
            const unknown = gameData ? unknownBuildParts(entry.dto, gameData) : [];
            if (unknown.length) {
                skipped.push(`${names.get(entry.id)} (unknown ${unknown.slice(0, 2).join(', ')})`);
                continue;
            }
            roster.push({ ...entry, name: names.get(entry.id) });
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
        const plan = planSweep({
            zones: this._zones,
            roster,
            choices: this._choices,
            maxPartySize: settings.maxPartySize,
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
        else if (!this._roster.entries.length) notes.push('Add teammates to the roster first.');
        else if (plan.refused) notes.push(plan.refused);
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
        if (!this._roster.entries.length) {
            this._status('Add teammates to the roster first.');
            return;
        }
        const gameData = buildGameDataPayload();
        if (!gameData) {
            this._status('No game data available.');
            return;
        }
        const plan = this._plan(gameData);
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
        this._stopRequested = true;
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

        this._running = true;
        this._stopRequested = false;
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
            const quickCache = new Map();
            const stage1 = plan.tasks.map((task) => ({
                ...task,
                id: `${task.zoneKey}|${task.comp.key}`,
                party: buildCompositionParty(self.dto, task.comp.members),
            }));
            const finished1 = await this._runPass(
                stage1,
                quickHours,
                gameData,
                communityBuffs,
                current,
                (task, sim) => {
                    const row = this._rowFor(task);
                    row.quick = readResult(sim, gameData, quickHours, { priceCache: quickCache });
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
                    const fullCache = new Map();
                    const stage2 = rerun.map((row) => ({
                        zone: row.zone,
                        zoneKey: row.zoneKey,
                        comp: row.comp,
                        id: row.id,
                        party: buildCompositionParty(self.dto, row.comp.members),
                    }));
                    const finished2 = await this._runPass(
                        stage2,
                        fullHours,
                        gameData,
                        communityBuffs,
                        current,
                        (task, sim) => {
                            const row = this._rows.get(task.id);
                            if (row) row.full = readResult(sim, gameData, fullHours, { priceCache: fullCache });
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
                if (this.host) {
                    this.host.isRunning = false;
                    this.host._flushPendingReprice?.();
                }
                this._setRunningUi(false);
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
        if (this._repricePending) {
            this._repricePending = false;
            this.onPricingChanged();
        } else {
            this._renderResults();
        }
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
        if (running) {
            const fill = this._el('progress-fill');
            if (fill) fill.style.width = '0%';
        }
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
        return sortRows([...this._rows.values()], this._baselines, this._sortKey, this._sortAsc);
    }

    /** @private */
    _renderResults() {
        const container = this._el('results');
        const summary = this._el('summary');
        if (!container) return;
        if (summary) summary.textContent = this._summary;
        if (!this._rows.size) {
            container.innerHTML = this._running
                ? '<div style="color:#666; font-size:12px;">Waiting for the first results…</div>'
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
            ${th('deaths', 'Deaths/hr', 'Your deaths per hour')}
            ${th('xpVsSolo', 'EXP vs solo', 'Your EXP against you alone in the same zone and tier')}
            ${th('profitVsSolo', 'Profit vs solo', 'Your profit against you alone in the same zone and tier')}
            ${th('', '')}</tr></thead><tbody>`;
        for (const row of rows) {
            const shown = shownMetrics(row);
            const baseline = this._baselines.get(row.zoneKey) || null;
            const zoneLabel = `${row.zone.isDungeon ? '[D] ' : ''}${esc(row.zone.name)} T${row.zone.difficultyTier}`;
            const aliases = row.comp.aliases?.length
                ? ` title="Same builds as: ${esc(row.comp.aliases.map((a) => a.join(' + ')).join('; '))}"`
                : '';
            const party = `<span${aliases} style="${row.isBaseline ? 'font-weight:700; color:#ccc;' : ''}">${esc(partyLabel(row.comp))}</span>`;
            const hoursTag = shown
                ? ` <span style="color:#555; font-size:9px;" title="${shown === row.full ? 'Re-run at full hours' : 'Quick pass'}">${shown.hours}h</span>`
                : '';
            html += `<tr data-pf-row="${esc(row.id)}" style="border-bottom:1px solid #1a1a1a;">${td(zoneLabel)}${td(party + hoursTag)}`;
            if (!shown) {
                html += `${td('sim failed', `color:${RED};`)}${td('')}${td('')}${td('')}${td('')}`;
            } else {
                const unpriced = shown.unpriced?.length
                    ? `<span title="No price for ${esc(shown.unpriced.join(', '))}; counted as 0" style="color:#ff9800;">≥</span>`
                    : '';
                const capped =
                    shown.uncappedProfit != null
                        ? ` <span title="Limited by market volume (uncapped ${esc(formatKMB(shown.uncappedProfit))})" style="color:#ff9800;">*</span>`
                        : '';
                const profit =
                    shown.profitPerHour == null
                        ? td('—', 'color:#555;', 'Could not be priced')
                        : td(`${unpriced}${esc(formatKMB(shown.profitPerHour))}${capped}`);
                const delta = row.isBaseline ? { xpPct: null, profitDelta: null } : soloDelta(row, baseline);
                html +=
                    td(esc(formatKMB(shown.xpPerHour))) +
                    profit +
                    td(shown.deathsPerHour.toFixed(3)) +
                    (row.isBaseline
                        ? td('baseline', 'color:#666;') + td('', '')
                        : signed(delta.xpPct, `${delta.xpPct?.toFixed(1)}%`) +
                          signed(delta.profitDelta, esc(formatKMB(delta.profitDelta))));
            }
            html += td(
                `<button data-pf-load="${esc(row.id)}" style="${SMALL_BTN_STYLE}" title="Load this party into the editor">Load</button>`
            );
            html += '</tr>';
        }
        html += '</tbody></table>';
        html += `<div style="margin-top:6px; display:flex; gap:6px; align-items:center;">
            <button data-pf="csv" style="${SMALL_BTN_STYLE}">Export CSV</button>
            <span style="color:#555; font-size:10px;">Rows marked with hours were simmed that long; "vs solo" compares like with like.</span></div>`;
        container.innerHTML = html;

        container.querySelectorAll('[data-pf-sort]').forEach((cell) => {
            cell.addEventListener('click', () => {
                const key = cell.dataset.pfSort;
                if (this._sortKey === key) this._sortAsc = !this._sortAsc;
                else {
                    this._sortKey = key;
                    // Fewer deaths is better
                    this._sortAsc = key === 'deaths';
                }
                this._renderResults();
            });
        });
        container.querySelectorAll('[data-pf-load]').forEach((button) => {
            button.addEventListener('click', () => this.loadRowIntoEditor(button.dataset.pfLoad));
        });
        this._el('csv')?.addEventListener('click', () => this.exportCsv());
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
        const party = buildCompositionParty(self.dto, row.comp.members);
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
        this._status(`Loaded ${self.name} + ${partyLabel(row.comp)} into the editor.`);
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
