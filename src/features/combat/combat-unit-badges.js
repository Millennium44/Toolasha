/**
 * Combat unit badges
 *
 * Each party member's share of the damage, on the face of the person doing it.
 *
 * The DPS panel and the trial scoreboard both rank the party, and a ranked list
 * is the wrong shape for the question asked mid-fight — "is *that* one pulling
 * their weight" while looking straight at them. `portrait-dps.js` already
 * answers the rate half of that for this client's own fights. Two things it
 * does not do, and this file exists for both:
 *
 * - **The share.** A rate is only readable against the party's; "1.2K/s" says
 *   nothing without knowing whether that is a third of the party or a
 *   twentieth. The share is the figure a guild argues about.
 * - **A guild trial.** A trial fight runs on the server and reaches this client
 *   over `guild_battle_updated`, not over its own battle feed — so the damage
 *   tracker knows nothing about it, and the fight view's portraits sit there
 *   unlabelled through the one fight where twenty names most need telling
 *   apart. The trial split is read through `liveTrialSplit`, which is the
 *   attribution module's own summary; no arithmetic is repeated here.
 *
 * ## Where the badge is anchored, and why it keeps coming back
 *
 * On the tile, in its flow, as the last child — the battle panel clips its
 * children, so anything hung outside the tile's box is drawn and cropped away.
 * Tiles come in two shapes and both are badged: the full `CombatUnit` card, and
 * the `MiniUnit` line the game draws for everybody except the watcher in a
 * spectated trial. A trial where only one of twenty-odd portraits could carry a
 * figure would be the feature's worst case, and the mini units are the twenty.
 *
 * The join is the **name** on the tile, never its position. A slot is a
 * position in this fight; the moment somebody leaves, every index after them
 * means a different person, and a badge joined by index puts one player's
 * damage on another's face. A tile whose name is not in the table gets no badge
 * rather than somebody else's.
 *
 * Every selector is a prefix match, because the game's class names carry a
 * build hash (`CombatUnit_combatUnit__1p2q3`) that changes with every update.
 * This is the fragile end of the script and it fails by drawing nothing.
 *
 * ## Re-attaching, which is the whole lifecycle problem
 *
 * React rebuilds the battle panel whenever the fight changes and whenever the
 * Combat tab is left and returned to, taking every injected node with it.
 * Anchors captured once go stale — the failure KikiMeter documents and solves
 * by re-attaching on an observer. Same answer here, in this fork's own shape:
 * the badges are re-drawn from scratch on a `domObserver` registration
 * (debounced, because a game tick fires it dozens of times over) and on a
 * one-second timer, and each badge carries a `data-` attribute so a rebuild
 * that *did* keep it produces one badge rather than two.
 *
 * A tick never writes to the DOM. The timer is the only cadence, and a draw
 * that produces the same text as the last one touches nothing.
 *
 * Off by default: the portraits are already carrying health, mana and an
 * ability bar, and a purely visual addition to a crowded tile should be asked
 * for rather than assumed.
 *
 * The idea of a per-unit live meter is DPs', from MWI Combat Suite by Frotty
 * (MIT), and of a class-and-share readout in a trial KikiMeter's by ZhuLiMoon
 * (MIT) — see `third-party/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { liveTrialSplit } from '../guild/guild-trial-damage.js';
import { damageBreakdown } from './damage-tracker.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { formatLargeNumber, formatWithSeparator } from '../../utils/formatters.js';
import { ROW_COLORS } from '../../utils/overlay-format.js';
import { GAME } from '../../utils/selectors.js';

/** Where the party's tiles live, as opposed to the monsters' */
const PLAYERS_AREA = '[class*="BattlePanel_playersArea"]';

/** Marks a badge as ours, so a rebuild cannot leave two */
export const BADGE_MARK = 'data-toolasha-unit-badge';

/** Slow enough not to fight the game's own redraw, fast enough to read as live */
export const REFRESH_MS = 1000;

/**
 * Below this share a badge is drawn dim rather than in the party colour.
 *
 * Not a judgement about the player — a support build is meant to be down here —
 * but about the figure: a share this small is inside the attribution's own
 * error on a crowded tick, and drawing it as boldly as a 30% share claims a
 * precision the measurement does not have.
 */
export const DIM_SHARE_PCT = 5;

/**
 * The rows to badge with, and where they came from.
 *
 * The trial wins whenever it is live, because during a trial this client's own
 * damage tracker is measuring side-combat — a member farming a zone while the
 * trial runs on the server — and badging portraits in the trial's fight view
 * with a zone's figures would be worse than badging nothing.
 *
 * @param {Object} [sources] - Injectable for tests
 * @param {Function} [sources.trial] - `liveTrialSplit`
 * @param {Function} [sources.run] - `damageBreakdown`
 * @returns {{players: Array<Object>, source: 'trial'|'run'}} Rows and their provenance
 */
