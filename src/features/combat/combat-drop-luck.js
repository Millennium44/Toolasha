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
 * - **Dungeons get a different question.** They pay from a reward table on
 *   completion, not per monster, so the per-monster model declines to measure
 *   one. What a dungeon *can* be asked is how many chests it paid against how
 *   many it owed — the Combat Drop Quantity bonus is the whole of the randomness
 *   in a dungeon payout — and `utils/dungeon-chest-luck.js` answers that instead.
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
import { registerRow, rowOption } from '../../utils/overlay-rows.js';
import { formatLargeNumber } from '../../utils/formatters.js';
import { rows, blank, signedPercent, ROW_COLORS } from '../../utils/overlay-format.js';
import dungeonTracker from './dungeon-tracker.js';
import {
    chestLuck,
    chestsPerCompletion,
    countDungeonChests,
    dungeonChestItems,
    newChestTally,
    noteChestCount,
} from '../../utils/dungeon-chest-luck.js';
import { newKeyLedger, noteItems, sample, keyFlow, entryKeyFor } from '../../utils/key-ledger.js';
import { partyLevelGaps, isLevelGapped } from '../../utils/dungeon-level-gap.js';

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
        // A dungeon is measured by watching its chests rather than by modelling
        // its monsters; `_noteChests` fills this in and nothing else touches it
        this.chests = null;
        // Keys are counted continuously rather than sampled, so that buying a
        // stack mid-run cannot be mistaken for keys coming back
        this.keys = newKeyLedger();
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

        this.itemsHandler = (data) => noteItems(this.keys, data?.endCharacterItems);
        webSocketHook.on('items_updated', this.itemsHandler);

        // The tracker knows when a run finished, which is a fact rather than the
        // inference the chest count gives — and it is the only thing that can
        // count a completion that paid somebody nothing
        this.dungeonHandler = (_current, completed) => this._onDungeonCompleted(completed);
        dungeonTracker.onUpdate(this.dungeonHandler);
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
        if (this.itemsHandler) {
            webSocketHook.off('items_updated', this.itemsHandler);
            this.itemsHandler = null;
        }
        if (this.dungeonHandler) {
            dungeonTracker.offUpdate(this.dungeonHandler);
            this.dungeonHandler = null;
        }
        this.timerRegistry.clearAll();
        document.getElementById(DISPLAY_ID)?.remove();
        this.context = null;
        this.lastResult = null;
        this.liveAt = 0;
        this.chests = null;
        this.keys = newKeyLedger();
        this.isInitialized = false;
    }

    /**
     * A run finished, which the chest count can only guess at.
     *
     * Worth taking from the tracker rather than inferring for two reasons: two
     * completions between samples merge into one rise, and a completion that paid
     * somebody nothing produces no rise at all — which is exactly the case a
     * level-gapped character is in, and exactly the one worth showing.
     *
     * @param {Object} completed - The tracker's completed run, or null on a
     *   progress update
     */
    _onDungeonCompleted(completed) {
        if (!completed || !this.chests) return;

        try {
            this.chests.completions += 1;

            // Two "Key counts" messages a run, so the fall between them is what
            // each member spent. Only a fall: a rise means they restocked, and
            // what they spent underneath that is not recoverable.
            for (const [who, count] of Object.entries(completed.keyCountsMap || {})) {
                sample(this.keys, who, count);
            }
        } catch (error) {
            console.error('[CombatDropLuck] Recording a dungeon completion failed:', error);
        }
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
                isDungeon: dataManager.getActionDetails(combatAction.actionHrid)?.combatZoneInfo?.isDungeon === true,
                // battleId numbers the fight in progress, so the one before it is
                // the last that actually finished and paid out
                battles: Math.max((data?.battleId || 0) - 1, 0),
                partySize: players.length || 1,
                bonuses: {
                    combatDropRate: stats?.combatDropRate || 0,
                    combatRareFind: stats?.combatRareFind || 0,
                    combatDropQuantity: stats?.combatDropQuantity || 0,
                },
                // Everybody's standing against the highest level in the party. A
                // character far below it is penalised on what drops for them, so
                // a luck reading that ignores this blames their gear for their
                // party. Captured for every zone, not just dungeons.
                levelGaps: this._partyGaps(players),
                // Without stats the model would silently assume a bare character
                // and call anyone wearing drop gear lucky, so say so instead
                hasBonuses: !!stats,
            };

            this._noteChests(data);

            // The running loot total rides along on the same message, so the
            // percentile can be kept current during a run rather than waiting
            // for the battle panel that only appears once you leave
            this._refreshLive(self?.totalLootMap);
        } catch (error) {
            console.error('[CombatDropLuck] Reading battle context failed:', error);
        }
    }

    /**
     * Each party member's level-gap penalty, by name.
     *
     * The level is read off the payload rather than computed from a profile: the
     * party is right there in the message, and a profile has to be fetched and
     * cached and can be stale. When it is absent the answer is null — unknown
     * rather than unpenalised, because drawing a missing level as a clean bill of
     * health is the one outcome worse than saying nothing.
     *
     * @param {Array<Object>} players - `new_battle` players
     * @returns {Object} Name to debuff, a negative fraction or null
     */
    _partyGaps(players) {
        const gaps = partyLevelGaps(players.map((player) => player?.combatDetails?.combatLevel ?? null));

        const byName = {};
        players.forEach((player, index) => {
            const name = player?.character?.name;
            if (name) byName[name] = gaps[index];
        });
        return byName;
    }

    /**
     * Watch every player's chest count for the moments it rises.
     *
     * The dungeon tracker counts completions properly, off the party's "Key
     * counts" chat messages, and that is used when it has them. This is the
     * fallback for when it does not — which the tracker's own code says is the
     * solo case, since a validated run needs party messages. A rise in the chest
     * count is one completion that paid what it rose by.
     *
     * The two differ in one way that matters: a rise cannot see a completion that
     * paid nothing, and the tracker can.
     *
     * Done from `new_battle` rather than from the collector because the loot map
     * for *every* player rides along on it, and a completion has to be seen the
     * battle it lands on or two of them merge into one.
     *
     * @param {Object} data - `new_battle` message
     */
    _noteChests(data) {
        if (!this.context?.isDungeon) {
            this.chests = null;
            return;
        }

        const { actionHrid, difficultyTier } = this.context;
        const battleId = data?.battleId || 0;
        const players = data?.players || [];

        // A different dungeon, or the same one begun again, is a different run —
        // and its loot map starts back at nothing, which would otherwise read as
        // everybody opening their chests at once
        if (!this.chests || this.chests.actionHrid !== actionHrid || battleId < this.chests.battleId) {
            this.chests = { actionHrid, battleId, partySize: players.length || 1, tallies: {}, completions: 0 };
        }
        this.chests.battleId = battleId;
        this.chests.partySize = players.length || this.chests.partySize;

        const chestItems = dungeonChestItems(dataManager.getActionDetails(actionHrid), difficultyTier);
        const characterId = dataManager.getCurrentCharacterId();

        for (const player of players) {
            const name = player?.character?.name;
            if (!name) continue;

            if (!this.chests.tallies[name]) this.chests.tallies[name] = newChestTally();
            const tally = this.chests.tallies[name];

            tally.isCurrentPlayer = player.character.id === characterId;
            // Read each time rather than once: gear and buffs change mid-run, and
            // the expectation should follow what is actually worn
            tally.quantity = player.combatDetails?.combatStats?.combatDropQuantity || 0;
            noteChestCount(tally, countDungeonChests(player.totalLootMap, chestItems));
        }
    }

    /**
     * How the dungeon's chests have fallen, per player.
     *
     * @returns {{partySize: number, players: Array<Object>, counted: string,
     *   entryKey: Object|null}|null} Null outside a dungeon
     */
    dungeonChestLuck() {
        const tracked = this.chests;
        if (!tracked) return null;

        const partySize = tracked.partySize || 1;
        const gaps = this.context?.levelGaps || {};
        // The tracker's count is the whole party's, so it applies to everybody;
        // the chest-rise count is per player and only stands in when it has to
        const fromTracker = tracked.completions > 0;

        const players = Object.entries(tracked.tallies).map(([name, tally]) => {
            const mean = chestsPerCompletion({ partySize, dropQuantity: tally.quantity });
            const completions = fromTracker ? tracked.completions : tally.completions;
            const levelGap = gaps[name] ?? null;

            return {
                name,
                isCurrentPlayer: Boolean(tally.isCurrentPlayer),
                byPayout: tally.byPayout,
                mean,
                levelGap,
                // What actually arrived per completion, which is the figure that
                // needs no model at all — and the only one that can show a
                // completion paying nothing
                observed: completions > 0 ? tally.chests / completions : null,
                luck: chestLuck({ completions, chests: tally.chests, mean }),
            };
        });

        if (!players.length) return null;

        return {
            partySize,
            players,
            counted: fromTracker ? 'tracker' : 'chests',
            entryKey: this._entryKeySpend(),
        };
    }

    /**
     * What entry keys this dungeon has actually cost, counted rather than derived.
     *
     * @returns {{itemHrid: string, spent: number, gained: number}|null}
     */
    _entryKeySpend() {
        const itemHrid = entryKeyFor(this.context?.actionHrid);
        if (!itemHrid) return null;

        return { itemHrid, ...keyFlow(this.keys, itemHrid) };
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

        this.lastResult = { percentile, income, expected, battles, hasBonuses, players: this._playerLuck() };
        return this.lastResult;
    }

    /**
     * Each player placed among the sessions they could have had.
     *
     * A real figure per player rather than the party's repeated: everybody's
     * drop gear differs, so everybody has a different distribution, and the
     * question "was that haul unusual" has a different answer for each of them.
     *
     * It is also the *better* per-player figure. Takings against expectation
     * says how far off the mean somebody landed; it cannot say whether that is
     * remarkable. On a zone whose value rides on one rare, −20% is an utterly
     * ordinary run; on a zone of small steady drops it is a bad one. Only the
     * distribution knows which, and the percentile is what carries it.
     *
     * Computed here rather than in the tile because inverting a distribution
     * costs about ten milliseconds — once per session is nothing, and once per
     * player per second is a frozen overlay.
     *
     * @returns {Array<Object>} `{name, isCurrentPlayer, percentile}`, empty solo
     */
    _playerLuck() {
        try {
            const party = partyLuck(this.context);
            // Solo, the session percentile already *is* this player's: the model
            // was built from their bonuses. A second one would be the same
            // number computed a second way.
            if (party.players.length < 2) return [];

            return party.players.map((player) => ({
                name: player.name,
                isCurrentPlayer: player.isCurrentPlayer,
                percentile: player.session ? sessionLuck(player.session, player.actualValue).percentile : null,
            }));
        } catch (error) {
            console.error('[CombatDropLuck] Placing each player in their own distribution failed:', error);
            return [];
        }
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

/**
 * A dungeon run in words, for a tooltip.
 *
 * @param {Object} player - One entry from `dungeonChestLuck().players`
 * @returns {string}
 */
export function describeChestRun(player) {
    const luck = player.luck;
    if (!luck) {
        return (
            `${player.name}: no completion seen yet. A dungeon pays on completion, so this fills in ` +
            'when the first one does.'
        );
    }

    const payouts = Object.entries(player.byPayout || {})
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([count, times]) => `${times}×${count}`)
        .join(', ');

    const lines = [
        `${player.name}: ${luck.chests} chests over ${luck.completions} completions, ` +
            `${luck.expected.toFixed(1)} expected.`,
    ];

    // The measured rate first when there is a level gap, because the modelled one
    // is the thing that stopped applying
    if (player.observed !== null && player.observed !== undefined) {
        lines.push(`That is ${player.observed.toFixed(2)} a completion against a modelled ${player.mean.toFixed(2)}.`);
    }

    if (isLevelGapped(player.levelGap)) {
        lines.push(
            `Level gap ${Math.round(Math.abs(player.levelGap) * 100)}%: they are far enough below the top of the ` +
                'party for the game to cut what drops for them, so what they were owed is not what the model says ' +
                'and no percentile here would be about their luck.'
        );
        return lines.join('\n');
    }

    lines.push(
        `Each completion pays ${Math.floor(player.mean)} guaranteed and ${(luck.chance * 100).toFixed(1)}% ` +
            `of another; ${luck.extras} of those came against ${luck.expectedExtras.toFixed(1)} owed.`
    );
    if (payouts) lines.push(`Completions by payout: ${payouts}.`);
    if (luck.percentile === null) {
        lines.push('Nothing about this payout is random, so there is no luck in it to place.');
    }
    return lines.join('\n');
}

