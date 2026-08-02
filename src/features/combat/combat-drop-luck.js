/**
 * Combat Drop Luck
 *
 * Puts a percentile on a combat session's takings, in the battle panel beside the
 * revenue figure that prompts the question.
 *
 * Revenue on its own cannot answer "was that bad, or was that just Tuesday?".
 * A zone's average tells you nothing about its spread, and the zones people
 * actually grind are the ones with a rare drop carrying most of the value — where
 * the median session is well under average and a single lucky hour is worth a
 * day. This says where the session sits: 50 is exactly typical, 5 means
 * nineteen sessions in twenty do better.
 *
 * The maths is in `utils/drop-luck.js` and the zone modelling in
 * `utils/combat-drop-model.js`; this module only decides when to ask and where to
 * put the answer.
 *
 * It is asked twice. The battle panel gets it on `battle_unit_fetched`, which is
 * the moment you leave combat and see the revenue it sits beside. The overlay
 * row wants it during the run, so the figure is also recomputed from the running
 * loot total on `new_battle` — throttled, because the transform costs about a
 * tenth of a second and battles can be seconds apart.
 *
 * Two limits worth knowing, both shown rather than hidden:
 *
 * - **Dungeons are skipped.** They pay from a reward table on completion, not per
 *   monster, which is a different distribution. A number built from the wrong
 *   model would look just as convincing as a right one.
 * - **Unpriced drops are left out of both sides.** An item with no market price is
 *   dropped from the model and from the session's income, so the comparison stays
 *   like for like.
 */

import config from '../../core/config.js';
import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import { getItemPrice } from '../../utils/market-data.js';
import { sessionLuck } from '../../utils/drop-luck.js';
import { buildCombatSession, lootValue, sessionMean } from '../../utils/combat-drop-model.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { partyLuck } from './party-luck.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { formatLargeNumber } from '../../utils/formatters.js';
import { row, rows, blank, signedPercent, ROW_COLORS } from '../../utils/overlay-format.js';

const DISPLAY_ID = 'mwi-drop-luck';
const EXP_SECTION_SELECTOR = '[class*="BattlePanel_gainedExp"]';
const MAX_PANEL_TRIES = 10;
const PANEL_RETRY_MS = 200;
/**
 * How often the percentile is recomputed mid-run.
 *
 * The transform is around a tenth of a second on a busy zone, and battles can be
 * seconds apart, so recomputing per battle would spend a noticeable slice of the
 * run on a figure that barely moves between kills.
 */
const LIVE_INTERVAL_MS = 30000;

/** Above this is a good session, below the mirror of it a bad one */
const LUCKY_PERCENTILE = 0.75;
const UNLUCKY_PERCENTILE = 0.25;

/**
 * A percentile as a rank, so it reads as a position rather than a probability.
 * @param {number} percentile - In [0, 1]
 * @returns {string} e.g. "73rd"
 */
export function formatOrdinal(percentile) {
    const rank = Math.min(Math.max(Math.round(percentile * 100), 1), 99);
    const lastTwo = rank % 100;
    const suffix = lastTwo >= 11 && lastTwo <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[rank % 10] || 'th';
    return `${rank}${suffix}`;
}

/**
 * How a percentile should read to someone who just finished the session.
 *
 * Phrased as how many sessions do better rather than as the percentile again,
 * because "3rd percentile" and "97 sessions in 100 beat that" are the same fact
 * and only one of them is an answer.
 *
 * @param {number} percentile - In [0, 1]
 * @returns {{text: string, tone: string}} Wording and which of lucky/unlucky/normal
 */
export function describeLuck(percentile) {
    const better = Math.round((1 - percentile) * 100);
    const text = `${formatOrdinal(percentile)} percentile — ${better} runs in 100 beat it`;

    if (percentile >= LUCKY_PERCENTILE) return { text, tone: 'lucky' };
    if (percentile <= UNLUCKY_PERCENTILE) return { text, tone: 'unlucky' };
    return { text, tone: 'normal' };
}

