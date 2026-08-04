/**
 * Equipment Savings
 *
 * The gear you are saving for, and when you will have it.
 *
 * Wanting a piece of equipment is a savings problem, and the game gives you no
 * help with it at all: the price is on one screen, your coins on another, and
 * what you earn per day nowhere. So the question people actually ask — "can I
 * afford the sword yet, and if not, when" — is answered by opening the market,
 * squinting, and subtracting in your head, several times a day, for weeks.
 *
 * ## What an upgrade costs is not what it is priced at
 *
 * You sell the piece it replaces. The cost is the target's ask **less** the bid
 * on what you are wearing, which for a late-game slot is most of the price —
 * reading the ask alone can double the figure. Somebody keeping the old piece
 * for a second loadout pays the full ask, so the trade-in is the **Keep old
 * gear** switch rather than an assumption baked into the number.
 *
 * ## The ladder
 *
 * A target nobody sells is a run at the anvil, and the cheapest run starts from
 * the best copy you own — which is the one you are wearing. That number is
 * honest and it is also a bet with your kit: a failure takes the equipped piece
 * down or away. So the card carries the ladder beside it: the same target
 * reached from your *second*-best copy, or from a base you buy or make when
 * there is no second copy, leaving what you fight in untouched.
 *
 * ## Everything, not just each thing
 *
 * A slot at a time answers the wrong question when you want three pieces. The
 * Everything row is the whole list against your coins, because that is the plan
 * you are actually saving towards.
 *
 * The arithmetic is in `utils/equipment-savings.js` with tests. This module
 * reads the market, the character and the income, and draws.
 *
 * The model is EWatch's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import storage from '../../core/storage.js';
import marketAPI from '../../api/marketplace.js';
import networthHistory from '../networth/networth-history.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';
import { getItemPrices } from '../../utils/market-data.js';
import { getItemHridFromName } from '../../utils/game-lookups.js';
import { shopPurchasePrice } from '../../utils/token-valuation.js';
import { calculateArtisanBonus } from '../../utils/material-calculator.js';
import { formatWithSeparator, formatKMB } from '../../utils/formatters.js';
import { itemIcon, linkToMarketplace, drawLine, blank, shortDuration, ROW_COLORS } from '../../utils/overlay-format.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { createPanel, panelCard, panelNote } from '../../utils/simple-panel.js';
import { registerRow } from '../../utils/overlay-rows.js';
import {
    upgradeCost,
    craftCost,
    savingsProgress,
    timeToAffordSeconds,
    totalSavings,
    orderTargets,
} from '../../utils/equipment-savings.js';

const STORAGE_KEY = 'equipmentSavings';
const MENU_BUTTON_CLASS = 'toolasha-savings-button';
const MENU_BUTTON_SETTING = 'equipmentSavings_menuButton';

/** The enhancement levels the game allows, which is what the picker offers */
const MAX_ENHANCEMENT = 20;

/**
 * The slots EWatch lists, in its order.
 *
 * A row per slot rather than a row per target, because the question is "what is
 * this slot going to be" — a slot with nothing watched is still worth a line
 * saying what is in it and inviting a target, which a list of targets alone
 * cannot do.
 */
const SLOTS = [
    'body',
    'charm',
    'earrings',
    'feet',
    'hands',
    'head',
    'legs',
    'main_hand',
    'neck',
    'off_hand',
    'pouch',
    'ring',
    'trinket',
    'back',
];

/** A slot's name as a heading */
const slotLabel = (slot) => slot.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

/**
 * The list, and how it is being read.
 *
 * At module scope and persisted, because the overlay tile reads it while the
 * panel is closed, which is most of the time.
 *
 * `targets` is keyed by item hrid rather than by slot: you can be saving for two
 * rings, and a slot-keyed list would silently drop one.
 */
const state = { targets: {}, noSell: false, marketValue: true, selected: null, locked: false };

/** The picker's own state, which is not worth persisting — it is a form */
const editing = { itemHrid: '', enhancementLevel: 0, slot: '' };

// Kept asking until the database opens: it is opened after the libraries are
// evaluated, so a read at module scope always returns the default and the list
// looks like it forgot everything. It waits for a character too: gear targets
// belong to the character wearing the gear, so the key it reads is theirs.
async function reload() {
    try {
        await storage.ready;
        const saved = await readScoped(STORAGE_KEY, 'settings', null, { migrate: 'adopt' });
        Object.assign(
            state,
            { targets: {}, noSell: false, marketValue: true, selected: null, locked: false },
            saved || {}
        );
    } catch (error) {
        console.error('[EquipmentSavings] Reading the equipment savings list failed:', error);
    }
}

reload();
// Module-scope state outlives the feature's own re-initialisation on a switch
dataManager.on('character_initialized', reload);
dataManager.on('character_switched', reload);

/** Write the list back, without making anybody wait for it */
function persist() {
    writeScoped(STORAGE_KEY, { ...state }, 'settings').catch((error) =>
        console.error('[EquipmentSavings] Saving the list failed:', error)
    );
}

/**
 * @param {string} itemHrid - The item
 * @returns {boolean} Whether it is being saved for
 */
export function isTargeted(itemHrid) {
    return Boolean(state.targets[itemHrid]);
}

/**
 * Start saving for a piece.
 *
 * @param {string} itemHrid - The item
 * @param {number} [enhancementLevel] - Which enhancement of it
 */
export function watchTarget(itemHrid, enhancementLevel = 0) {
    if (!itemHrid) return;
    // `noSell` and `craft` start unset rather than false, so a target follows
    // the panel's switch until it is told otherwise — one of them differing is
    // the exception, not the rule
    state.targets[itemHrid] = { enhancementLevel: Number(enhancementLevel) || 0 };
    persist();
}

/**
 * Whether one target trades in the piece it replaces.
 *
 * Per target because it genuinely differs: the sword you are replacing gets
 * sold, and the second ring you are buying replaces nothing you would part
 * with. Unset means "whatever the panel says", which is what most of them want.
 *
 * @param {string} itemHrid - The target
 * @returns {boolean}
 */
export function targetNoSell(itemHrid) {
    return state.targets[itemHrid]?.noSell ?? state.noSell;
}

/**
 * Cycle one target between following the panel, selling, and not selling.
 * @param {string} itemHrid - The target
 */
export function cycleTargetNoSell(itemHrid) {
    const target = state.targets[itemHrid];
    if (!target) return;

    // Follows → sells → keeps → follows
    if (target.noSell === undefined) target.noSell = false;
    else if (target.noSell === false) target.noSell = true;
    else delete target.noSell;
    persist();
}

/** @param {string} itemHrid - Whether this target is being crafted rather than bought */
export function isCrafting(itemHrid) {
    return Boolean(state.targets[itemHrid]?.craft);
}

/**
 * Whether this target is being saved for along the ladder rather than the
 * direct run.
 *
 * The two paths cost different amounts and take different lengths of time, so
 * which one you have decided on is what the bar should be filling against —
 * saving towards a figure you have already ruled out is the same as having no
 * figure. Stored on the target, since one piece can be worth the risk and
 * another not.
 *
 * @param {string} itemHrid - The target
 * @returns {boolean}
 */
export function isLaddering(itemHrid) {
    return state.targets[itemHrid]?.mode === 'ladder';
}

/**
 * Cost this target along the ladder instead of the direct run, or back again.
 * @param {string} itemHrid - The target
 */
export function toggleLaddering(itemHrid) {
    const target = state.targets[itemHrid];
    if (!target) return;

    if (target.mode === 'ladder') delete target.mode;
    else target.mode = 'ladder';
    persist();
}

/** @param {string} itemHrid - Craft it rather than buy it, or stop */
export function toggleCrafting(itemHrid) {
    const target = state.targets[itemHrid];
    if (!target) return;

    if (target.craft) delete target.craft;
    else target.craft = true;
    persist();
}

/** @param {string} itemHrid - Stop saving for this */
export function unwatchTarget(itemHrid) {
    delete state.targets[itemHrid];
    persist();
}

/** Whether the old piece is being kept rather than sold to pay for the new one */
export function isNoSell() {
    return state.noSell;
}

/** @param {boolean} noSell - Keep the old piece rather than trading it in */
export function setNoSell(noSell) {
    state.noSell = Boolean(noSell);
    persist();
}

/** Whether coins tied up in market orders count towards what you can spend */
export function isCountingMarketOrders() {
    return state.marketValue;
}

/** @param {boolean} counting - Count outstanding orders as spendable */
export function setCountingMarketOrders(counting) {
    state.marketValue = Boolean(counting);
    persist();
}

/**
 * Whether a price fetch is in flight.
 *
 * Shown rather than hidden: a Refresh button that does nothing visible for a
 * second is a button people press four times.
 */
let refreshing = false;

/** Fetch prices again, and redraw when they land */
async function refreshMarket() {
    if (refreshing) return;
    refreshing = true;
    equipmentSavingsPanel.render();

    try {
        await marketAPI.fetch(true);
    } catch (error) {
        console.error('[EquipmentSavings] Refreshing the market failed:', error);
    } finally {
        refreshing = false;
        equipmentSavingsPanel.render();
    }
}

/** Whether the panel is read-only, which is what it is most of the time */
export function isLocked() {
    return state.locked;
}

/** @param {boolean} locked - Lock the panel back to its reading shape */
export function setLocked(locked) {
    state.locked = Boolean(locked);
    // A picker left open under a slot that is about to disappear
    editing.slot = '';
    editing.itemHrid = '';
    persist();
}

/**
 * Pin which target the tile and the header carry.
 *
 * Pinned rather than derived, because the tile's own answer is "the nearest
 * one", and the thing somebody is actually saving for is often not the cheapest
 * — the eye is how you say so.
 *
 * @param {string|null} itemHrid - Which target
 */
export function selectTarget(itemHrid) {
    state.selected = state.selected === itemHrid ? null : itemHrid;
    persist();
}

/** Forget everything, for a test that must not inherit the last one */
export function resetEquipmentSavings() {
    editing.itemHrid = '';
    editing.enhancementLevel = 0;
    editing.slot = '';
    state.targets = {};
    state.noSell = false;
    state.marketValue = true;
    state.selected = null;
    state.locked = false;
}

/**
 * Coins in hand.
 *
 * Straight off the character's items rather than out of the net worth figure:
 * net worth is recalculated on a schedule and includes everything you own, and
 * a savings bar has to move when you spend, not when a worker next runs.
 *
 * @returns {number}
 */
export function coinsHeld() {
    // Filtered to the inventory location, as every other reader of this list
    // does. `getInventory` returns every character item — equipped pieces,
    // listings, everything — and coins turn up under more than one of them, so
    // an unfiltered `find` picks up a figure that is not what you can spend.
    const items = dataManager.getInventory?.() || [];
    const coin = items.find(
        (item) => item.itemHrid === '/items/coin' && item.itemLocationHrid === '/item_locations/inventory'
    );
    return coin?.count || 0;
}

