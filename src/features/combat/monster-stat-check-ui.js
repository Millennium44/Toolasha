/**
 * Monster stat check — panel
 *
 * A floating panel that, when the setting is on, mirrors the in-game monster
 * detail panel: click a monster and the game emits `battle_unit_fetched` with
 * that unit's live combat details; this catches it, builds the same monster in
 * the sim, and shows the two columns side by side with a verdict on each gap.
 *
 * The arithmetic — which fields, how to back the room level out, how to tell a
 * live buff from a modelling bug — is in `monster-stat-check.js`. This owns the
 * DOM, the drag, the minimize, and the one thing that has to happen here rather
 * than there: building the sim monster, which needs live game data seeded first.
 */

import config from '../../core/config.js';
import webSocketHook from '../../core/websocket.js';
import storage from '../../core/storage.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { attachMinimize } from '../../utils/panel-minimize.js';
import { buildGameDataPayload } from '../combat-sim/combat-sim-adapter.js';
import { setGameData } from '../combat-sim/engine/game-data.js';
import Monster from '../combat-sim/engine/monster.js';
import {
    deriveRoomLevel,
    buildComparison,
    buildExportPayload,
    compareBuffProduction,
    buffSignature,
} from './monster-stat-check.js';
import { downloadFile } from '../../utils/csv-export.js';
import labyrinthClearRate from './labyrinth-clear-rate.js';
import { captureFile, startCapture } from './labyrinth-tick-capture.js';

const BLIND_VERDICT = {
    match: { glyph: '✓', color: '#6fce7f' },
    missing: { glyph: '⚠', color: '#e56b6b' },
    magnitude: { glyph: '≠', color: '#e0b64a' },
    extra: { glyph: '+', color: '#7aa2d0' },
};

const UPTIME_VERDICT = {
    ok: { glyph: '✓', color: '#6fce7f' },
    'sim-under': { glyph: '⚠', color: '#e56b6b' },
    'sim-over': { glyph: '≠', color: '#e0b64a' },
    'sim-missing': { glyph: '⚠', color: '#e56b6b' },
    'sim-extra': { glyph: '+', color: '#7aa2d0' },
};

const SETTING_KEY = 'labyrinthMonsterStatCheck';
const PANEL_ID = 'toolasha-monster-stat-check';
const PANEL_KEY = 'monsterStatCheck';
/** Discrepancy records kept, deduped by monster+room, oldest evicted. */
const MAX_HISTORY = 100;
/** Where the log persists across refreshes. */
const STORE_NAME = 'labyrinth';
const STORE_KEY = 'monsterStatCheckLog';

const VERDICT_STYLE = {
    match: { glyph: '✓', color: '#6fce7f', label: 'match' },
    buff: { glyph: '↑', color: '#e0b64a', label: 'buff' },
    debuff: { glyph: '↓', color: '#e0b64a', label: 'debuff' },
    mismatch: { glyph: '⚠', color: '#e56b6b', label: 'off' },
    unknown: { glyph: '–', color: 'rgba(255,255,255,0.35)', label: '' },
};

/** @param {number|null} n */
function fmt(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    return Math.round(n).toLocaleString();
}