class CombatDropLuck {
    constructor() {
        this.isInitialized = false;
        this.newBattleHandler = null;
        this.battleUnitFetchedHandler = null;
        this.timerRegistry = createTimerRegistry();
        this.context = null;
        // Kept so the overlay row has something to show between fights; the
        // battle panel that normally carries this is gone the moment you leave
        this.lastResult = null;
        this.liveAt = 0;
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('combatDropLuck')) return;
        this.isInitialized = true;

        // The zone, the player's drop stats and the battle count are only on the
        // wire mid-combat. By the time the panel appears the action may be gone
        // from the character's list, so they are captured as they go past.
        this.newBattleHandler = (data) => this._rememberContext(data);
        webSocketHook.on('new_battle', this.newBattleHandler);

        this.battleUnitFetchedHandler = (message) => this._onCombatEnded(message);
        webSocketHook.on('battle_unit_fetched', this.battleUnitFetchedHandler);
    }

    disable() {
        if (this.newBattleHandler) {
            webSocketHook.off('new_battle', this.newBattleHandler);
            this.newBattleHandler = null;
        }
        if (this.battleUnitFetchedHandler) {
            webSocketHook.off('battle_unit_fetched', this.battleUnitFetchedHandler);
            this.battleUnitFetchedHandler = null;
        }
        this.timerRegistry.clearAll();
        document.getElementById(DISPLAY_ID)?.remove();
        this.context = null;
        this.lastResult = null;
        this.liveAt = 0;
        this.isInitialized = false;
    }

    /**
     * Note the zone, the player's drop bonuses and how far the run has got.
     * @param {Object} data - `new_battle` message
     */
    _rememberContext(data) {
        try {
            const actions = dataManager.getCurrentActions();
            const combatAction = actions.find((action) => action.actionHrid?.startsWith('/actions/combat/'));
            if (!combatAction) return;

            const characterId = dataManager.getCurrentCharacterId();
            const players = data?.players || [];
            const self = players.find((player) => player?.character?.id === characterId);
            const stats = self?.combatDetails?.combatStats;

            this.context = {
                actionHrid: combatAction.actionHrid,
                difficultyTier: combatAction.difficultyTier || 0,
                // battleId numbers the fight in progress, so the one before it is
                // the last that actually finished and paid out
                battles: Math.max((data?.battleId || 0) - 1, 0),
                partySize: players.length || 1,
                bonuses: {
                    combatDropRate: stats?.combatDropRate || 0,
                    combatRareFind: stats?.combatRareFind || 0,
                    combatDropQuantity: stats?.combatDropQuantity || 0,
                },
                // Without stats the model would silently assume a bare character
                // and call anyone wearing drop gear lucky, so say so instead
                hasBonuses: !!stats,
            };

            // The running loot total rides along on the same message, so the
            // percentile can be kept current during a run rather than waiting
            // for the battle panel that only appears once you leave
            this._refreshLive(self?.totalLootMap);
        } catch (error) {
            console.error('[CombatDropLuck] Reading battle context failed:', error);
        }
    }

    /**
     * Recompute mid-run, at most every `LIVE_INTERVAL_MS`.
     *
     * Deferred off the WebSocket handler because the transform is long enough to
     * be felt, and a message handler is the worst place to spend that — it
     * delays every other feature listening to the same message.
     *
     * @param {Object} lootMap - The run's loot so far
     */
    _refreshLive(lootMap) {
        if (!lootMap || !this.context?.battles) return;

        const now = Date.now();
        if (now - this.liveAt < LIVE_INTERVAL_MS) return;
        this.liveAt = now;

        const deferred = setTimeout(() => {
            try {
                this._analyse(lootMap);
            } catch (error) {
                console.error('[CombatDropLuck] Live luck calculation failed:', error);
            }
        }, 0);
        this.timerRegistry.registerTimeout(deferred);
    }

    /**
     * Work out the luck for the session that just ended and show it.
     * @param {Object} message - `battle_unit_fetched` message
     */
    _onCombatEnded(message) {
        const lootMap = message?.unit?.totalLootMap;
        if (!lootMap || !this.context) return;

        this._findPanel(0, (panel) => {
            if (panel.querySelector(`#${DISPLAY_ID}`)) return;

            const line = document.createElement('div');
            line.id = DISPLAY_ID;
            line.textContent = 'Drop luck: working it out…';
            panel.appendChild(line);

            // The transform is a tenth of a second on a busy zone, which is a
            // visible stutter if it runs before the panel has painted
            const deferred = setTimeout(() => this._fillIn(line, lootMap), 0);
            this.timerRegistry.registerTimeout(deferred);
        });
    }

    /**
     * Replace the placeholder with the answer, or remove it if there is none.
     * @param {HTMLElement} line - The row to fill in
     * @param {Object} lootMap - The session's `totalLootMap`
     */
    _fillIn(line, lootMap) {
        try {
            const result = this._analyse(lootMap);
            if (!result) {
                line.remove();
                return;
            }

            const { text, tone } = describeLuck(result.percentile);
            const color = {
                lucky: config.getSetting('color_profit') || '#047857',
                unlucky: config.getSetting('color_loss') || '#f87171',
                normal: config.getSetting('color_text_primary') || config.COLOR_TEXT_PRIMARY,
            }[tone];

            line.style.color = color;
            line.textContent = `Drop luck: ${text}`;
            line.title = this._explain(result);
        } catch (error) {
            console.error('[CombatDropLuck] Luck calculation failed:', error);
            line.remove();
        }
    }

    /**
     * Model the zone and place the session in it.
     * @param {Object} lootMap - The session's `totalLootMap`
     * @returns {Object|null} `{ percentile, income, battles, hasBonuses }`, or null
     *   when the zone cannot be modelled
     */
    _analyse(lootMap) {
        const { actionHrid, difficultyTier, battles, partySize, bonuses, hasBonuses } = this.context;

        const actionDetail = dataManager.getActionDetails(actionHrid);
        const monsterDetailMap = dataManager.getInitClientData()?.combatMonsterDetailMap;

        // One price source for the model and the takings alike, or the comparison
        // measures the spread between bid and ask rather than luck
        const priceOf = (itemHrid) =>
            itemHrid === '/items/coin' ? 1 : getItemPrice(itemHrid, { context: 'profit', side: 'sell' });

        const session = buildCombatSession({
            actionDetail,
            monsterDetailMap,
            battles,
            priceOf,
            difficultyTier,
            bonuses,
            partySize,
        });
        if (!session) return null;

        const income = lootValue(lootMap, priceOf);
        const { percentile } = sessionLuck(session, income);

        // The other half of the same question. The percentile says where the
        // session sits among the sessions it could have been, which is the
        // honest answer but a counter-intuitive one on a zone where a rare
        // carries the value: a perfectly ordinary run sits well below the 50th
        // and reads as bad luck. Against the mean it reads as par.
        const expected = sessionMean(session);

        this.lastResult = { percentile, income, expected, battles, hasBonuses };
        return this.lastResult;
    }

    /**
     * The hover text, which is where the caveats live rather than in the line
     * itself — the line has to stay one glance wide.
     * @param {Object} result - From `_analyse`
     * @returns {string} Tooltip
     */
    _explain(result) {
        const parts = [
            `Value of ${result.battles} battles' drops, against every outcome those battles could have had.`,
            'Drops with no market price are left out of both sides.',
        ];
        if (!result.hasBonuses) {
            parts.push('Your drop rate and quantity bonuses were not available, so this assumes none.');
        }
        return parts.join('\n');
    }

    /**
     * Run something once the battle panel exists.
     *
     * The panel is built after the message that says combat ended, so there is
     * nothing to attach to yet when the answer is ready.
     *
     * @param {number} tries - How many attempts have been made
     * @param {Function} onFound - Called with the panel
     */
    _findPanel(tries, onFound) {
        const panel = document.querySelector(EXP_SECTION_SELECTOR)?.parentElement;
        if (panel) {
            onFound(panel);
            return;
        }
        if (tries >= MAX_PANEL_TRIES) return;

        const retry = setTimeout(() => this._findPanel(tries + 1, onFound), PANEL_RETRY_MS);
        this.timerRegistry.registerTimeout(retry);
    }
}