/** Hours of net worth history considered when combat has nothing to say */
const NETWORTH_TREND_HOURS = 48;

/** The shortest window the net worth trend will be trusted over */
const NETWORTH_MIN_SPAN_HOURS = 6;

/** The fewest points the net worth trend needs to be a trend rather than two dots */
const NETWORTH_MIN_POINTS = 3;

/**
 * A day's income, read off a net worth series rather than measured directly.
 *
 * Theil-Sen — the median of every pairwise slope — rather than a line through
 * the two endpoints or a least-squares fit: both are dragged hard by a single
 * sell-off landing near an end of the window, and a sell-off inside the
 * window is exactly the case this has to survive. The median of every pair
 * shrugs off a handful of outliers without needing to know which points they
 * are, at the cost of being quadratic in the point count — fine for the
 * couple of dozen hourly snapshots a 48h window actually holds.
 *
 * @param {Array<{t: number, total: number}>} points - Chronological, oldest first
 * @returns {number|null} Coins per day, or null when the window is too thin to trust
 */
export function trendPerDay(points) {
    if (!Array.isArray(points) || points.length < NETWORTH_MIN_POINTS) return null;

    const spanHours = (points[points.length - 1].t - points[0].t) / 3_600_000;
    if (!(spanHours >= NETWORTH_MIN_SPAN_HOURS)) return null;

    const slopes = [];
    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
            const dt = points[j].t - points[i].t;
            // Same-timestamp points — the compaction in networth-history.js can
            // leave a run collapsed to its first and last — contribute nothing
            // a slope can use
            if (!(dt > 0)) continue;
            slopes.push(((points[j].total - points[i].total) / dt) * 86_400_000);
        }
    }
    if (!slopes.length) return null;

    slopes.sort((a, b) => a - b);
    const mid = Math.floor(slopes.length / 2);
    return slopes.length % 2 ? slopes[mid] : (slopes[mid - 1] + slopes[mid]) / 2;
}

/**
 * The net worth trend, for when combat has nothing to say.
 *
 * `total` rather than `gold` and `inventory` on their own: buying a piece of
 * gear or a house room moves coins into an asset the same session it leaves
 * the purse, and a coins-only read would count that as a pause in income it
 * never was. `total` nets the transfer out and is left with what combat and
 * skilling actually added, which is the same reason it is the figure the
 * history chart leads with.
 *
 * @returns {number|null} Coins per day, or null when there is nothing to trust yet
 */
function networthIncomePerDay() {
    const series = networthHistory.recentSeries?.(NETWORTH_TREND_HOURS) || [];
    const perDay = trendPerDay(series);
    // A shrinking net worth is not an income to divide a shortfall by — it is
    // the same "nothing rather than a guess" the combat reading follows below
    return perDay > 0 ? perDay : null;
}

/**
 * What the character makes in a day, read off the combat stats.
 *
 * Nothing rather than a guess when combat has not run: dividing by an
 * invented income would produce a confident arrival date.
 *
 * @returns {number|null}
 */
function combatIncomePerDay() {
    const combat = window.Toolasha?.Combat;
    const data = combat?.combatStatsDataCollector?.getLatestData?.();
    const player = data?.players?.find((entry) => entry.isCurrentPlayer);
    if (!player) return null;

    // `durationSeconds` is the field the collector publishes. Reaching for
    // `startTime`/`endTime` — which it does not have — made this
    // `Date.now() - Date.now()`, so every run was zero seconds long, every rate
    // divided by nothing, and the panel said "No income data" forever.
    const seconds = data.durationSeconds || 0;
    if (!(seconds > 0)) return null;

    // `dailyProfit` is `{ask, bid}`, not a number — the two sides of the book,
    // which is the same Lazy/Mid distinction the Combat Profit panel draws.
    // Compared as a number it is NaN, so this returned null however long the run
    // had been, on top of the duration being read from a field that is not there.
    const stats = combat?.combatStatsCalculator?.calculatePlayerStats?.(player, seconds);
    const profit = state.noSell ? stats?.dailyProfit?.ask : stats?.dailyProfit?.bid;
    return profit > 0 ? profit : null;
}

/**
 * What the character makes in a day, and where the figure came from.
 *
 * Combat first, because it is a direct measurement of the session actually
 * being played. When nothing has fought recently — a skiller, or the first
 * minute after a reload — the combat source has nothing to say, and the panel
 * used to go dark rather than say anything at all. The net worth trend stands
 * in for it: slower and noisier, since market swings and one-off purchases
 * are in there too, but it is the only other place in the script that knows
 * anything about income, and a rough answer beats none for telling whether a
 * purchase is a week away or a year.
 *
 * @returns {{perDay: number|null, source: ('combat'|'networth'|null)}}
 */
export function incomeEstimate() {
    const combat = combatIncomePerDay();
    if (combat !== null) return { perDay: combat, source: 'combat' };

    const trend = networthIncomePerDay();
    if (trend !== null) return { perDay: trend, source: 'networth' };

    return { perDay: null, source: null };
}

/**
 * What the character makes in a day.
 *
 * @returns {number|null}
 */
export function incomePerDay() {
    return incomeEstimate().perDay;
}

/**
 * What the game calls an item, for a list that stores only hrids.
 * @param {string} itemHrid - The item
 * @returns {string}
 */
function nameOf(itemHrid) {
    return (
        dataManager.getItemDetails?.(itemHrid)?.name ||
        String(itemHrid || '')
            .split('/')
            .pop()
            .replace(/_/g, ' ')
    );
}

/**
 * The piece currently in the slot this target would fill.
 *
 * By equipment type rather than by name, since that is what a target replaces —
 * and the equipment map is keyed by item **location**, which is not the same
 * string as the type.
 *
 * @param {string} itemHrid - The target
 * @returns {Object|null} The worn item, or null for an empty slot
 */
function wornRivalOf(itemHrid) {
    const type = dataManager.getItemDetails?.(itemHrid)?.equipmentDetail?.type;
    if (!type) return null;

    const location = `/item_locations/${type.split('/').pop()}`;
    return dataManager.getEquipment?.()?.get?.(location) || null;
}

/**
 * What is tied up in market orders.
 *
 * Sell orders are counted at what they will pay after tax and buy orders at the
 * coins already handed over, both of which are money you have — just not money
 * you can spend this second. Whether it counts is the switch.
 *
 * @returns {number}
 */
export function marketOrderValue() {
    const totals = window.Toolasha?.Market?.marketOrderTotals?.calculateTotals?.();
    if (!totals) return 0;
    return (totals.sellOrders || 0) + (totals.buyOrders || 0) + (totals.unclaimed || 0);
}

/**
 * Coins a purchase can actually draw on.
 *
 * @returns {number}
 */
export function spendable() {
    return coinsHeld() + (state.marketValue ? marketOrderValue() : 0);
}

/**
 * The recipe that makes a piece, if the game has one.
 *
 * Found by looking for the action that outputs it rather than from a table, so a
 * recipe added by an update is priced rather than missed.
 *
 * @param {string} itemHrid - The finished piece
 * @returns {Object|null} `{inputItems, upgradeItemHrid, outputCount}`
 */
export function recipeFor(itemHrid) {
    const actions = dataManager.getInitClientData?.()?.actionDetailMap || {};

    for (const [actionHrid, action] of Object.entries(actions)) {
        const output = action?.outputItems?.find((entry) => entry.itemHrid === itemHrid);
        if (!output) continue;

        // Artisan tea takes a fraction off every input, so a recipe priced at
        // its printed cost is priced for somebody else's tea. The game's own
        // panel says 88.9 shards where the recipe says 100; quoting the 100 is
        // an eleven per cent overcharge on every craft this card prices.
        const saved = artisanBonus(action);

        return {
            actionHrid,
            artisan: saved,
            inputItems: (action.inputItems || []).map((input) => ({
                ...input,
                count: (input.count || 0) * (1 - saved),
            })),
            upgradeItemHrid: action.upgradeItemHrid || null,
            outputCount: output.count || 1,
        };
    }
    return null;
}

/**
 * What fraction of a recipe's inputs the tea saves.
 *
 * Through the shared calculator, which resolves the loadout for the action's
 * own skill — so it is the tea you would be brewing under, not whatever is in
 * the slots while you are out fighting.
 *
 * @param {Object} action - The action detail
 * @returns {number} 0 to 1
 */
function artisanBonus(action) {
    try {
        return calculateArtisanBonus(action) || 0;
    } catch (error) {
        console.error('[EquipmentSavings] Reading the artisan bonus failed:', error);
        return 0;
    }
}

/**
 * Whether the piece a recipe upgrades is already in hand.
 *
 * Worn counts as owned — an upgrade consumes the piece you are wearing just as
 * happily as one in the bag, and that is the usual case here.
 *
 * @param {string} itemHrid - The piece the recipe consumes
 * @returns {boolean}
 */
function ownsBase(itemHrid) {
    if (!itemHrid) return true;
    return (dataManager.getInventory?.() || []).some((item) => item.itemHrid === itemHrid && (item.count || 0) > 0);
}

/**
 * What taking a piece you already own from one enhancement level to another costs.
 *
 * Capes, quivers and the rest of the untradable gear cannot be bought at any
 * level, so "save up for a +7 cape" is not a purchase at all — it is a run at
 * the anvil, and what it costs is the expected materials and protections that
 * run consumes. Pricing it at a market ask reports nothing, because there is no
 * ask, which is why an untradable target read as unpriced forever.
 *
 * Expected rather than typical: the Markov model gives the mean attempts to
 * reach a level, which is the only figure a savings bar can honestly fill
 * against. A particular run will cost more or less and there is nothing to be
 * done about that.
 *
 * @param {string} itemHrid - The piece
 * @param {number} targetLevel - Enhancement level being aimed at
 * @param {number} startLevel - What it is now
 * @returns {number|null} Coins, or null when the run cannot be modelled
 */
