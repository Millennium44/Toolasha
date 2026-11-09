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
 * ## Levels are on the list too
 *
 * "Fierce Aura to 46" is a savings goal in every way a sword is: a pile of books
 * at what the market wants for them, against the coins you have. So ability
 * levels sit on the same list — added by hand from the panel, or handed over by
 * a sim run that has just costed one — and a goal you have read your way past
 * says so rather than sitting there at full price forever.
 *
 * A house room is the same again: "Mystical Study to 5" is the coins each level
 * asks for outright plus the materials it wants, at what the market would charge
 * to go and buy them. Rooms get their own set of cards beside the levels, and a
 * room you have since built says Reached rather than staying on the bill.
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
import marketAPI from '../../api/marketplace.js';
import networthHistory from '../networth/networth-history.js';
import { getItemPrices, getPricingMode } from '../../utils/market-data.js';
import { patientTickPrice } from '../../utils/patient-tick.js';
import { itemRequirementHtml } from '../../utils/item-requirements.js';
import { getItemHridFromName } from '../../utils/game-lookups.js';
import { shopPurchasePriceByMode } from '../../utils/token-valuation.js';
import { findProducingAction } from '../../utils/production-index.js';
import { calculateArtisanBonus } from '../../utils/material-calculator.js';
import { explainAbilityLevelUpCost } from '../../utils/ability-cost-calculator.js';
import { formatWithSeparator, formatKMB } from '../../utils/formatters.js';
import { calculatePriceAfterTax } from '../../utils/profit-helpers.js';
import {
    itemIcon,
    skillIcon,
    linkToMarketplace,
    drawLine,
    blank,
    shortDuration,
    spriteUrl,
    ROW_COLORS,
} from '../../utils/overlay-format.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { describeEnhancementSource, enhancementParamsFor } from '../enhancement/enhancement-params-source.js';
// The one enhancement cost model: the shared protect-from sweep, and the shared
// pricing rules. This card used to carry its own copy of both.
import { cheapestProtectPlan } from '../../utils/enhancement-protect-sweep.js';
import {
    getCheapestProtectionPrice,
    perAttemptMaterialCost,
    pricingStamp,
    priceMirror,
} from '../../utils/enhancement-input-pricing.js';
import { MIRROR_FIRST_LEVEL, MIRROR_ITEM_HRID } from '../../utils/mirror-route.js';
import { createPanel, panelCard, panelNote } from '../../utils/simple-panel.js';
import { styleGameButton } from '../../utils/game-look.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { roomSkill } from '../../utils/room-skills.js';
import {
    combatStatsDataCollector,
    combatStatsCalculator,
    marketOrderTotals,
    enhancementCalculator,
    craftingPlanCalculator,
    missingMaterialsButton,
} from '../../utils/bundle-bridge.js';
import {
    upgradeCost,
    craftCost,
    savingsProgress,
    timeToAffordSeconds,
    totalSavings,
    orderTargets,
    loadSavingsRecord,
    saveSavingsRecord,
    abilityGoals,
    abilityGoalLabel,
    abilityGoalReached,
    abilityBookHrid,
    addAbilityGoal,
    removeAbilityGoal,
    resetAbilityGoals,
    houseGoals,
    houseGoalLabel,
    houseGoalReached,
    addHouseGoal,
    removeHouseGoal,
    resetHouseGoals,
    targetKey,
    migrateSavingsTargets,
} from '../../utils/equipment-savings.js';
import { ENHANCEMENT_SOLVER_MAX_LEVEL, maxEnhancementLevel, maxHouseRoomLevel } from '../../utils/game-maximums.js';

const MENU_BUTTON_CLASS = 'toolasha-savings-button';
const MENU_BUTTON_SETTING = 'equipmentSavings_menuButton';

/**
 * The color the house cards are drawn in.
 *
 * A third color rather than the abilities' purple: the two sets sit under one
 * another and a reader scrolling past should be able to tell which list they are
 * in without reading the heading.
 */
const HOUSE_ACCENT = '#f59e0b';

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

/**
 * The picker's own state, which is not worth persisting — it is a form.
 *
 * `ability*` is the second picker's and `house*` the third's: which one, what
 * level, and a cost only used when the market cannot supply one.
 */
const editing = {
    itemHrid: '',
    enhancementLevel: 0,
    slot: '',
    abilityHrid: '',
    abilityLevel: 0,
    abilityCost: '',
    addingAbility: false,
    houseRoomHrid: '',
    houseLevel: 0,
    houseCost: '',
    addingHouse: false,
};

// Kept asking until the database opens: it is opened after the libraries are
// evaluated, so a read at module scope always returns the default and the list
// looks like it forgot everything. It waits for a character too: gear targets
// belong to the character wearing the gear, so the key it reads is theirs.
//
// The read goes through `utils/equipment-savings.js`, which keeps the ability
// goals out of the state below and hands back the gear side. Two writers of one
// key lose each other's edits, so there is only the one.
async function reload() {
    try {
        const saved = await loadSavingsRecord();
        // `undefined` means a later reload() — for a character switched to
        // (and possibly away from again) while this one was still reading
        // storage — has already run and committed its own state. Resetting
        // to defaults here would blank whatever that later call just loaded;
        // doing nothing is correct, since only the most recent switch's
        // reload() is allowed to touch `state`.
        if (saved === undefined) return;
        Object.assign(
            state,
            { targets: {}, noSell: false, marketValue: true, selected: null, locked: false },
            saved || {}
        );
        // A list written before the key carried the enhancement level files a
        // +5 under the bare hrid. Folded here, on the way in, so nothing below
        // ever sees the old shape — and so the first write back is already in
        // the new one
        state.targets = foldLadderRoutes(migrateSavingsTargets(state.targets));
        // The pin is a key into that list, so it moves with it
        if (state.selected && !state.targets[state.selected]) {
            const moved = Object.entries(state.targets).find(([, target]) => target.itemHrid === state.selected);
            state.selected = moved ? moved[0] : null;
        }
    } catch (error) {
        console.error('[EquipmentSavings] Reading the equipment savings list failed:', error);
    }
}

reload();
// Module-scope state outlives the feature's own re-initialisation on a switch
dataManager.on('character_initialized', reload);
dataManager.on('character_switched', reload);

/**
 * How many times the game has told us something the savings figures depend on.
 *
 * The overlay redraws every visible tile once a second, and this tile's render
 * is the most expensive one in the panel — a live trace put it at 4.2 ms, which
 * was 85% of a seven-tile tick. It earns that: `everything()` resolves a loadout
 * per target, scans the action map for a recipe, and prices an enhancement run,
 * all against coins, inventory, worn gear and levels that had not moved since
 * the last tick.
 *
 * So the tile's `version()` needs a summary of everything that compute reads,
 * and the game-side half of it is this counter. Deliberately broad: an
 * enhancement run is priced through the loadout, which is gear, teas, community
 * buffs and levels together, so anything that could move one of those bumps it.
 * A counter that is bumped too often only costs a redraw that was going to
 * happen anyway; one that misses an input shows a stale price, which is the one
 * outcome worth avoiding.
 */
let gameRevision = 0;

[
    'character_initialized',
    'character_switched',
    'items_updated',
    'action_completed',
    'actions_updated',
    'skills_updated',
    'abilities_updated',
    'house_rooms_updated',
    'market_listings_updated',
    'consumables_updated',
    'buffs_updated',
    'community_buffs_updated',
    'personal_buffs_updated',
    'new_battle',
].forEach((event) =>
    dataManager.on(event, () => {
        gameRevision++;
    })
);

// Every figure on the tile is a price or a difference of prices, so a new feed
// is a new tile
marketAPI.on(() => {
    gameRevision++;
});

/**
 * Reads that cannot change inside one synchronous costing pass.
 *
 * A list of eight enhancing targets asked the same questions over and over for
 * one draw: the character's enhancing bench was resolved twenty-four times (the
 * run, the ladder's run and the chip on each card), the recipe behind a piece
 * was looked up twice, and the shop that sells its base was walked twice. None
 * of those answers can move while the pass is running — nothing awaits — so the
 * repeats were pure cost.
 *
 * Held for the pass rather than on a clock or an event: the map is thrown away
 * before control returns to the game, so a memo here can never answer with a
 * figure the game has since moved past.
 */
let passMemo = null;

/** Nesting depth, so `everything()` calling `watchedTargets()` keeps one memo */
let passDepth = 0;

/**
 * Run a costing pass with a memo covering it.
 * @param {Function} pass - The work, run immediately
 * @returns {*} Whatever `pass` returns
 */
function inPass(pass) {
    passDepth++;
    if (passDepth === 1) passMemo = new Map();
    try {
        return pass();
    } finally {
        passDepth--;
        if (!passDepth) passMemo = null;
    }
}

/**
 * A value computed at most once per pass, and normally when there is no pass.
 * @param {string} key - What is being remembered
 * @param {Function} compute - Produces it
 * @returns {*} The value
 */
function oncePerPass(key, compute) {
    if (!passMemo) return compute();
    if (passMemo.has(key)) return passMemo.get(key);
    const value = compute();
    passMemo.set(key, value);
    return value;
}

/**
 * Which side of the book a buy and a sale are priced on: Toolasha's own profit pricing mode
 * (`profitCalc_pricingMode`), through the shared resolver, so this card agrees with every other
 * figure Toolasha draws. Conservative buys at the ask and sells into the bid; Patient Buy buys at
 * the bid and sells into the bid; Hybrid asks on both; Optimistic buys at the bid and sells at the ask.
 * @param {'buy'|'sell'} transaction - Which transaction
 * @returns {'ask'|'bid'} The book side
 */
function bookSide(transaction) {
    return getPricingMode('profit', transaction) === 'bid' ? 'bid' : 'ask';
}

/** The side a purchase is priced on (see {@link bookSide}) */
const buySide = () => bookSide('buy');

/** The side a sale is priced on (see {@link bookSide}) */
const sellSide = () => bookSide('sell');

/**
 * What buying one costs: the book's price on the buy side. Zero means no quote on that side, which every
 * caller treats as unpriced, never as free.
 * @param {string} itemHrid - The item
 * @param {number} [level=0] - Enhancement level
 * @returns {number} Coins, 0 when the buy side has no price
 */
function buyPrice(itemHrid, level = 0) {
    return sidePrice(itemHrid, level, 'buy', buySide());
}

/**
 * What selling one fetches before tax: the book's price on the sell side. Zero means no quote.
 * @param {string} itemHrid - The item
 * @param {number} [level=0] - Enhancement level
 * @returns {number} Coins, 0 when the sell side has no price
 */
function sellPrice(itemHrid, level = 0) {
    return sidePrice(itemHrid, level, 'sell', sellSide());
}

/**
 * One side of the book for one transaction, with the patient +1 tick the profit settings ask for (a buy
 * at the bid steps up a tick, a sale at the ask steps down), exactly as `getItemPrice` applies it.
 * Only a live listing is ticked: an estimated side, or an Iron Cow value, has no queue to jump.
 * @param {string} itemHrid - The item
 * @param {number} level - Enhancement level
 * @param {'buy'|'sell'} transaction - Which transaction
 * @param {'ask'|'bid'} side - The book side the mode picked
 * @returns {number} Coins, 0 when that side has no price
 */
function sidePrice(itemHrid, level, transaction, side) {
    const prices = getItemPrices(itemHrid, level);
    const value = Number(prices?.[side]) || 0;
    if (!(value > 0) || prices.source || prices[`${side}Estimated`]) return value;
    return (
        patientTickPrice(value, transaction, side, {
            ask: prices.ask,
            bid: prices.bid,
            askEstimated: prices.askEstimated,
            bidEstimated: prices.bidEstimated,
            itemHrid,
            enhancementLevel: level,
        }) || value
    );
}

/** The label for the buy price on the card: the ask when buying off the sellers, the bid when waiting */
function buyLabel() {
    return buySide() === 'ask' ? 'Ask Price:' : 'Bid Price:';
}

/**
 * The bench every enhancement figure on this card is run on.
 * @param {string} itemHrid - The piece being costed
 * @returns {Object} Enhancement parameters
 */
function savingsParams(itemHrid) {
    return oncePerPass(`params:${itemHrid}`, () => enhancementParamsFor('savings', itemHrid));
}

/**
 * The savings list itself, as a string.
 *
 * Read rather than counted, because the list is edited from a panel, a context
 * menu and a sim hand-off, and a counter would have to be bumped in all three.
 * It is a handful of short entries — this is cheaper than one market lookup.
 *
 * @returns {string}
 */
function listStamp() {
    const targets = Object.entries(state.targets).map(
        ([key, target]) =>
            `${key}:${target.enhancementLevel || 0}:${target.noSell ?? ''}:${target.craft ?? ''}:` +
            `${target.mode ?? ''}:${target.route ?? ''}:${target.quotedCost ?? ''}`
    );
    const abilities = abilityGoals().map((goal) => `${goal.abilityHrid}:${goal.targetLevel}:${goal.cost ?? ''}`);
    const houses = houseGoals().map((goal) => `${goal.houseRoomHrid}:${goal.targetLevel}:${goal.cost ?? ''}`);

    return [
        targets.join(','),
        abilities.join(','),
        houses.join(','),
        state.selected ?? '',
        state.noSell ? 1 : 0,
        state.marketValue ? 1 : 0,
        routePreference(),
    ].join('|');
}

/** @returns {boolean} Whether anything at all is being saved for */
function savingForAnything() {
    return Boolean(Object.keys(state.targets).length || abilityGoals().length || houseGoals().length);
}

/** Write the list back, without making anybody wait for it */
function persist() {
    saveSavingsRecord({ ...state }).catch((error) =>
        console.error('[EquipmentSavings] Saving the list failed:', error)
    );
}

/**
 * @param {string} itemHrid - The item
 * @param {number} [enhancementLevel] - Which enhancement of it
 * @returns {boolean} Whether it is being saved for
 */
export function isTargeted(itemHrid, enhancementLevel = 0) {
    return Boolean(state.targets[targetKey(itemHrid, enhancementLevel)]);
}

/**
 * Start saving for a piece.
 *
 * The price may come with it. A caller that has already costed this exact
 * purchase — the upgrade advisor, which quotes a figure on the row the button
 * sits in — hands that figure over rather than leaving this module to re-derive
 * it from a different model: two surfaces quoting two numbers for one target is
 * the reader having to work out which of them is lying. It is stored as what it
 * is, a quote from somewhere else with a name on it, and the panel says so.
 *
 * @param {string} itemHrid - The item
 * @param {number} [enhancementLevel] - Which enhancement of it
 * @param {Object} [quote] - What the caller costed it at
 * @param {number|null} [quote.cost] - Coins, or null when the caller could not price it
 * @param {string} [quote.costSource] - Short label for where that came from, e.g. `market`
 */
