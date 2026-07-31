/**
 * Combat Panel Scale
 *
 * Resize the two sides of the battle panel independently, and choose how they
 * sit relative to each other.
 *
 * A ten-monster wave and a solo fight get the same slab of screen, so one is
 * cramped and the other is mostly empty — and the character panel beside it
 * takes whatever is left over. The right answer differs per character: a
 * ranged build watching cooldowns wants the enemy side big, an idler wants the
 * whole fight small and the inventory tall. Toolasha's settings are stored per
 * character already, so each one keeps its own arrangement without any of this
 * having to know that.
 *
 * The technique is from **Scaley Way Idle** by Frotty; see
 * docs/THIRD-PARTY-LICENSES.md. Written fresh against Toolasha's settings and
 * style helpers rather than copied, and it differs in three ways that matter:
 *
 * - **Stylesheet, not per-element inline styles.** The original re-ran a
 *   `querySelectorAll` sweep from a `MutationObserver` on the whole body, which
 *   fires on every combat tick. A rule matches whatever React renders next
 *   without anything having to watch for it.
 * - **Class-prefix selectors.** The original pinned exact CSS-module hashes
 *   (`BattlePanel_playersArea__vvwlB`). Those are regenerated on every game
 *   build, so a script written that way stops working silently at the next
 *   patch and looks merely broken rather than out of date.
 * - **`zoom` by default.** `transform: scale()` leaves the original layout box
 *   behind, so a shrunk side keeps its full-size gap — which is why the
 *   original needs a spacer element and a forced 50/50 split to look right.
 *   `zoom` reflows, so the space is actually recovered. `transform` is still
 *   available for anyone who wants the old behaviour.
 */

import config from '../../core/config.js';
import { addStyles, removeStyles } from '../../utils/dom.js';

const STYLE_ID = 'mwi-combat-panel-scale';

/** Every setting that changes the sheet, so one list drives watch and rebuild */
const WATCHED = [
    'combatScale',
    'combatScalePlayers',
    'combatScaleMonsters',
    'combatScaleMethod',
    'combatScaleOrigin',
    'combatScaleLayout',
    'combatScalePanelHeight',
];

const PLAYERS = '[class*="BattlePanel_playersArea"]';
const MONSTERS = '[class*="BattlePanel_monstersArea"]';
const BATTLE_AREA = '[class*="BattlePanel_battleArea"]';
const UNIT_GRID = '[class*="BattlePanel_combatUnitGrid"]';
const RIGHT_PANEL = '[class*="GamePage_characterManagementPanel"]';

/**
 * Read a percentage setting back as a multiplier.
 * @param {string} key - Setting key
 * @returns {number} 0.25..2, defaulting to 1
 */
function scaleOf(key) {
    const pct = Number(config.getSettingValue(key, 100));
    if (!Number.isFinite(pct) || pct <= 0) return 1;
    return Math.min(2, Math.max(0.25, pct / 100));
}

/**
 * The declarations that shrink one side.
 *
 * `zoom` is a single declaration and reflows, which is the whole reason it is
 * the default. `transform` needs an origin and leaves its layout box at full
 * size, so it is paired with a negative margin that reclaims the difference —
 * without that, shrinking a side to 50% leaves half the panel blank and the
 * original's forced 50/50 split is the only thing hiding it.
 *
 * @param {number} scale - Multiplier
 * @param {string} method - 'zoom' or 'transform'
 * @param {string} origin - transform-origin, when transforming
 * @returns {string} CSS declarations
 */
function scaleRule(scale, method, origin) {
    if (scale === 1) return '';
    if (method === 'transform') {
        const reclaim = (1 - scale) * 100;
        return (
            `transform: scale(${scale}) !important;` +
            `transform-origin: ${origin} !important;` +
            `margin-bottom: -${reclaim}% !important;`
        );
    }
    return `zoom: ${scale} !important;`;
}

/**
 * How the two sides sit relative to each other.
 *
 * 'game' emits nothing at all. The original always forced a side-by-side 50/50
 * split, which is a whole layout rewrite to accept for the sake of making the
 * sprites smaller — and it is the change most likely to fight whatever the game
 * does next. Leaving the layout alone is the default, and the override is there
 * for people who actually want it.
 *
 * @param {string} layout - 'game', 'side', or 'stack'
 * @returns {string} CSS
 */
function layoutRules(layout) {
    if (layout === 'side') {
        return `
            ${BATTLE_AREA} {
                display: flex !important;
                flex-direction: row !important;
                flex-wrap: nowrap !important;
                align-items: flex-start !important;
            }
            ${PLAYERS}, ${MONSTERS} {
                flex: 1 1 50% !important;
                min-width: 0 !important;
            }
        `;
    }
    if (layout === 'stack') {
        return `
            ${BATTLE_AREA} {
                display: flex !important;
                flex-direction: column !important;
                align-items: stretch !important;
            }
            ${PLAYERS}, ${MONSTERS} {
                flex: 0 0 auto !important;
                max-width: none !important;
            }
        `;
    }
    return '';
}

/** The character panel's height, in vh. Zero leaves the game's own. */
function panelHeightRules() {
    const vh = Number(config.getSettingValue('combatScalePanelHeight', 0));
    if (!Number.isFinite(vh) || vh <= 0) return '';
    return `
        ${RIGHT_PANEL} {
            height: ${Math.min(100, Math.max(20, vh))}vh !important;
            overflow-y: auto !important;
        }
    `;
}

/**
 * Build the whole sheet from the current settings.
 * @returns {string} CSS, empty when nothing is being overridden
 */
export function buildCombatScaleCSS() {
    const method = config.getSettingValue('combatScaleMethod', 'zoom') === 'transform' ? 'transform' : 'zoom';
    const origin = config.getSettingValue('combatScaleOrigin', 'top center');
    const players = scaleRule(scaleOf('combatScalePlayers'), method, origin);
    const monsters = scaleRule(scaleOf('combatScaleMonsters'), method, origin);

    const parts = [];
    if (players) parts.push(`${PLAYERS} ${UNIT_GRID} { ${players} }`);
    if (monsters) parts.push(`${MONSTERS} ${UNIT_GRID} { ${monsters} }`);
    parts.push(layoutRules(config.getSettingValue('combatScaleLayout', 'game')));
    parts.push(panelHeightRules());

    return parts.filter(Boolean).join('\n');
}

const combatPanelScale = {
    watchers: null,

    apply() {
        removeStyles(STYLE_ID);
        if (!config.getSetting('combatScale')) return;

        const css = buildCombatScaleCSS();
        if (css) addStyles(css, STYLE_ID);
    },

    initialize() {
        // Every knob rebuilds the sheet where you turned it. Finding the right
        // scale is a matter of nudging a number and looking at the result, and
        // a reload between each nudge would make that unusable — which is the
        // one thing the original's floating panel with its Apply button had
        // going for it over living in a settings page.
        if (!this.watchers) {
            this.watchers = WATCHED.map((key) => {
                const handler = () => this.apply();
                config.onSettingChange(key, handler);
                return { key, handler };
            });
        }
        this.apply();
    },

    disable() {
        removeStyles(STYLE_ID);
        for (const { key, handler } of this.watchers || []) config.offSettingChange(key, handler);
        this.watchers = null;
    },
};

export default combatPanelScale;
