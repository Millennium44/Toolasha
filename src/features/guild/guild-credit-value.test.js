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

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    settings: {},
    clientData: null,
    prices: {},
    observers: {},
    buildingLevels: {},
    captures: [],
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key, fallback) => (key in game.settings ? game.settings[key] : fallback) },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.clientData,
        getInventory: () => [],
        getGuildBuildingLevel: (hrid) => game.buildingLevels[hrid] ?? 0,
        getCharacterGuildBuffLevel: () => 0,
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

const guildCreditValue = (await import('./guild-credit-value.js')).default;
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

    test('the top of the ladder is tier 21, at level 300', () => {
        // Tiers start at 100 and step 10 to a maximum level of 300, which is 21
        // tiers — the same ladder `guild-trials-math.js` encodes, and not the 20
        // this badge used to cap at
        expect(buildAndReadTier('Lv.300')).toBe('T21');
        expect(buildAndReadTier('Lv.500')).toBe('T21');

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
            expect(el.querySelector('.mwi-trial-tier').textContent).toBe(`T${tier}`);
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
            selectedItemName: 'Guild Token',
            tokenName: 'Guild Token',
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
