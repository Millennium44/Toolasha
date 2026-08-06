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
import { damageBreakdown, battleBreakdown } from './damage-tracker.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { formatLargeNumber, formatWithSeparator } from '../../utils/formatters.js';
import { ROW_COLORS } from '../../utils/overlay-format.js';

/** Where the party's portraits live */
const PLAYERS_AREA = '[class*="BattlePanel_playersArea"]';
/** And where the things they are fighting live */
const MONSTERS_AREA = '[class*="BattlePanel_monstersArea"]';
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
export function meterText(player, current = null) {
    // Null until there is enough to divide by, which is a different thing from
    // zero and should not be drawn as one
    const rate = (value) => (value === null || value === undefined ? null : Math.round(value));

    // The rate in full and the damage abbreviated, as DPs draws it. They are read
    // differently: a rate is compared against another rate, where 1,052 against
    // 1.1K is the comparison, while a running total only has to convey a size.
    const line = (dps, damage, label) => {
        const shown = rate(dps);
        const figure = shown === null ? '—' : formatWithSeparator(shown);
        return `${figure} DPS ${formatLargeNumber(Math.round(damage || 0))} ${label}`;
    };

    // This fight above the run, as DPs has it. The order is the point: the fight
    // in front of you is the one you can still change, and the run is the
    // context you read it against.
    //
    // The cur line is always there, dashed when there is nothing to say yet.
    // It used to render only once a player had acted this fight, which gave
    // that player's tile a taller meter than their neighbours' — five portraits
    // at three different heights, shifting again at every fight boundary.
    const lines = [current ? line(current.dps, current.damage, 'cur') : '— cur'];
    lines.push(line(player.dps, player.damage, 'total'));

    return {
        lines,
        title:
            `${player.name}\n` +
            (current
                ? `This fight: ${formatLargeNumber(Math.round(current.damage || 0))} damage` +
                  (rate(current.dps) === null
                      ? ', too early for a rate.'
                      : `, ${formatWithSeparator(rate(current.dps))}/s.`)
                : '') +
            `\nThis run: ${formatLargeNumber(Math.round(player.damage || 0))} damage` +
            (rate(player.dps) === null
                ? ', not yet long enough to give a rate.'
                : `, ${formatWithSeparator(rate(player.dps))}/s.`),
    };
}

/**
 * What a monster's tile says: how fast it is being taken down.
 *
 * Per slot rather than per name, so two of the same monster side by side each
 * carry their own rate — averaging them would put a number on both tiles that
 * was true of neither.
 *
 * @param {Object} enemy - From `battleBreakdown().enemies`
 * @returns {{text: string, title: string}}
 */
