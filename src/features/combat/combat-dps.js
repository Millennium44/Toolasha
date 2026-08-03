/**
 * Combat DPS
 *
 * How much damage is actually going out, measured from the combat tick stream.
 *
 * ## Where the number comes from, and what it is not
 *
 * The game sends no damage figure. What it sends, several times a second while a
 * fight is on, is every combatant's current and maximum health. Damage is
 * therefore inferred: **health a monster lost between two ticks is damage
 * something did to it.** Summed over a run and divided by the time spent
 * fighting, that is damage per second.
 *
 * Two consequences worth stating plainly, because a DPS figure that quietly
 * means something else is worse than no DPS figure:
 *
 * - **It is the whole party's damage, not yours.** Nothing on the wire says who
 *   struck the blow, so in a party this is everyone's output together. Solo they
 *   are the same number. The row says which it is showing.
 * - **Overkill is not counted.** A hit that takes a monster from 40 health to
 *   dead counts 40, not whatever the hit was worth. This understates by more the
 *   harder you hit relative to what you are fighting.
 *
 * The clock runs on ticks received rather than on wall time, so time spent out
 * of combat — respawns, the gap between runs, an idle night — is not divided
 * into the total. A run that stopped an hour ago holds its last figure instead
 * of decaying towards zero.
 */

import config from '../../core/config.js';
import webSocketHook from '../../core/websocket.js';
import { damageBreakdown } from './damage-tracker.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { formatLargeNumber } from '../../utils/formatters.js';
import { rows, blank, ROW_COLORS } from '../../utils/overlay-format.js';

/** Accuracy in its own colour, so it does not read as part of the damage figure */
const ACCURACY_COLOR = '#ff9800';

/**
 * Ticks arrive about three times a second. A gap longer than this means the
 * fight stopped rather than that it was slow, so the time is not counted.
 */
const MAX_TICK_GAP_MS = 2000;

/** Below this the average is noise — a single fight says little about a build */
const MIN_SECONDS = 5;

class CombatDPS {
    constructor() {
        this.isInitialized = false;
        this.battleHandler = null;
        this.reset();
    }

    /** Forget the run and start measuring again */
    reset() {
        this.damage = 0;
        this.taken = 0;
        this.seconds = 0;
        this.lastTickAt = 0;
        this.monsterHp = new Map();
        this.playerHp = new Map();
        this.partySize = 1;
        this.battleId = null;
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('combatDps', true)) return;
        this.isInitialized = true;

        this.battleHandler = (data) => this._onBattleUpdated(data);
        webSocketHook.on('battle_updated', this.battleHandler);
    }

    disable() {
        if (this.battleHandler) {
            webSocketHook.off('battle_updated', this.battleHandler);
            this.battleHandler = null;
        }
        this.reset();
        this.isInitialized = false;
    }

    /** Damage per second dealt so far, or null when too little has been seen */
    get dps() {
        if (this.seconds < MIN_SECONDS) return null;
        return this.damage / this.seconds;
    }

    /** Damage per second taken so far, or null */
    get dtps() {
        if (this.seconds < MIN_SECONDS) return null;
        return this.taken / this.seconds;
    }

    /**
     * Fold one combat tick into the running totals.
     * @param {Object} data - `battle_updated` payload
     */
    _onBattleUpdated(data) {
        try {
            const now = Date.now();

            // A new battle is a new set of monsters, so last tick's health is
            // about somebody else and comparing against it would count a fresh
            // monster's full health as damage
            if (data?.battleId !== this.battleId) {
                this.battleId = data?.battleId;
                this.monsterHp.clear();
                this.playerHp.clear();
            }

            this.damage += this._foldSide(data?.mMap, this.monsterHp);
            this.taken += this._foldSide(data?.pMap, this.playerHp);

            const players = Object.keys(data?.pMap || {}).length;
            if (players > 0) this.partySize = players;

            // Only the gap between two ticks of the same fight is time spent
            // fighting; the first tick after a break contributes none
            const gap = now - this.lastTickAt;
            if (this.lastTickAt && gap > 0 && gap < MAX_TICK_GAP_MS) {
                this.seconds += gap / 1000;
            }
            this.lastTickAt = now;
        } catch (error) {
            console.error('[CombatDPS] Reading a combat tick failed:', error);
        }
    }

    /**
     * Health lost across one side since the last tick.
     *
     * Health going **up** is a heal or a replacement, never negative damage, so
     * it is recorded and not counted. Treating it as damage of the other sign
     * would let a healer's output cancel the party's.
     *
     * @param {Object} unitMap - `mMap` or `pMap`
     * @param {Map} previous - Last tick's health, updated in place
     * @returns {number} Damage since the last tick
     */
    _foldSide(unitMap, previous) {
        let lost = 0;
        for (const [slot, unit] of Object.entries(unitMap || {})) {
            const current = Number(unit?.cHP);
            if (!Number.isFinite(current)) continue;

            const before = previous.get(slot);
            if (Number.isFinite(before) && current < before) lost += before - current;
            previous.set(slot, current);
        }
        return lost;
    }
}