/** @param {number|null} pct */
function fmtDelta(pct) {
    if (pct == null || !Number.isFinite(pct)) return '';
    const sign = pct >= 0 ? '+' : '−';
    return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** Coarse "how long ago" for the paging label. @param {number} [ts] */
function relTime(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.round(m / 60)}h ago`;
}

/**
 * Build the sim monster for a fetched unit, scaled to match the game's numbers.
 * Room level is recovered from the unit's defense so the sim scales identically;
 * a gap that remains is then a modelling difference, not a room-level mismatch.
 *
 * With `applyBuffs`, the unit's live effects are folded into the sim before it
 * computes stats (buffed-against-buffed); without it, the sim is the unbuffed
 * baseline. The game's combatBuffMap records are the engine's own buff shape —
 * `{ typeHrid, ratioBoost, flatBoost }` — so they land on the accuracy, evasion,
 * damage, armour and resistance ratings exactly as the game's did.
 *
 * @param {Object} gameUnit - The `unit` from a `battle_unit_fetched` payload
 * @param {boolean} applyBuffs - Whether to inject the unit's live effects
 * @returns {{monster: Monster, roomLevel: number, buffApplied: boolean}|null}
 */
function buildSimMonster(gameUnit, applyBuffs) {
    try {
        const hrid = gameUnit?.hrid;
        if (!hrid) return null;
        const payload = buildGameDataPayload();
        if (!payload) return null;
        setGameData(payload);

        const tier = Number(gameUnit?.difficultyTier) || 0;
        const gameDefense = Number(gameUnit?.combatDetails?.defenseLevel);
        const baseDefense = Number(payload.combatMonsterDetailMap?.[hrid]?.combatDetails?.defenseLevel);
        // Only labyrinth (tier 0) scales by room level; a higher-tier monster's
        // defense carries the tier multipliers and must not be read as one.
        const roomLevel = tier === 0 ? deriveRoomLevel(gameDefense, baseDefense) : 0;

        const monster = new Monster(hrid, tier, roomLevel, true);
        const buffMap = gameUnit?.combatBuffMap;
        const buffApplied = !!(applyBuffs && buffMap && typeof buffMap === 'object' && Object.keys(buffMap).length);
        if (buffApplied) monster.combatBuffs = { ...buffMap };
        monster.updateCombatDetails();
        return { monster, roomLevel, buffApplied };
    } catch (error) {
        console.error('[MonsterStatCheck] Failed to build sim monster:', error);
        return null;
    }
}

class MonsterStatCheckPanel {
    constructor() {
        this.container = null;
        this.body = null;
        this.header = null;
        this.titleEl = null;
        this.minimize = null;
        this.isDragging = false;
        this.dragOffset = { x: 0, y: 0 };
        this.dragMoveHandler = null;
        this.dragUpHandler = null;
        /** The most recent comparison, for the console dump. */
        this.last = null;
        /** The snapshot currently on screen (live, or a history entry being browsed). */
        this.displayed = null;
        /** Recorded comparisons for the session, keyed by `${hrid}|${roomLevel}`. */
        this.history = new Map();
        /** Which history key is on screen, so the arrows know where they are. */
        this.viewKey = null;
        /** Paging filter: 'all' pages every view; 'discrepancies' only mismatches. */
        this.viewMode = 'all';
        /** 'buffed' compares with the unit's effects on the sim; 'baseline' without. */
        this.simMode = 'buffed';
        /** Whether the pointer is over the panel, so arrows only steer it then. */
        this.hovered = false;
        this.keyHandler = null;
    }

    /**
     * Show (building on first use) and refresh for a freshly fetched monster.
     * A fresh click always jumps back to the live view, even if you were browsing
     * history a moment ago.
     * @param {Object} gameUnit
     */
    showFor(gameUnit) {
        // Build both views up front: the buffed sim (effects folded in — the
        // trustworthy like-for-like check) and the unbuffed baseline (raw sim
        // stats, so the effect the game applied is visible). The toggle then
        // switches between them, and both travel with the history entry.
        const baseBuilt = buildSimMonster(gameUnit, false);
        const buffedBuilt = buildSimMonster(gameUnit, true);
        const baselineCmp = buildComparison(gameUnit, baseBuilt?.monster?.combatDetails || null, { simBuffed: false });
        const buffedCmp = buildComparison(gameUnit, buffedBuilt?.monster?.combatDetails || null, {
            simBuffed: Boolean(buffedBuilt?.buffApplied),
        });
        this.last = {
            recordedAt: Date.now(),
            hrid: gameUnit?.hrid,
            name: gameUnit?.name,
            roomLevel: buffedBuilt?.roomLevel ?? baseBuilt?.roomLevel ?? 0,
            simBuilt: Boolean(buffedBuilt?.monster?.combatDetails),
            // Kept so the blind-sim button can diff produced buffs against the live set.
            combatBuffMap: gameUnit?.combatBuffMap || {},
            buffs: buffedCmp.buffs,
            // The buffed verdict is canonical for the log, title and ordering.
            hasMismatch: buffedCmp.hasMismatch,
            buffed: { groups: buffedCmp.groups, hasMismatch: buffedCmp.hasMismatch, simBuffed: buffedCmp.simBuffed },
            baseline: { groups: baselineCmp.groups, hasMismatch: baselineCmp.hasMismatch, simBuffed: false },
        };
        this._record();
        this.displayed = this.last;
        this.viewKey = this._recordKey(this.last);

        this._ensureBuilt();
        this.container.style.display = 'flex';
        bringPanelToFront(this.container);
        this._render();
    }

    close() {
        if (this.container) this.container.style.display = 'none';
    }

    /**
     * Note the current comparison in the session log. Every clicked monster is
     * kept so the arrows can page back through them; deduped by monster and room
     * (a re-click refreshes that entry), capped so a long session can't grow
     * without bound.
     */
    /** Log key: monster + room + effect set, so each distinct buff state is kept. */
    _recordKey(snap) {
        return `${snap.hrid}|${snap.roomLevel}|${buffSignature(snap.combatBuffMap)}`;
    }

    _record() {
        if (!this.last?.hrid) return;
        const key = this._recordKey(this.last);
        // Every clicked monster is kept — the "⚠ only" filter changes what you
        // page through, never what is stored, so switching it can't lose views.
        // Re-insert so the map stays newest-last for eviction and paging.
        this.history.delete(key);
        this.history.set(key, this.last);
        while (this.history.size > MAX_HISTORY) {
            this.history.delete(this.history.keys().next().value);
        }
        this._persist();
    }

    /**
     * Keys to page through, honouring the "⚠ only" filter — discrepancies-first
     * ordering, optionally narrowed to just the mismatches.
     * @returns {string[]}
     */
    _pagingKeys() {
        const ordered = this._orderedKeys();
        return this.viewMode === 'discrepancies' ? ordered.filter((k) => this.history.get(k)?.hasMismatch) : ordered;
    }

    /**
     * Keys in paging order: discrepancies first (newest first by capture time),
     * then the clean views (newest first). So paging surfaces the mismatches
     * before anything else, and the ordering is by time rather than insertion
     * order — robust to entries restored from storage arriving out of order.
     * @returns {string[]}
     */
    _orderedKeys() {
        const entries = [...this.history.entries()];
        const byTimeDesc = (a, b) => (b[1].recordedAt || 0) - (a[1].recordedAt || 0);
        const sortedKeys = (predicate) =>
            entries
                .filter(([, s]) => predicate(s))
                .sort(byTimeDesc)
                .map(([k]) => k);
        return [...sortedKeys((s) => s.hasMismatch), ...sortedKeys((s) => !s.hasMismatch)];
    }

    /** Save the log and the view choices so a refresh keeps them. */
    _persist() {
        try {
            const payload = { mode: this.viewMode, simMode: this.simMode, entries: [...this.history.values()] };
            Promise.resolve(storage.set(STORE_KEY, payload, STORE_NAME)).catch(() => {});
        } catch {
            /* storage unavailable — the log simply stays in-memory */
        }
    }

    /** Restore a persisted log on start, without clobbering anything just clicked. */
    async _loadPersisted() {
        try {
            const saved = await storage.get(STORE_KEY, STORE_NAME, null);
            if (!saved) return;
            if (saved.mode === 'all' || saved.mode === 'discrepancies') this.viewMode = saved.mode;
            if (saved.simMode === 'buffed' || saved.simMode === 'baseline') this.simMode = saved.simMode;
            for (const entry of saved.entries || []) {
                if (!entry?.hrid) continue;
                const key = `${entry.hrid}|${entry.roomLevel}`;
                if (!this.history.has(key)) this.history.set(key, entry);
            }
            if (this.container && this.displayed) this._render();
        } catch (error) {
            console.error('[MonsterStatCheck] Failed to load persisted log:', error);
        }
    }

    /** Page through recorded views. dir −1 is previous (Up), +1 is next (Down). */
    _navigate(dir) {
        const keys = this._pagingKeys();
        if (keys.length < 2) return;
        let index = keys.indexOf(this.viewKey);
        if (index === -1) index = 0;
        const next = Math.min(keys.length - 1, Math.max(0, index + dir));
        if (next === index) return;
        this.viewKey = keys[next];
        this.displayed = this.history.get(this.viewKey);
        this._render();
    }

    /** Wipe the log, keeping the current view on screen. */
    _clearHistory() {
        this.history.clear();
        this.viewKey = null;
        this._persist();
        this._render();
    }

    /** Flip the paging filter between all views and only the discrepancies. */
    _toggleViewMode() {
        this.viewMode = this.viewMode === 'all' ? 'discrepancies' : 'all';
        this._persist();
        this._render();
    }

    /** Flip the sim column between the buffed and the unbuffed-baseline view. */
    _toggleSimMode() {
        this.simMode = this.simMode === 'buffed' ? 'baseline' : 'buffed';
        this._persist();
        this._render();
    }

    /**
     * Run a blind sim fight for the shown monster and diff the buffs it produces
     * on its own against the game's live effects. Synchronous — a handful of
     * fights is well under the frame budget.
     */
    async _runBlindSim() {
        const snap = this.displayed;
        if (!snap?.hrid) return;
        try {
            const { produced, ran } = await labyrinthClearRate.blindBuffProbe(snap.hrid, snap.roomLevel);
            snap.blind = { rows: compareBuffProduction(snap.combatBuffMap || {}, produced), ran, at: Date.now() };
        } catch (error) {
            console.error('[MonsterStatCheck] Blind sim failed:', error);
            snap.blind = { rows: [], ran: false, at: Date.now() };
        }
        // Only re-render if this snapshot is still the one on screen.
        if (this.displayed === snap) this._render();
        this._persist();
    }

    /**
     * Decompose the monster's incoming damage per ability from the armed tick
     * capture and compare it against the sim, to localise a timing/uptime gap.
     */
    async _runUptimeHarness() {
        const snap = this.displayed;
        if (!snap?.hrid) return;
        try {
            const capture = captureFile();
            const capturedMonster = capture?.context?.monsterHrid;
            // A capture is usable if it holds ticks and is for this monster (or is
            // unlabelled). Otherwise arm a fresh one that records the next fight.
            const usable = capture?.ticks?.length && (!capturedMonster || capturedMonster === snap.hrid);
            if (usable) {
                const result = await labyrinthClearRate.uptimeHarness(snap.hrid, snap.roomLevel, capture.ticks);
                snap.uptime = result ? { rows: result.comparison.rows, at: Date.now() } : { error: 'Sim run failed.' };
            } else {
                // Nothing captured for this monster — start capturing the next fight.
                startCapture({ monsterHrid: snap.hrid, roomLevel: snap.roomLevel });
                snap.uptime = {
                    armed: true,
                    message: 'Capturing — fight this monster, then click “Run uptime harness” again.',
                };
            }
        } catch (error) {
            console.error('[MonsterStatCheck] Uptime harness failed:', error);
            snap.uptime = { error: 'Uptime harness failed (see console).' };
        }
        if (this.displayed === snap) this._render();
    }

    /** Download the session's discrepancy log plus the current snapshot as JSON. */
    _export() {
        const payload = buildExportPayload(Array.from(this.history.values()), this.last, Date.now());
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        downloadFile(`toolasha-monster-stat-check-${stamp}.json`, JSON.stringify(payload), 'application/json');
    }

    /** @returns {Object|null} The most recent comparison, for the console. */
    dump() {
        const view = this.last?.buffed || (this.last?.groups ? this.last : null);
        if (this.last && view) {
            const rows = view.groups.flatMap((g) =>
                g.rows.map((r) => ({
                    group: g.group,
                    stat: r.label,
                    game: r.game,
                    sim: r.sim,
                    delta: r.deltaPct == null ? '' : `${r.deltaPct.toFixed(1)}%`,
                    verdict: r.verdict,
                }))
            );
            console.log(
                `[MonsterStatCheck] ${this.last.name || this.last.hrid} (room ${this.last.roomLevel})`,
                this.last.buffs.length ? `buffs: ${this.last.buffs.join(', ')}` : 'no buffs'
            );
            console.table(rows);
        }
        return this.last;
    }

    /** @returns {Array<Object>} The session discrepancy log, newest last. */
    logEntries() {
        return Array.from(this.history.values());
    }

    /** Build a plain-text rendering of the view on screen, for the clipboard. */
    _copyText(snapshot) {
        if (!snapshot) return '';
        const view =
            snapshot[this.simMode] || snapshot.buffed || snapshot.baseline || (snapshot.groups ? snapshot : null);
        const lines = [];
        const room = snapshot.roomLevel > 0 ? ` — Room ${snapshot.roomLevel}` : '';
        lines.push(`${snapshot.name || 'Monster'}${room}  (sim: ${this.simMode})`);
        if (view) {
            for (const g of view.groups) {
                lines.push(`[${g.group}]`);
                for (const r of g.rows) {
                    const d = r.deltaPct == null ? '' : ` (${r.deltaPct >= 0 ? '+' : ''}${r.deltaPct.toFixed(1)}%)`;
                    lines.push(`  ${r.label}: game ${fmt(r.game)} / sim ${fmt(r.sim)}${d} — ${r.verdict}`);
                }
            }
        }
        if (snapshot.buffs?.length) lines.push(`Active effects: ${snapshot.buffs.join(', ')}`);
        if (snapshot.blind?.rows?.length) {
            lines.push('Blind sim — buffs it produces (game / sim):');
            for (const r of snapshot.blind.rows) {
                lines.push(`  ${r.name}: ${this._blindBoost(r.game)} / ${this._blindBoost(r.sim)} — ${r.verdict}`);
            }
        }
        if (snapshot.uptime?.rows?.length) {
            lines.push('Uptime harness — incoming damage / ability (real vs sim):');
            for (const r of snapshot.uptime.rows) {
                const rd = r.real ? `${Math.round(r.real.dmgSharePct)}%` : '—';
                const sd = r.sim ? `${Math.round(r.sim.dmgSharePct)}%` : '—';
                const rc = r.real ? `${Math.round(r.real.castSharePct)}%` : '—';
                const sc = r.sim ? `${Math.round(r.sim.castSharePct)}%` : '—';
                lines.push(`  ${r.ability}: dmg ${rd}/${sd}, cast ${rc}/${sc} — ${r.verdict}`);
            }
        }
        return lines.join('\n');
    }

    /** Copy the current view to the clipboard, with a brief ✓ on the button. */
    _copyToClipboard(btn) {
        const text = this._copyText(this.displayed);
        if (!text || !navigator.clipboard) return;
        navigator.clipboard
            .writeText(text)
            .then(() => {
                btn.textContent = '✓';
                setTimeout(() => (btn.textContent = '⧉'), 1200);
            })
            .catch((error) => console.error('[MonsterStatCheck] Copy failed:', error));
    }

    _ensureBuilt() {
        if (this.container) return;

        const container = document.createElement('div');
        container.id = PANEL_ID;
        container.style.cssText = `
            position: fixed;
            top: 8%;
            left: 50%;
            transform: translateX(-50%);
            z-index: ${config.Z_FLOATING_PANEL};
            width: 340px;
            min-width: 260px;
            min-height: 140px;
            display: flex;
            flex-direction: column;
            /* Height grows to fit the content (header + body), so a full readout
               shows without a scrollbar; capped just under the viewport so it can
               never run off screen, and resizable from the corner. */
            max-height: 94vh;
            resize: both;
            background: rgba(10, 10, 20, 0.96);
            border: 2px solid ${config.COLOR_ACCENT};
            border-radius: 8px;
            box-shadow: 0 4px 24px rgba(0, 0, 0, 0.8);
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            color: #fff;
            user-select: none;
            overflow: hidden;
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 8px 12px;
            border-bottom: 1px solid rgba(255,255,255,0.1);
            cursor: grab;
            background: rgba(255,255,255,0.04);
            flex-shrink: 0;
        `;

        const title = document.createElement('span');
        title.style.cssText = `font-size: 0.85rem; font-weight: 600; color: ${config.COLOR_ACCENT}; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`;
        title.textContent = 'Monster Stat Check';

        const controls = document.createElement('div');
        controls.style.cssText = 'display: flex; align-items: center; flex-shrink: 0;';

        const copyBtn = document.createElement('button');
        copyBtn.textContent = '⧉';
        copyBtn.title = 'Copy the results on screen to the clipboard (as text)';
        copyBtn.style.cssText = `background: none; border: none; color: #aaa; font-size: 1rem; line-height: 1; cursor: pointer; padding: 0 4px;`;
        copyBtn.addEventListener('mouseenter', () => (copyBtn.style.color = '#fff'));
        copyBtn.addEventListener('mouseleave', () => (copyBtn.style.color = '#aaa'));
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._copyToClipboard(copyBtn);
        });

        const exportBtn = document.createElement('button');
        exportBtn.textContent = '⭳';
        exportBtn.title = 'Export the session’s discrepancy log (JSON)';
        exportBtn.style.cssText = `background: none; border: none; color: #aaa; font-size: 1rem; line-height: 1; cursor: pointer; padding: 0 4px;`;
        exportBtn.addEventListener('mouseenter', () => (exportBtn.style.color = '#fff'));
        exportBtn.addEventListener('mouseleave', () => (exportBtn.style.color = '#aaa'));
        exportBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._export();
        });

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.title = 'Close';
        closeBtn.style.cssText = `background: none; border: none; color: #aaa; font-size: 1.2rem; line-height: 1; cursor: pointer; padding: 0 2px;`;
        closeBtn.addEventListener('mouseenter', () => (closeBtn.style.color = '#fff'));
        closeBtn.addEventListener('mouseleave', () => (closeBtn.style.color = '#aaa'));
        closeBtn.addEventListener('click', () => this.close());

        controls.appendChild(exportBtn);
        controls.appendChild(closeBtn);
        header.appendChild(title);
        header.appendChild(controls);

        const body = document.createElement('div');
        body.style.cssText = `flex: 1; overflow-y: auto; padding: 10px 12px;`;

        container.appendChild(header);
        container.appendChild(body);
        document.body.appendChild(container);
        registerFloatingPanel(container);

        this.container = container;
        this.header = header;
        this.body = body;
        this.titleEl = title;

        this.minimize = attachMinimize({
            panel: container,
            header,
            body,
            panelKey: PANEL_KEY,
            beforeEl: closeBtn,
            restore: false,
        });

        this._setupDragging(header);

        // Arrows page through history, but only while the pointer is over the
        // panel — otherwise they'd fight the game's own keyboard handling.
        container.addEventListener('pointerenter', () => (this.hovered = true));
        container.addEventListener('pointerleave', () => (this.hovered = false));
        this.keyHandler = (e) => {
            if (!this.hovered || this.container?.style.display === 'none' || this.minimize?.collapsed) return;
            if (e.key === 'ArrowUp') {
                this._navigate(-1);
                e.preventDefault();
            } else if (e.key === 'ArrowDown') {
                this._navigate(1);
                e.preventDefault();
            }
        };
        document.addEventListener('keydown', this.keyHandler);
    }

    /** A small header-style icon button for the nav bar. */
    _navButton(glyph, title, onClick, enabled) {
        const b = document.createElement('button');
        b.textContent = glyph;
        b.title = title;
        b.disabled = !enabled;
        b.style.cssText = `background:none; border:none; color:${enabled ? '#aaa' : 'rgba(255,255,255,0.2)'}; font-size:0.8rem; cursor:${enabled ? 'pointer' : 'default'}; padding:0 2px; line-height:1;`;
        if (enabled) {
            b.addEventListener('mouseenter', () => (b.style.color = '#fff'));
            b.addEventListener('mouseleave', () => (b.style.color = '#aaa'));
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                onClick();
            });
        }
        return b;
    }

    /** A small text pill button for the nav bar (store toggle, Clear). */
    _pillButton(text, title, onClick) {
        const b = document.createElement('button');
        b.textContent = text;
        b.title = title;
        b.style.cssText =
            'background:none; border:1px solid rgba(255,255,255,0.15); border-radius:4px; color:#aaa; font-size:0.64rem; cursor:pointer; padding:1px 5px; white-space:nowrap;';
        b.addEventListener('mouseenter', () => (b.style.color = '#fff'));
        b.addEventListener('mouseleave', () => (b.style.color = '#aaa'));
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        return b;
    }

    /**
     * The paging bar. The controls (view filter, sim toggle, Clear) always show
     * so they can never strand the user; the arrows and position only appear once
     * there is something to page through.
     */
    _renderNav(body) {
        const keys = this._pagingKeys();
        const total = keys.length;
        const index = keys.indexOf(this.viewKey);
        const misCount = [...this.history.values()].filter((s) => s.hasMismatch).length;

        const nav = document.createElement('div');
        nav.style.cssText =
            'display:flex; flex-wrap:wrap; align-items:center; gap:5px; margin-bottom:8px; font-size:0.7rem; color:rgba(255,255,255,0.55);';

        if (total > 0) {
            nav.appendChild(this._navButton('▲', 'Previous (↑)', () => this._navigate(-1), index > 0));
            nav.appendChild(this._navButton('▼', 'Next (↓)', () => this._navigate(1), index >= 0 && index < total - 1));
        }

        const label = document.createElement('span');
        label.style.cssText = 'flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
        if (!total) {
            label.innerHTML =
                this.viewMode === 'discrepancies'
                    ? 'no discrepancies logged'
                    : `<span style="opacity:0.6;">nothing recorded yet</span>`;
        } else {
            const pos = index === -1 ? `${total}` : `${index + 1} / ${total}`;
            const mis = misCount ? ` · <span style="color:#e56b6b;">⚠ ${misCount}</span>` : '';
            const rel = index >= 0 ? relTime(this.displayed?.recordedAt) : '';
            label.innerHTML = `${pos}${mis}${rel ? ` · ${rel}` : ''}`;
        }
        nav.appendChild(label);

        nav.appendChild(
            this._pillButton(
                this.simMode === 'buffed' ? 'Sim: buffed' : 'Sim: baseline',
                'Compare against the sim with the unit’s effects applied (buffed) or the unbuffed baseline',
                () => this._toggleSimMode()
            )
        );
        nav.appendChild(
            this._pillButton(
                this.viewMode === 'all' ? 'Show: all' : 'Show: ⚠ only',
                'Page through every recorded view, or only the discrepancies (nothing is deleted)',
                () => this._toggleViewMode()
            )
        );
        nav.appendChild(this._pillButton('Clear', 'Clear the session log', () => this._clearHistory()));

        body.appendChild(nav);
    }

    _render() {
        const snapshot = this.displayed;
        if (!snapshot) return;
        const body = this.body;
        body.innerHTML = '';
        const { name, roomLevel, buffs, simBuilt } = snapshot;
        // Pick the requested view; fall back through buffed/baseline, and for an
        // entry persisted before the two-view split, treat the snapshot itself.
        const view =
            snapshot[this.simMode] || snapshot.buffed || snapshot.baseline || (snapshot.groups ? snapshot : null);
        if (!view) return;
        const { groups, simBuffed } = view;
        const hasMismatch = view.hasMismatch;

        // Title carries the monster, its room level, and a ⚠ when this view is off
        const levelLabel = roomLevel > 0 ? ` — Room ${roomLevel}` : '';
        const flag = snapshot.hasMismatch ? '⚠ ' : '';
        this.titleEl.textContent = `${flag}${name || 'Monster'}${levelLabel}`;
        this.titleEl.style.color = snapshot.hasMismatch ? '#e56b6b' : config.COLOR_ACCENT;

        this._renderNav(body);

        // Column header: Stat | Game | Sim | Δ
        body.appendChild(
            this._rowEl({ label: 'Stat', game: 'Game', sim: 'Sim', delta: '', verdict: null }, { headerRow: true })
        );

        if (!simBuilt) {
            const warn = document.createElement('div');
            warn.style.cssText = 'font-size: 0.72rem; color: #e56b6b; padding: 8px 0; font-style: italic;';
            warn.textContent = 'Sim could not build this monster — showing game values only.';
            body.appendChild(warn);
        }

        for (const group of groups) {
            const heading = document.createElement('div');
            heading.style.cssText = `font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.5px; color: rgba(255,255,255,0.4); margin: 8px 0 2px;`;
            heading.textContent = group.group;
            body.appendChild(heading);

            for (const row of group.rows) {
                body.appendChild(
                    this._rowEl({
                        label: row.label,
                        game: fmt(row.game),
                        sim: fmt(row.sim),
                        delta: fmtDelta(row.deltaPct),
                        verdict: row.verdict,
                    })
                );
            }
        }

        // Footer: active buffs and the legend that reads a gap.
        const footer = document.createElement('div');
        footer.style.cssText = `margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08); font-size: 0.7rem; line-height: 1.5; color: rgba(255,255,255,0.55);`;

        const buffLine = document.createElement('div');
        if (buffs.length) {
            const applied = simBuffed ? ' (applied to sim)' : '';
            buffLine.innerHTML = `<span style="color:#e0b64a;">Active effects${applied}:</span> ${buffs.join(', ')}`;
        } else {
            buffLine.textContent = 'No active effects — clean baseline; every row should match.';
        }
        footer.appendChild(buffLine);

        const legend = document.createElement('div');
        legend.style.cssText = 'margin-top: 4px;';
        if (simBuffed) {
            // The sim carries the effects too, so every row is a like-for-like check.
            legend.innerHTML = hasMismatch
                ? '<span style="color:#e56b6b;">⚠ off</span> = game and sim disagree with the same effects applied — a real modelling gap.'
                : 'Sim built with the active effects applied — every row matches, so the sim models this monster and its effects correctly.';
        } else {
            legend.innerHTML = hasMismatch
                ? '<span style="color:#e56b6b;">⚠ off</span> = a gap with no active effect to explain it — the sim may be wrong here.'
                : 'No active effects, so the sim’s baseline is compared directly.';
        }
        footer.appendChild(legend);

        this._renderBlind(footer, snapshot);
        this._renderUptime(footer, snapshot);

        body.appendChild(footer);
    }

    /** The uptime-harness section: a Run button, and the incoming-damage diff. */
    _renderUptime(footer, snapshot) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08);';

        const up = snapshot.uptime;
        if (up) {
            const head = document.createElement('div');
            head.style.cssText =
                'font-size:0.68rem; text-transform:uppercase; letter-spacing:0.5px; color:rgba(255,255,255,0.4); margin-bottom:2px;';
            head.textContent = 'Uptime harness — incoming damage / ability';
            wrap.appendChild(head);

            if (up.armed) {
                const armed = document.createElement('div');
                armed.style.cssText = 'font-size:0.72rem; color:#6fce7f; font-style:italic;';
                armed.textContent = up.message;
                wrap.appendChild(armed);
            } else if (up.error) {
                const err = document.createElement('div');
                err.style.cssText = 'font-size:0.72rem; color:#e0b64a; font-style:italic;';
                err.textContent = up.error;
                wrap.appendChild(err);
            } else if (!up.rows?.length) {
                const none = document.createElement('div');
                none.style.cssText = 'font-size:0.72rem; color:rgba(255,255,255,0.5);';
                none.textContent = 'No attacks found in the capture.';
                wrap.appendChild(none);
            } else {
                const header = document.createElement('div');
                header.style.cssText =
                    'display:grid; grid-template-columns:1.3fr 0.9fr 0.9fr auto; gap:4px; font-size:0.64rem; color:rgba(255,255,255,0.4); padding:1px 0;';
                header.innerHTML =
                    '<span>ability</span><span style="text-align:right;">real dmg%</span><span style="text-align:right;">sim dmg%</span><span></span>';
                wrap.appendChild(header);

                for (const r of up.rows) {
                    const style = UPTIME_VERDICT[r.verdict] || UPTIME_VERDICT.ok;
                    const line = document.createElement('div');
                    line.style.cssText =
                        'display:grid; grid-template-columns:1.3fr 0.9fr 0.9fr auto; gap:4px; align-items:baseline; font-size:0.74rem; padding:1px 0;';
                    const pct = (side) => (side ? `${Math.round(side.dmgSharePct)}%` : '—');
                    const name = document.createElement('span');
                    name.textContent = r.ability;
                    name.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
                    // Cast share on hover, so the row stays compact.
                    name.title = `casts: real ${r.real ? Math.round(r.real.castSharePct) : '—'}% / sim ${r.sim ? Math.round(r.sim.castSharePct) : '—'}%  ·  mean/cast: real ${r.real ? Math.round(r.real.meanDmgPerCast) : '—'} / sim ${r.sim ? Math.round(r.sim.meanDmgPerCast) : '—'}`;
                    const g = document.createElement('span');
                    g.textContent = pct(r.real);
                    g.style.cssText = 'text-align:right; font-variant-numeric:tabular-nums;';
                    const s = document.createElement('span');
                    s.textContent = pct(r.sim);
                    s.style.cssText =
                        'text-align:right; font-variant-numeric:tabular-nums; color:rgba(255,255,255,0.75);';
                    const v = document.createElement('span');
                    v.textContent = style.glyph;
                    v.style.cssText = `text-align:right; color:${style.color};`;
                    v.title = r.verdict;
                    line.append(name, g, s, v);
                    wrap.appendChild(line);
                }
                const key = document.createElement('div');
                key.style.cssText = 'margin-top:3px; font-size:0.66rem; color:rgba(255,255,255,0.45);';
                key.innerHTML =
                    '<span style="color:#e56b6b;">⚠ sim-under</span> = sim gives this ability a smaller share of incoming damage than reality — a cadence or buff-uptime gap. Hover a row for cast% and mean/cast.';
                wrap.appendChild(key);
            }
        }

        const btn = document.createElement('button');
        btn.textContent = up?.rows?.length ? 'Re-run uptime harness' : 'Run uptime harness';
        btn.title =
            'Decompose the monster’s incoming damage per ability vs the sim. With no capture yet, arms one for the next fight.';
        btn.style.cssText =
            'margin-top:6px; background:none; border:1px solid rgba(255,255,255,0.2); border-radius:4px; color:#cbd5e8; font-size:0.7rem; cursor:pointer; padding:3px 8px;';
        btn.addEventListener('mouseenter', () => (btn.style.background = 'rgba(255,255,255,0.06)'));
        btn.addEventListener('mouseleave', () => (btn.style.background = 'none'));
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            btn.textContent = 'Running…';
            btn.disabled = true;
            setTimeout(() => this._runUptimeHarness(), 0);
        });
        wrap.appendChild(btn);

        footer.appendChild(wrap);
    }

    /** Boost as a short string: a ratio as a percent, else the flat value. */
    _blindBoost(rec) {
        if (!rec) return '—';
        if (rec.ratioBoost) return `${(rec.ratioBoost * 100).toFixed(0)}%`;
        if (rec.flatBoost) return `${Math.round(rec.flatBoost * 1000) / 1000}`;
        return '0';
    }

    /** The blind-sim section: a Run button, and the produced-vs-live buff diff. */
    _renderBlind(footer, snapshot) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08);';

        const blind = snapshot.blind;
        if (blind) {
            const head = document.createElement('div');
            head.style.cssText =
                'font-size:0.68rem; text-transform:uppercase; letter-spacing:0.5px; color:rgba(255,255,255,0.4); margin-bottom:2px;';
            head.textContent = 'Blind sim — buffs it produces';
            wrap.appendChild(head);

            if (!blind.ran) {
                const err = document.createElement('div');
                err.style.cssText = 'font-size:0.72rem; color:#e56b6b; font-style:italic;';
                err.textContent = 'Blind fight could not run (no loadout or sim data).';
                wrap.appendChild(err);
            } else if (!blind.rows.length) {
                const none = document.createElement('div');
                none.style.cssText = 'font-size:0.72rem; color:rgba(255,255,255,0.5);';
                none.textContent = 'No buffs on either side.';
                wrap.appendChild(none);
            } else {
                for (const r of blind.rows) {
                    const style = BLIND_VERDICT[r.verdict] || BLIND_VERDICT.match;
                    const line = document.createElement('div');
                    line.style.cssText =
                        'display:grid; grid-template-columns: 1.4fr 0.8fr 0.8fr auto; gap:4px; align-items:baseline; font-size:0.74rem; padding:1px 0;';
                    const name = document.createElement('span');
                    name.textContent = r.name;
                    name.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
                    const g = document.createElement('span');
                    g.textContent = this._blindBoost(r.game);
                    g.style.cssText = 'text-align:right; font-variant-numeric:tabular-nums;';
                    const s = document.createElement('span');
                    s.textContent = this._blindBoost(r.sim);
                    s.style.cssText =
                        'text-align:right; font-variant-numeric:tabular-nums; color:rgba(255,255,255,0.75);';
                    const v = document.createElement('span');
                    v.textContent = style.glyph;
                    v.style.cssText = `text-align:right; color:${style.color};`;
                    v.title = r.verdict;
                    line.append(name, g, s, v);
                    wrap.appendChild(line);
                }
                const key = document.createElement('div');
                key.style.cssText = 'margin-top:3px; font-size:0.66rem; color:rgba(255,255,255,0.45);';
                key.innerHTML =
                    '<span style="color:#e56b6b;">⚠ missing</span> = the sim never produced a live effect · ' +
                    '<span style="color:#e0b64a;">≠</span> different strength · <span style="color:#7aa2d0;">+</span> sim-only (timing). Game vs sim columns.';
                wrap.appendChild(key);
            }
        }

        const btn = document.createElement('button');
        btn.textContent = blind ? 'Re-run blind sim' : 'Run blind sim';
        btn.title = 'Simulate a fight fed only the monster + level (no live buffs) and list the buffs the sim produces';
        btn.style.cssText =
            'margin-top:6px; background:none; border:1px solid rgba(255,255,255,0.2); border-radius:4px; color:#cbd5e8; font-size:0.7rem; cursor:pointer; padding:3px 8px;';
        btn.addEventListener('mouseenter', () => (btn.style.background = 'rgba(255,255,255,0.06)'));
        btn.addEventListener('mouseleave', () => (btn.style.background = 'none'));
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            btn.textContent = 'Running…';
            btn.disabled = true;
            // Yield a frame so the label paints before the synchronous fight.
            setTimeout(() => this._runBlindSim(), 0);
        });
        wrap.appendChild(btn);

        footer.appendChild(wrap);
    }

    /**
     * One four-column line: stat, game, sim, delta+verdict.
     * @param {{label,game,sim,delta,verdict}} cells
     * @param {{headerRow?: boolean}} [options]
     */
    _rowEl({ label, game, sim, delta, verdict }, { headerRow = false } = {}) {
        const row = document.createElement('div');
        row.style.cssText = `display: grid; grid-template-columns: 1.35fr 1fr 1fr 0.9fr; gap: 4px; align-items: baseline; padding: 2px 0; font-size: ${headerRow ? '0.66rem' : '0.78rem'};`;
        if (headerRow) row.style.color = 'rgba(255,255,255,0.4)';

        const name = document.createElement('span');
        name.textContent = label;
        name.style.cssText = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';

        const gameEl = document.createElement('span');
        gameEl.textContent = game;
        gameEl.style.cssText = 'text-align: right; font-variant-numeric: tabular-nums;';

        const simEl = document.createElement('span');
        simEl.textContent = sim;
        simEl.style.cssText = 'text-align: right; font-variant-numeric: tabular-nums; color: rgba(255,255,255,0.75);';

        const deltaEl = document.createElement('span');
        deltaEl.style.cssText = 'text-align: right; font-variant-numeric: tabular-nums; font-size: 0.72rem;';
        const style = verdict ? VERDICT_STYLE[verdict] : null;
        if (headerRow) {
            deltaEl.textContent = 'Δ';
        } else if (style) {
            deltaEl.textContent = `${style.glyph}${delta ? ' ' + delta : ''}`;
            deltaEl.style.color = style.color;
        }

        row.appendChild(name);
        row.appendChild(gameEl);
        row.appendChild(simEl);
        row.appendChild(deltaEl);
        return row;
    }

    _setupDragging(header) {
        header.style.touchAction = 'none';
        header.addEventListener('pointerdown', (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
            bringPanelToFront(this.container);
            this.isDragging = true;
            const rect = this.container.getBoundingClientRect();
            this.container.style.transform = 'none';
            this.container.style.top = `${rect.top}px`;
            this.container.style.left = `${rect.left}px`;
            this.dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            header.style.cursor = 'grabbing';
            e.preventDefault();
        });

        this.dragMoveHandler = (e) => {
            if (!this.isDragging) return;
            let x = e.clientX - this.dragOffset.x;
            let y = e.clientY - this.dragOffset.y;
            const minVisible = 80;
            y = Math.max(0, Math.min(y, window.innerHeight - minVisible));
            x = Math.max(-this.container.offsetWidth + minVisible, Math.min(x, window.innerWidth - minVisible));
            this.container.style.top = `${y}px`;
            this.container.style.left = `${x}px`;
        };

        this.dragUpHandler = () => {
            if (!this.isDragging) return;
            this.isDragging = false;
            header.style.cursor = 'grab';
        };

        document.addEventListener('pointermove', this.dragMoveHandler);
        document.addEventListener('pointerup', this.dragUpHandler);
        document.addEventListener('pointercancel', this.dragUpHandler);
    }

    teardown() {
        if (this.keyHandler) {
            document.removeEventListener('keydown', this.keyHandler);
            this.keyHandler = null;
        }
        if (this.dragMoveHandler) {
            document.removeEventListener('pointermove', this.dragMoveHandler);
            this.dragMoveHandler = null;
        }
        if (this.dragUpHandler) {
            document.removeEventListener('pointerup', this.dragUpHandler);
            document.removeEventListener('pointercancel', this.dragUpHandler);
            this.dragUpHandler = null;
        }
        if (this.minimize) {
            this.minimize.destroy();
            this.minimize = null;
        }
        if (this.container) {
            unregisterFloatingPanel(this.container);
            this.container.remove();
            this.container = null;
        }
        this.body = null;
        this.header = null;
        this.isDragging = false;
    }
}