export function enemyMeterText(enemy) {
    const dps = enemy.dps === null || enemy.dps === undefined ? null : Math.round(enemy.dps);

    return {
        text: dps === null ? '—' : `${formatWithSeparator(dps)}/s`,
        title:
            `${enemy.name || 'This enemy'}: ${formatWithSeparator(Math.round(enemy.damage || 0))} damage dealt to ` +
            'it this fight' +
            (dps === null ? ', too early for a rate.' : `, ${formatWithSeparator(dps)} per second.`),
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
        //
        // Coalesced to one draw per frame: the observer watches the whole app
        // (the battle panel comes and goes, so there is no stable element to
        // scope to), and a busy game tick fires it dozens of times over.
        this.observer = new MutationObserver(() => this._scheduleDraw());
        const root = document.getElementById('root') || document.body;
        this.observer.observe(root, { childList: true, subtree: true });

        this.timers.registerInterval(
            setInterval(() => {
                if (document.hidden) return;
                this._draw();
            }, REFRESH_MS)
        );
        this._draw();
    }

    disable() {
        this.observer?.disconnect();
        this.observer = null;
        this.timers.clearAll();
        if (this._drawScheduled) {
            cancelAnimationFrame(this._drawScheduled);
            this._drawScheduled = null;
        }
        for (const meter of document.querySelectorAll(`[${MARK}]`)) meter.remove();
        this.isInitialized = false;
    }

    /** At most one redraw per frame, however many mutations asked for it */
    _scheduleDraw() {
        if (this._drawScheduled) return;
        this._drawScheduled = requestAnimationFrame(() => {
            this._drawScheduled = null;
            this._draw();
        });
    }

    /** Put a meter on every portrait, and a rate on every monster */
    _draw() {
        try {
            const run = damageBreakdown();
            const fight = battleBreakdown();
            this._drawPlayers(run, fight);
            this._drawEnemies(fight);
        } catch (error) {
            console.error('[PortraitDps] Drawing the portrait meters failed:', error);
        }
    }

    /**
     * @param {Object} run - From `damageBreakdown`
     * @param {Object} fight - From `battleBreakdown`
     */
    _drawPlayers(run, fight) {
        const area = document.querySelector(PLAYERS_AREA);
        if (!area) return;

        const units = [...area.querySelectorAll(UNIT)];
        const pairs = matchPortraits(units, run.players);

        // The current-fight row is keyed by slot, and the run's row is keyed by
        // name — so the join between them goes through the name, which is the
        // only thing meaningful in both
        const currentByName = new Map();
        for (const entry of Object.values(fight.players || {})) {
            if (entry?.name) currentByName.set(entry.name, entry);
        }

        this._prune(area, new Set(pairs.map((pair) => pair.unit)));
        for (const { unit, player } of pairs) {
            this._meter(unit, meterText(player, currentByName.get(player.name) || null));
        }
    }

    /**
     * @param {Object} fight - From `battleBreakdown`
     */
    _drawEnemies(fight) {
        const area = document.querySelector(MONSTERS_AREA);
        if (!area) return;

        // Monsters are joined by slot rather than by name, which is the opposite
        // of the players and right for the opposite reason: two of the same
        // monster are two different fights, and their names cannot tell them
        // apart. A slot is stable for the length of a battle, and the tiles are
        // rebuilt when it ends.
        const units = [...area.querySelectorAll(UNIT)];
        const wanted = new Set();

        units.forEach((unit, index) => {
            const enemy = fight.enemies?.[index];
            if (!enemy) return;

            wanted.add(unit);
            this._meter(unit, enemyMeterText(enemy), true);
        });

        this._prune(area, wanted);
    }

    /**
     * Take away meters whose tile is no longer one we are drawing on.
     *
     * @param {HTMLElement} area - Players or monsters
     * @param {Set<HTMLElement>} wanted - Tiles that should keep theirs
     */
    _prune(area, wanted) {
        for (const meter of area.querySelectorAll(`[${MARK}]`)) {
            if (!wanted.has(meter.parentElement)) meter.remove();
        }
    }

    /**
     * @param {HTMLElement} unit - The tile
     * @param {{text: string, lines: Array<string>, title: string}} content - What it says
     * @param {boolean} [atBottom] - Force it under the tile, as monsters want
     */
    _meter(unit, content, atBottom = false) {
        const below = atBottom || config.getSettingValue('portraitDpsPosition', 'above') === 'below';
        const lines = content.lines || [content.text];

        let meter = unit.querySelector(`:scope > [${MARK}]`);
        if (!meter) {
            meter = document.createElement('div');
            meter.setAttribute(MARK, '1');
            // In the flow of the tile rather than positioned over it. The first
            // version hung the meter outside the tile's box at `top: -14px`,
            // which drew nothing visible: the battle panel clips its children,
            // so the meter was there and cropped away. DPs makes room for its
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
                color: ROW_COLORS.bad,
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

        const text = lines.join('\n');
        if (meter.dataset.text !== text) {
            meter.dataset.text = text;
            meter.replaceChildren();
            for (const line of lines) {
                const row = document.createElement('div');
                row.textContent = line;
                meter.appendChild(row);
            }
        }
        meter.title = content.title;
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