export function enhancementCost(itemHrid, targetLevel, startLevel = 0) {
    if (!(targetLevel > startLevel) || targetLevel > MAX_ENHANCEMENT) return null;

    const calculator = window.Toolasha?.Utils?.enhancementCalculator?.calculateEnhancement;
    // The character's own gear, skill and teas — not `getEnhancingParams`,
    // which hands back the simulator's manual settings unless auto-detect
    // happens to be on, and those default to a fully kitted enhancer. Costing
    // your cape at somebody else's bench quotes a run you cannot make.
    const params = window.Toolasha?.Utils?.enhancementConfig?.getAutoDetectedParams?.();
    const details = dataManager.getItemDetails?.(itemHrid);
    if (!calculator || !params || !details) return null;

    // Priced at the ask, falling back to what the vendor pays for anything the
    // market has no answer for
    const priceOf = (hrid) =>
        hrid === '/items/coin' ? 1 : getItemPrices(hrid, 0)?.ask || dataManager.getItemDetails?.(hrid)?.sellPrice || 0;

    let materials = 0;
    for (const cost of details.enhancementCosts || []) {
        materials += (cost.count || 0) * priceOf(cost.itemHrid);
    }
    if (!(materials > 0)) return null;

    const protection = cheapestProtection(itemHrid, priceOf);

    try {
        // Falling all the way back to +0 on every failure is what "no
        // protection" means, and past about +5 it is ruinous — nobody enhances
        // that way, so costing it that way would report a number no player
        // would ever pay. The run to price is the cheapest of the protect-from
        // choices, which is the same search the enhancement display makes.
        //
        // From +2 whatever the run starts at, not from the start level. A
        // protect-from below where you begin is not a wasted setting: the first
        // failure drops you *below* the start, and from there the protection is
        // what stops the next one sending you to +0. Bounding the search at the
        // start level forbade the cheap strategies to exactly the runs that
        // start high — so a +5 → +7 run could only protect from +5 while a
        // +4 → +7 run was allowed to protect from +4, and the card reported
        // that starting lower was cheaper. It is the same 2-to-target search
        // the enhancement tooltip and the standalone library make.
        const strategies = [0];
        if (protection.price > 0) {
            for (let from = 2; from <= targetLevel; from++) strategies.push(from);
        }

        let best = null;
        for (const protectFrom of strategies) {
            const run = calculator({
                enhancingLevel: params.enhancingLevel || 0,
                toolBonus: params.toolBonus || 0,
                speedBonus: params.speedBonus || 0,
                itemLevel: details.itemLevel || 0,
                targetLevel,
                startLevel,
                protectFrom,
                blessedTea: Boolean(params.teas?.blessed),
                guzzlingBonus: params.guzzlingBonus || 1,
            });

            const total = run.attempts * materials + (run.protectionCount || 0) * protection.price;
            if (best === null || total < best) best = total;
        }

        return best > 0 ? best : null;
    } catch (error) {
        console.error('[EquipmentSavings] Costing an enhancement run failed:', error);
        return null;
    }
}

/**
 * The cheapest thing that will absorb a failed enhancement.
 *
 * The Mirror of Protection works on anything; some pieces name their own
 * protections. The piece itself protects too, but a target the market will not
 * sell has no second copy to buy, which is precisely the case this exists for.
 *
 * @param {string} itemHrid - The piece being enhanced
 * @param {Function} priceOf - Prices one item hrid
 * @returns {{itemHrid: string|null, price: number}}
 */
function cheapestProtection(itemHrid, priceOf) {
    const details = dataManager.getItemDetails?.(itemHrid);
    const options = ['/items/mirror_of_protection', ...(details?.protectionItemHrids || [])];

    let best = { itemHrid: null, price: 0 };
    for (const hrid of options) {
        const price = priceOf(hrid);
        if (price > 0 && (!best.price || price < best.price)) best = { itemHrid: hrid, price };
    }
    return best;
}

/**
 * The best enhancement of a piece already in hand, if any.
 *
 * The inventory covers worn pieces too, which is the case that matters: the
 * cape you are enhancing is the one on your back. Null rather than zero when
 * none is owned, because "have a +0" and "have none" are different starting
 * points for a run.
 *
 * @param {string} itemHrid - The piece
 * @returns {number|null} Its enhancement level, or null when none is held
 */
function highestOwnedLevel(itemHrid) {
    let best = null;
    for (const item of dataManager.getInventory?.() || []) {
        if (item.itemHrid !== itemHrid || !(item.count > 0)) continue;
        const level = item.enhancementLevel || 0;
        if (best === null || level > best) best = level;
    }
    return best;
}

/**
 * The copy you would enhance instead of the one you are wearing.
 *
 * Enhancing your only copy puts your kit on the table: a failure drops it back
 * to +0, or destroys it outright when there is nothing protecting it, and you
 * fight in whatever the loss left you until you have built it back. The ladder
 * is what people do instead — leave the equipped piece where it is and take a
 * second copy up, so a bust costs the spare rather than the gear you are using.
 *
 * The *second*-best copy, not the best: the best one is the one on your back,
 * which the direct cost already counts from. Two copies at the same level are
 * two copies, so a stack of two +3s ladders from +3.
 *
 * @param {string} itemHrid - The piece
 * @returns {{level: number, spare: boolean}} `spare` is false when there is no
 *   second copy at all, and the ladder has to start from one you get hold of
 */
function ladderStart(itemHrid) {
    const levels = [];
    for (const item of dataManager.getInventory?.() || []) {
        if (item.itemHrid !== itemHrid || !(item.count > 0)) continue;
        const level = item.enhancementLevel || 0;
        levels.push(level);
        // A stack of two is two copies, and the second one is the spare
        if (item.count > 1) levels.push(level);
    }
    if (levels.length < 2) return { level: 0, spare: false };

    levels.sort((a, b) => b - a);
    return { level: levels[1], spare: true };
}

/**
 * What a fresh base costs, bought or made, whichever is cheaper.
 *
 * Both are read through the same helpers the rest of the panel prices with, so
 * a ladder quoted here and a target quoted below cannot disagree. The craft
 * reading treats an upgrade base already in the bag as free, as every other
 * craft figure in this panel does — for a ladder that is the second copy you
 * were going to spend anyway, and it is the same number the card above shows.
 *
 * @param {string} itemHrid - The piece
 * @returns {{price: number, crafted: boolean}} Zero when nowhere sells or makes one
 */
function freshBasePrice(itemHrid) {
    const market = basePrice(itemHrid);

    const recipe = recipeFor(itemHrid);
    const made = recipe?.inputItems?.length ? craftMaterialsCost(itemHrid, recipe) : null;
    if (made !== null && made > 0 && (!(market > 0) || made < market)) return { price: made, crafted: true };

    return { price: market, crafted: false };
}

/**
 * The ladder alternative, costed, or nothing when there is no ladder to climb.
 *
 * Null rather than a zero when the spare is already at the target: there is
 * nothing to enhance, you simply wear it, and a line saying "0" would read as a
 * free upgrade. `enhancementCost` returns null for that on its own, because a
 * run that starts at or above where it is going is not a run.
 *
 * @param {string} itemHrid - The piece
 * @param {number} enhancementLevel - The level being aimed at
 * @returns {{cost: number, fromLevel: number, spare: boolean, base: number, crafted: boolean}|null}
 */
function ladderOption(itemHrid, enhancementLevel) {
    const { level, spare } = ladderStart(itemHrid);
    const fromLevel = spare ? level : 0;

    const run = enhancementCost(itemHrid, enhancementLevel, fromLevel);
    if (run === null) return null;

    const base = spare ? { price: 0, crafted: false } : freshBasePrice(itemHrid);
    // No spare and nowhere to get one: there is no second copy to ladder with,
    // and quoting the run alone would price a piece you cannot start from
    if (!spare && !(base.price > 0)) return null;

    return { cost: run + base.price, fromLevel, spare, base: base.price, crafted: base.crafted };
}

/**
 * What a +0 of something costs, from wherever it can actually be got.
 *
 * The market first, then the shops. Capes are drops and shop lines and are
 * never listed, so a market-only reading reports that a cape cannot be bought
 * at any price — which would make "buy a base and enhance it" look impossible
 * for exactly the pieces that path exists to serve.
 *
 * @param {string} itemHrid - The piece
 * @returns {number} Coins, or 0 when nowhere sells it
 */
function basePrice(itemHrid) {
    const ask = getItemPrices(itemHrid, 0)?.ask || 0;
    if (ask > 0) return ask;

    const data = dataManager.getInitClientData?.() || {};
    const shops = [data.shopItemDetailMap, data.taskShopItemDetailMap, data.labyrinthShopItemDetailMap];
    return shopPurchasePrice(itemHrid, shops, (hrid) => getItemPrices(hrid, 0)?.ask || 0) || 0;
}

/**
 * What one target costs, bought or crafted.
 *
 * @param {string} itemHrid - The target
 * @param {number} enhancementLevel - Which enhancement
 * @returns {{cost: number|null, ask: number, crafted: boolean, recipe: Object|null}}
 */
function costOf(itemHrid, enhancementLevel) {
    const ask = getItemPrices(itemHrid, enhancementLevel)?.ask || 0;
    const worn = wornRivalOf(itemHrid);
    const wornBid = worn ? getItemPrices(worn.itemHrid, worn.enhancementLevel || 0)?.bid || 0 : 0;
    const noSell = targetNoSell(itemHrid);

    // Nobody is selling this one at this level — which is usually not a piece
    // you cannot have, but a piece you enhance to. Capes are the plain case:
    // the market carries +0s and nothing above, so "save for a +7" is a run at
    // the anvil starting from the one already on your back, not a purchase at a
    // price that does not exist. Gating this on the item being untradable was
    // wrong — a cape is perfectly tradable at +0, and the target still has no
    // ask, which is why the whole path never fired.
    if (!ask) {
        const held = highestOwnedLevel(itemHrid);
        // Buying a base to enhance is only a path when a base can be bought at
        // all — and for a cape that is the token shop rather than the market
        const baseAsk = held === null ? basePrice(itemHrid) : 0;

        if (held !== null || baseAsk > 0) {
            const run = enhancementCost(itemHrid, enhancementLevel, held ?? 0);
            if (run !== null) {
                // Enhancing the piece you are wearing has nothing to trade in:
                // it is the same piece, and it goes on your back either way
                const tradeIn = worn?.itemHrid === itemHrid || noSell ? 0 : wornBid;
                const direct = Math.max(0, run + baseAsk - tradeIn);
                // The safe way round the same run, priced beside it
                const ladder = ladderOption(itemHrid, enhancementLevel);
                // The mode stays stored even when the ladder is not currently
                // there to climb — sell the spare and the card falls back to
                // the direct run rather than to no figure, and buying another
                // spare puts it back the way you left it
                const laddering = Boolean(ladder) && isLaddering(itemHrid);

                return {
                    cost: laddering ? ladder.cost : direct,
                    mode: laddering ? 'ladder' : 'direct',
                    // Whichever one is not the basis is still worth a line, so
                    // the card always carries both
                    direct,
                    ask: 0,
                    crafted: false,
                    enhancing: true,
                    fromLevel: held ?? 0,
                    ownsBase: held !== null,
                    ladder,
                    recipe: null,
                };
            }
        }
    }

    if (!isCrafting(itemHrid)) {
        return {
            cost: upgradeCost({ targetAsk: ask, equippedBid: wornBid, noSell }),
            ask,
            crafted: false,
            recipe: null,
        };
    }

    // Crafting prices the materials instead of the finished piece, which for an
    // upgrade you already hold the base of is a completely different figure —
    // a Furious Spear you own becomes a Refined one for the price of the shards
    const recipe = recipeFor(itemHrid);
    const materials = craftMaterialsCost(itemHrid, recipe);

    if (materials === null) return { cost: null, ask, crafted: true, recipe };
    // The trade-in still applies: crafting the replacement does not stop you
    // selling the piece it replaces
    return {
        cost: noSell ? materials : Math.max(0, materials - wornBid),
        ask,
        crafted: true,
        recipe,
    };
}