export function watchTarget(itemHrid, enhancementLevel = 0, { cost = null, costSource = '' } = {}) {
    if (!itemHrid) return;
    const level = Number(enhancementLevel) || 0;
    // `noSell` and `craft` start unset rather than false, so a target follows
    // the panel's switch until it is told otherwise — one of them differing is
    // the exception, not the rule
    const target = { itemHrid, enhancementLevel: level };

    // Explicitly, because `Number(null)` is 0 and an unpriced target recorded
    // as costing nothing reports itself as already affordable
    const quoted = cost === null || cost === undefined || cost === '' ? null : Number(cost);
    if (Number.isFinite(quoted) && quoted >= 0) {
        target.quotedCost = quoted;
        if (costSource) target.quotedFrom = String(costSource);
    }

    state.targets[targetKey(itemHrid, level)] = target;
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
 * @param {number} [enhancementLevel] - Which enhancement of it
 * @returns {boolean}
 */
export function targetNoSell(itemHrid, enhancementLevel = 0) {
    return state.targets[targetKey(itemHrid, enhancementLevel)]?.noSell ?? state.noSell;
}

/**
 * Cycle one target between following the panel, selling, and not selling.
 * @param {string} itemHrid - The target
 * @param {number} [enhancementLevel] - Which enhancement of it
 */
export function cycleTargetNoSell(itemHrid, enhancementLevel = 0) {
    const target = state.targets[targetKey(itemHrid, enhancementLevel)];
    if (!target) return;

    // Follows → sells → keeps → follows
    if (target.noSell === undefined) target.noSell = false;
    else if (target.noSell === false) target.noSell = true;
    else delete target.noSell;
    persist();
}

/**
 * @param {string} itemHrid - Whether this target is being crafted rather than bought
 * @param {number} [enhancementLevel] - Which enhancement of it
 * @returns {boolean}
 */
export function isCrafting(itemHrid, enhancementLevel = 0) {
    return Boolean(state.targets[targetKey(itemHrid, enhancementLevel)]?.craft);
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
 * @param {number} [enhancementLevel] - Which enhancement of it
 * @returns {boolean}
 */
export function isLaddering(itemHrid, enhancementLevel = 0) {
    return state.targets[targetKey(itemHrid, enhancementLevel)]?.mode === 'ladder';
}

/** Every route a card can be costed along, in the order the table lists them */
export const ROUTE_IDS = ['buy', 'craft', 'mirror', 'enhance', 'ladder'];

/** The routes a chip can pin. Direct and ladder are `mode`'s alone, see {@link routePinOf} */
const PINNABLE_ROUTES = ['buy', 'craft', 'mirror'];

/** Short names, for the table and the chip */
const ROUTE_LABELS = { buy: 'Buy', craft: 'Craft', mirror: 'Mirror', enhance: 'Enhance', ladder: 'Ladder' };

/**
 * Fold a stored `route` that says enhance or ladder into `mode`, which owns ladder-ness.
 *
 * An earlier, never-released build wrote ladder pins to `route`. Ladder and direct live in `mode`
 * only (`'ladder'`, or absent for direct), the one field every build reads, so no two builds can
 * disagree about it: a `route: 'ladder'` becomes `mode: 'ladder'`, and either value of `route` is
 * dropped, whatever `mode` says.
 *
 * @param {Object} targets - The list as stored
 * @returns {Object} The same list
 */
function foldLadderRoutes(targets) {
    for (const target of Object.values(targets || {})) {
        if (!target || (target.route !== 'ladder' && target.route !== 'enhance')) continue;
        if (target.route === 'ladder' && target.mode !== 'ladder') target.mode = 'ladder';
        delete target.route;
    }
    return targets;
}

/**
 * The route a target is pinned to, if any: buy, craft or mirror. Null is Auto.
 *
 * Stored in two fields so an older build keeps working. `craft: true` is the old Crafting switch and
 * is written for a craft pin; `route` carries buy and mirror (which an older build ignores, reading
 * an unset `craft` as buying). This build never writes `craft` beside a different `route`, so when it
 * finds one, an older build toggled Crafting on and that choice stands. A `route: 'craft'` whose
 * `craft` is gone means an older build switched Crafting off: buying.
 *
 * Ladder and direct are not here: they are `mode` and nothing else.
 *
 * @param {Object|undefined} target - A stored target
 * @returns {string|null} A route id, or null for Auto
 */
function routePinOf(target) {
    if (!target) return null;
    const route = PINNABLE_ROUTES.includes(target.route) ? target.route : null;
    if (target.craft) return 'craft';
    if (route === 'craft') return 'buy';
    return route;
}

/**
 * Pin a target to buy, craft or mirror, or back to Auto. Never touches `mode`.
 * @param {string} itemHrid - The target
 * @param {number} enhancementLevel - Which enhancement of it
 * @param {string|null} route - 'buy', 'craft', 'mirror', or null for Auto
 */
export function setRoutePin(itemHrid, enhancementLevel = 0, route = null) {
    const target = state.targets[targetKey(itemHrid, enhancementLevel)];
    if (!target) return;

    if (PINNABLE_ROUTES.includes(route)) target.route = route;
    else delete target.route;
    // The old Crafting switch, kept in step so a rollback sees a craft pin as Crafting and the rest as Buying
    if (route === 'craft') target.craft = true;
    else delete target.craft;
    persist();
}

/**
 * Pin the ladder (`mode: 'ladder'`) or go back to the direct run (no `mode`).
 * @param {string} itemHrid - The target
 * @param {number} [enhancementLevel] - Which enhancement of it
 * @param {boolean} ladder - Whether to climb the ladder
 */
export function setLadder(itemHrid, enhancementLevel = 0, ladder = true) {
    const target = state.targets[targetKey(itemHrid, enhancementLevel)];
    if (!target) return;

    if (ladder) target.mode = 'ladder';
    else delete target.mode;
    persist();
}

/**
 * The route pinned for a target, for the chip.
 * @param {string} itemHrid - The target
 * @param {number} [enhancementLevel] - Which enhancement of it
 * @returns {string|null} A route id, or null for Auto
 */
export function routePin(itemHrid, enhancementLevel = 0) {
    return routePinOf(state.targets[targetKey(itemHrid, enhancementLevel)]);
}

/**
 * Whether any watched target is pinned to a route, for the panel's reset button.
 * @returns {boolean}
 */
export function anyRoutePinned() {
    return Object.values(state.targets).some((target) => routePinOf(target) !== null);
}

/**
 * Put every watched target back on Auto. Never touches `mode`, so ladder choices stay.
 */
export function clearAllRoutePins() {
    let changed = false;
    for (const target of Object.values(state.targets)) {
        if (!target || routePinOf(target) === null) continue;
        delete target.route;
        delete target.craft;
        changed = true;
    }
    if (changed) persist();
}

/**
 * Step the chip: Auto, then each route offered on the card in turn, then Auto again.
 * @param {string} itemHrid - The target
 * @param {number} enhancementLevel - Which enhancement of it
 * @param {Array<string>} offered - The route ids the card lists
 */
export function cycleRoutePin(itemHrid, enhancementLevel = 0, offered = []) {
    const order = [null, ...PINNABLE_ROUTES.filter((id) => offered.includes(id))];
    const at = order.indexOf(routePin(itemHrid, enhancementLevel));
    // A pin to a route the card no longer lists starts the cycle over
    setRoutePin(itemHrid, enhancementLevel, order[(at + 1) % order.length]);
}

/**
 * Cost this target along the ladder instead of the direct run, or back again.
 * @param {string} itemHrid - The target
 * @param {number} [enhancementLevel] - Which enhancement of it
 */
export function toggleLaddering(itemHrid, enhancementLevel = 0) {
    setLadder(itemHrid, enhancementLevel, !isLaddering(itemHrid, enhancementLevel));
}

/**
 * The global preference for cards whose chip is on Auto.
 * @returns {string} 'auto', or a route id: 'buy', 'craft' or 'mirror'
 */
function routePreference() {
    const value = config.getSettingValue?.('equipmentWatch_routePreference');
    return value === 'buy' || value === 'craft' || value === 'mirror' ? value : 'auto';
}

/**
 * @param {string} itemHrid - Craft it rather than buy it, or stop
 * @param {number} [enhancementLevel] - Which enhancement of it
 */
export function toggleCrafting(itemHrid, enhancementLevel = 0) {
    const target = state.targets[targetKey(itemHrid, enhancementLevel)];
    if (!target) return;

    // The old Crafting switch is now a pin: Crafting pins craft, Buying pins buy
    setRoutePin(itemHrid, enhancementLevel, target.craft ? 'buy' : 'craft');
}

/**
 * @param {string} itemHrid - Stop saving for this
 * @param {number} [enhancementLevel] - Which enhancement of it
 */
export function unwatchTarget(itemHrid, enhancementLevel = 0) {
    delete state.targets[targetKey(itemHrid, enhancementLevel)];
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
 * @param {string|null} key - Which target, by `targetKey` — the item and its
 *   level together, since the +5 and the +8 of one sword are two entries
 */
export function selectTarget(key) {
    state.selected = state.selected === key ? null : key;
    persist();
}

/**
 * Forget everything.
 *
 * Originally test-only, so a test would not inherit the last one's state; also
 * called from `cleanup()` below so a character switch cannot leave the
 * equipmentWatch tile showing the outgoing character's target under the
 * incoming character's name.
 */
export function resetEquipmentSavings() {
    editing.itemHrid = '';
    editing.enhancementLevel = 0;
    editing.slot = '';
    editing.abilityHrid = '';
    editing.abilityLevel = 0;
    editing.abilityCost = '';
    editing.addingAbility = false;
    editing.houseRoomHrid = '';
    editing.houseLevel = 0;
    editing.houseCost = '';
    editing.addingHouse = false;
    state.targets = {};
    state.noSell = false;
    state.marketValue = true;
    state.selected = null;
    state.locked = false;
    resetAbilityGoals();
    resetHouseGoals();
}

/**
 * Where the character's abilities actually are.
 *
 * The learned list rather than the equipped kit: a goal is worth having for a
 * book you own but are not fighting with, and reading the kit would report it at
 * level 0 and quote the whole path again.
 *
 * @returns {Map<string, {level: number, experience: number}>}
 */
export function learnedAbilityLevels() {
    const learned = dataManager.getLearnedAbilities?.() || [];
    return new Map(
        learned
            .filter((entry) => entry?.abilityHrid)
            .map((entry) => [
                entry.abilityHrid,
                { level: Math.floor(Number(entry.level) || 0), experience: Number(entry.experience) || 0 },
            ])
    );
}

/**
 * An ability's name as the game gives it, rather than as its hrid spells it.
 * @param {string} abilityHrid - The ability
 * @returns {string}
 */
function abilityName(abilityHrid) {
    return dataManager.getInitClientData?.()?.abilityDetailMap?.[abilityHrid]?.name || '';
}

/**
 * What the books to a level would cost today, when the market can say.
 *
 * The same costing the sim's upgrade advisor uses — books at the market price,
 * from where the ability actually is, and null rather than zero when nobody is
 * selling the book. A manual goal is then estimated by the same arithmetic that
 * a sim-made one arrives with, so the two are comparable on the list.
 *
 * @param {string} abilityHrid - The ability
 * @param {number} targetLevel - The level being saved for
 * @returns {number|null} Coins, or null when the book has no listing
 */
export function abilityBookCost(abilityHrid, targetLevel) {
    if (!abilityHrid || !(targetLevel > 0)) return null;

    const owned = learnedAbilityLevels().get(abilityHrid) || null;
    const level = owned?.level || 0;
    if (level >= targetLevel) return 0;

    // The experience on a book already read is a position within its level, not
    // the floor of it — those books count towards the next one
    const floorXp = dataManager.getInitClientData?.()?.levelExperienceTable?.[level] || 0;
    const total = explainAbilityLevelUpCost(abilityHrid, level, owned?.experience ?? floorXp, targetLevel)?.total;

    return Number.isFinite(total) ? Math.max(0, total) : null;
}

/**
 * Every ability goal, against the level it is at and the coins you have.
 *
 * @returns {Array<Object>} `{abilityHrid, itemHrid, name, targetLevel, currentLevel, done, cost, ...}`
 */
export function watchedAbilityGoals() {
    const coins = spendable();
    const perDay = incomePerDay();
    const levels = learnedAbilityLevels();

    const goals = abilityGoals().map((goal) => {
        const currentLevel = levels.get(goal.abilityHrid)?.level || 0;
        const done = abilityGoalReached(goal, currentLevel);
        // A goal already reached costs nothing more, whatever it was costed at
        // when it went on the list
        const cost = done ? 0 : (goal.cost ?? null);
        const progress = savingsProgress(cost, coins);

        return {
            abilityHrid: goal.abilityHrid,
            // The book, so the icon and the marketplace link have something to
            // point at — an ability itself is not a tradeable thing
            itemHrid: abilityBookHrid(goal.abilityHrid),
            name: goal.label || abilityGoalLabel(goal.abilityHrid, goal.targetLevel, abilityName(goal.abilityHrid)),
            targetLevel: goal.targetLevel,
            currentLevel,
            done,
            ability: true,
            enhancementLevel: 0,
            cost,
            ...progress,
            seconds: timeToAffordSeconds(progress.needed, perDay),
        };
    });

    return orderTargets(goals);
}

/**
 * Save towards a level of an ability, from the panel.
 *
 * @param {string} abilityHrid - The ability
 * @param {number} targetLevel - The level wanted
 * @param {number|null} [cost] - Coins, when the market cannot be asked
 * @returns {Promise<void>}
 */
export async function watchAbility(abilityHrid, targetLevel, cost = undefined) {
    if (!abilityHrid || !(targetLevel > 0)) return;

    const priced = cost === undefined ? abilityBookCost(abilityHrid, targetLevel) : cost;
    await addAbilityGoal({
        abilityHrid,
        targetLevel,
        cost: priced,
        label: abilityGoalLabel(abilityHrid, targetLevel, abilityName(abilityHrid)),
    });
}

/**
 * Stop saving for a level of an ability.
 * @param {string} abilityHrid - The ability
 * @returns {Promise<void>}
 */
export async function unwatchAbility(abilityHrid) {
    await removeAbilityGoal(abilityHrid);
}

/**
 * Where the character's rooms actually are.
 *
 * @returns {Map<string, number>} Room hrid → the level it is built to
 */
export function houseRoomLevels() {
    const built = dataManager.getHouseRooms?.() || new Map();
    return new Map(
        [...built.entries()].map(([houseRoomHrid, room]) => [
            houseRoomHrid,
            Math.max(0, Math.floor(Number(room?.level) || 0)),
        ])
    );
}

/**
 * A room's name as the game gives it, rather than as its hrid spells it.
 * @param {string} houseRoomHrid - The room
 * @returns {string}
 */
function houseRoomName(houseRoomHrid) {
    return dataManager.getInitClientData?.()?.houseRoomDetailMap?.[houseRoomHrid]?.name || '';
}

/**
 * What building a room up to a level would cost today.
 *
 * The same basis the sim's upgrade advisor costs a house upgrade on: every level
 * from the one the room is at up to the target, coins in the list at face value
 * and materials at what it would cost to go and buy them. A material nobody is
 * selling makes the whole goal unpriced rather than cheap — a total that quietly
 * leaves out its most expensive line is worse than no total.
 *
 * @param {string} houseRoomHrid - The room
 * @param {number} targetLevel - The level being built to
 * @returns {number|null} Coins, or null when some part of it has no price
 */
export function houseUpgradeCost(houseRoomHrid, targetLevel) {
    if (!houseRoomHrid || !(targetLevel > 0)) return null;

    const currentLevel = houseRoomLevels().get(houseRoomHrid) || 0;
    if (currentLevel >= targetLevel) return 0;

    const costs = dataManager.getInitClientData?.()?.houseRoomDetailMap?.[houseRoomHrid]?.upgradeCostsMap;
    if (!costs) return null;

    let total = 0;
    for (let level = currentLevel + 1; level <= targetLevel; level++) {
        // Keyed by number in the payload and by string once it has been through
        // storage, and a missing level is a level this cannot price
        const materials = costs[level] ?? costs[String(level)];
        if (!Array.isArray(materials) || !materials.length) return null;

        for (const material of materials) {
            const count = Number(material?.count) || 0;
            if (!material?.itemHrid || count <= 0) continue;

            // Coins have no order book: they are worth exactly themselves
            if (material.itemHrid === '/items/coin') {
                total += count;
                continue;
            }

            const ask = buyPrice(material.itemHrid, 0);
            if (!(ask > 0)) return null;
            total += ask * count;
        }
    }
    return total;
}

/**
 * Every house room goal, against the level the room is at and the coins you have.
 *
 * @returns {Array<Object>} `{houseRoomHrid, skill, name, targetLevel, currentLevel, done, cost, ...}`
 */
export function watchedHouseGoals() {
    const coins = spendable();
    const perDay = incomePerDay();
    const levels = houseRoomLevels();

    const goals = houseGoals().map((goal) => {
        const currentLevel = levels.get(goal.houseRoomHrid) || 0;
        const done = houseGoalReached(goal, currentLevel);
        // A room already built costs nothing more, whatever it was costed at
        // when it went on the list
        const cost = done ? 0 : (goal.cost ?? null);
        const progress = savingsProgress(cost, coins);

        return {
            houseRoomHrid: goal.houseRoomHrid,
            // A room is built rather than bought, so there is no item to point
            // the marketplace at — the skill's artwork stands in for the icon
            itemHrid: '',
            skill: roomSkill(goal.houseRoomHrid),
            name: goal.label || houseGoalLabel(goal.houseRoomHrid, goal.targetLevel, houseRoomName(goal.houseRoomHrid)),
            targetLevel: goal.targetLevel,
            currentLevel,
            done,
            house: true,
            enhancementLevel: 0,
            cost,
            ...progress,
            seconds: timeToAffordSeconds(progress.needed, perDay),
        };
    });

    return orderTargets(goals);
}

/**
 * Save towards a level of a house room, from the panel.
 *
 * @param {string} houseRoomHrid - The room
 * @param {number} targetLevel - The level wanted, capped at the one the game builds to
 * @param {number|null} [cost] - Coins, when the market cannot be asked
 * @returns {Promise<void>}
 */
export async function watchHouse(houseRoomHrid, targetLevel, cost = undefined) {
    if (!houseRoomHrid || !(targetLevel > 0)) return;

    const wanted = Math.min(maxHouseRoomLevel(), Math.floor(Number(targetLevel) || 0));
    const priced = cost === undefined ? houseUpgradeCost(houseRoomHrid, wanted) : cost;
    await addHouseGoal({
        houseRoomHrid,
        targetLevel: wanted,
        cost: priced,
        label: houseGoalLabel(houseRoomHrid, wanted, houseRoomName(houseRoomHrid)),
    });
}

/**
 * Stop saving for a level of a house room.
 * @param {string} houseRoomHrid - The room
 * @returns {Promise<void>}
 */
export async function unwatchHouse(houseRoomHrid) {
    await removeHouseGoal(houseRoomHrid);
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
    const data = combatStatsDataCollector()?.getLatestData?.();
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
    const stats = combatStatsCalculator()?.calculatePlayerStats?.(player, seconds);
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
 * What selling the worn piece would actually put in hand: its bid net of the
 * market sell tax, since a trade-in is a sale — or the vendor's flat price when
 * that pays at least as much (the bulk-sell assistant's rule: the vendor wins a
 * tie, and only unenhanced stacks can be vendored). With no bid, an unenhanced
 * piece still fetches the vendor price. Zero when nothing is worn or nothing
 * would buy it. (Equipment is never a cowbell bag, so the 18% bag rate cannot
 * apply here.)
 *
 * @param {{itemHrid: string, enhancementLevel?: number}|null} worn - The worn item
 * @returns {number} After-tax whole coins
 */
function wornTradeIn(worn) {
    if (!worn) return 0;
    const level = worn.enhancementLevel || 0;
    const bid = sellPrice(worn.itemHrid, level);
    // The game floors the after-tax price of a sale to whole coins per unit
    const market = bid > 0 ? Math.floor(calculatePriceAfterTax(bid)) : 0;
    const vendor = level === 0 ? Number(dataManager.getItemDetails?.(worn.itemHrid)?.sellPrice) || 0 : 0;
    return Math.max(market, vendor);
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
    const totals = marketOrderTotals()?.calculateTotals?.();
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
    return oncePerPass(`recipe:${itemHrid}`, () => {
        // The shared reverse index rather than a scan of the whole action table.
        // `production-index.js` exists because several features answered this
        // question by walking every action in the game; this one walked it once
        // per target per redraw, and once more for the ladder's base, and the
        // walk allocates an entry array per action every time. The index answers
        // in the same order — first producing action, its matching output — so
        // the recipe picked cannot change.
        const producer = findProducingAction(itemHrid);
        if (!producer) return null;
        const { actionHrid, action, output } = producer;

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
            // Refinement recipes carry the base's enhancement into the output:
            // a ★+12 made this way is made FROM a +12 base, not a +0
            retainAllEnhancement: Boolean(action.retainAllEnhancement),
            outputCount: output.count || 1,
        };
    });
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
    // A copy on the auction is not in hand: it cannot be consumed
    return (dataManager.getInventory?.() || []).some(
        (item) => item.itemHrid === itemHrid && (item.count || 0) > 0 && item.itemLocationHrid !== LISTED_LOCATION
    );
}

/**
 * Whether the only copies of a piece are on the market, for a line that would otherwise say "you have
 * one".
 * @param {string} itemHrid - The piece
 * @returns {boolean}
 */
function onlyListed(itemHrid) {
    const copies = (dataManager.getInventory?.() || []).filter(
        (item) => item.itemHrid === itemHrid && item.count !== 0
    );
    return copies.length > 0 && copies.every((item) => item.itemLocationHrid === LISTED_LOCATION);
}

/**
 * Protect-from sweeps already run, per enhancement engine.
 *
 * Keyed by the calculator object rather than held in one table so a reloaded
 * bundle — or a suite standing its own calculator up — never reads answers the
 * previous one produced.
 * @type {WeakMap<Function, Map<string, number|null>>}
 */
const sweptRuns = new WeakMap();

/** Sweeps remembered per engine before the table is dropped and refilled */
const SWEPT_RUN_LIMIT = 400;

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
    if (!(targetLevel > startLevel) || targetLevel > ENHANCEMENT_SOLVER_MAX_LEVEL) return null;

    // The character's own gear, skill and teas — always. This path only fires when the
    // finished piece has no ask at any price, so there is nobody else whose bench could
    // produce it: a bench typed into the simulator, or the Pro toggle's, quotes a run
    // that cannot be made on this player's behalf. The card's rule is the `savings`
    // entry in `SURFACE_RULES` (`ownBench: 'always'`), and the parity suite pins that
    // it ignores the manual panel and the Pro toggle alike.
    const params = savingsParams(itemHrid);
    const details = dataManager.getItemDetails?.(itemHrid);
    const calculate = enhancementCalculator()?.calculateEnhancement;
    if (!params || !details || !calculate) return null;

    // Priced by the one shared rule: a one-sided book cross-fills, and only then
    // does it fall back to what the thing costs to make. The vendor price is not a
    // fallback. This card used to take `ask || sellPrice`, which on a bid-only book
    // quoted the vendor price — a ninth of the real bill on the fixtures in
    // enhancement-cost-parity.test.js. A material nothing can price makes the whole
    // run unpriced (see the plan check below).
    const materials = perAttemptMaterialCost(details);
    if (!materials.hasCost) return null;
    // A craft-priced material with an unpriced input is a partial bill: the same as a missing price
    const unpricedMaterials = Boolean(materials.hasMissingPrices || materials.hasPartialPrices);

    // Without `includeSelf` this would offer a second copy of the piece as
    // protection. This card exists for untradable gear, where there is no second
    // copy to buy at any price, and the fallback would quote the vendor sell
    // price — which is not an offer anyone will honour.
    const protection = getCheapestProtectionPrice(itemHrid, { includeSelf: false });
    // A craft-priced protection with an unpriced input is a floor, not a price: costed like a partial
    // material bill (unknown), never quoted as a firm figure. Read defensively: older quotes lack the flag.
    const protectionPartial = Boolean(protection?.partial);

    // Nothing below this line reads the game again: the sweep is a pure function
    // of the numbers gathered above, and it is the expensive half of this whole
    // card — a run sweeps one Markov chain per protect-from level of the climb,
    // and a list of eight enhancing targets costs two runs each, which was ~190
    // chains solved on every redraw of a list nothing had touched. Keyed on
    // those numbers rather than on a clock or an event, so a hit is the same
    // answer a recomputation would give: a moved bench, material price or
    // protection price is a different key. Per engine, so a rebuilt bundle
    // starts clean.
    const key = [
        itemHrid,
        targetLevel,
        startLevel,
        params.enhancingLevel || 0,
        params.toolBonus || 0,
        params.speedBonus || 0,
        details.itemLevel || 0,
        params.teas?.blessed ? 1 : 0,
        params.guzzlingBonus || 1,
        params.blessedTeaBonus ?? '',
        materials.cost,
        unpricedMaterials ? 1 : 0,
        protection.itemHrid || '',
        protection.price,
        protectionPartial ? 1 : 0,
    ].join('|');
    let swept = sweptRuns.get(calculate);
    if (!swept) {
        swept = new Map();
        sweptRuns.set(calculate, swept);
    }
    if (swept.has(key)) return swept.get(key);

    try {
        // Falling all the way back to +0 on every failure is what "no
        // protection" means, and past about +5 it is ruinous — nobody enhances
        // that way, so costing it that way would report a number no player
        // would ever pay. The run to price is the cheapest of the protect-from
        // choices, and that search — from +2 to the target whatever level the
        // run starts at — now lives in the engine as `protectFromLevels`, with
        // the reason attached.
        const plan = cheapestProtectPlan({
            chain: {
                enhancingLevel: params.enhancingLevel || 0,
                toolBonus: params.toolBonus || 0,
                speedBonus: params.speedBonus || 0,
                itemLevel: details.itemLevel || 0,
                blessedTea: Boolean(params.teas?.blessed),
                guzzlingBonus: params.guzzlingBonus || 1,
                // Forwarded where it used to be dropped: without it the chain
                // fell back to the stock 1% double-jump chance rather than the
                // character's real one
                blessedTeaBonus: params.blessedTeaBonus,
            },
            targetLevel,
            startLevel,
            materialCostPerAttempt: materials.cost,
            protectionOptions: protection.price > 0 ? [{ itemHrid: protection.itemHrid, price: protection.price }] : [],
            hasMissingPrices: unpricedMaterials,
            // The namespace's calculator rather than the engine's own import.
            // In the built script they are the same module — enhancement-calculator
            // is shared, so the market bundle's import resolves to exactly this
            // object — but going through the bridge keeps the seam this module's
            // suite stands a stub in front of to make the arithmetic legible.
            calculate,
        });

        // A plan that left a material unpriced is a partial bill: unknown, like a run nothing
        // could price, so the target reads as unpriced instead of quoting the part that had a price
        // A partial protection quote only taints a plan that actually spends protection: a run
        // that never protects (a +0 to +1 climb) does not depend on that price at all
        const cost = plan && !plan.hasMissingPrices && !(protectionPartial && plan.protections > 0) ? plan.cost : null;
        // Bounded rather than grown forever: a player editing a target's level
        // walks through twenty keys a piece, and nothing here is worth holding
        // an unbounded table for. A failed sweep is not cached — the next draw
        // should try it again rather than repeat the failure.
        if (swept.size >= SWEPT_RUN_LIMIT) swept.clear();
        swept.set(key, cost);
        return cost;
    } catch (error) {
        console.error('[EquipmentSavings] Costing an enhancement run failed:', error);
        return null;
    }
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
        // Equipped copies don't reliably carry a count field the way stacked
        // inventory items do — requiring count > 0 dropped them, so the piece
        // on your back read as unowned. Skip only an explicit zero (a consumed
        // stack), matching highestOwnedEnhancements in loadout-snapshot.js.
        if (item.itemHrid !== itemHrid || item.count === 0 || item.itemLocationHrid === LISTED_LOCATION) continue;
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
        // Same equipped-copy caveat as highestOwnedLevel above: only an
        // explicit zero disqualifies an entry.
        if (item.itemHrid !== itemHrid || item.count === 0 || item.itemLocationHrid === LISTED_LOCATION) continue;
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
    return oncePerPass(`base:${itemHrid}`, () => {
        const ask = buyPrice(itemHrid, 0);
        if (ask > 0) return ask;

        // The shop walk below prices every line in the shop to value the token
        // the base is bought with, which for a cape is a few hundred market
        // lookups — once per target and again for its ladder before this memo
        const data = dataManager.getInitClientData?.() || {};
        const shops = [data.shopItemDetailMap, data.taskShopItemDetailMap, data.labyrinthShopItemDetailMap];
        return shopPurchasePriceByMode(itemHrid, shops) || 0;
    });
}

/**
 * What one target costs, bought or crafted.
 *
 * @param {string} itemHrid - The target
 * @param {number} enhancementLevel - Which enhancement
 * @returns {{cost: number|null, ask: number, crafted: boolean, recipe: Object|null}}
 */
function conventionalCost(itemHrid, enhancementLevel) {
    const ask = buyPrice(itemHrid, enhancementLevel);
    const worn = wornRivalOf(itemHrid);
    const wornBid = wornTradeIn(worn);
    const noSell = targetNoSell(itemHrid, enhancementLevel);

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
                // Before any trade-in, for the real cost the route table compares on
                const directGross = run + baseAsk;
                // The safe way round the same run, priced beside it
                const ladder = ladderOption(itemHrid, enhancementLevel);
                // The mode stays stored even when the ladder is not currently
                // there to climb — sell the spare and the card falls back to
                // the direct run rather than to no figure, and buying another
                // spare puts it back the way you left it
                const laddering = Boolean(ladder) && isLaddering(itemHrid, enhancementLevel);

                return {
                    cost: laddering ? ladder.cost : direct,
                    mode: laddering ? 'ladder' : 'direct',
                    // Whose bench every enhancement figure on this card was run
                    // on — the same resolver `enhancementCost` asked, so the chip
                    // and the number can never name different benches.
                    enhanceSource: describeEnhancementSource(savingsParams(itemHrid)),
                    // Whichever one is not the basis is still worth a line, so
                    // the card always carries both
                    direct,
                    directGross,
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

    if (!isCrafting(itemHrid, enhancementLevel) || !craftMakesTarget(itemHrid, enhancementLevel)) {
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
    const materials = craftMaterialsCost(itemHrid, recipe, enhancementLevel);

    if (materials === null) return { cost: null, ask, crafted: true, recipe, upgradeBaseLevel: 0 };
    // The trade-in still applies: crafting the replacement does not stop you
    // selling the piece it replaces
    return {
        cost: noSell ? materials.cost : Math.max(0, materials.cost - wornBid),
        ask,
        crafted: true,
        recipe,
        // The level the base was priced at, carried out so the Missing Mats
        // button shops for the same thing this figure paid for
        upgradeBaseLevel: materials.upgradeBaseLevel,
    };
}

/**
 * Whether crafting yields the target AT its level. A recipe that does not retain enhancement makes a
 * +0, so for a +12 target it is not a route at all (pricing its materials would quote a +0's price
 * for a +12). A +0 target needs only a recipe.
 *
 * @param {string} itemHrid - The target
 * @param {number} enhancementLevel - The level wanted
 * @returns {boolean}
 */
function craftMakesTarget(itemHrid, enhancementLevel) {
    const recipe = recipeFor(itemHrid);
    if (!recipe?.inputItems?.length) return false;
    return !(enhancementLevel > 0) || Boolean(recipe.retainAllEnhancement);
}

/**
 * Whether a crafting plan prices every leg. A total is only a price if no node under it is a purchase
 * nobody quotes: a partial sum would read as a cheap craft.
 *
 * @param {Object|null} node - A plan node from the planner
 * @returns {boolean}
 */
function planPriced(node) {
    if (!node || !Number.isFinite(node.totalCost)) return false;
    if (node.strategy === 'buy' && node.itemHrid !== '/items/coin' && !(node.buyPrice > 0)) return false;
    return (node.children || []).every(planPriced);
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
 * @param {number} [enhancementLevel] - The level the output is wanted at
 * @returns {{cost: number, upgradeBaseLevel: number}|null} Coins for one and the
 *   level its base was shopped for, or null when it cannot be priced
 */
function craftMaterialsCost(itemHrid, recipe, enhancementLevel = 0) {
    return oncePerPass(`craftmat:${itemHrid}:${enhancementLevel}`, () =>
        craftMaterialsCostRaw(itemHrid, recipe, enhancementLevel)
    );
}

/**
 * The body of {@link craftMaterialsCost}, unmemoized.
 * @param {string} itemHrid - The finished piece
 * @param {Object|null} recipe - From `recipeFor`
 * @param {number} enhancementLevel - The level the output is wanted at
 * @returns {{cost: number, upgradeBaseLevel: number, consumed: Object|null}|null}
 */
function craftMaterialsCostRaw(itemHrid, recipe, enhancementLevel) {
    const planner = craftingPlanCalculator()?.computeBestCraftingPlan;
    // The mode's own name, not the side it resolves to: the planner then prices through the profit
    // context and applies the patient tick, where a bare 'ask'/'bid' is taken as an explicit side and
    // skips it (the same call the action panel's cost summary makes)
    const plannerMode = config.getSettingValue?.('profitCalc_pricingMode') || 'hybrid';
    const plannerBase = (hrid) => {
        if (planner) {
            const plan = planner(hrid, 1, plannerMode);
            if (planPriced(plan)) return plan.totalCost;
        }
        const ask = buyPrice(hrid, 0);
        return ask > 0 ? ask : null;
    };

    if (planner && recipe?.inputItems?.length) {
        try {
            let total = 0;
            for (const input of recipe.inputItems) {
                const plan = planner(input.itemHrid, input.count || 0, plannerMode);
                if (!planPriced(plan)) return null;
                total += plan.totalCost;
            }

            const base = upgradeBaseRoute(recipe, enhancementLevel, plannerBase);
            if (base.cost === null) return null;
            total += base.cost;

            return {
                cost: total / (recipe.outputCount > 0 ? recipe.outputCount : 1),
                upgradeBaseLevel: base.level,
                consumed: upgradeBaseConsumed(recipe, enhancementLevel, base),
            };
        } catch (error) {
            console.error('[EquipmentSavings] The crafting planner failed, falling back to material asks:', error);
        }
    }

    const flatBase = upgradeBaseRoute(recipe, enhancementLevel, plannerBase);
    if (flatBase.cost === null) return null;
    const flat = craftCost({
        inputItems: recipe?.inputItems,
        priceOf: (hrid) => buyPrice(hrid, 0),
        outputCount: recipe?.outputCount,
        // The base is priced level-aware above, never inside craftCost
        haveBase: true,
        upgradeAsk: 0,
    });
    return flat === null
        ? null
        : {
              cost: flat + flatBase.cost,
              upgradeBaseLevel: flatBase.level,
              consumed: upgradeBaseConsumed(recipe, enhancementLevel, flatBase),
          };
}

/**
 * The owned copy of a recipe's base that the chosen base route uses up, if any.
 *
 * `upgradeBaseRoute` prices a base you hold at nothing, which is right for the coins to find and wrong
 * for what the route really costs: the copy is consumed, so a sale is given up. This names it so the
 * route's real cost can charge it. A plain recipe takes the lowest-level owned copy (the cheapest to
 * give up); a retaining recipe takes the held copy at the level, or the best copy it enhances up.
 *
 * @param {Object|null} recipe - From `recipeFor`
 * @param {number} enhancementLevel - The level the OUTPUT is wanted at
 * @param {{cost: number|null, level: number}} route - From `upgradeBaseRoute`
 * @returns {{itemHrid: string, level: number}|null} Null when nothing owned is used
 */
function upgradeBaseConsumed(recipe, enhancementLevel, route) {
    const baseHrid = recipe?.upgradeItemHrid;
    if (!baseHrid || route?.cost === null) return null;

    const needsLevel = recipe.retainAllEnhancement ? enhancementLevel || 0 : 0;
    const held = highestOwnedLevel(baseHrid);
    if (held === null) return null;
    if (needsLevel <= 0) return { itemHrid: baseHrid, level: lowestOwnedLevel(baseHrid) ?? held };
    // Held at the level: used as it is. Held below it with the run chosen: the copy enhanced up. A
    // bought listing leaves the held copy alone
    if (held >= needsLevel || route.level === 0) return { itemHrid: baseHrid, level: held };
    return null;
}

/**
 * The lowest enhancement level at which a piece is held.
 * @param {string} itemHrid - The piece
 * @returns {number|null} Null when none is held
 */
function lowestOwnedLevel(itemHrid) {
    let best = null;
    for (const item of dataManager.getInventory?.() || []) {
        if (item.itemHrid !== itemHrid || item.count === 0 || item.itemLocationHrid === LISTED_LOCATION) continue;
        const level = item.enhancementLevel || 0;
        if (best === null || level < best) best = level;
    }
    return best;
}

/**
 * What the recipe's base piece costs, at the level the output demands.
 *
 * A plain upgrade recipe consumes its base at any level, so one in the bag is
 * free and a missing one costs a +0. A `retainAllEnhancement` recipe is
 * different: the output inherits the base's enhancement, so a ★+12 target is
 * made FROM a +12 base — a bag copy only helps as a starting point for the
 * enhance up, and the cost is whichever is cheaper of buying one already at
 * the level and enhancing the best copy held (a fresh +0 when none is).
 *
 * @param {Object|null} recipe - From `recipeFor`
 * @param {number} enhancementLevel - The level the OUTPUT is wanted at
 * @param {Function} priceBase - +0 base price (planner or ask), null when unpriceable
 * @returns {number|null} Coins, 0 when the base in hand suffices, null when unpriceable
 */
export function upgradeBaseCost(recipe, enhancementLevel, priceBase) {
    return upgradeBaseRoute(recipe, enhancementLevel, priceBase).cost;
}

/**
 * The same figure, and WHICH shop it was costed at.
 *
 * The cost alone cannot tell the Missing Mats button what listing to open: the
 * two routes buy different things. Winning on `directAsk` means the base is
 * bought already at the level, so the bill wants that level's listing. Winning
 * on the run means what is bought is a +0 to enhance, so the bill wants the +0
 * — which is what the button has always opened, and is right for that route
 * alone. Both come out of one comparison here so the panel's figure and the
 * button's listing can never be reasoning about different routes.
 *
 * `level` is the level to SHOP for, not the level wanted: it is 0 whenever the
 * run supplies the enhancement, and 0 for every recipe that does not retain
 * enhancement at all.
 *
 * @param {Object|null} recipe - From `recipeFor`
 * @param {number} enhancementLevel - The level the OUTPUT is wanted at
 * @param {Function} priceBase - +0 base price (planner or ask), null when unpriceable
 * @returns {{cost: number|null, level: number}} Coins for the base, and the level to buy it at
 */
export function upgradeBaseRoute(recipe, enhancementLevel, priceBase) {
    const baseHrid = recipe?.upgradeItemHrid;
    if (!baseHrid) return { cost: 0, level: 0 };

    const needsLevel = recipe.retainAllEnhancement ? enhancementLevel || 0 : 0;
    if (needsLevel <= 0) {
        if (ownsBase(baseHrid)) return { cost: 0, level: 0 };
        return { cost: priceBase(baseHrid), level: 0 };
    }

    const held = highestOwnedLevel(baseHrid);
    // Already in the bag at the level: nothing to buy, but the bill is still
    // ABOUT that level, and a tab reading "sufficient" against +0 copies while
    // the +12 sits unspent would be the same lie the other way round
    if (held !== null && held >= needsLevel) return { cost: 0, level: needsLevel };

    const candidates = [];
    const directAsk = buyPrice(baseHrid, needsLevel);
    if (directAsk > 0) candidates.push({ cost: directAsk, level: needsLevel });

    const run = enhancementCost(baseHrid, needsLevel, held ?? 0);
    if (run !== null) {
        const fresh = held !== null ? 0 : priceBase(baseHrid);
        if (fresh !== null) candidates.push({ cost: run + fresh, level: 0 });
    }

    if (!candidates.length) return { cost: null, level: needsLevel };
    // Ties go to the listing, which is the one route the button can shop for
    return candidates.reduce((best, entry) => (entry.cost < best.cost ? entry : best));
}

/** Where a piece in the inventory list is a market listing, which cannot be spent */
const LISTED_LOCATION = '/item_locations/market_listing';

/** Where an unequipped piece sits */
const BAG_LOCATION = '/item_locations/inventory';

/**
 * Whether a copy of exactly this piece at exactly this level is in hand to be consumed.
 *
 * A bag copy is preferred to the worn one: the worn one is what the trade-in
 * rule is about. A listed copy is on the auction and cannot go into a mirror.
 *
 * @param {string} itemHrid - The piece
 * @param {number} level - Enhancement level
 * @param {{itemHrid: string, enhancementLevel?: number}|null} worn - What the slot holds
 * @returns {{worn: boolean}|null} Null when none is held
 */
function heldCopyAt(itemHrid, level, worn) {
    let bag = false;
    let equipped = false;
    for (const item of dataManager.getInventory?.() || []) {
        // Same explicit-zero-only rule as highestOwnedLevel: an equipped entry carries no count
        if (item.itemHrid !== itemHrid || item.count === 0) continue;
        if ((item.enhancementLevel || 0) !== level) continue;
        const location = item.itemLocationHrid;
        if (location === LISTED_LOCATION) continue;
        if (!location || location === BAG_LOCATION) bag = true;
        else equipped = true;
    }
    if (bag) return { worn: false };
    const wornMatch = Boolean(worn) && worn.itemHrid === itemHrid && (worn.enhancementLevel || 0) === level;
    if (wornMatch) return { worn: true };
    return equipped ? { worn: false } : null;
}

/**
 * What a Philosopher's Mirror costs to buy: the ASK, the same book side the build's inputs and the
 * Buy route are priced on. Only when the book has no ask is the shared resolver's estimate used,
 * and then it is flagged so the card shows it as an estimate rather than a firm price.
 *
 * @returns {{price: number, estimated: boolean}|null} Null when nothing prices the mirror
 */
function mirrorQuote() {
    const ask = buyPrice(MIRROR_ITEM_HRID, 0);
    if (ask > 0) return { price: ask, estimated: false };

    const guarded = priceMirror();
    if (guarded?.price > 0 && !guarded.unpriced && !guarded.partial) return { price: guarded.price, estimated: true };
    return null;
}

/**
 * The Philosopher's Mirror build for one target: a +L is made from a +(L-1) of the
 * piece itself and a +(L-2) of its base item (the unrefined one for a refined piece,
 * `baseItemHrids[0]`), plus a mirror. The same recipe the enhancement tooltip and the
 * upgrade advisor price (see `utils/mirror-route.js`).
 *
 * An input already owned is CONSUMED, so it is not free: it is charged at what selling it
 * would have fetched (its sell-side price after tax). An input not owned is bought at its buy-side price (the ask in
 * Conservative mode, per `profitCalc_pricingMode`). Three
 * figures come out, because they answer three questions:
 *
 * - `cash`: coins to find. Bought inputs and the mirror, less the worn piece's trade-in when
 *   the worn piece is not itself consumed (a consumed worn piece cannot also be sold). This is
 *   what the bar, the countdown and the alerts fill against.
 * - `real`: `coins` plus the sale value of the owned copies the build uses, net of the trade-in
 *   credit the buy route also nets. This is what routes are compared on, so a build never wins
 *   merely because it needs less cash.
 * - `forgone`: the sale value of the owned copies consumed, for the card's own line.
 *
 * Not modelled (the build is simply not offered, never mispriced): building an input with a
 * mirror of its own, enhancing an owned lower copy up to the level, Blessed Tea.
 *
 * @param {string} itemHrid - The target
 * @param {number} level - Enhancement level wanted
 * @param {Object} [context] - Context
 * @param {Object|null} [context.worn] - The piece in the slot
 * @param {boolean} [context.noSell] - Keeping the old piece, so no trade-in
 * @returns {Object|null} Null when the build does not apply; `{unpriced: true}` when an input
 *   or the mirror has no price; otherwise the priced build
 */
export function mirrorBuildRoute(itemHrid, level, { worn = null, noSell = false } = {}) {
    if (!itemHrid || !(level >= MIRROR_FIRST_LEVEL)) return null;

    const mirror = mirrorQuote();
    if (!mirror) return null;

    const details = dataManager.getItemDetails?.(itemHrid);
    const baseHrid =
        details?.baseItemHrids?.[0] ||
        (itemHrid.endsWith('_refined') ? recipeFor(itemHrid)?.upgradeItemHrid : null) ||
        itemHrid;

    const wanted = [
        { itemHrid, level: level - 1 },
        { itemHrid: baseHrid, level: level - 2 },
    ];
    const inputs = [];
    let bought = 0;
    let forgone = 0;
    let wornConsumed = false;
    let saleKnown = true;
    for (const want of wanted) {
        const held = heldCopyAt(want.itemHrid, want.level, worn);
        if (held) {
            // What selling it would have fetched, after tax. No bid is an unknown sale, never a free copy:
            // the cash is still known (an owned copy costs no coins), so only the real cost goes unknown.
            // The worn piece while selling is the exception: its sale is the trade-in every route nets
            const sale = wornTradeIn({ itemHrid: want.itemHrid, enhancementLevel: want.level });
            if (!(sale > 0) && !(held.worn && !noSell)) saleKnown = false;
            forgone += sale;
            if (held.worn) wornConsumed = true;
            inputs.push({ ...want, owned: true, worn: held.worn, price: sale });
        } else {
            const ask = buyPrice(want.itemHrid, want.level);
            if (!(ask > 0)) return { unpriced: true };
            bought += ask;
            inputs.push({ ...want, owned: false, worn: false, price: ask });
        }
    }

    const coins = bought + mirror.price;
    const credit = noSell ? 0 : wornTradeIn(worn);
    return {
        inputs,
        mirrorPrice: mirror.price,
        // No ask on the book: the price is the shared resolver's estimate, and the card says so
        estimated: mirror.estimated,
        coins,
        forgone,
        wornConsumed,
        cash: Math.max(0, coins - (wornConsumed ? 0 : credit)),
        // Not clamped: two routes that both net below the trade-in must still compare. Display clamps
        real: saleKnown ? coins + forgone - credit : null,
        bill: [
            ...inputs
                .filter((input) => !input.owned)
                .map((input) => ({ itemHrid: input.itemHrid, enhancementLevel: input.level, count: 1 })),
            { itemHrid: MIRROR_ITEM_HRID, count: 1 },
        ],
    };
}

/**
 * What one target costs by the cheapest route: the conventional one (buy, craft, or
 * enhance) or a Philosopher's Mirror build.
 *
 * Routes are compared on REAL cost, but `cost` stays the coins to find, which is what every
 * reader (bar, countdown, sort, totals, alerts) fills against. Without a mirror price, or on
 * the enhance-only route for gear nobody sells, the result is the conventional one unchanged.
 *
 * @param {string} itemHrid - The target
 * @param {number} enhancementLevel - Which enhancement
 * @param {Object} [options] - Options
 * @param {boolean} [options.mirror] - Whether a mirror build may win (off when an advisor quote supplies the figure)
 * @returns {Object} `conventionalCost`'s fields plus `realCost`, `route` ('mirror' when the build wins)
 *   and `mirrorBuild` (the priced build, winning or not)
 */
function costOf(
    itemHrid,
    enhancementLevel,
    { mirror: allowMirror = true, pin: routePinned = null, ladder: ladderPinned = false, preference = 'auto' } = {}
) {
    const base = conventionalCost(itemHrid, enhancementLevel);
    const worn = wornRivalOf(itemHrid);
    const noSell = targetNoSell(itemHrid, enhancementLevel);
    const wornBid = wornTradeIn(worn);
    // The sale the baseline "buy it, sell the old piece" nets; every route's real cost is measured from it
    const credit = noSell ? 0 : wornBid;
    // What an owned copy a route uses up would have fetched. A copy nothing bids for gives up no sale
    // only when it is untradable; a tradable copy with an empty book leaves the route unpriced (null),
    // as the mirror does. Not clamped at zero: comparison must not hide a route that nets below the credit
    const gives = (copy) => {
        if (!copy) return 0;
        const sale = wornTradeIn({ itemHrid: copy.itemHrid, enhancementLevel: copy.level });
        if (sale > 0) return sale;
        // The worn piece used up: its sale is the very trade-in the baseline nets (the same lookup), so the
        // unknown cancels and the real cost is known after all
        if (!noSell && heldCopyAt(copy.itemHrid, copy.level, worn)?.worn === true) return 0;
        return dataManager.getItemDetails?.(copy.itemHrid)?.isTradable === false ? 0 : null;
    };
    const realOf = (gross, copy) => {
        const sale = gives(copy);
        return sale === null ? null : gross + sale - credit;
    };

    const rows = [];
    const add = (id, cash, real, extra = {}) =>
        rows.push({ id, label: ROUTE_LABELS[id], cash, real, priced: cash !== null && real !== null, ...extra });

    let eligible;
    if (base.enhancing) {
        // A piece nobody sells: the run at the anvil, directly or up a ladder
        add(
            'enhance',
            base.direct,
            base.direct === null
                ? null
                : realOf(base.directGross, base.ownsBase ? { itemHrid, level: base.fromLevel } : null)
        );
        if (base.ladder) {
            const spare = base.ladder.spare ? { itemHrid, level: base.ladder.fromLevel } : null;
            add('ladder', base.ladder.cost, realOf(base.ladder.cost, spare));
        }
        // Direct unless the ladder is pinned: Auto never climbs it on its own
        eligible = ['enhance'];
    } else {
        if (base.ask > 0) {
            const cash = upgradeCost({ targetAsk: base.ask, equippedBid: wornBid, noSell });
            add('buy', cash, cash === null ? null : realOf(base.ask, null));
        } else {
            // Nobody selling one right now: still a route, listed as unpriced so the card shows it is missing
            add('buy', null, null);
        }
        const recipe = recipeFor(itemHrid);
        // A craft route exists only where there is a recipe to craft from
        if (craftMakesTarget(itemHrid, enhancementLevel)) {
            const materials = craftMaterialsCost(itemHrid, recipe, enhancementLevel);
            if (materials === null) add('craft', null, null);
            else {
                // A craft that uses up the worn piece cannot also sell it, so no trade-in against the cash
                const usesWorn =
                    materials.consumed &&
                    heldCopyAt(materials.consumed.itemHrid, materials.consumed.level, worn)?.worn === true;
                add(
                    'craft',
                    noSell || usesWorn ? materials.cost : Math.max(0, materials.cost - wornBid),
                    realOf(materials.cost, materials.consumed),
                    { recipe, upgradeBaseLevel: materials.upgradeBaseLevel }
                );
            }
        }
        const build = mirrorBuildRoute(itemHrid, enhancementLevel, { worn, noSell });
        // From +MIRROR_FIRST_LEVEL up a mirror build always applies; no build means the mirror itself has no price
        if (build?.unpriced || (!build && enhancementLevel >= MIRROR_FIRST_LEVEL)) add('mirror', null, null);
        else if (build) add('mirror', build.cash, build.real, { build, estimated: build.estimated });
        // Auto weighs every route there is
        eligible = ['buy', 'craft', 'mirror'];
    }

    // The pin: on a piece nobody sells it is the ladder switch (`mode`), otherwise buy, craft or mirror
    const pin = base.enhancing ? (ladderPinned ? 'ladder' : null) : routePinned;

    const usable = (id) => rows.find((row) => row.id === id && row.priced && (allowMirror || id !== 'mirror'));
    // A pin needs only its coins to find: real cost steers Auto and Prefer, and a pin is not steered
    const standing = (id) => rows.find((row) => row.id === id && row.cash !== null && (allowMirror || id !== 'mirror'));
    let chosen = null;
    let pinNote = '';
    if (pin) {
        chosen = standing(pin) || null;
        if (!chosen) {
            const applies = rows.some((row) => row.id === pin && (allowMirror || pin !== 'mirror'));
            pinNote = applies
                ? `${ROUTE_LABELS[pin]} is pinned but has no price right now, so Auto is used.`
                : `${ROUTE_LABELS[pin]} is pinned but doesn't apply to this item, so Auto is used.`;
        }
    }
    // "Prefer X" is for cards left on Auto: X whenever it is priced and applicable
    if (!chosen && !pin && preference !== 'auto') chosen = usable(preference) || null;
    if (!chosen) {
        for (const id of eligible) {
            const row = usable(id);
            if (row && (!chosen || row.real < chosen.real)) chosen = row;
        }
    }

    const routes = rows.map(({ id, label, cash, real, priced, estimated }) => ({
        id,
        label,
        cash,
        real,
        priced,
        estimated: Boolean(estimated),
        chosen: chosen?.id === id,
    }));
    const common = { routes, pin, pinNote, pinned: Boolean(pin && chosen?.id === pin) };
    if (!chosen) return { ...base, ...common, realCost: base.cost, route: null, mirrorBuild: null };

    const build = rows.find((row) => row.id === 'mirror')?.build || null;
    const result = {
        ...base,
        ...common,
        cost: chosen.cash,
        realCost: chosen.real,
        route: chosen.id,
        mirrorBuild: build,
    };
    if (chosen.id === 'ladder') result.mode = 'ladder';
    else if (chosen.id === 'enhance') result.mode = 'direct';
    else if (chosen.id === 'craft') {
        result.recipe = chosen.recipe || result.recipe;
        result.upgradeBaseLevel = chosen.upgradeBaseLevel || 0;
    } else {
        // The craft route's listing no longer applies
        result.upgradeBaseLevel = 0;
    }
    return result;
}

/**
 * Every target, costed against what you are wearing and what you have.
 *
 * @returns {Array<Object>} `{itemHrid, name, enhancementLevel, ask, cost, ...}`
 */
export function watchedTargets() {
    return inPass(costEveryTarget);
}

/**
 * The body of {@link watchedTargets}, run inside a pass.
 * @returns {Array<Object>} Same shape as `watchedTargets`
 */
function costEveryTarget() {
    const coins = spendable();
    const perDay = incomePerDay();

    const targets = Object.entries(state.targets).map(([key, target]) => {
        const itemHrid = target.itemHrid || key;
        const enhancementLevel = target.enhancementLevel || 0;
        const {
            cost,
            realCost,
            route,
            mirrorBuild,
            routes,
            pin,
            pinNote,
            ask,
            crafted,
            recipe,
            enhancing,
            fromLevel,
            ownsBase: holdsBase,
            ladder,
            direct,
            mode,
            enhanceSource,
            upgradeBaseLevel,
        } = costOf(itemHrid, enhancementLevel, {
            pin: routePinOf(target),
            ladder: target.mode === 'ladder',
            preference: routePreference(),
        });

        const worn = wornRivalOf(itemHrid);
        const wornBid = wornTradeIn(worn);

        // An advisor's figure is only a reference: it was frozen when Watch was pressed, and it
        // ignored the route chip. Every card is costed here, live, along its route
        const quoted = Number.isFinite(target.quotedCost) ? target.quotedCost : null;
        const progress = savingsProgress(cost, coins);

        return {
            key,
            itemHrid,
            name: nameOf(itemHrid),
            enhancementLevel,
            ask,
            crafted,
            enhancing: Boolean(enhancing),
            // Whose enhancing stats the derived figure was run on, for the card
            // to name beside it — null on a target that runs no sweep
            enhanceSource: enhanceSource || null,
            ownsBase: Boolean(holdsBase),
            fromLevel: fromLevel || 0,
            ladder: ladder || null,
            direct: direct ?? null,
            // Which of the two paths every figure below is counted along
            mode: mode || 'direct',
            recipe,
            // Which listing the craft's base was costed at, so the Missing Mats
            // button opens that one rather than always the +0
            upgradeBaseLevel: upgradeBaseLevel || 0,
            noSell: targetNoSell(itemHrid, enhancementLevel),
            ownNoSell: target.noSell !== undefined,
            worn: worn ? { ...worn, name: nameOf(worn.itemHrid), bid: wornBid } : null,
            // Coins to find: what the bar, the countdown, the sort and the totals fill against
            cost,
            // The cost with the sale value of any owned copy a route consumes counted in. Only
            // choosing between routes reads it
            realCost,
            // The route the figure is counted along: 'buy', 'craft', 'mirror', 'enhance' or 'ladder'
            // (null when unpriced)
            route,
            // Every route that applies, each with its cash and real cost and the chosen one marked
            routes,
            // The route the card is pinned to (null = Auto), and why a pin is not in force
            pin: pin || null,
            pinNote,
            // The priced build whether or not it won, for the card to name or offer
            mirrorBuild: mirrorBuild || null,
            // The advisor's figure from when the card was added, shown beside the live one
            quotedCost: quoted,
            quotedFrom: quoted === null ? '' : target.quotedFrom || '',
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
    return inPass(costEverything);
}

/**
 * The body of {@link everything}, run inside a pass so the targets under it and
 * the totals over them share one memo rather than one each.
 * @returns {Object} Same shape as `everything`
 */
function costEverything() {
    const targets = watchedTargets();
    const abilities = watchedAbilityGoals();
    const houses = watchedHouseGoals();
    // A level already reached is not part of what is left to save for, and
    // totalling it would keep the plan expensive after it got cheaper
    const outstanding = [...targets, ...abilities.filter((goal) => !goal.done), ...houses.filter((goal) => !goal.done)];

    const { cost, unpriced } = totalSavings(outstanding);
    const progress = savingsProgress(outstanding.length ? cost : null, spendable());

    return {
        targets,
        abilities,
        houses,
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
    styleGameButton(watch, 'primary', true);
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
    list.classList.add('toolasha-select');
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

    for (let level = 0; level <= maxEnhancementLevel(); level++) {
        const ask = editing.itemHrid ? buyPrice(editing.itemHrid, level) : 0;
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
            priceLine(
                crafted ? 'Materials:' : buySide() === 'ask' ? 'Lowest Ask:' : 'Highest Bid:',
                formatWithSeparator(Math.round(ask)),
                ROW_COLORS.gold
            )
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
 * EWatch's own shape: the state is the button, in the color of what it means,
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
 * Open the listing for the piece a row is actually about.
 *
 * A watched target is an item AND a level, and the two are one thing here — the
 * row says "Furious Spear +12" and the marketplace it opens has to be the +12
 * order book, not the +0 one that costs a fifth as much. `linkToMarketplace`
 * hands its navigate only an hrid, so the level rides along in the closure
 * rather than in a wider signature every unlevelled caller would have to grow.
 *
 * @param {Object} target - From `watchedTargets`
 * @returns {Function} A navigate for `linkToMarketplace`
 */
function openTargetListing(target) {
    return (itemHrid) => navigateToMarketplace(itemHrid, target.enhancementLevel || 0);
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

    // A room has no item to draw or to open, so it is headlined by the artwork
    // of the skill it boosts instead
    const icon = target.house ? skillIcon(target.skill, 20) : itemIcon(target.itemHrid, 20);
    linkToMarketplace(icon, target.itemHrid, openTargetListing(target));

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
        // Full means you can go and buy it, which is worth a different color
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
    const watching = state.selected === targetKey(target.itemHrid, target.enhancementLevel);

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
        selectTarget(targetKey(target.itemHrid, target.enhancementLevel));
        equipmentSavingsPanel.render();
    });

    const icon = itemIcon(target.itemHrid, 22);
    linkToMarketplace(icon, target.itemHrid, openTargetListing(target));

    const name = document.createElement('span');
    name.textContent = target.enhancementLevel ? `${target.name} +${target.enhancementLevel}` : target.name;
    Object.assign(name.style, { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    linkToMarketplace(name, target.itemHrid, openTargetListing(target));

    const cost = document.createElement('span');
    cost.textContent = target.cost === null ? 'no price' : formatKMB(target.cost);
    cost.style.color = target.cost === null ? ROW_COLORS.bad : ROW_COLORS.gold;
    cost.title =
        target.cost === null
            ? 'Nobody is selling this, so what it would cost is unknown rather than nothing.'
            : target.route === 'mirror' && target.mirrorBuild
              ? `${formatKMB(target.cost)} in coins to build it with a Philosopher's Mirror. ` +
                mirrorBuildSummary(target.mirrorBuild)
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
        unwatchTarget(target.itemHrid, target.enhancementLevel);
        equipmentSavingsPanel.render();
    });

    heading.append(eye, icon, name, cost, remove);
    card.appendChild(heading);
    const requirement = itemRequirementHtml(target.itemHrid);
    if (requirement) card.insertAdjacentHTML('beforeend', requirement);

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
        cycleTargetNoSell(target.itemHrid, target.enhancementLevel);
        equipmentSavingsPanel.render();
    });
    perTarget.appendChild(sell);

    // Only where there are two paths to choose between. A target with no second
    // copy and nowhere to get one has one run and no decision to offer.
    if (target.enhancing && target.ladder) perTarget.appendChild(ladderButton(target));
    // The route chip: Auto, or the route this card is pinned to. Shown on every card with a route, even
    // a lone one, so pressing it never makes it vanish and leave the player unsure what it was set to
    if (!target.enhancing && (target.routes.length > 0 || target.pin)) perTarget.appendChild(routeChip(target));
    card.appendChild(perTarget);

    if (target.route === 'mirror' && target.mirrorBuild) {
        card.appendChild(mirrorLines(target));
        card.appendChild(mirrorBillButton(target.mirrorBuild.bill));
    } else if (target.enhancing) {
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
        // The caption names the model *and*, when the figure on this card is
        // this module's own, whose enhancing stats it ran on — the same word
        // the enhancement tooltip's chip prints, so "Yours" means the same
        // thing on both. A card showing an advisor's quote says nothing here:
        // that figure came off another bench, and the advisor's own breakdown
        // is where it names it.
        card.appendChild(
            priceLine(
                target.ownsBase ? 'Not sold at this level' : 'Buy a +0 and enhance it',
                target.enhanceSource ? `Enhancement Cost (${target.enhanceSource.label})` : 'Enhancement Cost',
                'rgba(232, 236, 245, 0.55)'
            )
        );
        if (target.mode === 'ladder' && target.ladder) card.appendChild(directLine(target));
        else if (target.ladder) card.appendChild(ladderLine(target.ladder, target.enhancementLevel));
    } else if (target.route === 'craft' || (target.route === null && target.crafted)) {
        card.appendChild(recipeLines(target));
        if (target.recipe?.actionHrid)
            card.appendChild(missingMatsButton(target.recipe.actionHrid, target.upgradeBaseLevel || 0));
    } else if (target.ask > 0) {
        card.appendChild(priceLine(buyLabel(), formatWithSeparator(Math.round(target.ask)), ROW_COLORS.gold));
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

    // Why a pin is not in force, then every route side by side
    if (target.pinNote) {
        const note = document.createElement('div');
        note.textContent = target.pinNote;
        note.dataset.routeNote = 'true';
        Object.assign(note.style, { color: ROW_COLORS.accent, fontSize: '10px' });
        card.appendChild(note);
    }
    if (target.routes.length > 1) card.appendChild(routeTable(target));

    // A card added from the upgrade advisor names the figure the advisor gave then, for reference.
    // The card itself is costed live, like every other
    if (target.quotedCost !== null && target.quotedCost !== undefined) {
        const from = target.quotedFrom
            ? `Upgrade advisor when added (${target.quotedFrom}):`
            : 'Upgrade advisor when added:';
        card.appendChild(
            priceLine(from, formatWithSeparator(Math.round(target.quotedCost)), 'rgba(232, 236, 245, 0.55)')
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
 * @param {number} [upgradeBaseLevel] - The enhancement level the craft's base piece was
 *   costed at, from `upgradeBaseRoute`. A refinement that retains enhancement is made
 *   FROM a base already at the output's level, and the card counted buying one — so the
 *   button has to open that level's listing or it quotes a different piece than the card
 *   did. 0 (the default, and every plain craft) opens the +0 listing as before.
 * @returns {HTMLElement}
 */
function missingMatsButton(actionHrid, upgradeBaseLevel = 0) {
    const button = document.createElement('button');
    button.textContent = 'Missing Mats Marketplace';
    styleGameButton(button, 'primary', true);
    Object.assign(button.style, { marginTop: '4px', width: '100%', height: 'auto', minHeight: '1.5rem' });
    button.title = 'Open the marketplace on the materials this craft is short of.';

    button.addEventListener('click', async () => {
        const open = missingMaterialsButton()?.openMissingMaterials;
        if (!open) {
            button.textContent = 'The action panel feature is off';
            return;
        }
        button.textContent = 'Opening…';
        try {
            await open(actionHrid, 1, { upgradeItemLevel: upgradeBaseLevel });
        } catch (error) {
            console.error('[EquipmentSavings] Opening the missing materials failed:', error);
            button.textContent = 'Could not open the marketplace';
        }
    });
    return button;
}

/**
 * One input of a mirror build, named with its level: "Furious Spear ★ +12".
 * @param {{itemHrid: string, level: number}} input - An input of the build
 * @returns {string}
 */
function mirrorInputName(input) {
    return `${nameOf(input.itemHrid)} +${input.level}`;
}

/**
 * The chip beside the sell and craft switches: Auto, or the route the card is pinned to.
 * Clicking steps through Auto and each route the card lists. A pin that is not in force right now
 * (the route has no price) keeps its label, so the player can see it is still set.
 *
 * @param {Object} target - A costed target
 * @returns {HTMLElement}
 */
function routeChip(target) {
    const button = document.createElement('button');
    const pinned = Boolean(target.pin);
    // Names the route actually in force, so the chip never says one thing while the card is counted
    // along another: a pin that has fallen back to Auto still shows the pin, and the note says why
    const inForce = target.route ? ROUTE_LABELS[target.route] : '';
    button.textContent = pinned
        ? `Pinned: ${ROUTE_LABELS[target.pin] || target.pin}`
        : `Auto${inForce ? `: ${inForce}` : ''}`;
    button.dataset.targetRoute = target.itemHrid;
    Object.assign(button.style, {
        background: pinned ? 'rgba(100, 149, 237, 0.22)' : 'rgba(255, 255, 255, 0.06)',
        border: `1px solid ${pinned ? '#6495ed' : 'rgba(255, 255, 255, 0.12)'}`,
        borderRadius: '3px',
        color: pinned ? '#6495ed' : 'rgba(232, 236, 245, 0.55)',
        cursor: 'pointer',
        fontSize: '10px',
        padding: '1px 7px',
    });
    button.title =
        'Which route the cost, the bar and the countdown are counted along.\n' +
        'Auto takes the lowest real cost (or the route preferred in settings).\n' +
        'Click to pin a route; a pinned route with no price right now falls back to Auto.';
    button.addEventListener('click', () => {
        cycleRoutePin(
            target.itemHrid,
            target.enhancementLevel,
            target.routes.map((route) => route.id)
        );
        equipmentSavingsPanel.render();
    });
    return button;
}

/**
 * Every route that applies, side by side: the coins to find and the real cost, which also counts
 * the sale value of the owned copies the route uses up. The route the card is counted along is
 * marked. Short labels and KMB figures, to fit a phone.
 *
 * @param {Object} target - A costed target
 * @returns {HTMLElement}
 */
function routeTable(target) {
    const table = document.createElement('div');
    table.dataset.routeTable = target.itemHrid;
    Object.assign(table.style, {
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto auto',
        columnGap: '10px',
        rowGap: '1px',
        fontSize: '10px',
        marginTop: '2px',
    });
    table.title =
        'Cash is the coins to find. Real cost also counts the sale value of any copy of yours the route ' +
        'uses up, net of selling the piece it replaces. The marked row is the one the bar fills against.';

    const cell = (text, { color = 'rgba(232, 236, 245, 0.55)', bold = false, right = true } = {}) => {
        const element = document.createElement('span');
        element.textContent = text;
        Object.assign(element.style, {
            color,
            fontWeight: bold ? 'bold' : 'normal',
            textAlign: right ? 'right' : 'left',
            whiteSpace: 'nowrap',
        });
        return element;
    };

    table.append(cell('Route', { right: false }), cell('Cash'), cell('Real cost'));
    for (const route of target.routes) {
        const color = route.chosen ? ROW_COLORS.gold : route.priced ? ROW_COLORS.neutral : ROW_COLORS.bad;
        // Display clamps at zero; the comparison does not. An estimated price is marked with a tilde
        const figure = (value) =>
            value === null ? 'no price' : `${route.estimated ? '~' : ''}${formatKMB(Math.max(0, value))}`;
        table.append(
            cell(`${route.chosen ? '▸ ' : ''}${route.label}`, { color, bold: route.chosen, right: false }),
            cell(figure(route.cash), { color, bold: route.chosen }),
            cell(figure(route.real), { color, bold: route.chosen })
        );
    }
    return table;
}

/**
 * The mirror build in a sentence, for a tooltip.
 * @param {Object} build - From `mirrorBuildRoute`
 * @returns {string}
 */
function mirrorBuildSummary(build) {
    const parts = build.inputs.map((input) =>
        input.owned
            ? `your ${mirrorInputName(input)} (gives up ${formatKMB(input.price)} sale)`
            : `a ${mirrorInputName(input)} (${formatKMB(input.price)})`
    );
    return `Mirror build: ${parts.join(' + ')} + a Philosopher's Mirror (${build.estimated ? '~' : ''}${formatKMB(build.mirrorPrice)}).`;
}

/**
 * The mirror build, itemised: every input as owned or bought, the mirror, the sale the owned
 * copies give up, and the coins to find.
 *
 * Two numbers on purpose. The coins are what the bar fills against; the real cost also counts
 * the sale value of the copies the build consumes, and it is what the route was chosen on.
 *
 * @param {Object} target - A costed target whose cheapest route is the mirror build
 * @returns {HTMLElement}
 */
function mirrorLines(target) {
    const build = target.mirrorBuild;
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '1px' });

    const owned = build.inputs.filter((input) => input.owned);
    const summary = build.inputs.map((input) =>
        input.owned ? `your ${mirrorInputName(input)}` : `a ${mirrorInputName(input)}`
    );
    wrap.appendChild(
        priceLine(
            'Mirror build:',
            `${summary.join(' + ')} + a Philosopher's Mirror`,
            ROW_COLORS.gold,
            "The cheapest route found. A Philosopher's Mirror always succeeds: it turns a +(L-1) and a +(L-2) " +
                'into a +L.'
        )
    );
    for (const input of build.inputs) {
        wrap.appendChild(
            priceLine(
                mirrorInputName(input),
                input.owned ? 'you have one' : formatWithSeparator(Math.round(input.price)),
                input.owned ? ROW_COLORS.good : ROW_COLORS.gold
            )
        );
    }
    wrap.appendChild(
        priceLine(
            "Philosopher's Mirror",
            `${build.estimated ? '~' : ''}${formatWithSeparator(Math.round(build.mirrorPrice))}`,
            ROW_COLORS.gold
        )
    );

    // The worn piece, while selling: every route nets its sale as the trade-in, so using it up adds nothing
    const netted = owned.filter((input) => input.worn && !target.noSell);
    const forgone = owned.filter((input) => !netted.includes(input));
    for (const input of netted) {
        wrap.appendChild(
            priceLine(
                `Uses your worn ${mirrorInputName(input)} — its ${formatKMB(input.price)} sale is counted on every route`,
                '',
                ROW_COLORS.accent,
                'Selling the piece you wear is netted against every route, so using it up here costs no more ' +
                    'than the others.'
            )
        );
    }
    // Any other owned copy that goes into the build is not free: it is a sale not made
    if (forgone.length) {
        const sale = forgone.reduce((sum, input) => sum + input.price, 0);
        wrap.appendChild(
            priceLine(
                `Uses your ${forgone.map(mirrorInputName).join(' and ')} — gives up ${formatKMB(sale)} sale`,
                target.realCost === null || target.realCost === undefined
                    ? 'real cost: no price'
                    : `real cost ${formatKMB(Math.max(0, target.realCost))}`,
                ROW_COLORS.accent,
                `The sale value counted is the ${sellSide()} after tax. The bar fills against the coins below; the route ` +
                    `was chosen on this real cost, so it never wins just because it needs less cash.`
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
 * The Missing Mats button for a mirror build: shops for what the build actually needs (the
 * inputs not owned, and the mirror), not the old route's listing. Owned copies are not billed.
 *
 * @param {Array<{itemHrid: string, enhancementLevel?: number, count: number}>} bill - From `mirrorBuildRoute`
 * @returns {HTMLElement}
 */
function mirrorBillButton(bill) {
    const button = document.createElement('button');
    button.textContent = 'Missing Mats Marketplace';
    button.dataset.mirrorBill = 'true';
    styleGameButton(button, 'primary', true);
    Object.assign(button.style, { marginTop: '4px', width: '100%', height: 'auto', minHeight: '1.5rem' });
    button.title = "Open the marketplace on the inputs and the Philosopher's Mirror this build is short of.";

    button.addEventListener('click', async () => {
        const open = missingMaterialsButton()?.openMaterialsList;
        if (!open) {
            button.textContent = 'The action panel feature is off';
            return;
        }
        button.textContent = 'Opening…';
        try {
            await open(bill);
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
        const price = buyPrice(input.itemHrid, 0);
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
    // figure entirely, and it depends on what is in the bag. A recipe that
    // retains enhancement needs the base AT the target's level, so ownership
    // and the label are judged against that level, not against "any copy".
    if (recipe.upgradeItemHrid) {
        const needsLevel = recipe.retainAllEnhancement ? target.enhancementLevel || 0 : 0;
        const held = highestOwnedLevel(recipe.upgradeItemHrid);
        const owned = needsLevel > 0 ? held !== null && held >= needsLevel : held !== null;
        const baseName = `${nameOf(recipe.upgradeItemHrid)}${needsLevel > 0 ? ` +${needsLevel}` : ''}`;
        const status = owned
            ? 'you have one'
            : held === null && onlyListed(recipe.upgradeItemHrid)
              ? 'yours is listed on the market, counted in'
              : needsLevel > 0 && held !== null
                ? `enhance yours (+${held}) up, counted in`
                : 'not owned, counted in';
        wrap.appendChild(priceLine(`Upgrades ${baseName}`, status, owned ? ROW_COLORS.good : ROW_COLORS.accent));
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
        // Pins the other path, whichever Auto had picked
        setLadder(target.itemHrid, target.enhancementLevel, !on);
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
    const wornBid = wornTradeIn(worn);

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
    bid.textContent = wornBid > 0 ? formatWithSeparator(Math.round(wornBid)) : `No ${sellSide()}`;
    bid.style.color = wornBid > 0 ? ROW_COLORS.gold : 'rgba(232, 236, 245, 0.4)';
    bid.title =
        wornBid > 0
            ? 'What selling this would put towards an upgrade.'
            : `Nothing is quoted on the ${sellSide()} side for this.`;

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
 * One ability goal: the level wanted, what the books come to, and how far along.
 *
 * Shaped like a target card rather than like a new kind of row, because it is
 * the same question — a number of coins you do not have yet — and a reader
 * scanning the list should not have to learn a second layout to read it.
 *
 * @param {Object} goal - From `watchedAbilityGoals`
 * @returns {HTMLElement}
 */
function abilityCard(goal) {
    const card = document.createElement('div');
    Object.assign(card.style, {
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
        padding: '6px 7px',
        borderRadius: '3px',
        // Green once it has happened, so a finished goal reads as good news
        // rather than as an entry that has stopped moving
        borderLeft: `2px solid ${goal.done ? '#4ade80' : '#c084fc'}`,
        background: goal.done ? 'rgba(74, 222, 128, 0.08)' : 'rgba(192, 132, 252, 0.07)',
    });

    const heading = document.createElement('div');
    Object.assign(heading.style, { display: 'flex', alignItems: 'center', gap: '7px' });

    const icon = itemIcon(goal.itemHrid, 22);
    linkToMarketplace(icon, goal.itemHrid, navigateToMarketplace);

    const name = document.createElement('span');
    name.textContent = goal.name;
    Object.assign(name.style, { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    linkToMarketplace(name, goal.itemHrid, navigateToMarketplace);

    const cost = document.createElement('span');
    cost.textContent = goal.done ? 'Reached' : goal.cost === null ? 'no price' : formatKMB(goal.cost);
    cost.style.color = goal.done ? ROW_COLORS.good : goal.cost === null ? ROW_COLORS.bad : ROW_COLORS.gold;
    cost.title = goal.done
        ? `Already at Lv${goal.currentLevel}, so there is nothing left to buy.`
        : goal.cost === null
          ? 'Nobody is selling the book, so what the levels would cost is unknown rather than nothing.'
          : 'The books to this level, at what the market wants for them.';

    const remove = document.createElement('button');
    remove.textContent = '✕';
    remove.dataset.removeAbility = goal.abilityHrid;
    Object.assign(remove.style, {
        background: 'none',
        border: 'none',
        color: 'rgba(232, 236, 245, 0.5)',
        cursor: 'pointer',
        fontSize: '12px',
        padding: '0 2px',
    });
    remove.title = 'Stop saving for this level.';
    remove.addEventListener('click', async () => {
        await unwatchAbility(goal.abilityHrid);
        equipmentSavingsPanel.render();
    });

    heading.append(icon, name, cost, remove);
    card.appendChild(heading);

    card.appendChild(
        priceLine(
            'Level:',
            `${goal.currentLevel} → ${goal.targetLevel}`,
            goal.done ? ROW_COLORS.good : 'rgba(232, 236, 245, 0.75)'
        )
    );

    const bar = document.createElement('div');
    Object.assign(bar.style, { display: 'flex', alignItems: 'center', gap: '7px' });
    bar.appendChild(progressBar(goal.fraction));

    const status = document.createElement('span');
    status.textContent = goal.done ? `Reached at Lv${goal.currentLevel}` : statusText(goal);
    Object.assign(status.style, {
        color: goal.done || goal.affordable ? ROW_COLORS.good : 'rgba(232, 236, 245, 0.6)',
        fontSize: '11px',
        flex: '0 0 auto',
        minWidth: '96px',
        textAlign: 'right',
    });
    bar.appendChild(status);
    card.appendChild(bar);

    if (!goal.done) card.appendChild(percentLine(goal));
    return card;
}

/**
 * The abilities being saved for, and the way to add one.
 *
 * @param {HTMLElement} body - The panel body
 * @param {Array<Object>} goals - From `watchedAbilityGoals`
 */
function abilitySection(body, goals) {
    const card = panelCard(body, 'Ability Levels');

    for (const goal of goals) card.appendChild(abilityCard(goal));

    if (!goals.length && state.locked) {
        card.appendChild(panelNote('No ability levels being saved for — press Edit to add one.'));
        return;
    }
    // Adding is an editing act, and the panel is a reading list until it is
    // unlocked. The same switch the slots are behind.
    if (state.locked) return;

    if (!editing.addingAbility) {
        const add = document.createElement('button');
        add.textContent = '+ Add ability level';
        add.dataset.addAbility = 'true';
        styleGameButton(add, 'quiet', true);
        add.style.marginTop = '4px';
        add.title = 'Save towards a level of one of your abilities.';
        add.addEventListener('click', () => {
            editing.addingAbility = true;
            equipmentSavingsPanel.render();
        });
        card.appendChild(add);
        return;
    }

    card.appendChild(abilityPicker());
}

/**
 * The abilities a goal can be set for.
 *
 * The ones the character has learned lead, because those are the ones with a
 * level to improve on and the ones a goal is nearly always about. Everything
 * else follows, so a book you have not bought yet can still be planned for.
 *
 * @returns {Array<{abilityHrid: string, name: string, level: number, learned: boolean}>}
 */
export function abilityChoices() {
    const levels = learnedAbilityLevels();
    const all = dataManager.getInitClientData?.()?.abilityDetailMap || {};

    const named = (abilityHrid) => abilityDetailName(abilityHrid, all);
    const learned = [...levels.entries()].map(([abilityHrid, owned]) => ({
        abilityHrid,
        name: named(abilityHrid),
        level: owned.level,
        learned: true,
    }));

    const rest = Object.keys(all)
        .filter((abilityHrid) => !levels.has(abilityHrid))
        .map((abilityHrid) => ({ abilityHrid, name: named(abilityHrid), level: 0, learned: false }));

    const byName = (a, b) => a.name.localeCompare(b.name);
    return [...learned.sort(byName), ...rest.sort(byName)];
}

/**
 * One house room goal: the level wanted, what the build comes to, and how far along.
 *
 * The same layout as an ability goal's, which is the same layout as a target's:
 * it is the same question — a number of coins you do not have yet — and a reader
 * scanning the list should not have to learn a third card to read it.
 *
 * @param {Object} goal - From `watchedHouseGoals`
 * @returns {HTMLElement}
 */
function houseCard(goal) {
    const card = document.createElement('div');
    Object.assign(card.style, {
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
        padding: '6px 7px',
        borderRadius: '3px',
        // Green once it has happened, so a finished goal reads as good news
        // rather than as an entry that has stopped moving
        borderLeft: `2px solid ${goal.done ? '#4ade80' : HOUSE_ACCENT}`,
        background: goal.done ? 'rgba(74, 222, 128, 0.08)' : 'rgba(245, 158, 11, 0.07)',
    });

    const heading = document.createElement('div');
    Object.assign(heading.style, { display: 'flex', alignItems: 'center', gap: '7px' });

    const name = document.createElement('span');
    name.textContent = goal.name;
    Object.assign(name.style, { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });

    const cost = document.createElement('span');
    cost.textContent = goal.done ? 'Reached' : goal.cost === null ? 'no price' : formatKMB(goal.cost);
    cost.style.color = goal.done ? ROW_COLORS.good : goal.cost === null ? ROW_COLORS.bad : ROW_COLORS.gold;
    cost.title = goal.done
        ? `Already built to Lv${goal.currentLevel}, so there is nothing left to buy.`
        : goal.cost === null
          ? 'Some material for these levels has no listing, so the build costs an unknown amount rather than nothing.'
          : 'The coins and the materials for every level up to this one, at what the market wants for them.';

    const remove = document.createElement('button');
    remove.textContent = '✕';
    remove.dataset.removeHouse = goal.houseRoomHrid;
    Object.assign(remove.style, {
        background: 'none',
        border: 'none',
        color: 'rgba(232, 236, 245, 0.5)',
        cursor: 'pointer',
        fontSize: '12px',
        padding: '0 2px',
    });
    remove.title = 'Stop saving for this room level.';
    remove.addEventListener('click', async () => {
        await unwatchHouse(goal.houseRoomHrid);
        equipmentSavingsPanel.render();
    });

    heading.append(skillIcon(goal.skill, 22), name, cost, remove);
    card.appendChild(heading);

    card.appendChild(
        priceLine(
            'Level:',
            `${goal.currentLevel} → ${goal.targetLevel}`,
            goal.done ? ROW_COLORS.good : 'rgba(232, 236, 245, 0.75)'
        )
    );

    const bar = document.createElement('div');
    Object.assign(bar.style, { display: 'flex', alignItems: 'center', gap: '7px' });
    bar.appendChild(progressBar(goal.fraction));

    const status = document.createElement('span');
    status.textContent = goal.done ? `Reached at Lv${goal.currentLevel}` : statusText(goal);
    Object.assign(status.style, {
        color: goal.done || goal.affordable ? ROW_COLORS.good : 'rgba(232, 236, 245, 0.6)',
        fontSize: '11px',
        flex: '0 0 auto',
        minWidth: '96px',
        textAlign: 'right',
    });
    bar.appendChild(status);
    card.appendChild(bar);

    if (!goal.done) card.appendChild(percentLine(goal));
    return card;
}

/**
 * The rooms being saved for, and the way to add one.
 *
 * @param {HTMLElement} body - The panel body
 * @param {Array<Object>} goals - From `watchedHouseGoals`
 */
function houseSection(body, goals) {
    const card = panelCard(body, 'House Levels');

    for (const goal of goals) card.appendChild(houseCard(goal));

    if (!goals.length && state.locked) {
        card.appendChild(panelNote('No house levels being saved for — press Edit to add one.'));
        return;
    }
    // Adding is an editing act, and the panel is a reading list until it is
    // unlocked. The same switch the slots and the abilities are behind.
    if (state.locked) return;

    if (!editing.addingHouse) {
        const add = document.createElement('button');
        add.textContent = '+ Add house level';
        add.dataset.addHouse = 'true';
        styleGameButton(add, 'quiet', true);
        add.style.marginTop = '4px';
        add.title = 'Save towards a level of one of your house rooms.';
        add.addEventListener('click', () => {
            editing.addingHouse = true;
            equipmentSavingsPanel.render();
        });
        card.appendChild(add);
        return;
    }

    card.appendChild(housePicker());
}

/**
 * The rooms a goal can be set for.
 *
 * The ones the character has built lead, because those are the ones with a level
 * to improve on. Everything else follows, so a room you have not started can
 * still be planned for. A room already at the cap is left out entirely: there is
 * no level left to save for, and offering one would be offering nothing.
 *
 * @returns {Array<{houseRoomHrid: string, name: string, level: number, built: boolean}>}
 */
export function houseChoices() {
    const levels = houseRoomLevels();
    const all = dataManager.getInitClientData?.()?.houseRoomDetailMap || {};

    const named = (houseRoomHrid) =>
        all?.[houseRoomHrid]?.name ||
        houseRoomHrid
            .split('/')
            .pop()
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (letter) => letter.toUpperCase());

    const rooms = Object.keys(all).map((houseRoomHrid) => ({
        houseRoomHrid,
        name: named(houseRoomHrid),
        level: levels.get(houseRoomHrid) || 0,
        built: (levels.get(houseRoomHrid) || 0) > 0,
    }));

    const byName = (a, b) => a.name.localeCompare(b.name);
    return [
        ...rooms.filter((room) => room.built && room.level < maxHouseRoomLevel()).sort(byName),
        ...rooms.filter((room) => !room.built).sort(byName),
    ];
}

/**
 * The form: which room, to what level, and what that costs.
 *
 * The cost is the market's whenever it can price every material, and typed in
 * when it cannot — refusing the goal because one ingredient has an empty order
 * book helps nobody.
 *
 * @returns {HTMLElement}
 */
function housePicker() {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, {
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
        marginTop: '5px',
        borderLeft: `2px solid ${HOUSE_ACCENT}`,
        background: 'rgba(255, 255, 255, 0.03)',
        borderRadius: '3px',
        padding: '7px',
    });

    const choices = houseChoices();
    const chosen = choices.find((choice) => choice.houseRoomHrid === editing.houseRoomHrid) || null;

    const list = document.createElement('select');
    list.classList.add('toolasha-select');
    list.dataset.pickHouse = 'true';
    Object.assign(list.style, {
        background: 'rgba(0, 0, 0, 0.35)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        borderRadius: '3px',
        color: '#e8ecf5',
        fontSize: '11px',
        padding: '2px',
        width: '100%',
    });

    const none = document.createElement('option');
    none.value = '';
    none.textContent = '-- Select Room --';
    list.appendChild(none);

    for (const choice of choices) {
        const option = document.createElement('option');
        option.value = choice.houseRoomHrid;
        option.textContent = choice.built ? `${choice.name} (Lv${choice.level})` : `${choice.name} (not built)`;
        option.selected = choice.houseRoomHrid === editing.houseRoomHrid;
        list.appendChild(option);
    }
    list.addEventListener('change', () => {
        editing.houseRoomHrid = list.value;
        // A level below the one the room is already at is not a goal, so the
        // form opens on the next one up rather than on zero
        const at = choices.find((choice) => choice.houseRoomHrid === list.value)?.level || 0;
        if (editing.houseLevel <= at) editing.houseLevel = Math.min(maxHouseRoomLevel(), at + 1);
        equipmentSavingsPanel.render();
    });
    list.addEventListener('keydown', (event) => event.stopPropagation());
    wrap.appendChild(list);

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' });

    const levelLabel = document.createElement('span');
    levelLabel.textContent = 'Level:';
    Object.assign(levelLabel.style, { color: 'rgba(232, 236, 245, 0.6)', fontSize: '11px' });

    const level = document.createElement('input');
    level.type = 'number';
    level.min = '1';
    level.max = String(maxHouseRoomLevel());
    level.dataset.houseLevel = 'true';
    level.value = String(editing.houseLevel || '');
    Object.assign(level.style, {
        background: 'rgba(0, 0, 0, 0.35)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        borderRadius: '3px',
        color: '#e8ecf5',
        fontSize: '11px',
        padding: '2px 4px',
        width: '60px',
    });
    level.addEventListener('input', () => {
        // Capped as it is typed: the game stops at the room cap, and a
        // goal past it would be costed for levels that cannot be built
        editing.houseLevel = Math.min(maxHouseRoomLevel(), Math.max(0, Math.floor(Number(level.value) || 0)));
    });
    // On change rather than on every keystroke: the estimate below is worth
    // redrawing once the number has settled, not three times while it is typed
    level.addEventListener('change', () => equipmentSavingsPanel.render());
    level.addEventListener('keydown', (event) => event.stopPropagation());

    row.append(levelLabel, level);

    const estimate = chosen ? houseUpgradeCost(editing.houseRoomHrid, editing.houseLevel) : null;
    const priced = estimate !== null;

    const figure = document.createElement('span');
    figure.style.flex = '1';
    figure.style.fontSize = '11px';
    if (!chosen) {
        figure.textContent = 'Pick a room.';
        figure.style.color = 'rgba(232, 236, 245, 0.5)';
    } else if (priced) {
        figure.textContent = `${formatKMB(estimate)} to build`;
        figure.style.color = ROW_COLORS.gold;
        figure.title = 'Every level from where the room is now: coins at face value, materials at the asking price.';
    } else {
        figure.textContent = 'Materials unpriced — type a cost';
        figure.style.color = ROW_COLORS.bad;
    }
    row.appendChild(figure);
    wrap.appendChild(row);

    // Only when the market cannot answer, so the usual case is two fields rather
    // than three
    if (chosen && !priced) {
        const cost = document.createElement('input');
        cost.type = 'number';
        cost.min = '0';
        cost.placeholder = 'Cost in coins';
        cost.dataset.houseCost = 'true';
        cost.value = String(editing.houseCost || '');
        Object.assign(cost.style, {
            background: 'rgba(0, 0, 0, 0.35)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            borderRadius: '3px',
            color: '#e8ecf5',
            fontSize: '11px',
            padding: '2px 4px',
            width: '100%',
        });
        cost.addEventListener('input', () => {
            editing.houseCost = cost.value;
        });
        cost.addEventListener('keydown', (event) => event.stopPropagation());
        wrap.appendChild(cost);
    }

    const buttons = document.createElement('div');
    Object.assign(buttons.style, { display: 'flex', gap: '6px' });

    const save = document.createElement('button');
    save.textContent = '\u{1F441} Watch';
    save.dataset.saveHouse = 'true';
    styleGameButton(save, 'primary', true);
    const ready = Boolean(chosen) && editing.houseLevel > 0;
    save.disabled = !ready;
    save.style.opacity = ready ? '1' : '0.4';
    save.title = 'Add this room level to the savings list.';
    save.addEventListener('click', async () => {
        if (!ready) return;

        // Costed here rather than reusing the figure above it: the level field
        // changes what the goal is worth without redrawing on every keystroke,
        // so the estimate on screen can be one level behind the one being saved
        const fresh = houseUpgradeCost(editing.houseRoomHrid, editing.houseLevel);
        const typed = editing.houseCost === '' ? null : Number(editing.houseCost);
        await watchHouse(
            editing.houseRoomHrid,
            editing.houseLevel,
            fresh !== null ? fresh : Number.isFinite(typed) ? typed : null
        );
        editing.houseRoomHrid = '';
        editing.houseLevel = 0;
        editing.houseCost = '';
        editing.addingHouse = false;
        equipmentSavingsPanel.render();
    });

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    styleGameButton(cancel, 'quiet', true);
    cancel.addEventListener('click', () => {
        editing.addingHouse = false;
        equipmentSavingsPanel.render();
    });

    buttons.append(save, cancel);
    wrap.appendChild(buttons);
    return wrap;
}

/**
 * An ability's name, from a map already in hand.
 * @param {string} abilityHrid - The ability
 * @param {Object} abilityDetailMap - The game's ability map
 * @returns {string}
 */
function abilityDetailName(abilityHrid, abilityDetailMap) {
    return (
        abilityDetailMap?.[abilityHrid]?.name ||
        abilityHrid
            .split('/')
            .pop()
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (letter) => letter.toUpperCase())
    );
}

/**
 * The form: which ability, to what level, and what that costs.
 *
 * The cost is the market's when the book is listed, and typed in when it is not
 * — a goal nobody is selling the book for still has a price somebody has in
 * mind, and refusing the goal because the order book is empty helps nobody.
 *
 * @returns {HTMLElement}
 */
function abilityPicker() {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, {
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
        marginTop: '5px',
        borderLeft: '2px solid #c084fc',
        background: 'rgba(255, 255, 255, 0.03)',
        borderRadius: '3px',
        padding: '7px',
    });

    const choices = abilityChoices();
    const chosen = choices.find((choice) => choice.abilityHrid === editing.abilityHrid) || null;

    const list = document.createElement('select');
    list.classList.add('toolasha-select');
    list.dataset.pickAbility = 'true';
    Object.assign(list.style, {
        background: 'rgba(0, 0, 0, 0.35)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        borderRadius: '3px',
        color: '#e8ecf5',
        fontSize: '11px',
        padding: '2px',
        width: '100%',
    });

    const none = document.createElement('option');
    none.value = '';
    none.textContent = '-- Select Ability --';
    list.appendChild(none);

    for (const choice of choices) {
        const option = document.createElement('option');
        option.value = choice.abilityHrid;
        option.textContent = choice.learned ? `${choice.name} (Lv${choice.level})` : `${choice.name} (not learned)`;
        option.selected = choice.abilityHrid === editing.abilityHrid;
        list.appendChild(option);
    }
    list.addEventListener('change', () => {
        editing.abilityHrid = list.value;
        // A level below the one you are already at is not a goal, so the form
        // opens on the next one up rather than on zero
        const at = choices.find((choice) => choice.abilityHrid === list.value)?.level || 0;
        if (editing.abilityLevel <= at) editing.abilityLevel = at + 1;
        equipmentSavingsPanel.render();
    });
    list.addEventListener('keydown', (event) => event.stopPropagation());
    wrap.appendChild(list);

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' });

    const levelLabel = document.createElement('span');
    levelLabel.textContent = 'Level:';
    Object.assign(levelLabel.style, { color: 'rgba(232, 236, 245, 0.6)', fontSize: '11px' });

    const level = document.createElement('input');
    level.type = 'number';
    level.min = '1';
    level.dataset.abilityLevel = 'true';
    level.value = String(editing.abilityLevel || '');
    Object.assign(level.style, {
        background: 'rgba(0, 0, 0, 0.35)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        borderRadius: '3px',
        color: '#e8ecf5',
        fontSize: '11px',
        padding: '2px 4px',
        width: '60px',
    });
    level.addEventListener('input', () => {
        editing.abilityLevel = Math.max(0, Math.floor(Number(level.value) || 0));
    });
    // On change rather than on every keystroke: the estimate below is worth
    // redrawing once the number has settled, not three times while it is typed
    level.addEventListener('change', () => equipmentSavingsPanel.render());
    level.addEventListener('keydown', (event) => event.stopPropagation());

    row.append(levelLabel, level);

    const estimate = chosen ? abilityBookCost(editing.abilityHrid, editing.abilityLevel) : null;
    const priced = estimate !== null;

    const figure = document.createElement('span');
    figure.style.flex = '1';
    figure.style.fontSize = '11px';
    if (!chosen) {
        figure.textContent = 'Pick an ability.';
        figure.style.color = 'rgba(232, 236, 245, 0.5)';
    } else if (priced) {
        figure.textContent = `${formatKMB(estimate)} of books`;
        figure.style.color = ROW_COLORS.gold;
        figure.title = 'The books from where the ability is now, at the market price of the book.';
    } else {
        figure.textContent = 'Book unpriced — type a cost';
        figure.style.color = ROW_COLORS.bad;
    }
    row.appendChild(figure);
    wrap.appendChild(row);

    // Only when the market cannot answer, so the usual case is two fields rather
    // than three
    if (chosen && !priced) {
        const cost = document.createElement('input');
        cost.type = 'number';
        cost.min = '0';
        cost.placeholder = 'Cost in coins';
        cost.dataset.abilityCost = 'true';
        cost.value = String(editing.abilityCost || '');
        Object.assign(cost.style, {
            background: 'rgba(0, 0, 0, 0.35)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            borderRadius: '3px',
            color: '#e8ecf5',
            fontSize: '11px',
            padding: '2px 4px',
            width: '100%',
        });
        cost.addEventListener('input', () => {
            editing.abilityCost = cost.value;
        });
        cost.addEventListener('keydown', (event) => event.stopPropagation());
        wrap.appendChild(cost);
    }

    const buttons = document.createElement('div');
    Object.assign(buttons.style, { display: 'flex', gap: '6px' });

    const save = document.createElement('button');
    save.textContent = '\u{1F441} Watch';
    save.dataset.saveAbility = 'true';
    styleGameButton(save, 'primary', true);
    const ready = Boolean(chosen) && editing.abilityLevel > 0;
    save.disabled = !ready;
    save.style.opacity = ready ? '1' : '0.4';
    save.title = 'Add this level to the savings list.';
    save.addEventListener('click', async () => {
        if (!ready) return;

        // Costed here rather than reusing the figure above it: the level field
        // changes what the goal is worth without redrawing on every keystroke,
        // so the estimate on screen can be one level behind the one being saved
        const fresh = abilityBookCost(editing.abilityHrid, editing.abilityLevel);
        const typed = editing.abilityCost === '' ? null : Number(editing.abilityCost);
        await watchAbility(
            editing.abilityHrid,
            editing.abilityLevel,
            fresh !== null ? fresh : Number.isFinite(typed) ? typed : null
        );
        editing.abilityHrid = '';
        editing.abilityLevel = 0;
        editing.abilityCost = '';
        editing.addingAbility = false;
        equipmentSavingsPanel.render();
    });

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    styleGameButton(cancel, 'quiet', true);
    cancel.addEventListener('click', () => {
        editing.addingAbility = false;
        equipmentSavingsPanel.render();
    });

    buttons.append(save, cancel);
    wrap.appendChild(buttons);
    return wrap;
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
    draw: (body) => {
        const plan = everything();

        // The one the header watches, as EWatch's eye picks it: with several
        // things on the list the one you are actually saving for is the only
        // figure you want at a glance. Levels are candidates too — a panel with
        // only ability goals on it would otherwise have no headline at all.
        const headlines = [...plan.targets, ...plan.abilities, ...plan.houses];
        const watched =
            headlines.find((target) => target.key === state.selected) ||
            headlines
                .filter((target) => target.cost !== null && !target.affordable)
                .sort((a, b) => a.needed - b.needed)[0] ||
            headlines[0];
        if (watched) body.appendChild(headline(watched));

        const purse = panelCard(body, undefined);
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
        const market = panelCard(body, undefined);
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
        const switches = panelCard(body, undefined);
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

        // One press undoes every route pin, including ones carried over from the old Crafting switch
        if (anyRoutePinned()) {
            const reset = document.createElement('button');
            reset.textContent = 'All routes to Auto';
            reset.dataset.routesReset = 'true';
            Object.assign(reset.style, {
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                borderRadius: '3px',
                color: 'rgba(232, 236, 245, 0.75)',
                cursor: 'pointer',
                fontSize: '11px',
                padding: '2px 9px',
            });
            reset.title =
                'Unpin every card, so each is counted along its cheapest route (or the one preferred in settings).';
            reset.addEventListener('click', () => {
                clearAllRoutePins();
                equipmentSavingsPanel.render();
            });
            switches.appendChild(reset);
        }

        // Two shapes, one switch. Locked is a reading list — what you are saving
        // for and how far along — which is what the panel is for almost all of
        // the time. Unlocked opens every slot up so targets can be changed, and
        // is a great deal longer, which is why it is not the resting state.
        const list = panelCard(body, undefined);

        const watching = plan.targets.length + plan.abilities.length + plan.houses.length;

        if (state.locked) {
            if (!watching) {
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
        }

        // Levels, on the same list as the gear: it is the same savings question,
        // and a plan that answers it for a sword but not for the ability the
        // sword swings is half a plan
        abilitySection(body, plan.abilities);

        // And rooms, for the same reason: the Dojo you are saving for is money
        // that will not be there for the sword
        houseSection(body, plan.houses);

        if (!watching) return;

        // One at a time answers the wrong question when you want three pieces
        const all = panelCard(body, 'Everything');
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
        const pending = plan.abilities.filter((goal) => !goal.done).length;
        const building = plan.houses.filter((goal) => !goal.done).length;
        all.appendChild(
            panelNote(
                `${formatKMB(plan.cost)} for ${plan.targets.length} pieces` +
                    (pending ? `, ${pending} ability level${pending === 1 ? '' : 's'}` : '') +
                    (building ? `, ${building} house level${building === 1 ? '' : 's'}` : '') +
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
        button.textContent = isTargeted(hrid, level) ? 'Stop saving' : 'Save for';
    };
    label();

    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (isTargeted(hrid, level)) unwatchTarget(hrid, level);
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
        // Registered fresh on every initialize() — and initialize() runs again
        // on every character switch, right after cleanup() — so this must be
        // unregistered there. `config.onSettingChange` has no dedupe of its
        // own: left unpaired, a session with N character switches ends up with
        // N copies of this callback firing on every future toggle of the
        // setting, each doing the same (harmless but wasteful) work, forever.
        config.onSettingChange(MENU_BUTTON_SETTING, applyMenuButtonSetting);
    },
    cleanup: () => {
        config.offSettingChange(MENU_BUTTON_SETTING, applyMenuButtonSetting);
        detachMenuObserver?.();
        detachMenuObserver = null;
        document.querySelectorAll(`.${MENU_BUTTON_CLASS}`).forEach((button) => button.remove());
        // `state` (and the ability/house goal maps behind `abilityGoals()` and
        // `houseGoals()`) are module-scope and outlive a character switch —
        // the overlay panel re-initializes and starts redrawing on its 1s
        // timer before `reload()` (fired from
        // character_initialized/character_switched) has finished its async
        // read. Left as-is, the equipmentWatch tile shows the outgoing
        // character's savings target under the incoming character's name
        // until that read lands. `resetEquipmentSavings()` was previously
        // test-only; calling it here clears everything synchronously, the
        // same shape as watchlist's and treasure-tracker's resets.
        resetEquipmentSavings();
    },
};

registerRow({
    // EWatch's own tile. One tile, not a second one beside the old name.
    key: 'equipmentWatch',
    empty: 'Nothing watched',
    name: 'Equipment Watch',
    defaultSize: { width: 240, height: 46 },
    /**
     * What this tile would draw from, in three cheap reads.
     *
     * The list itself, the game's own revision counter, and a minute bucket.
     * The bucket is the honest way to cover the one input the other two cannot:
     * the arrival estimate divides the shortfall by an income, and the net worth
     * trend that stands in for combat income is measured over a rolling window,
     * so its slope drifts with the clock rather than with any event. Bucketing
     * to the minute bounds that drift at a minute on a figure drawn as "3d" or
     * "5h" — and leaves an idle tile drawing once a minute instead of sixty
     * times. Everything that can move faster than that (a price, a coin, a piece
     * of gear, a level, an edit to the list) moves the other two immediately.
     */
    version: () => {
        if (!savingForAnything()) return 'blank';
        // The sprite sheets too: an icon drawn before the game has loaded one is
        // a spacer, and the sheet turning up a second later changes nothing else
        return [
            gameRevision,
            Math.floor(Date.now() / 60_000),
            listStamp(),
            spriteUrl('items'),
            spriteUrl('skills'),
            // The profit mode, the base-crafting setting and the custom prices all move the run's cost
            pricingStamp(),
        ].join('|');
    },
    render: (container) => {
        // Asked before `everything()` rather than after it: an empty tile that
        // resolves a loadout to find out it is empty is the expensive case for
        // the player who has never opened this feature at all
        if (!savingForAnything()) return blank(container);

        const plan = everything();
        if (!plan.targets.length && !plan.abilities.length && !plan.houses.length) return blank(container);

        // Gear and levels together: the tile answers "what is next", and a level
        // you are three days from is the answer as readily as a sword is
        const entries = [...plan.targets, ...plan.abilities, ...plan.houses];

        // The pinned one if the eye has picked one, and otherwise the nearest,
        // because that is the next thing that happens. The pin matters: the
        // thing somebody is saving for is often not the cheapest, and a tile
        // that always shows the cheapest cannot be told otherwise.
        const pinned = entries.find((target) => target.key === state.selected && target.cost !== null);
        const next =
            pinned ||
            entries
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
            // From the top, level with the first line of the tile beside it
            justifyContent: 'flex-start',
            gap: '3px',
            lineHeight: '1.3',
            overflow: 'hidden',
        });

        const top = document.createElement('div');
        drawLine(top, [
            shown.house
                ? { icon: shown.skill, sheet: 'skills', size: 18 }
                : shown.itemHrid
                  ? { icon: shown.itemHrid, size: 18 }
                  : { text: '\u{1F3AF}', color: ROW_COLORS.dim },
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
            `\n${plan.targets.length} pieces` +
            (plan.abilities.length ? `, ${plan.abilities.length} ability levels` : '') +
            (plan.houses.length ? `, ${plan.houses.length} house levels` : '') +
            `, ${formatKMB(plan.cost)} altogether.` +
            (plan.unpriced ? `\n${plan.unpriced} of them have no market price.` : '') +
            '\nDouble-click for the whole list.';
    },
    onOpen: () => equipmentSavingsPanel.toggle(),
});
