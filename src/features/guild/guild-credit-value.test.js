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
vi.mock('./guild-token-exchange-capture.js', () => ({
    captureTokenExchangeFromModal: (...args) => game.captures.push(args),
    hydrateCapturedTokenExchanges: async () => ({}),
    capturedTokenExchanges: () => [],
}));

const creditValueModule = await import('./guild-credit-value.js');
const guildCreditValue = creditValueModule.default;
const { shrinePlanRecord, greedyAffordable } = creditValueModule;
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
                '/items/guild_token': { name: 'Guild Token', guildCreditConversions: [] },
                '/items/bronze_bar': {
                    name: 'Bronze Bar',
                    guildCreditConversions: [
                        { creditItemHrid: '/items/guild_credit_1', itemCount: 10, creditCount: 1 },
                    ],
                },
            },
            guildBuffDetailMap: {
                [FORCE]: {
                    shrineHrid: '/guild_shrines/force',
                    isCombat: true,
                    levelCosts: costs(10, {
                        3: { guildTokenCost: 300, creditCosts: [{ itemHrid: '/items/guild_credit_1', count: 50 }] },
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
        game.prices = { '/items/bronze_bar': { ask: 100, bid: 90 } };
        // Force and Tempo shrines have room; Rarity's cap equals its current
        // buff level, so that buff has no next level to suggest.
        game.buildingLevels = {
            '/guild_shrines/force': 10,
            '/guild_shrines/tempo': 10,
            '/guild_shrines/rarity': 5,
        };
        game.buffLevels = { [FORCE]: 2, [TEMPO]: 0, [RARITY]: 5 };
        game.inventory = [];
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

    test('a suggested buy shows its credit cost beside the token cost', () => {
        const modal = openModal();
        const forceRow = nextBuyRows(modal).find((r) => r.textContent.includes('Force'));
        expect(forceRow.textContent.replace(/\s+/g, ' ')).toContain('50 Trade Credit');
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

        expect(modal.querySelector('.mwi-shrine-spend-all').textContent).toBe(
            'Spending everything now: 2 of 2 next levels for 400 tokens'
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
        expect(totals).toContain('Total upgrade cost');
        expect(totals).toContain('300');
    });
});
