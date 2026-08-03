/**
 * Portrait DPS
 *
 * Each character's damage, drawn on their own portrait in the battle panel.
 *
 * The DPS tile already ranks the party, and a ranked list is the wrong shape for
 * the question people actually ask mid-fight, which is "is *that* one pulling
 * their weight" while looking straight at them. A figure on the portrait answers
 * it without a lookup between a name in a list and a face in a row.
 *
 * ## Matched by name, not by position
 *
 * The obvious join is index: the payload's player 0 is the leftmost portrait.
 * It is also the join that produced the bug this script has already had once —
 * a slot is a position in *this* fight, and the moment somebody leaves, every
 * index after them means a different person. The portraits carry their names in
 * the DOM, so the name is the join, and a portrait whose name is not in the
 * tally simply gets nothing rather than getting somebody else's damage.
 *
 * ## Attaching to a panel React owns
 *
 * The battle panel is rebuilt by the game whenever the fight changes, taking any
 * injected node with it. So the meters are re-attached on a `MutationObserver`
 * rather than created once, and each one is tagged with a `data-` attribute so a
 * rebuild that *did* keep them does not produce two.
 *
 * The class names carry a build hash — `CombatUnit_combatUnit__1p2q3` — which
 * changes with every game update, so every selector here is a prefix match. This
 * is the most fragile feature in the script for that reason: it reaches into the
 * game's own DOM rather than into the payload. It fails by drawing nothing.
 *
 * The idea is DPs', from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import config from '../../core/config.js';
import { damageBreakdown } from './damage-tracker.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { formatLargeNumber } from '../../utils/formatters.js';
import { ROW_COLORS } from '../../utils/overlay-format.js';

/** Where the party's portraits live */
const PLAYERS_AREA = '[class*="BattlePanel_playersArea"]';
/** One character's tile inside it */
const UNIT = '[class*="CombatUnit_combatUnit"]';
/** The name inside a tile, which is what a meter is matched on */
const UNIT_NAME = '[class*="CombatUnit_name"]';

/** Marks a meter as ours, so a rebuild cannot leave two */
const MARK = 'data-toolasha-portrait-dps';

/** Slow enough not to fight the game's own redraw, fast enough to feel live */
const REFRESH_MS = 1000;

/**
 * The name shown on a portrait.
 *
 * @param {HTMLElement} unit - A combat unit tile
 * @returns {string} Trimmed name, or '' when the tile has none
 */
export function portraitName(unit) {
    return unit?.querySelector(UNIT_NAME)?.textContent?.trim() || '';
}

/**
 * Pair each portrait with the tally row belonging to the character on it.
 *
 * Exported for its own sake: this is the whole of the logic worth testing, and
 * it is testable without a battle panel.
 *
 * @param {Array<HTMLElement>} units - Portrait tiles, in DOM order
 * @param {Array<Object>} players - From `damageBreakdown().players`
 * @returns {Array<{unit: HTMLElement, player: Object}>} Only the matches
 */
export function matchPortraits(units, players) {
    const byName = new Map();
    for (const player of players || []) {
        if (player?.name) byName.set(player.name, player);
    }

    const pairs = [];
    for (const unit of units || []) {
        const player = byName.get(portraitName(unit));
        // No match is no meter. The alternative — falling back to position —
        // is what puts one character's damage on another's face the moment
        // somebody leaves the party.
        if (player) pairs.push({ unit, player });
    }
    return pairs;
}

/**
 * What a meter says.
 *
 * DPS first because it is the comparable figure — total damage rewards whoever
 * has been in the fight longest, which in a party is everybody equally and after
 * a death is not.
 *
 * @param {Object} player - From `damageBreakdown().players`
 * @returns {{text: string, title: string}}
 */