/**
 * What making one costs, through the crafting planner where it is available.
 *
 * The planner is the better answer by a distance: it costs each ingredient at
 * whichever of buying and making it is cheaper, recursively, which is what
 * anybody actually does. Pricing the inputs at their asks assumes every one is
 * bought, and for a chain of refinements that overstates the total badly.
 *
 * It lives in the actions bundle, so it is reached through the global rather
 * than imported — importing it would copy the whole model into this bundle. When
 * it is not there, the flat reading of the recipe is used instead and says so.
 *
 * @param {string} itemHrid - The finished piece
 * @param {Object|null} recipe - From `recipeFor`
 * @returns {number|null} Coins for one, or null when it cannot be priced
 */
function craftMaterialsCost(itemHrid, recipe) {
    const planner = window.Toolasha?.Actions?.craftingPlanCalculator?.computeBestCraftingPlan;

    if (planner && recipe?.inputItems?.length) {
        try {
            // The base piece is not a cost when it is already in the bag, and the
            // planner has no way to know that — so it is priced without it and
            // the plan for the inputs alone is what is asked for
            let total = 0;
            for (const input of recipe.inputItems) {
                const plan = planner(input.itemHrid, input.count || 0, 'ask');
                if (!plan || !Number.isFinite(plan.totalCost)) return null;
                total += plan.totalCost;
            }

            if (recipe.upgradeItemHrid && !ownsBase(recipe.upgradeItemHrid)) {
                const base = planner(recipe.upgradeItemHrid, 1, 'ask');
                if (!base || !Number.isFinite(base.totalCost)) return null;
                total += base.totalCost;
            }

            return total / (recipe.outputCount > 0 ? recipe.outputCount : 1);
        } catch (error) {
            console.error('[EquipmentSavings] The crafting planner failed, falling back to material asks:', error);
        }
    }

    return craftCost({
        inputItems: recipe?.inputItems,
        priceOf: (hrid) => getItemPrices(hrid, 0)?.ask || 0,
        outputCount: recipe?.outputCount,
        haveBase: ownsBase(recipe?.upgradeItemHrid),
        upgradeAsk: recipe?.upgradeItemHrid ? getItemPrices(recipe.upgradeItemHrid, 0)?.ask || 0 : 0,
    });
}

/**
 * Every target, costed against what you are wearing and what you have.
 *
 * @returns {Array<Object>} `{itemHrid, name, enhancementLevel, ask, cost, ...}`
 */
export function watchedTargets() {
    const coins = spendable();
    const perDay = incomePerDay();

    const targets = Object.entries(state.targets).map(([itemHrid, target]) => {
        const enhancementLevel = target.enhancementLevel || 0;
        const {
            cost,
            ask,
            crafted,
            recipe,
            enhancing,
            fromLevel,
            ownsBase: holdsBase,
            ladder,
            direct,
            mode,
        } = costOf(itemHrid, enhancementLevel);

        const worn = wornRivalOf(itemHrid);
        const wornBid = worn ? getItemPrices(worn.itemHrid, worn.enhancementLevel || 0)?.bid || 0 : 0;
        const progress = savingsProgress(cost, coins);

        return {
            itemHrid,
            name: nameOf(itemHrid),
            enhancementLevel,
            ask,
            crafted,
            enhancing: Boolean(enhancing),
            ownsBase: Boolean(holdsBase),
            fromLevel: fromLevel || 0,
            ladder: ladder || null,
            direct: direct ?? null,
            // Which of the two paths every figure below is counted along
            mode: mode || 'direct',
            recipe,
            noSell: targetNoSell(itemHrid),
            ownNoSell: target.noSell !== undefined,
            worn: worn ? { ...worn, name: nameOf(worn.itemHrid), bid: wornBid } : null,
            cost,
            ...progress,
            seconds: timeToAffordSeconds(progress.needed, perDay),
        };
    });

    // Nearest to done first: that is the next thing that happens, and the only
    // entry you might act on today
    return orderTargets(targets);
}

/** @returns {Object} The whole list against your coins */
export function everything() {
    const targets = watchedTargets();
    const { cost, unpriced } = totalSavings(targets);
    const progress = savingsProgress(targets.length ? cost : null, spendable());

    return {
        targets,
        cost,
        unpriced,
        ...progress,
        seconds: timeToAffordSeconds(progress.needed, incomePerDay()),
    };
}

/**
 * Every piece of equipment the game has, grouped by the slot it fills.
 *
 * From the item map rather than from a list, so a piece added by an update can be
 * saved for rather than being missing until somebody notices.
 *
 * @returns {Array<{type: string, items: Array<{itemHrid: string, name: string}>}>}
 */
export function equipmentBySlot() {
    const itemDetailMap = dataManager.getInitClientData?.()?.itemDetailMap || {};
    const groups = new Map();

    for (const [itemHrid, details] of Object.entries(itemDetailMap)) {
        const type = details?.equipmentDetail?.type;
        if (!type) continue;

        if (!groups.has(type)) groups.set(type, []);
        groups.get(type).push({ itemHrid, name: details.name || itemHrid });
    }

    return [...groups.entries()]
        .map(([type, items]) => ({
            type,
            label: type.split('/').pop().replace(/_/g, ' '),
            items: items.sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * EWatch's picker, opened under the slot it belongs to.
 *
 * The item menu can only offer what you are holding, which is exactly the wrong
 * set — the thing you are saving for is by definition something you do not have.
 * So the panel needs a way in of its own, and it belongs under the slot rather
 * than at the top: the question is "what is going in this slot", and a picker
 * somewhere else makes you carry the slot in your head.
 *
 * A list box rather than a dropdown, as EWatch uses. A dropdown over three
 * hundred items is a scroll you cannot see the shape of, and it closes every
 * time anything redraws.
 *
 * @param {string} slot - The slot being filled
 * @returns {HTMLElement}
 */
function slotPicker(slot) {
    const card = document.createElement('div');
    Object.assign(card.style, {
        borderLeft: '2px solid #6495ed',
        background: 'rgba(255, 255, 255, 0.03)',
        borderRadius: '3px',
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
        padding: '7px',
    });

    const heading = document.createElement('div');
    Object.assign(heading.style, { display: 'flex', alignItems: 'center', gap: '8px' });

    const label = document.createElement('span');
    label.textContent = 'Compare with:';
    Object.assign(label.style, { color: 'rgba(232, 236, 245, 0.6)', flex: '1', fontSize: '11px' });

    const watch = document.createElement('button');
    watch.textContent = '\u{1F441} Watch';
    watch.dataset.pickAdd = 'true';
    Object.assign(watch.style, {
        background: 'rgba(255, 207, 92, 0.18)',
        border: '1px solid #ffcf5c',
        borderRadius: '3px',
        color: '#ffcf5c',
        cursor: 'pointer',
        fontSize: '11px',
        padding: '2px 10px',
    });
    watch.disabled = !editing.itemHrid;
    watch.style.opacity = editing.itemHrid ? '1' : '0.4';
    watch.addEventListener('click', () => {
        if (!editing.itemHrid) return;
        watchTarget(editing.itemHrid, editing.enhancementLevel);
        editing.itemHrid = '';
        editing.enhancementLevel = 0;
        editing.slot = '';
        equipmentSavingsPanel.render();
    });

    heading.append(label, watch);
    card.appendChild(heading);

    const list = document.createElement('select');
    list.dataset.pickItem = 'true';
    // A list box, not a dropdown: the shape of the list is visible and nothing
    // can close it
    list.size = 10;
    Object.assign(list.style, {
        background: 'rgba(0, 0, 0, 0.35)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        borderRadius: '3px',
        color: '#e8ecf5',
        fontSize: '11px',
        padding: '2px',
        width: '100%',
    });

    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '-- Select Item --';
    list.appendChild(blank);

    const group = equipmentBySlot().find((entry) => entry.type.split('/').pop() === slot);
    for (const item of group?.items || []) {
        const option = document.createElement('option');
        option.value = item.itemHrid;
        option.textContent = item.name;
        option.selected = item.itemHrid === editing.itemHrid;
        list.appendChild(option);
    }
    list.addEventListener('change', () => {
        editing.itemHrid = list.value;
        equipmentSavingsPanel.render();
    });
    // A keystroke in a list should not also be a game hotkey
    list.addEventListener('keydown', (event) => event.stopPropagation());
    card.appendChild(list);

    card.appendChild(enhancementButtons());
    if (editing.itemHrid) card.appendChild(costPreview(editing.itemHrid, editing.enhancementLevel));
    return card;
}

/**
 * A button per enhancement level, tinted where the market has one.
 *
 * The tint is the useful part: most levels of most items have never been listed,
 * and knowing which ones exist is half of choosing a target.
 *
 * @returns {HTMLElement}
 */
function enhancementButtons() {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', flexWrap: 'wrap', gap: '3px' });

    for (let level = 0; level <= MAX_ENHANCEMENT; level++) {
        const ask = editing.itemHrid ? getItemPrices(editing.itemHrid, level)?.ask || 0 : 0;
        const sold = ask > 0;
        const chosen = level === editing.enhancementLevel && Boolean(editing.itemHrid);

        const button = document.createElement('button');
        button.textContent = `+${level}`;
        button.dataset.pickLevel = String(level);
        Object.assign(button.style, {
            background: sold ? 'rgba(74, 222, 128, 0.22)' : 'rgba(255, 255, 255, 0.05)',
            border: `1px solid ${chosen ? '#e8ecf5' : sold ? '#4ade80' : 'rgba(255, 255, 255, 0.10)'}`,
            borderRadius: '3px',
            color: sold ? '#e8ecf5' : 'rgba(232, 236, 245, 0.35)',
            cursor: 'pointer',
            fontSize: '10px',
            fontWeight: chosen ? 'bold' : 'normal',
            padding: '2px 6px',
        });
        button.title = sold
            ? `${formatWithSeparator(Math.round(ask))} to buy.`
            : 'Nobody is selling this one — it would have to be enhanced up to.';
        button.addEventListener('click', () => {
            editing.enhancementLevel = level;
            equipmentSavingsPanel.render();
        });
        wrap.appendChild(button);
    }
    return wrap;
}

/**
 * What the piece being picked would cost, before it is committed to.
 *
 * @param {string} itemHrid - The piece
 * @param {number} enhancementLevel - Which enhancement
 * @returns {HTMLElement}
 */
function costPreview(itemHrid, enhancementLevel) {
    // The same costing the watched cards use, rather than a second reading of
    // the ask. Pricing the preview separately meant it could only ever offer a
    // purchase — a +7 cape previewed as "nobody is selling this one" and then
    // watched perfectly well, which is a preview saying the opposite of what
    // the panel was about to do.
    const { cost, ask, crafted, enhancing, fromLevel, ladder } = costOf(itemHrid, enhancementLevel);
    const progress = savingsProgress(cost, spendable());
    const seconds = timeToAffordSeconds(progress.needed, incomePerDay());

    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '11px' });

    const title = document.createElement('div');
    title.textContent =
        `${nameOf(itemHrid)}${enhancementLevel ? ` +${enhancementLevel}` : ''}` +
        (cost === null ? '' : `  ${formatKMB(cost)} needed`);
    Object.assign(title.style, { color: ROW_COLORS.gold, fontWeight: 'bold' });
    wrap.appendChild(title);

    if (cost === null) {
        const none = document.createElement('div');
        none.textContent = 'Nobody is selling this one, and it cannot be reached at the anvil either.';
        none.style.color = 'rgba(232, 236, 245, 0.5)';
        wrap.appendChild(none);
        return wrap;
    }

    if (enhancing) {
        wrap.appendChild(
            priceLine(`Enhance +${fromLevel} → +${enhancementLevel}`, 'Enhancement Cost', ROW_COLORS.gold)
        );
        if (ladder) wrap.appendChild(ladderLine(ladder, enhancementLevel));
    } else {
        wrap.appendChild(
            priceLine(crafted ? 'Materials:' : 'Lowest Ask:', formatWithSeparator(Math.round(ask)), ROW_COLORS.gold)
        );
    }
    wrap.appendChild(
        priceLine(
            'Difference:',
            `+${formatWithSeparator(Math.round(cost))}`,
            cost > 0 ? ROW_COLORS.bad : ROW_COLORS.good
        )
    );
    wrap.appendChild(
        priceLine(
            'Time:',
            progress.affordable ? 'Affordable' : seconds === null ? '--' : shortDuration(seconds),
            ROW_COLORS.accent
        )
    );
    return wrap;
}

/**
 * How a source of `incomeEstimate` reads in the panel.
 * @param {'combat'|'networth'|null} source - Where the figure came from
 * @returns {string}
 */
function sourceLabel(source) {
    return source === 'combat' ? 'combat session' : `networth trend, ${NETWORTH_TREND_HOURS}h`;
}

/**
 * A switch that reads as on or off rather than as a checkbox.
 *
 * EWatch's own shape: the state is the button, in the colour of what it means,
 * because these two change what every figure below them says and a tickbox is
 * easy to leave in the wrong position without noticing.
 *
 * @param {string} label - What it controls
 * @param {boolean} on - Its state
 * @param {Function} onChange - `(next) => void`
 * @param {string} title - What it does
 * @returns {HTMLElement}
 */
function toggle(label, on, onChange, title) {
    const button = document.createElement('button');
    button.textContent = `${label} ${on ? 'On' : 'Off'}`;
    button.dataset.toggle = label;
    Object.assign(button.style, {
        background: on ? 'rgba(74, 222, 128, 0.18)' : 'rgba(248, 113, 113, 0.18)',
        border: `1px solid ${on ? '#4ade80' : '#f87171'}`,
        borderRadius: '3px',
        color: on ? '#4ade80' : '#f87171',
        cursor: 'pointer',
        fontSize: '11px',
        padding: '2px 9px',
    });
    button.title = title;
    button.addEventListener('click', () => onChange(!on));
    return button;
}

/**
 * The one target the header watches, said large.
 *
 * @param {Object} target - From `watchedTargets`
 * @returns {HTMLElement}
 */
function headline(target) {
    const card = document.createElement('div');
    Object.assign(card.style, { display: 'flex', flexDirection: 'column', gap: '4px' });

    const line = document.createElement('div');
    Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '7px' });

    const icon = itemIcon(target.itemHrid, 20);
    linkToMarketplace(icon, target.itemHrid, navigateToMarketplace);

    const name = document.createElement('span');
    name.textContent = target.enhancementLevel ? `${target.name} +${target.enhancementLevel}` : target.name;
    Object.assign(name.style, {
        color: ROW_COLORS.gold,
        fontWeight: 'bold',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    });

    const cost = document.createElement('span');
    cost.textContent = target.cost === null ? 'no price' : formatKMB(target.cost);
    cost.style.color = target.cost === null ? ROW_COLORS.bad : ROW_COLORS.neutral;
    // Which run the headline is quoting, because the two figures differ by a
    // lot and a number with no path attached is the wrong one half the time
    cost.title =
        target.mode === 'ladder'
            ? `Along the ladder, from your +${target.ladder?.fromLevel ?? 0} copy.`
            : target.enhancing
              ? `The direct run, from your +${target.fromLevel} copy.`
              : '';

    const eta = document.createElement('span');
    eta.textContent = target.affordable ? 'Affordable' : target.seconds === null ? '--' : shortDuration(target.seconds);
    Object.assign(eta.style, {
        color: target.affordable ? ROW_COLORS.good : 'rgba(232, 236, 245, 0.6)',
        marginLeft: 'auto',
        fontSize: '11px',
    });

    line.append(icon, name);
    if (target.mode === 'ladder') {
        const tag = document.createElement('span');
        tag.textContent = 'ladder';
        Object.assign(tag.style, { color: ROW_COLORS.accent, fontSize: '10px', flex: '0 0 auto' });
        tag.title = 'This one is being costed along the ladder rather than the direct run.';
        line.appendChild(tag);
    }
    line.append(cost, eta);

    card.append(line, progressBar(target.fraction));
    return card;
}

