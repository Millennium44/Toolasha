/**
 * Lays out the guild trial party players that wrap under the leading card in rows.
 *
 * The game draws the trial party as a flex-wrap grid: a big leading card, then columns of up
 * to three mini tiles that wrap as whole blocks. With more players than fit beside the card,
 * the extra columns wrap onto lines below it and stack into a tall narrow column. This keeps
 * the game's layout and changes only those columns: each one whose top is at or below the
 * card's bottom gets `display: contents`, so its tiles become flex items of the grid and the
 * game's own wrap runs them left to right under the card. Columns beside the card are never
 * touched. Only columns this module flattened carry `FLAT_MARK` and are restored.
 *
 * Scoped to the two trial areas, so a normal party fight is never touched. There is no phone
 * rule: flattening on a narrow screen is harmless (nothing wraps below the card there that a
 * row layout does not already improve), so the same logic runs everywhere.
 *
 * Every reader of the unit DOM in this repo walks `querySelectorAll` from the area
 * (`MiniUnit_miniUnit` / `MiniUnit_name`) and badges attach to the tile itself, so columns
 * having no box changes nothing for them.
 */

import config from '../../core/config.js';

/** The setting that turns it on and off, live */
export const SETTING = 'guildTrialPackUnits';

/** Marks a column this module flattened */
export const FLAT_MARK = 'data-toolasha-flat';

/** The trial areas (combat trial, skilling trial) and the leading card inside each */
export const AREAS = [
    { area: '[class*="BattlePanel_guildPartyArea"]', card: '[class*="CombatUnit_combatUnit"]' },
    { area: '[class*="SkillingInstancePanel_playerArea"]', card: '[class*="SkillingInstancePanel_skillingUnit"]' },
];

export const AREA_SEL = AREAS.map((a) => a.area).join(', ');
export const COLUMN_SEL = '[class*="MiniUnitGrid_miniUnitColumn"]';
export const TILE_SEL = '[class*="MiniUnit_miniUnit"]';

class GuildTrialUnitGrid {
    constructor() {
        this.unwatch = null;
        this.observer = null;
        this.raf = 0;
        this.enabled = false;
        this.onResize = () => this._schedule();
    }

    /** Follow the setting; start working when it is on */
    initialize() {
        this.unwatch?.();
        this.unwatch = config.onSettingChange(SETTING, (enabled) => (enabled ? this._start() : this._stop()));
        if (config.getSetting(SETTING, true)) this._start();
        else this._stop();
    }

    /** Stop following the setting, restore every column this module flattened */
    cleanup() {
        this.unwatch?.();
        this.unwatch = null;
        this._stop();
    }

    _start() {
        if (this.enabled) {
            this._schedule();
            return;
        }
        this.enabled = true;
        this.observer = new MutationObserver((mutations) => {
            if (mutations.some((m) => this._relevant(m))) this._schedule();
        });
        this.observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', this.onResize);
        this._schedule();
    }

    _stop() {
        this.enabled = false;
        this.observer?.disconnect();
        this.observer = null;
        window.removeEventListener('resize', this.onResize);
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = 0;
        for (const col of document.querySelectorAll(`[${FLAT_MARK}]`)) this._restore(col);
    }

    /** Cheap filter: an element was added or removed inside a trial area, or an area itself came or went */
    _relevant(m) {
        const nodes = [...m.addedNodes, ...m.removedNodes].filter((n) => n.nodeType === 1);
        if (!nodes.length) return false;
        if (m.target.closest?.(AREA_SEL)) return true;
        return nodes.some((n) => n.matches?.(AREA_SEL) || n.querySelector?.(AREA_SEL));
    }

    _schedule() {
        if (!this.enabled || this.raf) return;
        this.raf = requestAnimationFrame(() => {
            this.raf = 0;
            this._run();
        });
    }

    _restore(col) {
        col.style.display = '';
        col.removeAttribute(FLAT_MARK);
    }

    _run() {
        if (!this.enabled) return;
        // Read every position first, then write, so the layout is measured once
        const plan = [];
        for (const { area: areaSel, card: cardSel } of AREAS) {
            for (const area of document.querySelectorAll(areaSel)) {
                const card = area.querySelector(cardSel);
                if (!card) continue;
                const limit = card.getBoundingClientRect().bottom - 1;
                for (const col of area.querySelectorAll(COLUMN_SEL)) {
                    const tile = col.querySelector(TILE_SEL);
                    if (!tile) continue;
                    plan.push({ col, below: tile.getBoundingClientRect().top >= limit });
                }
            }
        }
        for (const { col, below } of plan) {
            const flat = col.hasAttribute(FLAT_MARK);
            if (below && !flat) {
                if (col.style.display) continue; // the game styled it itself
                col.style.display = 'contents';
                col.setAttribute(FLAT_MARK, '');
            } else if (!below && flat) {
                this._restore(col);
            }
        }
        // A marked column that left an area (or lost its tiles) is no longer measured; restore it
        for (const col of document.querySelectorAll(`[${FLAT_MARK}]`)) {
            if (!plan.some((p) => p.col === col)) this._restore(col);
        }
    }
}

const guildTrialUnitGrid = new GuildTrialUnitGrid();

export default {
    name: 'Guild Trial Unit Grid',
    initialize: () => guildTrialUnitGrid.initialize(),
    cleanup: () => guildTrialUnitGrid.cleanup(),
};

export { guildTrialUnitGrid };