const panel = new MonsterStatCheckPanel();

/** The `battle_unit_fetched` handler, kept as a reference so it can be removed. */
let fetchHandler = null;

function handleFetched(data) {
    try {
        const unit = data?.unit;
        // Only monsters — a player's own detail panel fires this too.
        if (!unit || unit.isPlayer || !unit.hrid) return;
        panel.showFor(unit);
    } catch (error) {
        console.error('[MonsterStatCheck] Failed to handle fetched unit:', error);
    }
}

function initialize() {
    if (!fetchHandler) {
        fetchHandler = handleFetched;
        webSocketHook.on('battle_unit_fetched', fetchHandler);
    }

    // Restore the log saved from an earlier session so the panel opens with it.
    panel._loadPersisted();

    // Turning the setting off mid-session should take the panel away without a
    // refresh. Turning it on relies on the registry initialising the feature.
    config.onSettingChange(SETTING_KEY, (enabled) => {
        if (!enabled) disable();
    });
}

function disable() {
    if (fetchHandler) {
        webSocketHook.off('battle_unit_fetched', fetchHandler);
        fetchHandler = null;
    }
    panel.teardown();
}

/** Console: dump the last comparison as a table. Exposed on Toolasha.Debug. */
function dumpLast() {
    return panel.dump();
}

/** Console: the session's discrepancy log (also downloadable from the panel). */
function logEntries() {
    return panel.logEntries();
}

export default {
    name: 'Monster Stat Check',
    initialize,
    disable,
    dumpLast,
    logEntries,
};