export function badgeSource({ trial = liveTrialSplit, run = damageBreakdown } = {}) {
    const live = trial();
    if (live?.players?.length) return { players: live.players, source: 'trial' };
    return { players: run()?.players || [], source: 'run' };
}

/**
 * The rows keyed by the name they will be matched to a tile by.
 *
 * Lowercased, because a fight view's spelling of a name and a payload's are not
 * guaranteed to agree on case and a mismatch here is a missing badge. The first
 * row for a name wins: the tables are sorted biggest-first, so a duplicate name
 * (which should not happen, and has) resolves to the larger figure rather than
 * to whichever was iterated last.
 *
 * `share` is computed here when the source did not carry one — the trial
 * summary states it, the personal breakdown does not — as a ratio over the same
 * `damage` totals that table already holds. That is a division, not a second
 * attribution.
 *
 * @param {Array<Object>} players - From {@link badgeSource}
 * @returns {Map<string, Object>} Lowercased name → `{name, dps, damage, share}`
 */
export function badgeRows(players) {
    const total = (players || []).reduce((sum, player) => sum + (Number(player?.damage) || 0), 0);

    const rows = new Map();
    for (const player of players || []) {
        const name = String(player?.name || '').trim();
        if (!name) continue;

        const key = name.toLowerCase();
        if (rows.has(key)) continue;

        const damage = Number(player.damage) || 0;
        const share = Number.isFinite(player.share) ? player.share : total > 0 ? (damage / total) * 100 : null;
        rows.set(key, { name, dps: player.dps ?? null, damage, share });
    }
    return rows;
}

/**
 * What one badge says, and what it says when hovered.
 *
 * The rate first because it is the comparable figure, the share second because
 * it is the one that needs the rate to mean anything. Both dash rather than
 * showing a zero when they are unknown: too early for a rate is a different
 * statement from a rate of nothing, and drawing the second reads as an
 * accusation.
 *
 * @param {Object} row - From {@link badgeRows}
 * @param {string} [source] - `'trial'` or `'run'`, for the tooltip's wording
 * @returns {{text: string, color: string, title: string}}
 */
export function badgeText(row, source = 'run') {
    const rate = row?.dps === null || row?.dps === undefined ? null : Math.round(row.dps);
    const share = Number.isFinite(row?.share) ? row.share : null;

    const rateText = rate === null ? '—' : `${formatWithSeparator(rate)}/s`;
    const shareText = share === null ? '—' : `${share.toFixed(share >= 10 ? 0 : 1)}%`;

    const color = share === null ? ROW_COLORS.dim : share < DIM_SHARE_PCT ? ROW_COLORS.dim : ROW_COLORS.gold;

    const where =
        source === 'trial'
            ? 'Measured off the spectated guild trial stream'
            : 'Measured off this client’s own battle feed';

    return {
        text: `${rateText} · ${shareText}`,
        color,
        title:
            `${row?.name || 'This player'}: ${formatLargeNumber(Math.round(row?.damage || 0))} damage` +
            (rate === null ? ', too early for a rate.' : `, ${formatWithSeparator(rate)} per second.`) +
            (share === null ? '' : ` That is ${share.toFixed(1)}% of the split.`) +
            `\n${where}. A share is of the damage this client could attribute, ` +
            'which in a big party is not all of it.',
    };
}

/**
 * Pair each tile with the row belonging to the player on it.
 *
 * @param {Array<HTMLElement>} tiles - `{el, name}` candidates, in DOM order
 * @param {Map<string, Object>} rows - From {@link badgeRows}
 * @returns {Array<{el: HTMLElement, row: Object}>} Only the matches
 */
export function matchTiles(tiles, rows) {
    const pairs = [];
    for (const tile of tiles || []) {
        const row = rows?.get(
            String(tile?.name || '')
                .trim()
                .toLowerCase()
        );
        // No match is no badge. Falling back to position is what puts one
        // character's damage on another's face the moment somebody leaves
        if (row && tile.el) pairs.push({ el: tile.el, row });
    }
    return pairs;
}

/**
 * Every party tile in an area, full cards and mini lines alike, with its name.
 *
 * @param {Element} area - The players area
 * @returns {Array<{el: HTMLElement, name: string}>} Tiles in DOM order
 */
export function partyTiles(area) {
    if (!area?.querySelectorAll) return [];

    const tiles = [];
    for (const el of area.querySelectorAll(`${GAME.COMBAT_UNIT}, ${GAME.MINI_UNIT}`)) {
        const name =
            el.querySelector(GAME.COMBAT_UNIT_NAME)?.textContent?.trim() ||
            el.querySelector(GAME.MINI_UNIT_NAME)?.textContent?.trim() ||
            '';
        if (name) tiles.push({ el, name });
    }
    return tiles;
}