/**
 * The chest rows a dungeon shows in place of a percentile it cannot compute.
 *
 * @param {HTMLElement} container - The tile
 * @param {Object} chest - From `dungeonChestLuck`
 * @param {Function} figureOf - A player to `{text, color}`
 * @param {string} keyPrefix - Which tile's row options to honour
 */
function drawChestRows(container, chest, figureOf, keyPrefix) {
    const onlyNumbers = rowOption(`${keyPrefix}OnlyNumbers`);
    const onlyPlayer = rowOption(`${keyPrefix}OnlyPlayer`);

    const shown = onlyPlayer ? chest.players.filter((player) => player.isCurrentPlayer) : chest.players;
    rows(
        container,
        shown.map((player) => {
            const figure = figureOf(player);
            if (onlyNumbers) return [figure];
            return [
                { text: player.name, color: player.isCurrentPlayer ? ROW_COLORS.gold : ROW_COLORS.dim, ellipsis: true },
                figure,
            ];
        }),
        { align: true }
    );

    const counted =
        chest.counted === 'tracker'
            ? 'Completions come from the dungeon tracker, so a run that paid nothing still counts as a run.'
            : 'Completions are counted by watching the chests arrive, which cannot see a run that paid nothing.';

    const keys = chest.entryKey?.spent
        ? `Entry keys spent since this started watching: ${chest.entryKey.spent}` +
          (chest.entryKey.gained ? ` (${chest.entryKey.gained} acquired, not counted as spending).` : '.')
        : null;

    container.title = [
        'Dungeon: chests dropped against chests owed. The per-monster model does not fit a dungeon, ' +
            'but the drop-quantity bonus — the chance of a second chest — is the whole of the randomness in one.',
        counted,
        ...(keys ? [keys] : []),
        ...chest.players.map(describeChestRun),
    ].join('\n\n');
}

