/**
 * @vitest-environment happy-dom
 *
 * The guild-credit math: gold cost per credit, ranked ask-first by default,
 * with a missing price never masquerading as a zero and a null figure always
 * sorting to the bottom regardless of which column is active.
 *
 * Driven the way combat-level-panel.js is driven: build the modal shape the
 * game renders, let the feature's DOM observer callback fire, read the table
 * back out.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    settings: {},
    clientData: null,
    prices: {},
    observers: {},
    buildingLevels: {},
    buffLevels: {},
    inventory: [],
    captures: [],
    rates: {},
    storage: {},
    writes: 0,
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key, fallback) => (key in game.settings ? game.settings[key] : fallback) },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.clientData,
        getInventory: () => game.inventory,
        getGuildBuildingLevel: (hrid) => game.buildingLevels[hrid] ?? 0,
        getCharacterGuildBuffLevel: (hrid) => game.buffLevels[hrid] ?? 0,
        getCurrentCharacterId: () => 'char1',
    },
}));
// An in-memory stand-in for IndexedDB: the shrine planner's saved plan is the
// only thing this file reads or writes through it, and a round-trip needs a
// store that survives the record being reset between "modal openings".
vi.mock('../../core/storage.js', () => ({
    default: {
        tryGet: async (key, store = 'settings') => {
            const k = `${store}:${key}`;
            return { found: k in game.storage, value: game.storage[k] };
        },
        get: async (key, store = 'settings', fallback = null) => {
            const k = `${store}:${key}`;
            return k in game.storage ? game.storage[k] : fallback;
        },
        set: async (key, value, store = 'settings') => {
            game.writes += 1;
            game.storage[`${store}:${key}`] = JSON.parse(JSON.stringify(value));
            return true;
        },
    },
}));
vi.mock('../../utils/character-key.js', () => ({
    characterKey: (base) => `${base}_char1`,
    readScoped: async (base, store = 'settings', fallback = null) => {
        const k = `${store}:${base}_char1`;
        return k in game.storage ? game.storage[k] : fallback;
    },
    writeScoped: async (base, value, store = 'settings') => {
        game.writes += 1;
        game.storage[`${store}:${base}_char1`] = JSON.parse(JSON.stringify(value));
        return true;
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (id, className, callback) => {
            game.observers[className] = callback;
            return () => delete game.observers[className];
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (itemHrid, { mode }) => game.prices[itemHrid]?.[mode] ?? 0,
    // The planner's token→gold aside prices credits through this
    getItemPriceInfo: (itemHrid, { mode }) => ({
        price: game.prices[itemHrid]?.[mode] ?? 0,
        estimated: false,
    }),
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({
    navigateToMarketplace: () => {},
    createMaterialTab: () => document.createElement('button'),
    removeMaterialTabs: () => {},
    removeShrineMarketTabs: () => {},
    updateTabBadge: () => {},
    visibleTabsContainer: () => null,
}));
vi.mock('../../utils/marketplace-autofill.js', () => ({
    createAutofillManager: () => ({ initialize: () => {}, setPendingCalculation: () => {} }),
}));
// The marketplace hand-off. What matters here is which items the planner sends
// and under what heading, not what the marketplace does when it gets them —
// the shared list has its own tests for that.
const shopping = vi.hoisted(() => ({ calls: [] }));
vi.mock('../../utils/shopping-list.js', () => ({
    openShoppingList: (items, options) => shopping.calls.push({ items, options }),
    clearShoppingList: () => {},
}));
// The Guild Shop's token→credit rates, mocked the way the other guild tests mock
// a sibling module: `game.rates` is what the shop has been seen saying, one entry
// per credit colour, and a colour missing from it is one the player has never
// opened the exchange for.
vi.mock('./guild-token-exchange-capture.js', () => ({
    captureTokenExchangeFromModal: (...args) => game.captures.push(args),
    hydrateCapturedTokenExchanges: async () => ({ ...game.rates }),
    capturedTokenExchanges: () => Object.values(game.rates),
    capturedTokenExchange: (creditItemHrid) => game.rates[creditItemHrid] ?? null,
}));

const creditValueModule = await import('./guild-credit-value.js');
const guildCreditValue = creditValueModule.default;
const {
    shrinePlanRecord,
    greedyAffordable,
    creditShortfallMaterials,
    creditConversionPlan,
    shortCreditName,
    tokensForCredits,
    buyTokenCost,
    planNextBuys,
    DEFAULT_TOKEN_RATES,
    defaultTokenRate,
    tokenRateFor,
    tokensPerCredit,
    chooseCreditPath,
    goldPerTokenFor,
    mergedTokenExchanges,
    tokenConversionPlan,
} = creditValueModule;
const { TRIAL_MAX_TIER, levelFromTier, tierFromLevel } = await import('./guild-trials-math.js');

function buildExchangeModal(creditName) {
    document.body.innerHTML = '';
    const modal = document.createElement('div');
    const header = document.createElement('div');
    header.className = 'GuildPanel_header_x';
    header.textContent = creditName;
    modal.appendChild(header);
    const button = document.createElement('button');
    modal.appendChild(button);
    document.body.appendChild(modal);
    return modal;
}

function rowTexts(modal) {
    return Array.from(modal.querySelectorAll(`.mwi-guild-credit-value tbody tr`)).map((tr) => tr.textContent);
}

describe('guild credit value — exchange ranking table', () => {
    beforeEach(() => {
        game.settings = { guildCreditValue: true, guildCreditExchangeAdvisor: false, guildShrineUpgradePlanner: false };
        game.observers = {};
        game.prices = {
            '/items/bronze_bar': { ask: 100, bid: 90 },
            '/items/iron_bar': { ask: 300, bid: 280 },
            '/items/steel_bar': { ask: 50, bid: 0 },
        };
        game.clientData = {
            itemDetailMap: {
                '/items/guild_credit_1': { name: 'Trade Credit', guildCreditConversions: [] },
                '/items/bronze_bar': {
                    name: 'Bronze Bar',
                    guildCreditConversions: [
                        { creditItemHrid: '/items/guild_credit_1', itemCount: 10, creditCount: 1 },
                    ],
                },
                '/items/iron_bar': {
                    name: 'Iron Bar',
                    guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 5, creditCount: 1 }],
                },
                '/items/steel_bar': {
                    name: 'Steel Bar',
                    guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 1, creditCount: 1 }],
                },
            },
        };
        guildCreditValue.cleanup();
        guildCreditValue.initialize();
    });

    test('ranks by gold-per-credit ascending on the ask side by default', () => {
        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);

        // sellGPC: steel 50*1=50, bronze 100*10=1000, iron 300*5=1500
        const texts = rowTexts(modal);
        expect(texts[0]).toContain('Steel Bar');
        expect(texts[1]).toContain('Bronze Bar');
        expect(texts[2]).toContain('Iron Bar');
    });

    test('the cheapest row is the only one highlighted', () => {
        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);

        const rows = modal.querySelectorAll('.mwi-guild-credit-value tbody tr');
        expect(rows[0].style.color).toBe('#4ade80');
        expect(rows[1].style.color).not.toBe('#4ade80');
    });

    test('clicking the Bid header re-sorts by buy-side gold-per-credit', () => {
        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);

        const bidTh = Array.from(modal.querySelectorAll('th')).find((th) => th.textContent === 'Bid/credit');
        bidTh.click();

        // buyGPC: steel has no bid (null, sorts last), bronze 90*10=900, iron 280*5=1400
        const texts = rowTexts(modal);
        expect(texts[0]).toContain('Bronze Bar');
        expect(texts[1]).toContain('Iron Bar');
        expect(texts[2]).toContain('Steel Bar');
    });

    test('an item priced on only one side still appears, with a dash on the unpriced side', () => {
        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);

        const steelRow = Array.from(modal.querySelectorAll('.mwi-guild-credit-value tbody tr')).find((tr) =>
            tr.textContent.includes('Steel Bar')
        );
        // Bid ea. and Bid/credit columns should render as a dash, not a false zero
        expect(steelRow.textContent).toContain('–');
    });

    test('disabled by setting, no table is rendered', () => {
        game.settings.guildCreditValue = false;
        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);

        expect(modal.querySelector('.mwi-guild-credit-value')).toBeNull();
    });

    test('a credit type with no matching header title renders nothing', () => {
        const modal = buildExchangeModal('Some Other Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);

        expect(modal.querySelector('.mwi-guild-credit-value')).toBeNull();
    });

    test('re-rendering (e.g. modal reopened) replaces rather than duplicates the table', () => {
        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);
        game.observers['GuildPanel_exchangeModalContent'](modal);

        expect(modal.querySelectorAll('.mwi-guild-credit-value')).toHaveLength(1);
    });
});

describe('guild credit value — trial tier badge', () => {
    beforeEach(() => {
        game.settings = {};
        game.observers = {};
        game.clientData = { itemDetailMap: {} };
        guildCreditValue.cleanup();
        guildCreditValue.initialize();
    });

    function buildTileSummary(text) {
        document.body.innerHTML = '';
        const el = document.createElement('div');
        el.textContent = text;
        document.body.appendChild(el);
        return el;
    }

    test('a level below 100 gets no tier badge', () => {
        const el = buildTileSummary('Lv.99');
        game.observers['GuildPanel_tileSummary'](el);

        expect(el.querySelector('.mwi-trial-tier')).toBeNull();
    });

    test('level 100 is tier 1, and every 10 levels advances a tier', () => {
        expect(buildAndReadTier('Lv.100')).toBe('T1');
        expect(buildAndReadTier('Lv.109')).toBe('T1');
        expect(buildAndReadTier('Lv.110')).toBe('T2');
        expect(buildAndReadTier('Lv.150')).toBe('T6');

        function buildAndReadTier(text) {
            const el = buildTileSummary(text);
            game.observers['GuildPanel_tileSummary'](el);
            return el.querySelector('.mwi-trial-tier').textContent;
        }
    });

    test('the top of the ladder is tier 21, and past the level cap the badge says so', () => {
        // Tiers start at 100 and step 10 to a maximum level of 300, which is 21
        // tiers — the same ladder `guild-trials-math.js` encodes, and not the 20
        // this badge used to cap at.
        //
        // At the cap the level stops identifying the tier: T21, T22 and T23 all
        // read Lv.300, so the badge is a floor and wears a `+` to say so.
        expect(buildAndReadTier('Lv.300')).toBe('T21+');
        expect(buildAndReadTier('Lv.500')).toBe('T21+');

        function buildAndReadTier(text) {
            const el = buildTileSummary(text);
            game.observers['GuildPanel_tileSummary'](el);
            return el.querySelector('.mwi-trial-tier').textContent;
        }
    });

    test('the badge and the math agree on every tier of the ladder, both ways', () => {
        for (let tier = 1; tier <= TRIAL_MAX_TIER; tier++) {
            const level = levelFromTier(tier);
            expect(tierFromLevel(level)).toBe(tier);

            const el = buildTileSummary(`Lv.${level}`);
            game.observers['GuildPanel_tileSummary'](el);
            // The top tier is at the level cap, where the badge is a floor
            expect(el.querySelector('.mwi-trial-tier').textContent).toBe(
                `T${tier}${tier === TRIAL_MAX_TIER ? '+' : ''}`
            );
        }

        // One past the top is still the top, not a 22nd tier
        expect(levelFromTier(TRIAL_MAX_TIER + 1)).toBeNull();
        expect(tierFromLevel(310)).toBe(TRIAL_MAX_TIER);
    });

    test('a tile is only ever tagged once', () => {
        const el = buildTileSummary('Lv.150');
        game.observers['GuildPanel_tileSummary'](el);
        game.observers['GuildPanel_tileSummary'](el);

        expect(el.querySelectorAll('.mwi-trial-tier')).toHaveLength(1);
    });

    test('a redraw that wipes the badge gets it back, and never twice', () => {
        // React reuses the level line and replaces its children. The old guard
        // was a `data-` flag on that element, which survived the wipe — so the
        // badge vanished on the first card update and never returned, which is
        // exactly what the maintainer's "Lv.260" with no tier on it was.
        const el = buildTileSummary('Lv.260');
        game.observers['GuildPanel_tileSummary'](el);
        expect(el.querySelector('.mwi-trial-tier').textContent).toBe('T17');

        el.textContent = 'Lv.260';
        game.observers['GuildPanel_tileSummary'](el);
        expect(el.querySelectorAll('.mwi-trial-tier')).toHaveLength(1);
        expect(el.querySelector('.mwi-trial-tier').textContent).toBe('T17');
    });

    test('the badge never reads below what the record says is banked', () => {
        // Past the level cap the level is no longer the better number, and the
        // trials feature publishes the banked count on the card for this
        const owner = document.createElement('div');
        owner.dataset.mwiTrialBanked = '24';
        const el = document.createElement('div');
        el.textContent = 'Lv.300';
        owner.appendChild(el);
        document.body.appendChild(owner);

        game.observers['GuildPanel_tileSummary'](el);
        expect(el.querySelector('.mwi-trial-tier').textContent).toBe('T24+');
    });

    test('text with no level marker is left alone', () => {
        const el = buildTileSummary('No level here');
        game.observers['GuildPanel_tileSummary'](el);

        expect(el.querySelector('.mwi-trial-tier')).toBeNull();
    });

    test("a building tile's level (max 20, well under the trial floor of 100) never gets a tier badge", () => {
        // Buildings tab format: "Lv. 10 / 20" — below TRIAL_START_LEVEL, so
        // tierFromLevel() returns null and no badge is injected. This is the
        // level range GUILD_BUILDING_MAX_LEVEL covers; it must never be treated
        // as a trial level.
        const el = buildTileSummary('Lv.20');
        game.observers['GuildPanel_tileSummary'](el);

        expect(el.querySelector('.mwi-trial-tier')).toBeNull();
    });
});

describe('guild credit value — shrine upgrade planner building cap', () => {
    beforeEach(() => {
        game.settings = { guildCreditValue: true, guildCreditExchangeAdvisor: false, guildShrineUpgradePlanner: true };
        game.observers = {};
        game.prices = { '/items/bronze_bar': { ask: 100, bid: 90 } };
        game.buildingLevels = {};
        guildCreditValue.cleanup();
        guildCreditValue.initialize();
    });

    function buildBuffClientData(levelCostsMaxLevel) {
        return {
            itemDetailMap: {
                '/items/guild_credit_1': { name: 'Trade Credit', guildCreditConversions: [] },
                '/items/bronze_bar': {
                    name: 'Bronze Bar',
                    guildCreditConversions: [
                        { creditItemHrid: '/items/guild_credit_1', itemCount: 10, creditCount: 1 },
                    ],
                },
            },
            guildBuffDetailMap: {
                '/guild_buffs/force_combat': {
                    shrineHrid: '/guild_shrines/force',
                    isCombat: true,
                    levelCosts: Object.fromEntries(
                        Array.from({ length: levelCostsMaxLevel }, (_, i) => [String(i + 1), {}])
                    ),
                },
            },
        };
    }

    test('the target-level input caps at 20 even when levelCosts data claims more', () => {
        game.clientData = buildBuffClientData(25);

        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);

        const input = modal.querySelector('.mwi-shrine-planner input[type="number"]');
        expect(Number(input.max)).toBe(20);
    });

    test("the target-level input caps at 20 even when the shrine's own level claims more", () => {
        game.clientData = buildBuffClientData(20);
        game.buildingLevels = { '/guild_shrines/force': 25 };

        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);

        const input = modal.querySelector('.mwi-shrine-planner input[type="number"]');
        expect(Number(input.max)).toBe(20);
    });

    test('level 20 itself is a valid target — the cap excludes nothing in range', () => {
        game.clientData = buildBuffClientData(20);
        game.buildingLevels = { '/guild_shrines/force': 20 };

        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);

        const input = modal.querySelector('.mwi-shrine-planner input[type="number"]');
        expect(Number(input.max)).toBe(20);
    });
});

describe('reading the token exchange off the dialog', () => {
    beforeEach(() => {
        game.settings = { guildCreditValue: true, guildCreditExchangeAdvisor: false, guildShrineUpgradePlanner: false };
        game.observers = {};
        game.captures = [];
        game.prices = {};
        game.clientData = {
            itemDetailMap: {
                '/items/guild_credit_1': { name: 'Trade Credit', guildCreditConversions: [] },
                '/items/guild_token': { name: 'Guild Token' },
            },
        };
        guildCreditValue.cleanup();
        guildCreditValue.initialize();
    });

    test('an open exchange dialog is handed to the capture, credit and selection named', () => {
        const modal = buildExchangeModal('Trade Credit');
        const selector = document.createElement('div');
        selector.className = 'ItemSelector_itemContainer_x';
        selector.innerHTML = '<svg aria-label="Guild Token"></svg>';
        modal.appendChild(selector);

        game.observers['GuildPanel_exchangeModalContent'](modal);

        expect(game.captures).toHaveLength(1);
        expect(game.captures[0][1]).toEqual({
            creditItemHrid: '/items/guild_credit_1',
            creditName: 'Trade Credit',
            selectedItemHrid: null,
            selectedItemName: 'Guild Token',
            tokenHrid: '/items/guild_token',
            tokenName: 'Guild Token',
        });
    });

    test('a selection carrying its icon sprite hands the capture the hrid, whatever the label says', () => {
        const modal = buildExchangeModal('Trade Credit');
        const selector = document.createElement('div');
        selector.className = 'ItemSelector_itemContainer_x';
        // A French client: translated label, same sprite
        selector.innerHTML =
            '<svg aria-label="Jeton de guilde"><use href="/static/media/items_sprite.abc.svg#guild_token"></use></svg>';
        modal.appendChild(selector);

        game.observers['GuildPanel_exchangeModalContent'](modal);

        expect(game.captures).toHaveLength(1);
        expect(game.captures[0][1]).toMatchObject({
            selectedItemHrid: '/items/guild_token',
            selectedItemName: 'Jeton de guilde',
        });
    });

    test('a dialog whose header names no credit is not offered to the capture', () => {
        const modal = buildExchangeModal('Some Other Modal');

        game.observers['GuildPanel_exchangeModalContent'](modal);

        expect(game.captures).toEqual([]);
    });

    test('the capture runs even with the credit table switched off', () => {
        game.settings.guildCreditValue = false;
        const modal = buildExchangeModal('Trade Credit');

        game.observers['GuildPanel_exchangeModalContent'](modal);

        expect(game.captures).toHaveLength(1);
        expect(modal.querySelector('.mwi-guild-credit-value')).toBeNull();
    });
});

describe('shrine upgrade planner — saved plan and next-buy suggestions', () => {
    const FORCE = '/guild_buffs/force_combat';
    const TEMPO = '/guild_buffs/tempo_skilling';
    const RARITY = '/guild_buffs/rarity_combat';

    /** levelCosts for levels 1..max, with `at` overriding named levels */
    function costs(max, at = {}) {
        const out = {};
        for (let lvl = 1; lvl <= max; lvl++) out[String(lvl)] = at[lvl] || { guildTokenCost: 1000, creditCosts: [] };
        return out;
    }

    function planClientData() {
        return {
            itemDetailMap: {
                '/items/guild_credit_1': { name: 'Trade Credit', guildCreditConversions: [] },
                // Nothing on the market converts into this one — the planner's
                // "no conversion" case
                '/items/guild_credit_2': { name: 'Craft Credit', guildCreditConversions: [] },
                '/items/guild_token': { name: 'Guild Token', guildCreditConversions: [] },
                '/items/bronze_bar': {
                    name: 'Bronze Bar',
                    guildCreditConversions: [
                        { creditItemHrid: '/items/guild_credit_1', itemCount: 10, creditCount: 1 },
                    ],
                },
                // The cheaper route to the same credit: 150 gold per credit
                // against the bronze bar's 1000
                '/items/iron_bar': {
                    name: 'Iron Bar',
                    guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 5, creditCount: 1 }],
                },
            },
            guildBuffDetailMap: {
                [FORCE]: {
                    shrineHrid: '/guild_shrines/force',
                    isCombat: true,
                    levelCosts: costs(10, {
                        3: { guildTokenCost: 300, creditCosts: [{ itemHrid: '/items/guild_credit_1', count: 50 }] },
                        4: { guildTokenCost: 400, creditCosts: [{ itemHrid: '/items/guild_credit_2', count: 7 }] },
                        5: { guildTokenCost: 500, creditCosts: [{ itemHrid: '/items/guild_credit_1', count: 50 }] },
                    }),
                },
                [TEMPO]: {
                    shrineHrid: '/guild_shrines/tempo',
                    isCombat: false,
                    levelCosts: costs(10, { 1: { guildTokenCost: 100, creditCosts: [] } }),
                },
                [RARITY]: {
                    shrineHrid: '/guild_shrines/rarity',
                    isCombat: true,
                    levelCosts: costs(10),
                },
            },
        };
    }

    /** Open the exchange modal and return it, planner drawn */
    function openModal() {
        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);
        return modal;
    }

    function inputFor(modal, buffHrid) {
        return modal.querySelector(`.mwi-shrine-planner input[data-buff-hrid="${buffHrid}"]`);
    }

    function nextBuyRows(modal) {
        return Array.from(modal.querySelectorAll('.mwi-shrine-next-buy'));
    }

    /** Close the modal and forget the in-memory plan, as a page reload would */
    async function reopenFromStorage() {
        document.body.innerHTML = '';
        shrinePlanRecord.reset();
        await shrinePlanRecord.load();
        return openModal();
    }

    beforeEach(() => {
        vi.useFakeTimers();
        game.settings = { guildCreditValue: true, guildCreditExchangeAdvisor: false, guildShrineUpgradePlanner: true };
        game.observers = {};
        game.prices = { '/items/bronze_bar': { ask: 100, bid: 90 }, '/items/iron_bar': { ask: 30, bid: 25 } };
        shopping.calls = [];
        // Force and Tempo shrines have room; Rarity's cap equals its current
        // buff level, so that buff has no next level to suggest.
        game.buildingLevels = {
            '/guild_shrines/force': 10,
            '/guild_shrines/tempo': 10,
            '/guild_shrines/rarity': 5,
        };
        game.buffLevels = { [FORCE]: 2, [TEMPO]: 0, [RARITY]: 5 };
        game.inventory = [];
        // No colour's exchange has been opened yet — the honest default
        game.rates = {};
        game.storage = {};
        game.clientData = planClientData();
        shrinePlanRecord.reset();
        guildCreditValue.cleanup();
        guildCreditValue.initialize();
        // After the teardown, which flushes any save the previous test left pending
        game.writes = 0;
    });

    afterEach(() => {
        vi.useRealTimers();
        shrinePlanRecord.reset();
        game.storage = {};
        game.buffLevels = {};
        game.inventory = [];
        game.rates = {};
    });

    test('a typed target survives closing and reopening the modal', async () => {
        const modal = openModal();
        const input = inputFor(modal, FORCE);
        input.value = '7';
        input.dispatchEvent(new Event('input'));

        vi.advanceTimersByTime(400);
        await shrinePlanRecord.flushed();

        expect(game.storage['settings:guildShrinePlan_char1'].targets).toEqual({ [FORCE]: 7 });

        const reopened = await reopenFromStorage();
        expect(inputFor(reopened, FORCE).value).toBe('7');
        // Untouched buffs still sit at their current level
        expect(inputFor(reopened, TEMPO).value).toBe('0');
    });

    test('a target at or below the current level is pruned, not restored', async () => {
        game.storage['settings:guildShrinePlan_char1'] = {
            targets: { [FORCE]: 2, [TEMPO]: 4 },
            collapsed: true,
        };

        const modal = await reopenFromStorage();
        // FORCE is already level 2 — a no-op target, so the input keeps its default
        expect(inputFor(modal, FORCE).value).toBe('2');
        expect(inputFor(modal, TEMPO).value).toBe('4');

        vi.advanceTimersByTime(400);
        await shrinePlanRecord.flushed();
        expect(game.storage['settings:guildShrinePlan_char1'].targets).toEqual({ [TEMPO]: 4 });
    });

    test('a saved target above the current cap is clamped to it', async () => {
        game.storage['settings:guildShrinePlan_char1'] = { targets: { [TEMPO]: 99 }, collapsed: true };

        const modal = await reopenFromStorage();
        const input = inputFor(modal, TEMPO);
        expect(input.value).toBe(input.max);

        vi.advanceTimersByTime(400);
        await shrinePlanRecord.flushed();
        expect(game.storage['settings:guildShrinePlan_char1'].targets[TEMPO]).toBe(Number(input.max));
    });

    test('the expanded/collapsed state of the planner body persists', async () => {
        const modal = openModal();
        const body = modal.querySelector('.mwi-shrine-planner > div:nth-child(2)');
        expect(body.style.display).toBe('none');

        modal.querySelector('.mwi-shrine-planner > div').click();
        expect(body.style.display).toBe('block');

        vi.advanceTimersByTime(400);
        await shrinePlanRecord.flushed();
        expect(game.storage['settings:guildShrinePlan_char1'].collapsed).toBe(false);

        const reopened = await reopenFromStorage();
        expect(reopened.querySelector('.mwi-shrine-planner > div:nth-child(2)').style.display).toBe('block');
    });

    test('writes are debounced — a burst of keystrokes lands as one save', async () => {
        const modal = openModal();
        const input = inputFor(modal, FORCE);

        for (const keystroke of ['1', '12', '5']) {
            input.value = keystroke;
            input.dispatchEvent(new Event('input'));
            vi.advanceTimersByTime(100);
        }
        await shrinePlanRecord.flushed();
        expect(game.writes).toBe(0);

        vi.advanceTimersByTime(400);
        await shrinePlanRecord.flushed();
        expect(game.writes).toBe(1);
        expect(game.storage['settings:guildShrinePlan_char1'].targets).toEqual({ [FORCE]: 5 });
    });

    test('next buys list every unlocked buff, cheapest guild-token cost first', () => {
        const modal = openModal();
        const rows = nextBuyRows(modal).map((r) => r.textContent.replace(/\s+/g, ' ').trim());

        expect(rows).toHaveLength(2);
        expect(rows[0]).toContain('Tempo · Skilling');
        expect(rows[0]).toContain('100 tok');
        expect(rows[1]).toContain('Force · Combat');
        expect(rows[1]).toContain('300 tok');
    });

    test('a buff already at its shrine cap has no next level to suggest', () => {
        const modal = openModal();
        const text = nextBuyRows(modal)
            .map((r) => r.textContent)
            .join(' ');
        expect(text).not.toContain('Rarity');
    });

    test('a suggested buy shows its credit cost, shortened, with the full name in a tooltip', () => {
        const modal = openModal();
        const forceRow = nextBuyRows(modal).find((r) => r.textContent.includes('Force'));
        const credits = forceRow.querySelector('.mwi-shrine-next-buy-credits');

        expect(credits.textContent.replace(/\s+/g, ' ')).toBe('+ 50 Trade');
        expect(credits.title).toBe('50 Trade Credit');
    });

    test('affordability marking follows the held guild-token balance', () => {
        game.inventory = [
            { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 150 },
        ];
        const modal = openModal();
        const rows = nextBuyRows(modal);

        expect(modal.querySelector('.mwi-shrine-next-buys').textContent).toContain('Guild Token: 150');
        expect(rows[0].dataset.affordable).toBe('yes'); // 100 tokens
        expect(rows[1].dataset.affordable).toBe('no'); // 300 tokens
    });

    test('tokens held outside the inventory do not count toward the balance', () => {
        game.inventory = [{ itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/bank', count: 500 }];
        const modal = openModal();

        expect(modal.querySelector('.mwi-shrine-next-buys').textContent).toContain('Guild Token: 0');
        expect(nextBuyRows(modal)[0].dataset.affordable).toBe('no');
    });

    test('the spend-everything walk totals what the balance actually covers', () => {
        game.inventory = [
            { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 450 },
        ];
        const modal = openModal();

        // The Force level's 50 Trade Credit is bought on the market — that colour
        // has no token rate at all — so the walk says both halves of the bill
        expect(modal.querySelector('.mwi-shrine-spend-all').textContent).toBe(
            'Spending everything now: 2 of 2 next levels for 400 tokens plus ≈7.5K gold of mats'
        );
    });

    test('the walk says so when nothing on the list is affordable', () => {
        const modal = openModal();
        expect(modal.querySelector('.mwi-shrine-spend-all').textContent).toContain(
            'Nothing on this list is affordable'
        );
    });

    test('greedyAffordable stops at the first buy the balance cannot cover', () => {
        const options = [{ tokenCost: 100 }, { tokenCost: 300 }, { tokenCost: 500 }];
        expect(greedyAffordable(options, 0)).toEqual({ count: 0, spent: 0 });
        expect(greedyAffordable(options, 399)).toEqual({ count: 1, spent: 100 });
        expect(greedyAffordable(options, 400)).toEqual({ count: 2, spent: 400 });
        expect(greedyAffordable(options, 10_000)).toEqual({ count: 3, spent: 900 });
    });

    test('the existing total-cost calculator still answers the goal question', () => {
        const modal = openModal();
        const input = inputFor(modal, FORCE);
        input.value = '3';
        input.dispatchEvent(new Event('input'));

        const totals = modal.querySelector('.mwi-shrine-planner').textContent;
        // The heading follows the arithmetic: the figures below it are net of
        // what is held, so it no longer claims to be a gross "total cost"
        expect(totals).toContain('Still needed for these targets');
        expect(totals).toContain('300');
    });

    /** Set a target level and let the planner recalculate */
    function setTarget(modal, buffHrid, level) {
        const input = inputFor(modal, buffHrid);
        input.value = String(level);
        input.dispatchEvent(new Event('input'));
    }

    function matsButton(modal) {
        return modal.querySelector('.mwi-shrine-plan-mats-btn');
    }

    describe('missing mats hand-off', () => {
        test('the totals net against credits already held, and say how many those are', () => {
            game.inventory = [
                { itemHrid: '/items/guild_credit_1', itemLocationHrid: '/item_locations/inventory', count: 20 },
            ];
            const modal = openModal();
            setTarget(modal, FORCE, 3);

            const totals = modal.querySelector('.mwi-shrine-planner').textContent.replace(/\s+/g, ' ');
            // 50 owed, 20 held
            expect(totals).toContain('Trade Credit');
            expect(totals).toContain('30');
            expect(totals).toContain('(own 20)');
        });

        test('the shopping list buys the cheapest conversion into each credit', () => {
            const modal = openModal();
            setTarget(modal, FORCE, 3);
            matsButton(modal).click();

            // Iron at 150 gold/credit beats bronze at 1000: 50 credits at
            // 1 credit per 5 bars is 250 bars
            expect(shopping.calls).toHaveLength(1);
            expect(shopping.calls[0].items).toEqual([{ itemHrid: '/items/iron_bar', name: 'Iron Bar', count: 250 }]);
            expect(shopping.calls[0].options).toEqual({ heading: 'Shrine plan' });
        });

        test('a part-filled conversion still costs a whole one', () => {
            // The `_renderShrine` precedent's arithmetic, with no round number to
            // hide behind: 10 credits bought 4 at a time is three trades of 3 bars
            const conversions = {
                '/items/guild_credit_1': [{ hrid: '/items/iron_bar', name: 'Iron Bar', itemCount: 3, creditCount: 4 }],
            };
            expect(creditShortfallMaterials({ '/items/guild_credit_1': 10 }, conversions, [])).toEqual([
                { itemHrid: '/items/iron_bar', name: 'Iron Bar', count: 9 },
            ]);
        });

        test('raw material already in the inventory comes off the shopping list', () => {
            game.inventory = [
                { itemHrid: '/items/iron_bar', itemLocationHrid: '/item_locations/inventory', count: 200 },
            ];
            const modal = openModal();
            setTarget(modal, FORCE, 3);
            matsButton(modal).click();

            expect(shopping.calls[0].items).toEqual([{ itemHrid: '/items/iron_bar', name: 'Iron Bar', count: 50 }]);
        });

        test('bars held outside the inventory are not counted as held', () => {
            game.inventory = [{ itemHrid: '/items/iron_bar', itemLocationHrid: '/item_locations/bank', count: 500 }];
            const modal = openModal();
            setTarget(modal, FORCE, 3);
            matsButton(modal).click();

            expect(shopping.calls[0].items[0].count).toBe(250);
        });

        test('a credit nothing converts into is left off the list rather than throwing', () => {
            const modal = openModal();
            // Level 4 costs Craft Credit, which has no conversion at all
            expect(() => setTarget(modal, FORCE, 4)).not.toThrow();

            // Still owed, and still shown in the totals — it just has nothing to buy
            expect(modal.querySelector('.mwi-shrine-planner').textContent).toContain('Craft Credit');
            matsButton(modal).click();
            expect(shopping.calls[0].items.map((i) => i.itemHrid)).toEqual(['/items/iron_bar']);
        });

        test('there is no button when the plan owes no credits at all', () => {
            const modal = openModal();
            // Tempo's next levels cost tokens only
            setTarget(modal, TEMPO, 3);

            expect(matsButton(modal)).toBeNull();
        });

        test('there is no button when every needed credit is already held', () => {
            game.inventory = [
                { itemHrid: '/items/guild_credit_1', itemLocationHrid: '/item_locations/inventory', count: 50 },
            ];
            const modal = openModal();
            setTarget(modal, FORCE, 3);

            expect(matsButton(modal)).toBeNull();
            // The tokens are still owed, so the box is not empty — but nothing
            // in it is a credit, and nothing a credit converts from is on the
            // market for the button to offer
            expect(modal.querySelector('.mwi-shrine-planner').textContent).not.toContain('Trade Credit50');
        });

        test('a plan with nothing left to pay says so instead of showing an empty box', () => {
            game.inventory = [
                { itemHrid: '/items/guild_credit_1', itemLocationHrid: '/item_locations/inventory', count: 50 },
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 5000 },
            ];
            const modal = openModal();
            setTarget(modal, FORCE, 3);

            expect(matsButton(modal)).toBeNull();
            expect(modal.querySelector('.mwi-shrine-planner').textContent).toContain(
                'Everything these targets cost is already held'
            );
        });

        test('changing the target level rebuilds the list', () => {
            const modal = openModal();
            setTarget(modal, FORCE, 3);
            matsButton(modal).click();
            expect(shopping.calls[0].items[0].count).toBe(250);

            // Level 5 costs another 50 credits on top
            setTarget(modal, FORCE, 5);
            matsButton(modal).click();
            expect(shopping.calls).toHaveLength(2);
            expect(shopping.calls[1].items[0].count).toBe(500);

            // And back below the current level, where there is nothing to plan
            setTarget(modal, FORCE, 2);
            expect(matsButton(modal)).toBeNull();
        });
    });

    describe('the suggestions section folds', () => {
        const suggestHeading = (modal) => modal.querySelector('.mwi-shrine-suggest-heading');
        const suggestBody = (modal) => modal.querySelector('.mwi-shrine-suggest-body');

        test('clicking the heading folds the whole block and remembers it', async () => {
            const modal = openModal();
            expect(suggestBody(modal).style.display).toBe('block');

            suggestHeading(modal).click();
            expect(suggestBody(modal).style.display).toBe('none');
            expect(suggestHeading(modal).textContent).toContain('▶');
            expect(shrinePlanRecord.get().suggestionsCollapsed).toBe(true);

            // A fresh render honours the remembered fold
            const reopened = openModal();
            expect(suggestBody(reopened).style.display).toBe('none');
        });

        test('unfolding is remembered the same way', () => {
            shrinePlanRecord.get().suggestionsCollapsed = true;
            const modal = openModal();
            expect(suggestBody(modal).style.display).toBe('none');

            suggestHeading(modal).click();
            expect(suggestBody(modal).style.display).toBe('block');
            expect(shrinePlanRecord.get().suggestionsCollapsed).toBe(false);
        });
    });

    describe('suggestion row layout', () => {
        function forceRow(modal) {
            return nextBuyRows(modal).find((r) => r.textContent.includes('Force'));
        }

        test('the label is a single unwrapping line carrying shrine, buff and levels', () => {
            const modal = openModal();
            const label = forceRow(modal).querySelector('.mwi-shrine-next-buy-label');

            expect(label.textContent).toBe('Force · Combat · 2→3');
            expect(label.textContent).not.toContain('\n');
            expect(label.style.whiteSpace).toBe('nowrap');
            // Clipped rather than stacked: a name too long for the row loses its
            // tail, it does not become a column
            expect(label.style.textOverflow).toBe('ellipsis');
            expect(label.style.overflow).toBe('hidden');
        });

        test('the credit list wraps onto continuation lines instead of running off the row', () => {
            const modal = openModal();
            const credits = forceRow(modal).querySelector('.mwi-shrine-next-buy-credits');

            expect(credits.style.whiteSpace).toBe('normal');
            expect(credits.style.whiteSpace).not.toBe('nowrap');
            expect(credits.style.overflowWrap).toBe('anywhere');
            // A whole line of its own inside the wrapping row
            expect(credits.style.flexBasis).toBe('100%');
            expect(credits.style.minWidth).toBe('0');
        });

        test('the row itself wraps and is bounded by the modal width', () => {
            const modal = openModal();
            const row = forceRow(modal);

            expect(row.style.flexWrap).toBe('wrap');
            expect(row.style.maxWidth).toBe('100%');
            expect(row.style.boxSizing).toBe('border-box');
        });

        test('the token figure stays on one line', () => {
            const modal = openModal();
            expect(forceRow(modal).querySelector('.mwi-shrine-next-buy-tok').style.whiteSpace).toBe('nowrap');
        });

        test('the planner body scrolls vertically only', () => {
            const modal = openModal();
            const body = modal.querySelector('.mwi-shrine-planner > div:nth-child(2)');

            expect(body.style.overflowY).toBe('auto');
            expect(body.style.overflowX).toBe('hidden');
            expect(modal.querySelector('.mwi-shrine-planner').style.maxWidth).toBe('100%');
        });

        test('shortCreditName keeps the colour and drops the boilerplate', () => {
            expect(shortCreditName('Blue Guild Credit')).toBe('Blue');
            expect(shortCreditName('Trade Credit')).toBe('Trade');
            expect(shortCreditName('Guild Credit')).toBe('Guild Credit');
            expect(shortCreditName('')).toBe('');
        });
    });

    describe('suggested buys → marketplace → conversion', () => {
        function flowButton(modal) {
            return modal.querySelector('.mwi-shrine-next-buy-mats-btn');
        }

        function convertSteps(modal) {
            return Array.from(modal.querySelectorAll('.mwi-shrine-convert-step')).map((el) => el.textContent);
        }

        test('the hand-off is scoped to the affordable buys, not the whole list', () => {
            // 150 tokens covers Tempo (100, no credits) and nothing else, so the
            // Force level's 50 Trade Credit is not a bill to go shopping for yet
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 150 },
            ];
            const modal = openModal();

            expect(nextBuyRows(modal)[1].dataset.affordable).toBe('no');
            expect(flowButton(modal)).toBeNull();
            expect(convertSteps(modal)).toEqual([]);
        });

        test('the affordable buys’ credit shortfall becomes a marketplace list', () => {
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 450 },
            ];
            const modal = openModal();
            flowButton(modal).click();

            // 50 Trade Credit through the cheaper iron bar: 5 bars per credit
            expect(shopping.calls).toHaveLength(1);
            expect(shopping.calls[0].items).toEqual([{ itemHrid: '/items/iron_bar', name: 'Iron Bar', count: 250 }]);
            expect(shopping.calls[0].options).toEqual({ heading: 'Next buys' });
        });

        test('the convert plan names the same option and quantity the shortfall used', () => {
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 450 },
            ];
            const modal = openModal();

            expect(convertSteps(modal)).toEqual(['convert 250× Iron Bar → 50 Trade']);
            const line = modal.querySelector('.mwi-shrine-convert-step');
            expect(line.dataset.creditHrid).toBe('/items/guild_credit_1');
            expect(line.title).toContain('50 Trade Credit');
        });

        test('the conversion is the whole trade even where the bars are already held', () => {
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 450 },
                { itemHrid: '/items/iron_bar', itemLocationHrid: '/item_locations/inventory', count: 200 },
            ];
            const modal = openModal();
            flowButton(modal).click();

            // 50 bars left to buy, but all 250 still go over the counter
            expect(shopping.calls[0].items[0].count).toBe(50);
            expect(convertSteps(modal)).toEqual(['convert 250× Iron Bar → 50 Trade']);
        });

        test('nothing is drawn when the affordable buys are short of no credits', () => {
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 450 },
                { itemHrid: '/items/guild_credit_1', itemLocationHrid: '/item_locations/inventory', count: 50 },
            ];
            const modal = openModal();

            expect(flowButton(modal)).toBeNull();
            expect(convertSteps(modal)).toEqual([]);
        });

        test('creditConversionPlan rounds a part-filled trade up to a whole one', () => {
            const conversions = {
                '/items/guild_credit_1': [{ hrid: '/items/iron_bar', name: 'Iron Bar', itemCount: 3, creditCount: 4 }],
            };
            expect(
                creditConversionPlan({ '/items/guild_credit_1': 10 }, conversions, {
                    '/items/guild_credit_1': { name: 'Trade Credit' },
                })
            ).toEqual([
                {
                    creditItemHrid: '/items/guild_credit_1',
                    creditName: 'Trade Credit',
                    itemHrid: '/items/iron_bar',
                    itemName: 'Iron Bar',
                    itemCount: 9,
                    creditCount: 12,
                    owed: 10,
                },
            ]);
        });

        test('a credit nothing converts into contributes no step', () => {
            expect(creditConversionPlan({ '/items/guild_credit_2': 7 }, {}, {})).toEqual([]);
        });
    });

    describe('token → credit conversion awareness', () => {
        /** The Guild Shop seen exchanging `tokens` for `credits` of Trade Credit */
        function seeRate(tokens, credits, extra = {}) {
            game.rates['/items/guild_credit_1'] = {
                creditItemHrid: '/items/guild_credit_1',
                creditsPerToken: credits / tokens,
                tokensPerExchange: tokens,
                creditsPerExchange: credits,
                via: 'arrow',
                capturedAt: Date.UTC(2026, 0, 1),
                ...extra,
            };
        }

        function forceRow(modal) {
            return nextBuyRows(modal).find((r) => r.textContent.includes('Force'));
        }

        test('tokensForCredits rounds up to whole exchanges', () => {
            const batched = { creditsPerToken: 10 / 3, tokensPerExchange: 3, creditsPerExchange: 10 };
            expect(tokensForCredits(10, batched)).toBe(3);
            expect(tokensForCredits(11, batched)).toBe(6);
            expect(tokensForCredits(25, batched)).toBe(9);
            expect(tokensForCredits(0, batched)).toBe(0);

            // A reading that only kept the ratio is the same rule at a batch of one
            expect(tokensForCredits(10, { creditsPerToken: 4 })).toBe(3);
            // Never guessed
            expect(tokensForCredits(10, null)).toBeNull();
        });

        test('buyTokenCost adds the conversion top-up and nets what is held', () => {
            const buy = { tokenCost: 300, creditCosts: [{ itemHrid: '/items/guild_credit_1', count: 50 }] };
            const rate = { creditsPerToken: 10, tokensPerExchange: 1, creditsPerExchange: 10 };
            const rateFor = () => rate;

            expect(buyTokenCost(buy, {}, rateFor).effective).toBe(305);
            expect(buyTokenCost(buy, { '/items/guild_credit_1': 20 }, rateFor).effective).toBe(303);
            expect(buyTokenCost(buy, { '/items/guild_credit_1': 50 }, rateFor)).toMatchObject({
                effective: 300,
                conversionTokens: 0,
                conversions: [],
                unknown: [],
            });
        });

        test('an unseen colour is excluded from the sum and reported instead', () => {
            const buy = { tokenCost: 300, creditCosts: [{ itemHrid: '/items/guild_credit_2', count: 7 }] };
            const cost = buyTokenCost(buy, {}, () => null);

            expect(cost.effective).toBe(300);
            expect(cost.conversionTokens).toBe(0);
            expect(cost.unknown).toEqual([{ itemHrid: '/items/guild_credit_2', gap: 7 }]);
        });

        test('the row says how the missing credits would be covered', () => {
            seeRate(1, 10);
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 405 },
            ];
            const modal = openModal();
            const row = forceRow(modal);

            expect(row.querySelector('.mwi-shrine-next-buy-tok').textContent).toBe('305 tok');
            expect(row.querySelector('.mwi-shrine-next-buy-convert').textContent).toBe('convert 5 tok → 50 Trade');
            expect(row.dataset.affordable).toBe('yes');
        });

        test('a known rate makes the true cost the one affordability is judged on', () => {
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 404 },
            ];
            // Without a rate, 404 covers 100 + 300
            expect(nextBuyRows(openModal())[1].dataset.affordable).toBe('yes');

            // With one, the Force level really costs 305 and 404 no longer covers both
            seeRate(1, 10);
            expect(nextBuyRows(openModal())[1].dataset.affordable).toBe('no');
        });

        test('tokensPerExchange granularity is respected on the row', () => {
            // 3 tokens buy 10 credits, so 50 credits is five whole exchanges
            seeRate(3, 10);
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 5000 },
            ];
            const modal = openModal();

            expect(forceRow(modal).querySelector('.mwi-shrine-next-buy-tok').textContent).toBe('315 tok');
        });

        test('ordering follows the effective cost, not the sticker price', () => {
            game.clientData.guildBuffDetailMap[TEMPO].levelCosts['1'] = { guildTokenCost: 302, creditCosts: [] };

            // Sticker price alone puts Force (300) ahead of Tempo (302)
            expect(nextBuyRows(openModal())[0].textContent).toContain('Force');

            // The 50 Trade Credit it is short of costs 5 more tokens, so it is not
            // the cheaper of the two after all
            seeRate(1, 10);
            expect(nextBuyRows(openModal())[0].textContent).toContain('Tempo');
        });

        test('the spend-everything walk counts the conversion tokens it spent', () => {
            seeRate(3, 10);
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 5000 },
            ];
            const modal = openModal();

            expect(modal.querySelector('.mwi-shrine-spend-all').textContent).toBe(
                'Spending everything now: 2 of 2 next levels for 415 tokens, 15 of them converted into credits'
            );
        });

        test('planNextBuys will not let two buys spend the same credits twice', () => {
            const rate = { creditsPerToken: 10, tokensPerExchange: 1, creditsPerExchange: 10 };
            const buys = [
                { label: 'A', tokenCost: 10, creditCosts: [{ itemHrid: '/c', count: 50 }] },
                { label: 'B', tokenCost: 10, creditCosts: [{ itemHrid: '/c', count: 50 }] },
            ];
            const plan = planNextBuys(buys, {
                tokenBalance: 1000,
                creditBalances: { '/c': 50 },
                rateFor: () => rate,
            });

            // The first takes the 50 held; the second buys its own with tokens
            expect(plan.count).toBe(2);
            expect(plan.spent).toBe(25);
            expect(plan.conversionSpent).toBe(5);
            // The default path is the token one, so the shortfall is owed to the
            // guild shop rather than to the marketplace
            expect(plan.owedTokenCredits).toEqual({ '/c': 50 });
            expect(plan.owedCredits).toEqual({});
        });

        test('a colour with neither a rate nor a market price is named on the row rather than priced', () => {
            // Level 4 costs Craft Credit: no colour in the standard table names
            // it, no exchange has been seen for it, and nothing on the market
            // converts into it
            game.buffLevels[FORCE] = 3;
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 5000 },
            ];
            const modal = openModal();
            const note = forceRow(modal).querySelector('.mwi-shrine-next-buy-convert');

            expect(note.textContent).toBe(
                'Craft: rate not seen yet — select Guild Token in this exchange once to record it'
            );
            expect(note.title).toContain('Guild Token');
            // And nothing was added to the cost on the strength of not knowing
            expect(forceRow(modal).querySelector('.mwi-shrine-next-buy-tok').textContent).toBe('400 tok');
        });

        test('a converted figure is never presented as exact', () => {
            seeRate(1, 10, { via: 'tiles', capturedAt: 0 });
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 5000 },
            ];
            const modal = openModal();
            const note = forceRow(modal).querySelector('.mwi-shrine-next-buy-convert');

            expect(note.title).toContain('Approximate');
            expect(note.title).toContain('item tiles');
            expect(note.title).toContain('capture time unknown');
        });

        describe('the still-needed box', () => {
            function convertNote(modal, creditHrid) {
                return modal.querySelector(`.mwi-shrine-credit-convert[data-credit-hrid="${creditHrid}"]`);
            }

            test('a credit row says what converting it would cost in spare tokens', () => {
                seeRate(1, 10);
                game.inventory = [
                    { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 1000 },
                ];
                const modal = openModal();
                setTarget(modal, FORCE, 3);

                const note = convertNote(modal, '/items/guild_credit_1');
                expect(note.textContent).toBe('or convert ≈5 tokens');
                expect(note.title).toContain('Approximate');
            });

            test('no annotation when the spare tokens do not cover it', () => {
                seeRate(1, 1);
                // 300 of the 320 tokens are already owed to the level itself, and
                // 50 credits at one per token is more than the 20 left over
                game.inventory = [
                    { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 320 },
                ];
                const modal = openModal();
                setTarget(modal, FORCE, 3);

                expect(convertNote(modal, '/items/guild_credit_1')).toBeNull();
            });

            test('an unseen colour says so instead of a converted figure', () => {
                game.inventory = [
                    { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 1000 },
                ];
                const modal = openModal();
                setTarget(modal, FORCE, 3);

                const note = convertNote(modal, '/items/guild_credit_1');
                expect(note.textContent).toBe('Trade: token rate not seen yet');
                expect(note.title).toContain('Guild Token');
            });
        });
    });

    describe('the standard token→credit rates', () => {
        /** Colour → [tokens handed over, credits received], as the exchange dialog states it */
        const STATED = {
            green: [1, 10],
            brown: [1, 10],
            white: [1, 10],
            blue: [1, 10],
            purple: [1, 1],
            red: [1, 1],
            silver: [10, 1],
            gold: [60, 1],
        };

        test('all eight colours resolve, at the rate the game charges', () => {
            expect(Object.keys(DEFAULT_TOKEN_RATES).sort()).toEqual(Object.keys(STATED).sort());

            for (const [colour, [tokens, credits]] of Object.entries(STATED)) {
                const rate = tokenRateFor(`/items/${colour}_guild_credit`);
                expect(rate).toMatchObject({
                    tokensPerExchange: tokens,
                    creditsPerExchange: credits,
                    source: 'default',
                });
                expect(tokensPerCredit(rate)).toBeCloseTo(tokens / credits, 10);
                // One whole exchange is the smallest purchase there is
                expect(tokensForCredits(1, rate)).toBe(tokens);
            }
        });

        test('the asymmetry is the point: a blue credit is a tenth of a token, a gold one sixty', () => {
            expect(tokensPerCredit(defaultTokenRate('/items/blue_guild_credit'))).toBeCloseTo(0.1, 10);
            expect(tokensPerCredit(defaultTokenRate('/items/gold_guild_credit'))).toBe(60);
        });

        test('a colour the table does not name has no rate at all', () => {
            expect(defaultTokenRate('/items/guild_credit_1')).toBeNull();
            expect(defaultTokenRate('/items/octarine_guild_credit')).toBeNull();
            expect(defaultTokenRate('')).toBeNull();
            expect(tokenRateFor('/items/guild_credit_1')).toBeNull();
        });

        test('a captured reading overrides the standard rate, for its own colour only', () => {
            game.rates['/items/gold_guild_credit'] = {
                creditItemHrid: '/items/gold_guild_credit',
                creditsPerToken: 1,
                tokensPerExchange: 1,
                creditsPerExchange: 1,
                via: 'arrow',
                capturedAt: Date.UTC(2026, 0, 1),
            };

            // The shop was seen rebalancing gold credits; an observation beats a constant
            expect(tokenRateFor('/items/gold_guild_credit')).toMatchObject({
                source: 'captured',
                tokensPerExchange: 1,
                creditsPerExchange: 1,
            });
            // And says nothing about any other colour
            expect(tokenRateFor('/items/green_guild_credit')).toMatchObject({
                source: 'default',
                creditsPerExchange: 10,
            });
        });

        test('the merged exchange list is captures first, defaults for every gap', () => {
            game.rates['/items/green_guild_credit'] = {
                creditItemHrid: '/items/green_guild_credit',
                creditsPerToken: 4,
                tokensPerExchange: 1,
                creditsPerExchange: 4,
                via: 'arrow',
            };
            const itemDetailMap = {
                '/items/green_guild_credit': { name: 'Green Guild Credit' },
                '/items/gold_guild_credit': { name: 'Gold Guild Credit' },
                '/items/guild_credit_1': { name: 'Trade Credit' },
                '/items/iron_bar': { name: 'Iron Bar' },
            };

            const merged = mergedTokenExchanges(itemDetailMap);
            const byHrid = Object.fromEntries(merged.map((e) => [e.creditItemHrid, e]));

            expect(byHrid['/items/green_guild_credit']).toMatchObject({ source: 'captured', creditsPerToken: 4 });
            expect(byHrid['/items/gold_guild_credit']).toMatchObject({ source: 'default', tokensPerExchange: 60 });
            // A credit no colour names and no capture covers is simply absent
            expect(byHrid['/items/guild_credit_1']).toBeUndefined();
            expect(merged).toHaveLength(2);
        });
    });

    describe('choosing the cheaper way to a credit', () => {
        const gold = () => defaultTokenRate('/items/gold_guild_credit');

        test('the path follows the gold comparison', () => {
            // A gold credit is 60 tokens. At 100 gold a token that is 6,000 gold
            expect(chooseCreditPath({ rate: gold(), marketGoldPerCredit: 1_000, goldPerToken: 100 })).toMatchObject({
                path: 'market',
                tokenGold: 6_000,
                marketGold: 1_000,
            });
            expect(chooseCreditPath({ rate: gold(), marketGoldPerCredit: 100_000, goldPerToken: 100 })).toMatchObject({
                path: 'tokens',
            });
        });

        test('a tie goes to the token, which is what makes the best colour the one tokens buy', () => {
            expect(chooseCreditPath({ rate: gold(), marketGoldPerCredit: 6_000, goldPerToken: 100 }).path).toBe(
                'tokens'
            );
            // And the tie survives the arithmetic that produces it: 0.1 × 1500 is
            // not exactly 150 in a double
            const blue = defaultTokenRate('/items/blue_guild_credit');
            expect(chooseCreditPath({ rate: blue, marketGoldPerCredit: 150, goldPerToken: 1_500 }).path).toBe('tokens');
        });

        test('missing market data falls back to the token path rather than an invented figure', () => {
            expect(chooseCreditPath({ rate: gold(), marketGoldPerCredit: null, goldPerToken: 100 })).toMatchObject({
                path: 'tokens',
                marketGold: null,
            });
            expect(chooseCreditPath({ rate: gold(), marketGoldPerCredit: 1_000, goldPerToken: null })).toMatchObject({
                path: 'tokens',
                tokenGold: null,
            });
        });

        test('no rate leaves the market, and no market either leaves nothing', () => {
            expect(chooseCreditPath({ rate: null, marketGoldPerCredit: 1_000, goldPerToken: 100 }).path).toBe('market');
            expect(chooseCreditPath({ rate: null, marketGoldPerCredit: null }).path).toBe('unknown');
            expect(chooseCreditPath().path).toBe('unknown');
        });

        test('the gold-per-token bridge is the best colour on offer, not the first', () => {
            // Silk yields a blue credit one for one at 200 gold; a rune yields a
            // gold credit one for one at 6,000
            Object.assign(game.clientData.itemDetailMap, {
                '/items/blue_guild_credit': { name: 'Blue Guild Credit', guildCreditConversions: [] },
                '/items/gold_guild_credit': { name: 'Gold Guild Credit', guildCreditConversions: [] },
                '/items/silk': {
                    name: 'Silk',
                    guildCreditConversions: [
                        { creditItemHrid: '/items/blue_guild_credit', itemCount: 1, creditCount: 1 },
                    ],
                },
                '/items/rune': {
                    name: 'Rune',
                    guildCreditConversions: [
                        { creditItemHrid: '/items/gold_guild_credit', itemCount: 1, creditCount: 1 },
                    ],
                },
            });
            game.prices['/items/silk'] = { ask: 200, bid: 150 };
            game.prices['/items/rune'] = { ask: 6_000, bid: 5_000 };

            // Blue: 10 credits per token × 200 = 2,000. Gold: a sixtieth of a
            // credit per token × 6,000 = 100. The blue route wins the maximum
            expect(goldPerTokenFor(game.clientData.itemDetailMap)).toBe(2_000);

            // And that is what prices both paths: gold credits cost 60 × 2,000 of
            // token value against 6,000 on the market, so they are bought
            const marketFor = (hrid, price) =>
                chooseCreditPath({
                    rate: tokenRateFor(hrid),
                    marketGoldPerCredit: price,
                    goldPerToken: goldPerTokenFor(game.clientData.itemDetailMap),
                });
            expect(marketFor('/items/gold_guild_credit', 6_000).path).toBe('market');
            expect(marketFor('/items/blue_guild_credit', 200).path).toBe('tokens');
        });
    });

    describe('the recommended plan drives the whole section', () => {
        const BLUE = '/items/blue_guild_credit';
        const GOLD = '/items/gold_guild_credit';

        function tokenConvertSteps(modal) {
            return Array.from(modal.querySelectorAll('.mwi-shrine-token-convert-step')).map((el) => el.textContent);
        }
        function matConvertSteps(modal) {
            return Array.from(modal.querySelectorAll('.mwi-shrine-convert-step')).map((el) => el.textContent);
        }
        function rowFor(modal, label) {
            return nextBuyRows(modal).find((r) => r.textContent.includes(label));
        }

        beforeEach(() => {
            Object.assign(game.clientData.itemDetailMap, {
                [BLUE]: { name: 'Blue Guild Credit', guildCreditConversions: [] },
                [GOLD]: { name: 'Gold Guild Credit', guildCreditConversions: [] },
                '/items/silk': {
                    name: 'Silk',
                    guildCreditConversions: [{ creditItemHrid: BLUE, itemCount: 1, creditCount: 1 }],
                },
                '/items/rune': {
                    name: 'Rune',
                    guildCreditConversions: [{ creditItemHrid: GOLD, itemCount: 1, creditCount: 1 }],
                },
            });
            game.prices['/items/silk'] = { ask: 200, bid: 150 };
            game.prices['/items/rune'] = { ask: 6_000, bid: 5_000 };
            // Force's next level wants gold credits (60 tokens each — the market
            // is far cheaper); Tempo's wants blue ones (a tenth of a token each)
            game.clientData.guildBuffDetailMap[FORCE].levelCosts['3'] = {
                guildTokenCost: 100,
                creditCosts: [{ itemHrid: GOLD, count: 5 }],
            };
            game.clientData.guildBuffDetailMap[TEMPO].levelCosts['1'] = {
                guildTokenCost: 100,
                creditCosts: [{ itemHrid: BLUE, count: 20 }],
            };
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 1_000 },
            ];
        });

        test('each row shows only the plan it recommends', () => {
            const modal = openModal();

            expect(rowFor(modal, 'Tempo').querySelector('.mwi-shrine-next-buy-convert').textContent).toBe(
                'convert 2 tok → 20 Blue'
            );
            expect(rowFor(modal, 'Force').querySelector('.mwi-shrine-next-buy-convert').textContent).toBe(
                'buy ≈30.0K gold of mats → 5 Gold'
            );
        });

        test('the tooltip says why the path won', () => {
            const modal = openModal();
            const title = rowFor(modal, 'Force').querySelector('.mwi-shrine-next-buy-convert').title;

            expect(title).toContain('Gold — tokens: 120.0K gold-equiv/credit');
            expect(title).toContain('market: 6.0K/credit');
        });

        test('the effective cost, and so the ranking, counts only the tokens the plan spends', () => {
            const modal = openModal();
            const rows = nextBuyRows(modal);

            // Force pays 100 tokens and buys its credits with gold; Tempo pays
            // 100 plus the 2 tokens its blue credits cost
            expect(rows[0].textContent).toContain('Force');
            expect(rows[0].querySelector('.mwi-shrine-next-buy-tok').textContent).toBe('100 tok');
            expect(rows[1].querySelector('.mwi-shrine-next-buy-tok').textContent).toBe('102 tok');
            expect(rows[1].querySelector('.mwi-shrine-next-buy-tok').title).toContain(
                'plus 2 to convert into the credits it is short'
            );
            // No hedging on a standard rate — it is the rate the game charges
            expect(rows[1].querySelector('.mwi-shrine-next-buy-tok').title).not.toContain('about');
        });

        test('the greedy walk spends the recommended plan, tokens and gold named apart', () => {
            const modal = openModal();

            expect(modal.querySelector('.mwi-shrine-spend-all').textContent).toBe(
                'Spending everything now: 2 of 2 next levels for 202 tokens, 2 of them converted into credits plus ≈30.0K gold of mats'
            );
        });

        test('affordability is judged on the recommended plan, not on converting everything', () => {
            // 201 tokens covers Force (100) and not Tempo (102). Converting the
            // five gold credits instead would have cost 300 tokens on its own
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 201 },
            ];
            const modal = openModal();

            expect(nextBuyRows(modal)[0].dataset.affordable).toBe('yes');
            expect(nextBuyRows(modal)[1].dataset.affordable).toBe('no');
        });

        test('the mats button covers only the colours the plan sends to the market', () => {
            const modal = openModal();
            modal.querySelector('.mwi-shrine-next-buy-mats-btn').click();

            expect(shopping.calls).toHaveLength(1);
            expect(shopping.calls[0].items).toEqual([{ itemHrid: '/items/rune', name: 'Rune', count: 5 }]);
        });

        test('the plan lines split the same way the button does', () => {
            const modal = openModal();

            expect(matConvertSteps(modal)).toEqual(['convert 5× Rune → 5 Gold']);
            expect(tokenConvertSteps(modal)).toEqual(['convert 2 tok → 20 Blue']);
        });

        test('a token conversion line explains itself with the standard rate', () => {
            const modal = openModal();
            const line = modal.querySelector('.mwi-shrine-token-convert-step');

            expect(line.dataset.creditHrid).toBe(BLUE);
            expect(line.title).toContain('Standard exchange rate');
            expect(line.title).toContain('1 token → 10');
            expect(line.title).not.toContain('Approximate');
        });

        test('cheap materials move the token path onto the other colour', () => {
            // Silk collapses to 5 gold a credit. Blue credits are then worth 50
            // gold a token against gold credits' 100, so a token is best spent on
            // gold ones after all — and the blue ones are bought instead.
            game.prices['/items/silk'] = { ask: 5, bid: 4 };
            const modal = openModal();

            expect(tokenConvertSteps(modal)).toEqual(['convert 300 tok → 5 Gold']);
            expect(matConvertSteps(modal)).toEqual(['convert 20× Silk → 20 Blue']);
            expect(rowFor(modal, 'Tempo').querySelector('.mwi-shrine-next-buy-tok').textContent).toBe('100 tok');
            expect(rowFor(modal, 'Force').querySelector('.mwi-shrine-next-buy-tok').textContent).toBe('400 tok');
        });

        test('tokenConversionPlan rounds a part-filled exchange up to a whole one', () => {
            // 25 blue credits at ten a token is three exchanges: 3 tokens, 30 credits
            expect(tokenConversionPlan({ [BLUE]: 25 }, game.clientData.itemDetailMap)).toEqual([
                {
                    creditItemHrid: BLUE,
                    creditName: 'Blue Guild Credit',
                    tokens: 3,
                    credits: 30,
                    owed: 25,
                    rate: defaultTokenRate(BLUE),
                },
            ]);
            // A colour with no rate contributes no step rather than a guess
            expect(tokenConversionPlan({ '/items/guild_credit_1': 10 }, game.clientData.itemDetailMap)).toEqual([]);
        });

        test('a colour the market cannot supply goes back to the tokens', () => {
            // No rune on the market: the gold credits have nothing to be bought
            // with, so the plan converts them however dear that is
            delete game.prices['/items/rune'];
            const modal = openModal();

            expect(rowFor(modal, 'Force').querySelector('.mwi-shrine-next-buy-convert').textContent).toBe(
                'convert 300 tok → 5 Gold'
            );
            expect(rowFor(modal, 'Force').querySelector('.mwi-shrine-next-buy-tok').textContent).toBe('400 tok');
        });

        describe('the still-needed box', () => {
            function convertNote(modal, creditHrid) {
                return modal.querySelector(`.mwi-shrine-credit-convert[data-credit-hrid="${creditHrid}"]`);
            }

            test('only a token-path colour is offered the exchange', () => {
                const modal = openModal();
                setTarget(modal, FORCE, 3);
                setTarget(modal, TEMPO, 1);

                expect(convertNote(modal, BLUE).textContent).toBe('or convert 2 tokens');
                // Gold credits are bought, so the row above is the whole story
                expect(convertNote(modal, GOLD)).toBeNull();
            });

            test('a standard rate drops the ≈ and says it is the standard rate', () => {
                const modal = openModal();
                setTarget(modal, TEMPO, 1);
                const note = convertNote(modal, BLUE);

                expect(note.textContent).not.toContain('≈');
                expect(note.title).toContain('Standard exchange rate');
                expect(note.title).not.toContain('Approximate');
            });

            test('a captured rate keeps the ≈ and its provenance', () => {
                game.rates[BLUE] = {
                    creditItemHrid: BLUE,
                    creditsPerToken: 10,
                    tokensPerExchange: 1,
                    creditsPerExchange: 10,
                    via: 'tiles',
                    capturedAt: 0,
                };
                const modal = openModal();
                setTarget(modal, TEMPO, 1);
                const note = convertNote(modal, BLUE);

                expect(note.textContent).toBe('or convert ≈2 tokens');
                expect(note.title).toContain('Approximate');
                expect(note.title).toContain('item tiles');
                expect(note.title).toContain('capture time unknown');
            });
        });
    });
});
