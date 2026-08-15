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
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { attachMinimize } from '../../utils/panel-minimize.js';
import { buildGameDataPayload } from '../combat-sim/combat-sim-adapter.js';
import { setGameData } from '../combat-sim/engine/game-data.js';
import Monster from '../combat-sim/engine/monster.js';
import { deriveRoomLevel, buildComparison } from './monster-stat-check.js';

const SETTING_KEY = 'labyrinthMonsterStatCheck';
const PANEL_ID = 'toolasha-monster-stat-check';
const PANEL_KEY = 'monsterStatCheck';

const VERDICT_STYLE = {
    match: { glyph: '✓', color: '#6fce7f', label: 'match' },
    buff: { glyph: '≈', color: '#e0b64a', label: 'buff' },
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

/**
 * Build the sim monster for a fetched unit, scaled to match the game's numbers.
 * Room level is recovered from the unit's defense so the sim scales identically;
 * a gap that remains is then a modelling difference, not a room-level mismatch.
 * @param {Object} gameUnit - The `unit` from a `battle_unit_fetched` payload
 * @returns {{monster: Monster, roomLevel: number}|null}
 */
function buildSimMonster(gameUnit) {
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
        monster.updateCombatDetails();
        return { monster, roomLevel };
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
    }

    /**
     * Show (building on first use) and refresh for a freshly fetched monster.
     * @param {Object} gameUnit
     */
    showFor(gameUnit) {
        const built = buildSimMonster(gameUnit);
        const simDetails = built?.monster?.combatDetails || null;
        const comparison = buildComparison(gameUnit, simDetails);
        this.last = {
            hrid: gameUnit?.hrid,
            name: gameUnit?.name,
            roomLevel: built?.roomLevel ?? 0,
            simBuilt: Boolean(simDetails),
            ...comparison,
        };

        this._ensureBuilt();
        this.container.style.display = 'flex';
        bringPanelToFront(this.container);
        this._render(gameUnit);
    }

    close() {
        if (this.container) this.container.style.display = 'none';
    }

    /** @returns {Object|null} The most recent comparison, for the console. */
    dump() {
        if (this.last) {
            const rows = this.last.groups.flatMap((g) =>
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

    _ensureBuilt() {
        if (this.container) return;

        const container = document.createElement('div');
        container.id = PANEL_ID;
        container.style.cssText = `
            position: fixed;
            top: 15%;
            left: 50%;
            transform: translateX(-50%);
            z-index: ${config.Z_FLOATING_PANEL};
            width: 340px;
            display: flex;
            flex-direction: column;
            max-height: 70vh;
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

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.title = 'Close';
        closeBtn.style.cssText = `background: none; border: none; color: #aaa; font-size: 1.2rem; line-height: 1; cursor: pointer; padding: 0 2px;`;
        closeBtn.addEventListener('mouseenter', () => (closeBtn.style.color = '#fff'));
        closeBtn.addEventListener('mouseleave', () => (closeBtn.style.color = '#aaa'));
        closeBtn.addEventListener('click', () => this.close());

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
    }

    _render(gameUnit) {
        const body = this.body;
        body.innerHTML = '';
        const { roomLevel, groups, buffs, hasMismatch, simBuilt } = this.last;

        // Title carries the monster and its room level
        const levelLabel = roomLevel > 0 ? ` — Room ${roomLevel}` : '';
        this.titleEl.textContent = `${gameUnit?.name || 'Monster'}${levelLabel}`;

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
            buffLine.innerHTML = `<span style="color:#e0b64a;">Active buffs:</span> ${buffs.join(', ')}`;
        } else {
            buffLine.textContent = 'No active buffs — the two columns should match.';
        }
        footer.appendChild(buffLine);

        const legend = document.createElement('div');
        legend.style.cssText = 'margin-top: 4px;';
        legend.innerHTML = hasMismatch
            ? '<span style="color:#e56b6b;">⚠ off</span> = the sim disagrees with no buff to explain it.'
            : '<span style="color:#e0b64a;">≈ buff</span> = game is higher because a buff is up; the sim baseline carries none.';
        footer.appendChild(legend);

        body.appendChild(footer);
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

export default {
    name: 'Monster Stat Check',
    initialize,
    disable,
    dumpLast,
};