// Registered at module scope so the overlay has the row regardless of start-up
// order. Shows the last session analysed, and nothing before there is one.
registerRow({
    key: 'luck',
    empty: 'No run measured yet',
    name: 'Drop Luck',
    defaultSize: { width: 200, height: 40 },
    // LYuck behind the tile that carries its headline: a percentile cannot say
    // which drop is the reason, and that is the question a long run raises
    onOpen: () => window.Toolasha?.Combat?.partyLuckPanel?.toggle(),
    render: (container) => {
        // A dungeon first, because it has an answer where the per-monster model
        // has none — and because a stale percentile from the zone fought before
        // the dungeon is worse than no percentile at all
        const chest = combatDropLuck.dungeonChestLuck();
        if (chest) {
            return drawChestRows(
                container,
                chest,
                (player) => {
                    // A level-gapped character is owed less than the model says.
                    // Their percentile would read as terrible luck and would
                    // actually be a description of their party.
                    if (isLevelGapped(player.levelGap)) return { text: 'gap', bold: true, color: ROW_COLORS.bad };
                    if (player.luck?.percentile == null) return { text: '—', bold: true, color: ROW_COLORS.dim };

                    return {
                        text: `${(player.luck.percentile * 100).toFixed(1)}%`,
                        bold: true,
                        color: { lucky: ROW_COLORS.good, unlucky: ROW_COLORS.bad, normal: ROW_COLORS.neutral }[
                            describeLuck(player.luck.percentile).tone
                        ],
                    };
                },
                'luck'
            );
        }

        const result = combatDropLuck.lastResult;
        if (!result) return blank(container);

        // The percentile as a figure, not as a sentence. "93 runs in 100 beat
        // it" is the right explanation and the wrong tile — it wrapped to three
        // lines and pushed the number out of sight. It is the tooltip now.
        const { text } = describeLuck(result.percentile);

        // Your name on the left and the figure on the right, which is the shape
        // Lucky's tile has. One row rather than one per player: the percentile
        // is a property of the session — how unusual this run was against the
        // zone's own distribution — and there is no honest way to split it
        // between the people who were in it. What *can* be split is takings
        // against expectation, and that is the Over Expected tile.
        const party = partyLuck(combatDropLuck.context);
        const me = party.players.find((player) => player.isCurrentPlayer) || party.players[0];

        const onlyNumbers = rowOption('luckOnlyNumbers');
        const onlyPlayer = rowOption('luckOnlyPlayer');

        /**
         * One row: who, and where their haul sat among the ones they could have had.
         * @param {string} name - Whose
         * @param {number|null} value - Percentile, 0 to 1
         * @param {boolean} mine - Whether it is the current player
         * @returns {Array<Object>}
         */
        const luckRow = (name, value, mine) => {
            const figure = {
                text: value === null ? '—' : `${(value * 100).toFixed(1)}%`,
                bold: true,
                color:
                    value === null
                        ? ROW_COLORS.dim
                        : { lucky: ROW_COLORS.good, unlucky: ROW_COLORS.bad, normal: ROW_COLORS.neutral }[
                              describeLuck(value).tone
                          ],
            };
            if (onlyNumbers) return [figure];
            return [{ text: name, color: mine ? ROW_COLORS.gold : ROW_COLORS.dim, ellipsis: true }, figure];
        };

        // A row each where there is a party, because everybody's drop gear
        // differs and so does everybody's distribution — the same haul is
        // remarkable for one of them and ordinary for another. The figures are
        // computed when the session is analysed, not here: inverting a
        // distribution costs ten milliseconds a player.
        const each = result.players || [];
        if (each.length > 1) {
            const shown = onlyPlayer ? each.filter((player) => player.isCurrentPlayer) : each;
            rows(
                container,
                shown.map((player) => luckRow(player.name, player.percentile, player.isCurrentPlayer)),
                { align: true }
            );
            container.title =
                `${formatOrdinal(result.percentile)} percentile for the party — ${text}\n` +
                'Per player: their own haul against their own drop gear\u2019s distribution, so the figures are ' +
                'comparable even when the gear is not.';
            return;
        }

        // The aligned layout even for one line, so this tile's figure sits at
        // the same height as the first line of DPS and Over Expected beside it
        rows(container, [luckRow(me?.name || 'Luck', result.percentile, true)], { align: true });
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
    empty: 'No run measured yet',
    name: 'Over Expected %',
    defaultSize: { width: 200, height: 40 },
    render: (container) => {
        // In a dungeon the same question is chests against chests owed, which is
        // the one figure a dungeon payout can honestly be held to
        const chest = combatDropLuck.dungeonChestLuck();
        if (chest) {
            return drawChestRows(
                container,
                chest,
                (player) => {
                    // Over *what*, for somebody the game is paying a reduced
                    // share? The expectation is the part that stopped applying
                    if (isLevelGapped(player.levelGap)) return { text: 'gap', color: ROW_COLORS.bad };
                    if (!player.luck || !(player.luck.expected > 0)) return { text: '—', color: ROW_COLORS.dim };

                    const over = signedPercent((player.luck.chests / player.luck.expected - 1) * 100);
                    return { text: over.text, color: over.color };
                },
                'expected'
            );
        }

        const result = combatDropLuck.lastResult;
        if (!result || !(result.expected > 0)) return blank(container);

        const verdict = signedPercent((result.income / result.expected - 1) * 100);

        // A row per player and then the total, whether or not there is anybody
        // else in the party — which is the shape Lucky's tile has, and one
        // fewer layout to keep matching. The coins the percentage came from are
        // the tooltip: they are what makes the figure meaningful, and they are
        // also three times as wide as the tile.
        const party = partyLuck(combatDropLuck.context);
        const onlyNumbers = rowOption('expectedOnlyNumbers');
        const onlyPlayer = rowOption('expectedOnlyPlayer');

        const shown = onlyPlayer ? party.players.filter((player) => player.isCurrentPlayer) : party.players;
        const lines = shown.map((player) => {
            const each = signedPercent(player.percent ?? 0);
            const figure = { text: player.percent === null ? '—' : each.text, color: each.color };
            if (onlyNumbers) return [figure];

            return [
                {
                    text: player.name,
                    color: player.isCurrentPlayer ? ROW_COLORS.gold : ROW_COLORS.dim,
                    ellipsis: true,
                },
                figure,
            ];
        });

        // The party against the party's expectation, not an average of the
        // percentages — an average weights somebody who looted one item the
        // same as somebody who looted a hundred. Dropped when the tile has been
        // narrowed to one player: a total of one row is that row again.
        if (!onlyPlayer) {
            const total = party.total ? signedPercent(party.total.percent ?? 0) : verdict;
            const figure = { text: total.text, color: total.color, bold: true };
            lines.push(onlyNumbers ? [figure] : [{ text: 'TOTAL', color: ROW_COLORS.neutral, bold: true }, figure]);
        }

        rows(container, lines, { align: true });
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
