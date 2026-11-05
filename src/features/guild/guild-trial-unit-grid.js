/**
 * Packs the party tiles of a guild trial fight into fewer rows.
 *
 * The game lays the trial party out as one wide card (the watcher's own unit) and
 * columns of three mini units that wrap as whole blocks, which leaves a ragged,
 * tall area. One stylesheet turns the grid into a CSS grid of 48 px cells: the card
 * spans 3 columns by 3 rows, the minis flow around it, and the columns stop being
 * boxes (`display: contents`), so each mini becomes a grid item itself.
 *
 * Scoped under `BattlePanel_guildPartyArea`, the trial fight's party area, so a
 * normal party fight is never touched. Phones keep the game's own layout: below
 * `PHONE_MIN_WIDTH` the area is too narrow for the card's three columns.
 *
 * Every reader of the unit DOM in this repo walks `querySelectorAll` from the area
 * (`MiniUnit_miniUnit` / `MiniUnit_name`), and badges attach to the tile itself, so
 * the columns having no box changes nothing for them.
 */

import config from '../../core/config.js';

/** The setting that turns it on and off, live */
export const SETTING = 'guildTrialPackUnits';

/** Marks the injected stylesheet */
export const STYLE_MARK = 'data-toolasha-trial-unit-grid';

/** Below this viewport width the game's own layout is kept */
export const PHONE_MIN_WIDTH = 480;

/** The trial fight's party area; a normal party fight uses other containers */
export const AREA_SEL = '[class*="BattlePanel_guildPartyArea"]';

/** The stylesheet text */
export const GRID_CSS = `@media (min-width: ${PHONE_MIN_WIDTH}px) {
${AREA_SEL} [class*="MiniUnitGrid_miniUnitGrid"] { display: grid !important; grid-template-columns: repeat(auto-fill, 48px); gap: 4px; grid-auto-flow: row dense; align-content: start; }
${AREA_SEL} [class*="MiniUnitGrid_miniUnitGrid"] > [class*="CombatUnit_combatUnit"] { grid-column: span 3; grid-row: span 3; }
${AREA_SEL} [class*="MiniUnitGrid_miniUnitColumn"] { display: contents !important; }
}`;

class GuildTrialUnitGrid {
    constructor() {
        this.unwatch = null;
        this.styleEl = null;
    }

    /** Follow the setting, and apply the stylesheet when it is on */
    initialize() {
        this.unwatch?.();
        this.unwatch = config.onSettingChange(SETTING, (enabled) => (enabled ? this._apply() : this._remove()));
        if (config.getSetting(SETTING, true)) this._apply();
        else this._remove();
    }

    /** Stop following the setting, and take the stylesheet down */
    cleanup() {
        this.unwatch?.();
        this.unwatch = null;
        this._remove();
    }

    _apply() {
        if (this.styleEl?.isConnected) return;
        this.styleEl = document.createElement('style');
        this.styleEl.setAttribute(STYLE_MARK, '');
        this.styleEl.textContent = GRID_CSS;
        document.head.appendChild(this.styleEl);
    }

    _remove() {
        this.styleEl?.remove();
        this.styleEl = null;
    }
}

const guildTrialUnitGrid = new GuildTrialUnitGrid();

export default {
    name: 'Guild Trial Unit Grid',
    initialize: () => guildTrialUnitGrid.initialize(),
    cleanup: () => guildTrialUnitGrid.cleanup(),
};

export { guildTrialUnitGrid };