/**
 * EWatch's own eye, open or crossed out.
 *
 * The open one is the emoji; the closed one is drawn, because there is no
 * crossed-out-eye emoji that renders the same on every platform — the nearest
 * candidates are sunglasses and a monkey covering its face, both of which say
 * something else entirely. A stroked path says one thing everywhere.
 *
 * @param {boolean} watching - Whether this is the pinned one
 * @returns {Node}
 */
function eyeIcon(watching) {
    if (watching) return document.createTextNode('\u{1F441}\uFE0F');

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', '#999');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.style.flex = '0 0 auto';

    for (const d of [
        'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94',
        'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19',
        'M14.12 14.12a3 3 0 1 1-4.24-4.24',
    ]) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
    }

    const slash = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    slash.setAttribute('x1', '1');
    slash.setAttribute('y1', '1');
    slash.setAttribute('x2', '23');
    slash.setAttribute('y2', '23');
    svg.appendChild(slash);

    return svg;
}

/**
 * A bar reading coins saved against coins needed.
 * @param {number|null} fraction - Saved ÷ needed
 * @returns {HTMLElement}
 */
function progressBar(fraction) {
    const track = document.createElement('div');
    Object.assign(track.style, {
        flex: '1',
        height: '5px',
        background: 'rgba(255, 255, 255, 0.12)',
        borderRadius: '3px',
        overflow: 'hidden',
    });

    const fill = document.createElement('div');
    Object.assign(fill.style, {
        height: '100%',
        width: `${((fraction ?? 0) * 100).toFixed(2)}%`,
        // Full means you can go and buy it, which is worth a different colour
        // from "getting there"
        background: fraction >= 1 ? '#4ade80' : '#6495ed',
        transition: 'width 0.3s',
    });

    track.appendChild(fill);
    return track;
}

/**
 * One target: what it is, what it costs, how far along, and how long.
 *
 * @param {Object} target - From `watchedTargets`
 * @returns {HTMLElement}
 */