class CombatUnitBadges {
    constructor() {
        this.isInitialized = false;
        this.unregister = null;
        this.timers = createTimerRegistry();
        this.drawScheduled = null;
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('combatUnitBadges')) return;
        this.isInitialized = true;

        // Two triggers, and both are needed. The observer catches the panel
        // being rebuilt — leaving the Combat tab and coming back, or a fight
        // ending — which is when the badges are lost; the timer keeps the
        // figures moving between rebuilds.
        this.unregister = domObserver.onClass(
            'CombatUnitBadges',
            ['BattlePanel_playersArea', 'CombatUnit_combatUnit', 'MiniUnit_miniUnit'],
            () => this._scheduleDraw(),
            // A busy tick fires this dozens of times over; the max wait keeps a
            // continuously churning panel from deferring the redraw forever
            { debounce: true, debounceDelay: 150, debounceMaxWait: 1000 }
        );

        this.timers.registerInterval(
            setInterval(() => {
                if (typeof document !== 'undefined' && document.hidden) return;
                this._draw();
            }, REFRESH_MS)
        );
        this._draw();
    }

    disable() {
        this.unregister?.();
        this.unregister = null;
        this.timers.clearAll();
        if (this.drawScheduled !== null) {
            clearTimeout(this.drawScheduled);
            this.drawScheduled = null;
        }
        if (typeof document !== 'undefined') {
            for (const badge of document.querySelectorAll(`[${BADGE_MARK}]`)) badge.remove();
        }
        this.isInitialized = false;
    }

    /** At most one redraw per frame's worth of mutations, however many asked for it */
    _scheduleDraw() {
        if (this.drawScheduled !== null) return;
        this.drawScheduled = setTimeout(() => {
            this.drawScheduled = null;
            this._draw();
        }, 0);
    }

    /** Put a badge on every party tile whose player is in the table */
    _draw() {
        try {
            const area = typeof document === 'undefined' ? null : document.querySelector(PLAYERS_AREA);
            if (!area) return;

            const { players, source } = badgeSource();
            const pairs = matchTiles(partyTiles(area), badgeRows(players));

            this._prune(area, new Set(pairs.map((pair) => pair.el)));
            for (const { el, row } of pairs) this._badge(el, badgeText(row, source));
        } catch (error) {
            console.error('[CombatUnitBadges] Drawing the unit badges failed:', error);
        }
    }

    /**
     * Take away badges whose tile is no longer one we are drawing on.
     * @param {Element} area - The players area
     * @param {Set<HTMLElement>} wanted - Tiles that should keep theirs
     */
    _prune(area, wanted) {
        for (const badge of area.querySelectorAll(`[${BADGE_MARK}]`)) {
            if (!wanted.has(badge.parentElement)) badge.remove();
        }
    }

    /**
     * @param {HTMLElement} tile - The unit tile
     * @param {{text: string, color: string, title: string}} content - What it says
     */
    _badge(tile, content) {
        let badge = tile.querySelector(`:scope > [${BADGE_MARK}]`);
        if (!badge) {
            badge = document.createElement('div');
            badge.setAttribute(BADGE_MARK, '1');
            Object.assign(badge.style, {
                textAlign: 'center',
                fontSize: '10px',
                fontWeight: 'bold',
                lineHeight: '1.2',
                pointerEvents: 'none',
                textShadow: '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                padding: '0 2px',
            });
        }

        // Re-seated on every draw, because React puts its own children back in
        // whatever order it likes when it rebuilds a tile it kept our node in
        if (tile.lastElementChild !== badge) tile.appendChild(badge);

        // A draw that changed nothing touches nothing: the timer runs once a
        // second whether or not the fight moved
        if (badge.dataset.text !== content.text) {
            badge.dataset.text = content.text;
            badge.textContent = content.text;
        }
        if (badge.style.color !== content.color) badge.style.color = content.color;
        if (badge.title !== content.title) badge.title = content.title;
    }
}

const combatUnitBadges = new CombatUnitBadges();

export default {
    name: 'Combat Unit Badges',
    initialize: () => combatUnitBadges.initialize(),
    cleanup: () => {
        try {
            return combatUnitBadges.disable();
        } catch (error) {
            console.error('[Combat Unit Badges] Disable failed part-way:', error);
        } finally {
            combatUnitBadges.isInitialized = false;
        }
    },
    /** Draw now rather than on the next tick — for tests, and for a settings change */
    redraw: () => combatUnitBadges._draw(),
};

export { combatUnitBadges };