const combatDropLuck = new CombatDropLuck();

// Registered at module scope so the overlay has the row regardless of start-up
// order. Shows the last session analysed, and nothing before there is one.
registerRow({
    key: 'luck',
    name: 'Drop Luck',
    defaultSize: { width: 200, height: 40 },
    // LYuck behind the tile that carries its headline: a percentile cannot say
    // which drop is the reason, and that is the question a long run raises
    onOpen: () => window.Toolasha?.Combat?.partyLuckPanel?.toggle(),
    render: (container) => {
        const result = combatDropLuck.lastResult;
        if (!result) return blank(container);

        // The percentile as a figure, not as a sentence. "93 runs in 100 beat
        // it" is the right explanation and the wrong tile — it wrapped to three
        // lines and pushed the number out of sight. It is the tooltip now.
        const percent = result.percentile * 100;
        const { tone, text } = describeLuck(result.percentile);

        // Your name on the left and the figure on the right, which is the shape
        // Lucky's tile has. One row rather than one per player: the percentile
        // is a property of the session — how unusual this run was against the
        // zone's own distribution — and there is no honest way to split it
        // between the people who were in it. What *can* be split is takings
        // against expectation, and that is the Over Expected tile.
        const party = partyLuck(combatDropLuck.context);
        const me = party.players.find((player) => player.isCurrentPlayer) || party.players[0];

        row(container, [
            { text: me?.name || 'Luck', color: ROW_COLORS.gold, ellipsis: true },
            {
                text: `${percent.toFixed(1)}%`,
                bold: true,
                push: true,
                color: {
                    lucky: ROW_COLORS.good,
                    unlucky: ROW_COLORS.bad,
                    normal: ROW_COLORS.neutral,
                }[tone],
            },
        ]);
        container.title = `${formatOrdinal(result.percentile)} percentile — ${text}`;
    },
});