function targetCard(target) {
    const watching = state.selected === target.itemHrid;

    const card = document.createElement('div');
    Object.assign(card.style, {
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
        padding: '6px 7px',
        borderRadius: '3px',
        // The one the header carries reads blue, the rest gold, as EWatch's do
        borderLeft: `2px solid ${watching ? '#6495ed' : '#ffcf5c'}`,
        background: watching ? 'rgba(100, 149, 237, 0.10)' : 'rgba(255, 207, 92, 0.06)',
    });

    const heading = document.createElement('div');
    Object.assign(heading.style, { display: 'flex', alignItems: 'center', gap: '7px' });

    // EWatch's eye: which of several targets the header carries. Open on the one
    // being watched, closed on the rest.
    const eye = document.createElement('button');
    eye.dataset.watchEye = target.itemHrid;
    eye.replaceChildren(eyeIcon(watching));
    Object.assign(eye.style, {
        background: watching ? 'rgba(100, 149, 237, 0.30)' : 'rgba(100, 100, 100, 0.20)',
        border: `1px solid ${watching ? '#6495ed' : '#666'}`,
        borderRadius: '3px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        lineHeight: '1',
        padding: '3px 5px',
    });
    eye.title = watching ? 'Shown at the top of the panel.' : 'Show this one at the top of the panel.';
    eye.addEventListener('click', () => {
        selectTarget(target.itemHrid);
        equipmentSavingsPanel.render();
    });

    const icon = itemIcon(target.itemHrid, 22);
    linkToMarketplace(icon, target.itemHrid, navigateToMarketplace);

    const name = document.createElement('span');
    name.textContent = target.enhancementLevel ? `${target.name} +${target.enhancementLevel}` : target.name;
    Object.assign(name.style, { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    linkToMarketplace(name, target.itemHrid, navigateToMarketplace);

    const cost = document.createElement('span');
    cost.textContent = target.cost === null ? 'no price' : formatKMB(target.cost);
    cost.style.color = target.cost === null ? ROW_COLORS.bad : ROW_COLORS.gold;
    cost.title =
        target.cost === null
            ? 'Nobody is selling this, so what it would cost is unknown rather than nothing.'
            : target.worn
              ? `${formatKMB(target.ask)} to buy, less ${formatKMB(target.worn.bid)} for your ${target.worn.name}.`
              : `${formatKMB(target.ask)} to buy. Nothing in that slot to trade in.`;

    const remove = document.createElement('button');
    remove.textContent = '✕';
    remove.dataset.removeTarget = target.itemHrid;
    Object.assign(remove.style, {
        background: 'none',
        border: 'none',
        color: 'rgba(232, 236, 245, 0.5)',
        cursor: 'pointer',
        fontSize: '12px',
        padding: '0 2px',
    });
    remove.title = 'Stop saving for this.';
    remove.addEventListener('click', () => {
        unwatchTarget(target.itemHrid);
        equipmentSavingsPanel.render();
    });

    heading.append(eye, icon, name, cost, remove);
    card.appendChild(heading);

    // Per-target switches, because both genuinely differ per piece: the sword
    // being replaced gets sold and the second ring replaces nothing, and one
    // upgrade is worth crafting while another is cheaper to buy outright
    const perTarget = document.createElement('div');
    Object.assign(perTarget.style, { display: 'flex', gap: '5px', flexWrap: 'wrap' });

    const sell = document.createElement('button');
    sell.textContent = target.ownNoSell ? (target.noSell ? 'Keeping' : 'Selling') : 'Follows panel';
    sell.dataset.targetSell = target.itemHrid;
    Object.assign(sell.style, {
        background: 'rgba(255, 255, 255, 0.06)',
        border: `1px solid ${target.ownNoSell ? '#6495ed' : 'rgba(255, 255, 255, 0.12)'}`,
        borderRadius: '3px',
        color: target.ownNoSell ? '#6495ed' : 'rgba(232, 236, 245, 0.55)',
        cursor: 'pointer',
        fontSize: '10px',
        padding: '1px 7px',
    });
    sell.title =
        'Whether the piece this replaces is sold towards it.\n' +
        'Cycles: follows the panel switch, always sells, always keeps.';
    sell.addEventListener('click', () => {
        cycleTargetNoSell(target.itemHrid);
        equipmentSavingsPanel.render();
    });
    perTarget.appendChild(sell);

    if (recipeFor(target.itemHrid)?.inputItems?.length) {
        const craft = document.createElement('button');
        craft.textContent = target.crafted ? 'Crafting' : 'Buying';
        craft.dataset.targetCraft = target.itemHrid;
        Object.assign(craft.style, {
            background: target.crafted ? 'rgba(74, 222, 128, 0.18)' : 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${target.crafted ? '#4ade80' : 'rgba(255, 255, 255, 0.12)'}`,
            borderRadius: '3px',
            color: target.crafted ? '#4ade80' : 'rgba(232, 236, 245, 0.55)',
            cursor: 'pointer',
            fontSize: '10px',
            padding: '1px 7px',
        });
        craft.title =
            'Price the materials rather than the finished piece.\n' +
            'For an upgrade whose base you already hold, that is only the ingredients.';
        craft.addEventListener('click', () => {
            toggleCrafting(target.itemHrid);
            equipmentSavingsPanel.render();
        });
        perTarget.appendChild(craft);
    }

    // Only where there are two paths to choose between. A target with no second
    // copy and nowhere to get one has one run and no decision to offer.
    if (target.enhancing && target.ladder) perTarget.appendChild(ladderButton(target));
    card.appendChild(perTarget);

    if (target.enhancing) {
        // The chosen path leads in gold and the other follows in blue, so the
        // two rows swap places rather than the card losing one of them: the
        // comparison is the whole point, and only which one the bar is filling
        // against changes
        if (target.mode === 'ladder' && target.ladder) {
            card.appendChild(ladderLine(target.ladder, target.enhancementLevel, true));
        } else {
            card.appendChild(
                priceLine(
                    `Enhance +${target.fromLevel} \u2192 +${target.enhancementLevel}`,
                    target.cost === null ? 'cannot model' : formatWithSeparator(Math.round(target.cost)),
                    target.cost === null ? ROW_COLORS.bad : ROW_COLORS.gold
                )
            );
        }
        card.appendChild(
            priceLine(
                target.ownsBase ? 'Not sold at this level' : 'Buy a +0 and enhance it',
                'Enhancement Cost',
                'rgba(232, 236, 245, 0.55)'
            )
        );
        if (target.mode === 'ladder' && target.ladder) card.appendChild(directLine(target));
        else if (target.ladder) card.appendChild(ladderLine(target.ladder, target.enhancementLevel));
    } else if (target.crafted) {
        card.appendChild(recipeLines(target));
        if (target.recipe?.actionHrid) card.appendChild(missingMatsButton(target.recipe.actionHrid));
    } else if (target.ask > 0) {
        card.appendChild(priceLine('Ask Price:', formatWithSeparator(Math.round(target.ask)), ROW_COLORS.gold));
        // What it costs after the trade-in, which is the figure the bar fills
        // against — the ask alone is not what you have to find
        card.appendChild(
            priceLine(
                'Difference:',
                `+${formatWithSeparator(Math.round(target.cost ?? 0))}`,
                target.affordable ? ROW_COLORS.good : ROW_COLORS.bad
            )
        );
    }

    const bar = document.createElement('div');
    Object.assign(bar.style, { display: 'flex', alignItems: 'center', gap: '7px' });
    bar.appendChild(progressBar(target.fraction));

    const status = document.createElement('span');
    status.textContent = statusText(target);
    Object.assign(status.style, {
        color: target.affordable ? ROW_COLORS.good : 'rgba(232, 236, 245, 0.6)',
        fontSize: '11px',
        flex: '0 0 auto',
        minWidth: '96px',
        textAlign: 'right',
    });
    bar.appendChild(status);

    card.appendChild(bar);
    card.appendChild(percentLine(target));

    if (target.seconds !== null && !target.affordable) {
        const eta = document.createElement('div');
        eta.textContent = `ETA: ${shortDuration(target.seconds)}`;
        Object.assign(eta.style, { color: ROW_COLORS.accent, fontSize: '10px', textAlign: 'right' });
        card.appendChild(eta);
    }
    return card;
}

/**
 * Open the marketplace on what this craft is short of.
 *
 * The same button the action panel carries, on the card that is saving towards
 * the craft — which is where the question "what am I actually missing" gets
 * asked. It calls the action feature's own handler through the global rather
 * than rebuilding the marketplace tabs here, so the two cannot drift apart.
 *
 * @param {string} actionHrid - The craft
 * @returns {HTMLElement}
 */
function missingMatsButton(actionHrid) {
    const button = document.createElement('button');
    button.textContent = 'Missing Mats Marketplace';
    Object.assign(button.style, {
        background: 'linear-gradient(180deg, rgba(91, 141, 239, 0.2) 0%, rgba(91, 141, 239, 0.1) 100%)',
        border: '1px solid rgba(91, 141, 239, 0.4)',
        borderRadius: '5px',
        color: '#e8ecf5',
        cursor: 'pointer',
        fontSize: '11px',
        fontWeight: 'bold',
        marginTop: '4px',
        padding: '4px 8px',
        width: '100%',
    });
    button.title = 'Open the marketplace on the materials this craft is short of.';

    button.addEventListener('click', async () => {
        const open = window.Toolasha?.Actions?.missingMaterialsButton?.openMissingMaterials;
        if (!open) {
            button.textContent = 'The action panel feature is off';
            return;
        }
        button.textContent = 'Opening…';
        try {
            await open(actionHrid, 1);
        } catch (error) {
            console.error('[EquipmentSavings] Opening the missing materials failed:', error);
            button.textContent = 'Could not open the marketplace';
        }
    });
    return button;
}

/**
 * What a craft is made of, and what each ingredient comes to.
 *
 * Itemised rather than totalled, because the whole reason to craft is that one
 * ingredient is the expensive one — a total hides which, and that is the thing
 * worth knowing before committing to it.
 *
 * @param {Object} target - A costed target
 * @returns {HTMLElement}
 */
function recipeLines(target) {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '1px' });

    const recipe = target.recipe;
    if (!recipe?.inputItems?.length) {
        wrap.appendChild(priceLine('Materials:', 'no recipe', ROW_COLORS.bad));
        return wrap;
    }

    for (const input of recipe.inputItems) {
        const price = getItemPrices(input.itemHrid, 0)?.ask || 0;
        const count = input.count || 0;
        // One decimal once the tea has taken its cut, because the saving is
        // fractional and 88.9 rounded to 89 hides the very thing being shown
        const shown = Number.isInteger(count) ? formatWithSeparator(count) : count.toFixed(1);
        wrap.appendChild(
            priceLine(
                `${shown} × ${nameOf(input.itemHrid)}`,
                price > 0 ? formatWithSeparator(Math.round(price * count)) : 'no price',
                price > 0 ? ROW_COLORS.gold : ROW_COLORS.bad
            )
        );
    }

    if (recipe.artisan > 0) {
        wrap.appendChild(
            priceLine(
                'Artisan tea',
                `−${(recipe.artisan * 100).toFixed(1)}% materials`,
                ROW_COLORS.good,
                'From the loadout for this skill, not from whatever is in the slots right now.'
            )
        );
    }

    // Named rather than assumed: whether the base piece is a cost changes the
    // figure entirely, and it depends on what is in the bag
    if (recipe.upgradeItemHrid) {
        const owned = (dataManager.getInventory?.() || []).some(
            (item) => item.itemHrid === recipe.upgradeItemHrid && (item.count || 0) > 0
        );
        wrap.appendChild(
            priceLine(
                `Upgrades ${nameOf(recipe.upgradeItemHrid)}`,
                owned ? 'you have one' : 'not owned, counted in',
                owned ? ROW_COLORS.good : ROW_COLORS.accent
            )
        );
    }

    wrap.appendChild(
        priceLine(
            'Difference:',
            target.cost === null ? 'no price' : `+${formatWithSeparator(Math.round(target.cost))}`,
            target.cost === null ? ROW_COLORS.bad : target.affordable ? ROW_COLORS.good : ROW_COLORS.bad
        )
    );
    return wrap;
}

/**
 * A label and a figure on one line, as EWatch lists Ask Price and Difference.
 *
 * @param {string} label - What it is
 * @param {string} value - What it says
 * @param {string} color - Ink for the figure
 * @returns {HTMLElement}
 */
function priceLine(label, value, color, title = '') {
    const line = document.createElement('div');
    Object.assign(line.style, { display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '11px' });
    if (title) line.title = title;

    const name = document.createElement('span');
    name.textContent = label;
    name.style.color = 'rgba(232, 236, 245, 0.55)';

    const figure = document.createElement('span');
    figure.textContent = value;
    Object.assign(figure.style, { color, fontWeight: 'bold', whiteSpace: 'nowrap' });

    line.append(name, figure);
    return line;
}

/**
 * The ladder, said beside the cost of enhancing what you are wearing.
 *
 * The two figures answer different questions and both are worth having on the
 * card: the one above is what the target costs if you bet your equipped piece,
 * this is what it costs if you do not. The ladder is usually dearer — you are
 * starting lower, and possibly paying for a copy — and that is the price of not
 * fighting in a +0 for a week if it goes wrong.
 *
 * @param {Object} ladder - From `ladderOption`
 * @param {number} targetLevel - Where the ladder is climbing to
 * @returns {HTMLElement}
 */
function ladderLine(ladder, targetLevel, chosen = false) {
    const label = chosen
        ? ladder.spare
            ? `Ladder: enhance your +${ladder.fromLevel} copy`
            : `Ladder: enhance a fresh +0 ${ladder.crafted ? 'you make' : 'you buy'}`
        : ladder.spare
          ? `Ladder: enhance your +${ladder.fromLevel} copy instead`
          : `Ladder: enhance a fresh +0 ${ladder.crafted ? 'you make' : 'you buy'} instead`;

    const why =
        `Takes a second copy to +${targetLevel} and leaves the one you are wearing alone, so a failed ` +
        'attempt costs the spare rather than your kit.\n';
    const how = ladder.spare
        ? `Counted from the second-best copy you own, at +${ladder.fromLevel}.`
        : 'You own no second copy, so this starts from one you have to get: ' +
          `${formatWithSeparator(Math.round(ladder.base))} for a +0 ` +
          `${ladder.crafted ? 'at the crafting bench' : 'at the market or shop'}, plus the run.`;

    return priceLine(
        label,
        formatWithSeparator(Math.round(ladder.cost)),
        chosen ? ROW_COLORS.gold : ROW_COLORS.accent,
        why + how + (chosen ? '\nThe bar and the countdown are filling against this one.' : '')
    );
}

/**
 * The direct run, said as the alternative when the ladder is the one chosen.
 *
 * The mirror of `ladderLine`: whichever path the card is not counting along is
 * still worth its figure, because the point of the pair is the comparison. The
 * direct run is dearer in risk rather than in coins — it is your equipped piece
 * on the table — which is the thing the tooltip has to say, since the number
 * alone makes it look like the obvious choice.
 *
 * @param {Object} target - A costed target
 * @returns {HTMLElement}
 */
function directLine(target) {
    const label = target.ownsBase
        ? `Direct: enhance your +${target.fromLevel} copy instead`
        : 'Direct: buy a +0 and enhance that instead';

    const why =
        `Takes the best copy you own to +${target.enhancementLevel}. Cheaper, because it starts higher — and ` +
        'a failed attempt comes out of the piece you are wearing.';

    return priceLine(label, formatWithSeparator(Math.round(target.direct ?? 0)), ROW_COLORS.accent, why);
}

/**
 * The switch between costing the direct run and costing the ladder.
 *
 * A per-target button beside the sell and craft switches, because it is the
 * same kind of decision they are: it changes what every figure on the card
 * means, and it differs piece by piece. Named for the state it is in rather
 * than for what pressing it does, as its neighbours are.
 *
 * @param {Object} target - A costed target
 * @returns {HTMLElement}
 */
function ladderButton(target) {
    const on = target.mode === 'ladder';

    const button = document.createElement('button');
    button.textContent = on ? 'Ladder' : 'Direct';
    button.dataset.targetLadder = target.itemHrid;
    Object.assign(button.style, {
        background: on ? 'rgba(100, 149, 237, 0.22)' : 'rgba(255, 255, 255, 0.06)',
        border: `1px solid ${on ? '#6495ed' : 'rgba(255, 255, 255, 0.12)'}`,
        borderRadius: '3px',
        color: on ? '#6495ed' : 'rgba(232, 236, 245, 0.55)',
        cursor: 'pointer',
        fontSize: '10px',
        padding: '1px 7px',
    });
    button.title =
        'Which run the cost, the bar and the countdown are counted along.\n' +
        'Direct takes the best copy you own, risking the one you are wearing.\n' +
        'Ladder takes a second copy up instead and leaves your kit alone.';
    button.addEventListener('click', () => {
        toggleLaddering(target.itemHrid);
        equipmentSavingsPanel.render();
    });
    return button;
}

/**
 * The bar's own figure, to five places.
 *
 * Five looks absurd until the target is a two-billion-coin spear, at which point
 * a bar and a rounded percentage both sit still for a whole evening and the only
 * thing that says you are getting anywhere is the fifth decimal. EWatch shows
 * five for exactly this reason.
 *
 * @param {Object} target - A costed target
 * @returns {HTMLElement}
 */
function percentLine(target) {
    const line = document.createElement('div');
    line.textContent = target.fraction === null ? '' : `${(target.fraction * 100).toFixed(5)}%`;
    Object.assign(line.style, {
        color: target.affordable ? ROW_COLORS.good : ROW_COLORS.accent,
        fontSize: '10px',
        textAlign: 'right',
    });
    return line;
}

/**
 * What a bar says beside itself.
 * @param {Object} target - A costed target
 * @returns {string}
 */
function statusText(target) {
    if (target.cost === null) return 'unpriced';
    if (target.affordable) return 'Affordable';

    // The shortfall rather than the percentage: a percentage of an amount you
    // have not been told is not a figure you can act on
    const short = `${formatKMB(target.needed)} to go`;
    return target.seconds === null ? short : `${short} · ${shortDuration(target.seconds)}`;
}

/**
 * One slot: what is in it, what it would fetch, and what is being saved for.
 *
 * @param {string} slot - e.g. `main_hand`
 * @param {Array<Object>} targets - From `watchedTargets`
 * @returns {HTMLElement}
 */
function slotSection(slot, targets) {
    const wrap = document.createElement('div');
    wrap.dataset.slot = slot;
    Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '3px' });

    const worn = dataManager.getEquipment?.()?.get?.(`/item_locations/${slot}`) || null;
    const wornBid = worn ? getItemPrices(worn.itemHrid, worn.enhancementLevel || 0)?.bid || 0 : 0;

    // The heading: what is in the slot and what selling it would put towards
    // the upgrade, which is half the cost of every target below it
    const heading = document.createElement('div');
    Object.assign(heading.style, { display: 'flex', alignItems: 'center', gap: '7px', padding: '3px 0' });

    const label = document.createElement('span');
    label.textContent = `${slotLabel(slot)}:`;
    Object.assign(label.style, { color: 'rgba(232, 236, 245, 0.6)', minWidth: '76px', fontSize: '11px' });

    const name = document.createElement('span');
    name.textContent = worn
        ? `${nameOf(worn.itemHrid)}${worn.enhancementLevel ? ` +${worn.enhancementLevel}` : ''}`
        : 'Empty';
    Object.assign(name.style, {
        flex: '1',
        color: worn ? ROW_COLORS.neutral : 'rgba(232, 236, 245, 0.4)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    });

    const bid = document.createElement('span');
    bid.textContent = wornBid > 0 ? formatWithSeparator(Math.round(wornBid)) : 'No bid';
    bid.style.color = wornBid > 0 ? ROW_COLORS.gold : 'rgba(232, 236, 245, 0.4)';
    bid.title = wornBid > 0 ? 'What selling this would put towards an upgrade.' : 'Nothing bidding on this.';

    heading.append(label, name, bid);
    wrap.appendChild(heading);

    for (const target of targets.filter((entry) => slotOf(entry.itemHrid) === slot)) {
        wrap.appendChild(targetCard(target));
    }

    // The invitation stays whether or not something is already watched: two
    // rings and two earrings are a real plan, and a slot that stops offering
    // once it has one target cannot express it
    wrap.appendChild(emptySlotRow(slot));
    if (editing.slot === slot) wrap.appendChild(slotPicker(slot));
    return wrap;
}

/**
 * The invitation on a slot with nothing watched.
 *
 * @param {string} slot - The slot
 * @returns {HTMLElement}
 */
function emptySlotRow(slot) {
    const row = document.createElement('div');
    Object.assign(row.style, {
        borderLeft: '2px solid rgba(127, 214, 163, 0.5)',
        background: 'rgba(255, 255, 255, 0.03)',
        borderRadius: '3px',
        color: 'rgba(232, 236, 245, 0.45)',
        cursor: 'pointer',
        fontSize: '11px',
        padding: '6px',
        textAlign: 'center',
    });
    row.dataset.watchSlot = slot;
    row.replaceChildren(eyeIcon(false), document.createTextNode(' Click to watch'));
    Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'center' });
    row.title = 'Open the picker with this slot in mind.';
    row.addEventListener('click', () => {
        // Clicking the slot whose picker is open closes it, so the invitation
        // is a switch rather than a one-way door
        editing.slot = editing.slot === slot ? '' : slot;
        editing.itemHrid = '';
        editing.enhancementLevel = 0;
        equipmentSavingsPanel.render();
    });
    return row;
}

/**
 * Which slot a piece of equipment fills.
 * @param {string} itemHrid - The piece
 * @returns {string} e.g. `main_hand`, or '' when it is not equipment
 */
function slotOf(itemHrid) {
    const type = dataManager.getItemDetails?.(itemHrid)?.equipmentDetail?.type;
    return type ? type.split('/').pop() : '';
}

/**
 * The gear you are saving for.
 */
export const equipmentSavingsPanel = createPanel({
    id: 'equipmentWatch',
    title: 'Equipment Watch',
    size: { width: 420, height: 420 },
    accent: '#6495ed',
    draw: (body) => {
        const plan = everything();

        // The one the header watches, as EWatch's eye picks it: with several
        // things on the list the one you are actually saving for is the only
        // figure you want at a glance
        const watched =
            plan.targets.find((target) => target.itemHrid === state.selected) ||
            plan.targets
                .filter((target) => target.cost !== null && !target.affordable)
                .sort((a, b) => a.needed - b.needed)[0] ||
            plan.targets[0];
        if (watched) body.appendChild(headline(watched));

        const purse = panelCard(body, undefined, '#6495ed');
        Object.assign(purse.style, { flexDirection: 'row', alignItems: 'center', gap: '10px', flexWrap: 'wrap' });

        const coins = document.createElement('span');
        coins.textContent = `\u{1FA99} ${formatWithSeparator(Math.round(coinsHeld()))}`;
        Object.assign(coins.style, { color: ROW_COLORS.gold, fontWeight: 'bold' });
        coins.title = 'Coins in hand.';

        const orders = marketOrderValue();
        const listed = document.createElement('span');
        listed.textContent = `\u{1F4E6} ${formatKMB(orders)}`;
        listed.style.color = orders > 0 ? ROW_COLORS.good : 'rgba(232, 236, 245, 0.5)';
        listed.title =
            'Coins tied up in market orders — sell orders at what they will pay after tax, buy orders at what ' +
            'was handed over, plus anything unclaimed.';

        const { perDay, source } = incomeEstimate();
        const income = document.createElement('span');
        income.style.color = perDay === null ? 'rgba(232, 236, 245, 0.5)' : ROW_COLORS.good;
        income.style.flex = '1';
        income.textContent =
            perDay === null
                ? 'No income data'
                : `${state.noSell ? 'Mid' : 'Lazy'}: ${formatKMB(perDay)}/day (${sourceLabel(source)})`;
        income.title =
            perDay === null
                ? 'Neither a combat session nor the net worth trend has enough history yet to measure an income.'
                : source === 'combat'
                  ? 'Daily profit from the combat session, which is what the countdowns divide by.\n' +
                    'Lazy sells into the bids; Mid waits at the asks, which No Sell also assumes.'
                  : 'No combat session to measure — read instead off the trend in net worth over the last ' +
                    `${NETWORTH_TREND_HOURS}h.\nSlower and noisier than a combat measurement, but the only ` +
                    'other figure the script has.';

        purse.append(coins, listed, income);

        // Every figure in the panel is only as current as the prices behind it,
        // and a saving that has not moved in a day is usually a price that has
        // not moved rather than a run of bad luck
        const market = panelCard(body, undefined, '#6495ed');
        Object.assign(market.style, { flexDirection: 'row', alignItems: 'center', gap: '8px' });

        const age = marketAPI.getDataAge?.();
        const stamp = document.createElement('span');
        stamp.textContent = age === null ? 'Market Data: never' : `Market Data: ${shortDuration(age / 1000)} old`;
        Object.assign(stamp.style, { color: 'rgba(232, 236, 245, 0.6)', flex: '1', fontSize: '11px' });

        const refresh = document.createElement('button');
        refresh.textContent = refreshing ? 'Refreshing…' : '\u{1F504} Refresh';
        refresh.dataset.marketRefresh = 'true';
        Object.assign(refresh.style, {
            background: 'rgba(100, 149, 237, 0.22)',
            border: '1px solid #6495ed',
            borderRadius: '3px',
            color: '#6495ed',
            cursor: refreshing ? 'default' : 'pointer',
            fontSize: '11px',
            padding: '2px 9px',
        });
        refresh.disabled = refreshing;
        refresh.title = 'Fetch prices again rather than waiting for the next scheduled fetch.';
        refresh.addEventListener('click', refreshMarket);

        market.append(stamp, refresh);

        // EWatch's two switches, each changing what the figures below mean
        const switches = panelCard(body, undefined, '#6495ed');
        Object.assign(switches.style, { flexDirection: 'row', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });

        const explain = document.createElement('span');
        explain.textContent = 'Include market orders';
        Object.assign(explain.style, { color: 'rgba(232, 236, 245, 0.6)', flex: '1', fontSize: '11px' });

        switches.append(
            explain,
            toggle(
                'Market Value',
                state.marketValue,
                (on) => {
                    setCountingMarketOrders(on);
                    equipmentSavingsPanel.render();
                },
                'Count coins tied up in market orders as money you have. Off, only coins in hand count.'
            ),
            toggle(
                'No Sell',
                state.noSell,
                (on) => {
                    setNoSell(on);
                    equipmentSavingsPanel.render();
                },
                'Pay the full asking price rather than putting the piece it replaces towards it.'
            )
        );

        // Locked reads, unlocked edits. The button names what pressing it does.
        const lock = document.createElement('button');
        lock.textContent = state.locked ? 'Edit' : 'Lock';
        lock.dataset.lockToggle = 'true';
        Object.assign(lock.style, {
            background: state.locked ? 'rgba(74, 222, 128, 0.18)' : 'rgba(100, 149, 237, 0.22)',
            border: `1px solid ${state.locked ? '#4ade80' : '#6495ed'}`,
            borderRadius: '3px',
            color: state.locked ? '#4ade80' : '#6495ed',
            cursor: 'pointer',
            fontSize: '11px',
            padding: '2px 9px',
        });
        lock.title = state.locked
            ? 'Open every slot so targets can be added and removed.'
            : 'Put the panel back to the list of what you are saving for.';
        lock.addEventListener('click', () => {
            setLocked(!state.locked);
            equipmentSavingsPanel.render();
        });
        switches.appendChild(lock);

        // Two shapes, one switch. Locked is a reading list — what you are saving
        // for and how far along — which is what the panel is for almost all of
        // the time. Unlocked opens every slot up so targets can be changed, and
        // is a great deal longer, which is why it is not the resting state.
        const list = panelCard(body, undefined, '#6495ed');

        if (state.locked) {
            if (!plan.targets.length) {
                body.appendChild(
                    panelNote('Nothing being saved for yet — press Edit to open the slots and click one.')
                );
                return;
            }
            for (const target of plan.targets) list.appendChild(targetCard(target));
        } else {
            for (const slot of SLOTS) list.appendChild(slotSection(slot, plan.targets));

            // Anything watched whose slot is not in the list above — a slot the
            // game added, or a piece whose type this does not know. Better an
            // odd section than a target that silently disappears.
            const stray = plan.targets.filter((target) => !SLOTS.includes(slotOf(target.itemHrid)));
            for (const target of stray) list.appendChild(targetCard(target));

            if (!plan.targets.length) return;
        }

        // One at a time answers the wrong question when you want three pieces
        const all = panelCard(body, 'Everything', '#6495ed');
        const line = document.createElement('div');
        Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '7px' });
        line.appendChild(progressBar(plan.fraction));

        const status = document.createElement('span');
        status.textContent = statusText(plan);
        Object.assign(status.style, {
            color: plan.affordable ? ROW_COLORS.good : 'rgba(232, 236, 245, 0.6)',
            fontSize: '11px',
            flex: '0 0 auto',
            minWidth: '96px',
            textAlign: 'right',
        });
        line.appendChild(status);
        all.appendChild(line);
        all.appendChild(percentLine(plan));
        all.appendChild(
            panelNote(
                `${formatKMB(plan.cost)} for ${plan.targets.length} pieces` +
                    (plan.unpriced ? ` (+${plan.unpriced} unpriced)` : '')
            )
        );
    },
});

/**
 * Put a Save for button on one item menu.
 * @param {HTMLElement} actionMenu - The game's `Item_actionMenu` popup
 */
function injectSaveButton(actionMenu) {
    if (actionMenu.querySelector(`.${MENU_BUTTON_CLASS}`)) return;

    const itemName = actionMenu.querySelector('[class*="Item_name"]')?.textContent?.trim();
    const hrid = itemName && getItemHridFromName(itemName);
    // Only equipment: saving up for a cheese is not a plan
    if (!hrid || !dataManager.getItemDetails?.(hrid)?.equipmentDetail) return;

    const level =
        Number(actionMenu.querySelector('[class*="Item_enhancementLevel"]')?.textContent?.replace('+', '')) || 0;

    const button = document.createElement('button');
    // The game's own button classes, taken from a button already in this menu,
    // so it does not look like something bolted on
    const sibling = actionMenu.querySelector('button');
    if (sibling) button.className = sibling.className;
    button.classList.add(MENU_BUTTON_CLASS);

    const label = () => {
        button.textContent = isTargeted(hrid) ? 'Stop saving' : 'Save for';
    };
    label();

    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (isTargeted(hrid)) unwatchTarget(hrid);
        else watchTarget(hrid, level);

        label();
        // The panel may be open behind the menu, and a list that does not change
        // when you press the button looks like a button that does nothing
        if (equipmentSavingsPanel.panel) equipmentSavingsPanel.render();
    });

    actionMenu.appendChild(button);
}

let detachMenuObserver = null;

/** Start watching for item menus, if the setting says to */
function applyMenuButtonSetting() {
    const wanted = config.getSetting(MENU_BUTTON_SETTING);

    if (wanted && !detachMenuObserver) {
        detachMenuObserver = domObserver.onClass('EquipmentSavingsSaveButton', 'Item_actionMenu', injectSaveButton);
    } else if (!wanted && detachMenuObserver) {
        detachMenuObserver();
        detachMenuObserver = null;
        document.querySelectorAll(`.${MENU_BUTTON_CLASS}`).forEach((button) => button.remove());
    }
}

export default {
    name: 'Equipment Savings',
    initialize: () => {
        applyMenuButtonSetting();
        config.onSettingChange(MENU_BUTTON_SETTING, applyMenuButtonSetting);
    },
    cleanup: () => {
        detachMenuObserver?.();
        detachMenuObserver = null;
        document.querySelectorAll(`.${MENU_BUTTON_CLASS}`).forEach((button) => button.remove());
    },
};

registerRow({
    // EWatch's own tile. One tile, not a second one beside the old name.
    key: 'equipmentWatch',
    empty: 'Nothing watched',
    name: 'Equipment Watch',
    defaultSize: { width: 240, height: 46 },
    render: (container) => {
        const plan = everything();
        if (!plan.targets.length) return blank(container);

        // The pinned one if the eye has picked one, and otherwise the nearest,
        // because that is the next thing that happens. The pin matters: the
        // thing somebody is saving for is often not the cheapest, and a tile
        // that always shows the cheapest cannot be told otherwise.
        const pinned = plan.targets.find((target) => target.itemHrid === state.selected && target.cost !== null);
        const next =
            pinned ||
            plan.targets
                .filter((target) => target.cost !== null && !target.affordable)
                .sort((a, b) => a.needed - b.needed)[0];
        const shown = next || plan;

        // Two lines: the piece and the figures, then a bar under them. The bar is
        // what a savings tile is for — a figure says where you are and a bar says
        // it at a glance, which is all a tile has time for.
        container.replaceChildren();
        Object.assign(container.style, {
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: '3px',
            lineHeight: '1.3',
            overflow: 'hidden',
        });

        const top = document.createElement('div');
        drawLine(top, [
            shown.itemHrid ? { icon: shown.itemHrid, size: 18 } : { text: '\u{1F3AF}', color: ROW_COLORS.dim },
            {
                // With the enhancement, because a Plate Body and a Plate Body +10
                // are different purchases at very different prices, and the tile
                // naming only the first is naming the wrong one
                text: next
                    ? `${next.name}${next.enhancementLevel ? ` +${next.enhancementLevel}` : ''}`
                    : 'All affordable',
                color: next ? ROW_COLORS.gold : ROW_COLORS.good,
                bold: true,
                ellipsis: true,
            },
            // A pinned target you can already afford shows "0" and "0s" if it is
            // treated like one you are still saving for, which reads as broken
            // rather than as done
            next?.affordable
                ? { text: 'Affordable', color: ROW_COLORS.good, push: true }
                : next
                  ? { text: formatKMB(next.needed), color: ROW_COLORS.neutral, push: true }
                  : { text: formatKMB(plan.cost), color: ROW_COLORS.good, push: true },
            next && !next.affordable && next.seconds !== null
                ? { text: shortDuration(next.seconds), color: ROW_COLORS.gold }
                : null,
        ]);
        container.appendChild(top);

        const fraction = next ? next.fraction : plan.fraction;
        if (fraction !== null && fraction !== undefined) {
            const line = document.createElement('div');
            Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '6px' });
            line.appendChild(progressBar(fraction));

            const percent = document.createElement('span');
            percent.textContent = `${(fraction * 100).toFixed(1)}%`;
            Object.assign(percent.style, {
                color: fraction >= 1 ? ROW_COLORS.good : ROW_COLORS.dim,
                flex: '0 0 auto',
                fontSize: '90%',
            });
            line.appendChild(percent);
            container.appendChild(line);
        }

        container.title =
            (next
                ? `${next.name}${next.enhancementLevel ? ` +${next.enhancementLevel}` : ''} ` +
                  `${pinned ? 'is pinned' : 'is the nearest'}: ` +
                  (next.affordable
                      ? `affordable now at ${formatWithSeparator(Math.round(next.cost))}.`
                      : `${formatWithSeparator(Math.round(next.needed))} to go of ` +
                        `${formatWithSeparator(Math.round(next.cost))}.`)
                : 'Everything on the list is affordable now.') +
            `\n${plan.targets.length} pieces, ${formatKMB(plan.cost)} altogether.` +
            (plan.unpriced ? `\n${plan.unpriced} of them have no market price.` : '') +
            '\nDouble-click for the whole list.';
    },
    onOpen: () => equipmentSavingsPanel.toggle(),
});