const combatDPS = new CombatDPS();

/**
 * A line per player, then the total, which is DPs' shape.
 *
 * A party figure says the group is doing damage and not who is doing it, and
 * "who" is the whole question when somebody is under-geared for the zone. It
 * needs attribution, so it is drawn only when the Damage Tracker has some.
 *
 * The lines and the total both come from attribution rather than the total
 * coming from this module's own health-diff figure. The two measure different
 * things — health lost includes bleeds nobody cast — and a total that did not
 * equal the sum of the lines above it would read as an arithmetic bug.
 *
 * @param {HTMLElement} container - The tile
 * @param {Object} breakdown - From `damageBreakdown`
 */
/**
 * A DPS figure, to a decimal where a decimal means something.
 *
 * DPs writes 347.6 rather than 348, and at these magnitudes the tenth is a real
 * distinction — it is the figure people watch move as they change a rotation.
 * Past ten thousand it is noise on a number that no longer fits, so the compact
 * form takes over.
 *
 * @param {number} value - Damage per second
 * @returns {string}
 */
function dpsFigure(value) {
    return value < 10_000 ? value.toFixed(1) : formatLargeNumber(Math.round(value));
}

function drawPerPlayer(container, breakdown) {
    const lines = [];
    let total = 0;

    for (const player of breakdown.players) {
        if (player.dps === null) continue;
        total += player.dps;

        lines.push([
            { text: player.name, color: ROW_COLORS.gold, ellipsis: true },
            { text: dpsFigure(player.dps), color: ROW_COLORS.good },
            {
                // Null accuracy is no swings seen, which is not a 0% hit rate
                text: player.accuracy === null ? '--' : `${(player.accuracy * 100).toFixed(1)}%`,
                color: ACCURACY_COLOR,
            },
        ]);
    }

    lines.push([
        { text: 'Total DPS', color: ROW_COLORS.neutral, bold: true },
        { text: dpsFigure(total), color: ROW_COLORS.good, bold: true },
    ]);

    // Aligned: the player rows and the total are the same measurement, and a
    // total sitting a few pixels off the figure above it makes a reader check
    // whether it is even the same kind of number
    rows(container, lines, { align: true });
    container.title =
        'Damage per second and hit rate, per player, from attributed hits.\n' +
        'The caster is whoever’s mana fell on the tick, since the game attributes nothing.\n' +
        'Double-click for the breakdown by ability.';
}

registerRow({
    key: 'dps',
    empty: 'No damage tracked yet',
    name: 'DPS',
    defaultSize: { width: 200, height: 46 },
    render: (container) => {
        // Attribution first, because per player is the answer people want; the
        // health-diff figure is the fallback for when it is turned off
        const breakdown = damageBreakdown();
        if (breakdown.players.some((player) => player.dps !== null)) {
            return drawPerPlayer(container, breakdown);
        }

        const dealt = combatDPS.dps;
        if (dealt === null) return blank(container);

        const solo = combatDPS.partySize <= 1;
        rows(container, [
            [
                // Named for what it measures — in a party this is everyone's
                // damage, and calling it yours would be a plainly wrong number
                { text: solo ? 'DPS' : `Party DPS ×${combatDPS.partySize}`, color: ROW_COLORS.dim },
                { text: formatLargeNumber(Math.round(dealt)), color: ROW_COLORS.good, bold: true, push: true },
            ],
            [
                { text: 'Taken', color: ROW_COLORS.dim },
                { text: formatLargeNumber(Math.round(combatDPS.dtps || 0)), color: ROW_COLORS.bad, push: true },
            ],
        ]);
        container.title =
            'Damage inferred from health lost between combat ticks, over time spent in combat.\n' +
            'Overkill is not counted — a hit that takes a monster from 40 to dead counts 40.\n' +
            (solo ? '' : 'In a party this is the whole party\u2019s damage; nothing on the wire says who struck.') +
            '\nTurn the Damage Tracker on for a line per player.';
    },
    // The panel behind it: a DPS figure alone cannot say whether you are
    // winning the exchange or merely surviving it
    onOpen: () => window.Toolasha?.UI?.dpsPanel?.toggle(),
});

export default combatDPS;