export function meterText(player) {
    // Null until the run is long enough to divide by, which is a different
    // thing from zero and should not be drawn as one
    const dps = player.dps === null || player.dps === undefined ? null : Math.round(player.dps);
    const damage = formatLargeNumber(Math.round(player.damage || 0));

    return {
        text: dps === null ? `— ${damage}` : `${formatLargeNumber(dps)} dps  ${damage}`,
        title:
            `${player.name}: ${formatLargeNumber(Math.round(player.damage || 0))} damage this run` +
            (dps === null ? ', not yet long enough to give a rate.' : `, ${formatLargeNumber(dps)} per second.`),
    };
}

class PortraitDps {
    constructor() {
        this.isInitialized = false;
        this.observer = null;
        this.timers = createTimerRegistry();
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('portraitDps')) return;
        this.isInitialized = true;

        // Two triggers, and both are needed. The observer catches the panel
        // being rebuilt — which is when the meters are lost — and the timer
        // keeps the figures moving between rebuilds.
        this.observer = new MutationObserver(() => this._draw());
        const root = document.getElementById('root') || document.body;
        this.observer.observe(root, { childList: true, subtree: true });

        this.timers.registerInterval(setInterval(() => this._draw(), REFRESH_MS));
        this._draw();
    }

    disable() {
        this.observer?.disconnect();
        this.observer = null;
        this.timers.clearAll();
        for (const meter of document.querySelectorAll(`[${MARK}]`)) meter.remove();
        this.isInitialized = false;
    }

    /** Put a meter on every portrait whose character is in the tally */
    _draw() {
        try {
            const area = document.querySelector(PLAYERS_AREA);
            if (!area) return;

            const units = [...area.querySelectorAll(UNIT)];
            if (!units.length) return;

            const { players } = damageBreakdown();
            const pairs = matchPortraits(units, players);

            // Meters whose portrait has gone — somebody left, or the fight
            // changed shape — rather than left behind pointing at nobody
            const wanted = new Set(pairs.map((pair) => pair.unit));
            for (const meter of area.querySelectorAll(`[${MARK}]`)) {
                if (!wanted.has(meter.parentElement)) meter.remove();
            }

            for (const { unit, player } of pairs) this._meter(unit, player);
        } catch (error) {
            console.error('[PortraitDps] Drawing the portrait meters failed:', error);
        }
    }

    /**
     * @param {HTMLElement} unit - The portrait tile
     * @param {Object} player - Their row from the tally
     */
    _meter(unit, player) {
        const below = config.getSettingValue('portraitDpsPosition', 'above') === 'below';
        const { text, title } = meterText(player);

        let meter = unit.querySelector(`:scope > [${MARK}]`);
        if (!meter) {
            meter = document.createElement('div');
            meter.setAttribute(MARK, '1');
            // In the flow of the tile rather than positioned over it. The first
            // version hung the meter outside the tile's box at `top: -14px`,
            // which drew nothing visible: the battle panel clips its children,
            // so the meter was there and cropped away. MCS makes room for its
            // own lines the same way — the tile simply gets taller.
            Object.assign(meter.style, {
                textAlign: 'center',
                fontSize: '11px',
                fontWeight: 'bold',
                lineHeight: '1.25',
                pointerEvents: 'none',
                textShadow: '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                padding: '1px 2px',
            });
        }

        // Re-seated on every draw, because the setting can move between renders
        // and because React rebuilding the tile puts its own children back in
        // whatever order it likes
        const wanted = below ? unit.lastElementChild : unit.firstElementChild;
        if (wanted !== meter) {
            if (below) unit.appendChild(meter);
            else unit.insertBefore(meter, unit.firstChild);
        }

        meter.style.color = player.dps === null || player.dps === undefined ? ROW_COLORS.dim : ROW_COLORS.gold;
        if (meter.textContent !== text) meter.textContent = text;
        meter.title = title;
    }
}

const portraitDps = new PortraitDps();

export default {
    name: 'Portrait DPS',
    initialize: () => portraitDps.initialize(),
    cleanup: () => portraitDps.disable(),
    /** Draw now rather than on the next tick — for tests, and for a settings change */
    redraw: () => portraitDps._draw(),
};