/**
 * How far the run's takings are from what the zone owed.
 *
 * The companion to Drop luck, in coins rather than in percentiles. Where the
 * percentile says how unusual the run was, this says how much better or worse
 * off it left you — and on a zone whose value rides on one rare, those two say
 * quite different things about the same session.
 */
registerRow({
    key: 'overExpected',
    name: 'Over Expected %',
    defaultSize: { width: 200, height: 40 },
    render: (container) => {
        const result = combatDropLuck.lastResult;
        if (!result || !(result.expected > 0)) return blank(container);

        const verdict = signedPercent((result.income / result.expected - 1) * 100);

        // A row per player and then the total, whether or not there is anybody
        // else in the party — which is the shape Lucky's tile has, and one
        // fewer layout to keep matching. The coins the percentage came from are
        // the tooltip: they are what makes the figure meaningful, and they are
        // also three times as wide as the tile.
        const party = partyLuck(combatDropLuck.context);
        const lines = party.players.map((player) => {
            const each = signedPercent(player.percent ?? 0);
            return [
                {
                    text: player.name,
                    color: player.isCurrentPlayer ? ROW_COLORS.gold : ROW_COLORS.dim,
                    ellipsis: true,
                },
                { text: player.percent === null ? '—' : each.text, color: each.color, push: true },
            ];
        });

        // The party against the party's expectation, not an average of the
        // percentages — an average weights somebody who looted one item the
        // same as somebody who looted a hundred
        const total = party.total ? signedPercent(party.total.percent ?? 0) : verdict;
        lines.push([
            { text: 'TOTAL', color: ROW_COLORS.neutral, bold: true },
            { text: total.text, color: total.color, bold: true, push: true },
        ]);

        rows(container, lines);
        container.title =
            `${formatLargeNumber(Math.round(result.income))} of ` +
            `${formatLargeNumber(Math.round(result.expected))} expected over ${result.battles} battles.\n` +
            'Each player against what their own drop gear was owed; a player with no drop gear is owed less.\n' +
            'Drops with no market price are left out of both sides.';
    },
    // Both luck tiles open the same panel. Two panels split one question — a
    // percentile in one and the item table that explains it in the other — and
    // the answer is always in the half you did not open.
    onOpen: () => window.Toolasha?.Combat?.partyLuckPanel?.toggle(),
});

export default combatDropLuck;
