/** @vitest-environment happy-dom
 *
 * The protect-from sweep drawn into the enhancing panel.
 *
 * Mock the game, not the panel: a character, an item with one material and a protection item
 * in the slot, prices from a table. What is worth asserting is that the section draws, carries
 * a row per protect-from level for the slot item and for the cheapest alternative, marks the
 * panel's current setting, and stays collapsed until clicked.
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import * as mathjs from 'mathjs';

const state = vi.hoisted(() => ({
    settings: { enhanceSim: true, enhanceSim_autoDetect: false },
    // Rows the way `characterItems` carries them: one per stack, with its location and level
    inventory: [],
    // The character's action queue
    actions: [],
    // What a copy would sell for (the profit sell side); the buy side reads `prices`
    sellPrices: {},
    prices: {
        '/items/cheese': 500,
        '/items/mirror_of_protection': 20_000,
        '/items/cheese_sword_protector': 4_000,
        '/items/cheese_sword': 50_000,
    },
    items: {
        '/items/cheese_sword': {
            hrid: '/items/cheese_sword',
            name: 'Cheese Sword',
            itemLevel: 10,
            level: 10,
            enhancementCosts: [{ itemHrid: '/items/cheese', count: 2 }],
            protectionItemHrids: ['/items/cheese_sword_protector'],
        },
        '/items/cheese': { hrid: '/items/cheese', name: 'Cheese', sellPrice: 100 },
        '/items/mirror_of_protection': { hrid: '/items/mirror_of_protection', name: 'Mirror Of Protection' },
        '/items/cheese_sword_protector': { hrid: '/items/cheese_sword_protector', name: 'Cheese Sword Protector' },
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => Boolean(state.settings[key]),
        getSettingValue: (key, fallback) => state.settings[key] ?? fallback,
        toggleSetting: () => {},
        COLOR_XP_RATE: '#ffdd88',
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ itemDetailMap: state.items }),
        getItemDetails: (hrid) => state.items[hrid] || null,
        getActionDetails: () => ({ baseTimeCost: 12e9 }),
        getCurrentActions: () => [...state.actions],
        getPersonalBuffFlatBoost: () => 0,
        getInventory: () => [...state.inventory],
    },
}));
vi.mock('../../utils/enhancement-config.js', () => ({
    getEnhancingParams: () => ({
        enhancingLevel: 60,
        houseLevel: 0,
        toolBonus: 3,
        speedBonus: 0,
        experienceBonus: 0,
        rareFindBonus: 0,
        detectedTeaBonus: 0,
        guzzlingBonus: 1,
        teas: { blessed: false },
    }),
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { getPrice: (hrid) => ({ ask: state.prices[hrid] || -1, bid: -1 }), on: () => {} },
}));
vi.mock('../../utils/profit-helpers.js', () => ({
    resolveItemPrice: (hrid, options = {}) => {
        const table = options.side === 'sell' ? state.sellPrices : state.prices;
        return { price: table[hrid] || 0, custom: false, missing: !table[hrid] };
    },
}));
vi.mock('../../utils/tester-shop.js', () => ({
    testerShopEnabled: () => false,
    testerGearPrice: () => null,
    MIRROR_HRID: '/items/philosophers_mirror',
}));
vi.mock('../../utils/bundle-bridge.js', () => ({ missingMaterialsButton: () => null }));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));

import { displayEnhancementStats, protectSweepHTML } from './enhancement-display.js';
import { clearProtectSweepMemo } from '../../utils/enhancement-protect-sweep.js';

beforeAll(() => {
    globalThis.math = mathjs;
});

const BASE_PRICES = { ...state.prices };

beforeEach(() => {
    clearProtectSweepMemo();
    document.body.innerHTML = '';
    state.settings = { enhanceSim: true, enhanceSim_autoDetect: false };
    state.inventory = [];
    state.actions = [];
    state.sellPrices = {};
    state.prices = { ...BASE_PRICES };
});

function buildPanel({ target = 5, protectFrom = 3, protection = 'mirror_of_protection', itemName = null } = {}) {
    const panel = document.createElement('div');
    panel.innerHTML =
        (itemName
            ? `<div class="SkillActionDetail_item__2vEAz"><div class="Item_name__2C42x">${itemName}</div></div>`
            : '') +
        `<div><span>Target Level</span><input type="number" value="${target}"></div>` +
        `<div><span>Protect From Level</span><input type="number" value="${protectFrom}"></div>` +
        `<div class="protectionItemInputContainer">${
            protection ? `<svg><use href="/static/media/items_sprite.abc.svg#${protection}"></use></svg>` : ''
        }</div>`;
    document.body.appendChild(panel);
    return panel;
}

describe('protect-from sweep in the enhancing panel', () => {
    test('draws a collapsed sweep with a row per protect-from level for the slot item and the cheapest alternative', async () => {
        const panel = buildPanel();
        await displayEnhancementStats(panel, '/items/cheese_sword');

        const stats = panel.querySelector('#mwi-enhancement-stats');
        expect(stats).not.toBeNull();
        expect(stats.textContent).not.toContain('failed');

        const section = stats.querySelector('#mwi-enh-protsweep');
        expect(section).not.toBeNull();
        expect(section.style.display).toBe('none');

        const rows = Array.from(stats.querySelectorAll('.mwi-protsweep-row'));
        const none = rows.filter((row) => row.dataset.protectFrom === '0');
        const mirror = rows.filter((row) => row.dataset.item === '/items/mirror_of_protection');
        const protector = rows.filter((row) => row.dataset.item === '/items/cheese_sword_protector');
        expect(none).toHaveLength(1);
        expect(mirror.map((row) => row.dataset.protectFrom)).toEqual(['2', '3', '4', '5']);
        expect(protector.map((row) => row.dataset.protectFrom)).toEqual(['2', '3', '4', '5']);
        expect(stats.textContent).toContain('Mirror Of Protection');
        expect(stats.textContent).toContain('cheapest alternative');

        // The panel's own setting — protect from +3 with the mirror — is the marked row
        const current = rows.filter((row) => row.textContent.includes('◂'));
        expect(current).toHaveLength(1);
        expect(current[0].dataset.protectFrom).toBe('3');
        expect(current[0].dataset.item).toBe('/items/mirror_of_protection');

        // Exactly one cheapest star
        expect(rows.filter((row) => row.textContent.includes('★'))).toHaveLength(1);

        // The header toggles it open
        stats.querySelector('.mwi-enh-toggle[data-target="mwi-enh-protsweep"]').click();
        expect(section.style.display).toBe('');
    });

    test('no target level, no sweep; an empty slot prices the cheapest candidate alone', async () => {
        const noTarget = buildPanel({ target: '' });
        await displayEnhancementStats(noTarget, '/items/cheese_sword');
        expect(noTarget.querySelector('#mwi-enh-protsweep')).toBeNull();

        document.body.innerHTML = '';
        const emptySlot = buildPanel({ protectFrom: 0, protection: null });
        await displayEnhancementStats(emptySlot, '/items/cheese_sword');
        const rows = Array.from(emptySlot.querySelectorAll('.mwi-protsweep-row'));
        expect(
            rows
                .filter((row) => row.dataset.protectFrom !== '0')
                .every((row) => row.dataset.item === '/items/cheese_sword_protector')
        ).toBe(true);
        expect(emptySlot.textContent).toContain('Nothing in the protection slot');
        // No protection is the panel's setting, so the none row is the marked one
        const current = rows.filter((row) => row.textContent.includes('◂'));
        expect(current).toHaveLength(1);
        expect(current[0].dataset.protectFrom).toBe('0');
    });

    test('the spread column says it is approximate, and only the protected rows carry the mark', async () => {
        const panel = buildPanel();
        await displayEnhancementStats(panel, '/items/cheese_sword');
        const stats = panel.querySelector('#mwi-enhancement-stats');

        const header = Array.from(stats.querySelectorAll('th')).find((th) => th.textContent.includes('p10 – p90'));
        expect(header.textContent).toContain('(approx.)');
        expect(header.title).toContain('proportional to attempts');

        const rows = Array.from(stats.querySelectorAll('.mwi-protsweep-row'));
        const spreadCell = (row) => row.children[2];

        const none = rows.find((row) => row.dataset.protectFrom === '0');
        expect(spreadCell(none).textContent).not.toContain('≈');
        expect(spreadCell(none).title).toContain('Exact');

        const protectedRow = rows.find((row) => row.dataset.item === '/items/mirror_of_protection');
        expect(spreadCell(protectedRow).textContent).toContain('≈');
        expect(spreadCell(protectedRow).title).toContain('Approximate');

        expect(stats.textContent).toContain('exact on the "none" row');
    });

    test('protectSweepHTML returns nothing without an item', () => {
        expect(protectSweepHTML({ itemDetails: null, targetLevel: 5 })).toBe('');
    });
});

/** One `characterItems` row, the shape the game sends */
let nextId = 1;
function stack(itemHrid, count, { level = 0, location = '/item_locations/inventory' } = {}) {
    const id = nextId++;
    return {
        id,
        characterID: 1234,
        itemLocationHrid: location,
        itemHrid,
        enhancementLevel: level,
        count,
        offlineCount: 0,
        hash: `1234::${location}::${itemHrid}::${level}`,
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
    };
}

describe('protect-from sweep spending held protection', () => {
    const SWORD = '/items/cheese_sword';
    const PROTECTOR = '/items/cheese_sword_protector';

    const stockOn = (reserve = 2) => {
        state.settings.enhanceSim_protectFromStock = true;
        state.settings.enhanceSim_protectStockReserve = reserve;
    };
    const render = async (panelOptions) => {
        document.body.innerHTML = '';
        const panel = buildPanel(panelOptions);
        await displayEnhancementStats(panel, SWORD);
        return panel.querySelector('#mwi-enhancement-stats');
    };
    const groupHeader = (stats, name) =>
        Array.from(stats.querySelectorAll('#mwi-protsweep-table td[colspan]')).find((td) =>
            td.textContent.startsWith(name)
        );
    const rowsFor = (stats, hrid) =>
        Array.from(stats.querySelectorAll('.mwi-protsweep-row')).filter((row) => row.dataset.item === hrid);

    test('held 3 with keep 2: one from stock, the rest bought, and held items get their own column', async () => {
        stockOn(2);
        state.sellPrices = { [SWORD]: 45_000, [PROTECTOR]: 3_000 };
        state.inventory = [
            // Four at +0 in the bag, one of them the copy on the bench
            stack(SWORD, 4),
            // An equipped copy and an enhanced one are not protection stock
            stack(SWORD, 1, { location: '/item_locations/main_hand' }),
            stack(SWORD, 1, { level: 2 }),
            stack(PROTECTOR, 3),
        ];
        const stats = await render();
        expect(stats.textContent).not.toContain('failed');

        // The cheapest alternative draws on its one spare copy
        const protectorHeader = groupHeader(stats, 'Cheese Sword Protector');
        expect(protectorHeader.textContent).toContain('cheapest alternative');
        expect(protectorHeader.textContent).toContain('3 held, 1 spare @3.00K, then @4.00K');
        const protectorRows = rowsFor(stats, PROTECTOR);
        const split = protectorRows.find((row) => row.querySelector('.mwi-protsweep-stock'));
        // One spare copy is spent only in the runs that need a protection at all: under one
        expect(split.querySelector('.mwi-protsweep-stock').textContent).toMatch(
            /^0\.\d\d from stock \+ \d[\d,]*\.\d\d to buy$/
        );

        // The item itself is held beyond the reserve once the bench copy is set aside: 4 − 1 = 3
        const swordHeader = groupHeader(stats, 'Cheese Sword (');
        expect(swordHeader.textContent).toContain('(held, 3 held, 1 spare @45.00K, then @50.00K)');
        expect(rowsFor(stats, SWORD).map((row) => row.dataset.protectFrom)).toEqual(['2', '3', '4', '5']);
        expect(stats.textContent).toContain('beyond 2 of each are used first');
    });

    test('an enhanced copy on the bench is not one of the +0 spares', async () => {
        stockOn(2);
        state.sellPrices = { [SWORD]: 45_000 };
        state.inventory = [stack(SWORD, 4), stack(SWORD, 1, { level: 3 })];
        const stats = await render({ itemName: 'Cheese Sword +3' });
        expect(groupHeader(stats, 'Cheese Sword (').textContent).toContain('4 held, 2 spare');
    });

    test('an enhance running on another item does not hide the +0 bench copy of this one', async () => {
        stockOn(2);
        state.sellPrices = { [SWORD]: 45_000 };
        state.inventory = [stack(SWORD, 4)];
        // Enhancing some other item at +7 while the Enhance tab prepares a +0 Cheese Sword
        state.actions = [
            {
                id: 1,
                actionHrid: '/actions/enhancing/enhance',
                primaryItemHash: '1234::/item_locations/inventory::/items/cheese_spear::7',
                isDone: false,
                ordinal: 1,
            },
        ];
        const stats = await render({ itemName: 'Cheese Sword' });
        // 4 held, one of them on the bench: 3, of which 1 is spare above the keep-2
        expect(groupHeader(stats, 'Cheese Sword (').textContent).toContain('3 held, 1 spare');

        // The same action on this very item is the bench copy's level, and an enhanced copy is
        // not among the +0 ones
        state.actions = [
            { ...state.actions[0], primaryItemHash: '1234::/item_locations/inventory::/items/cheese_sword::7' },
        ];
        clearProtectSweepMemo();
        const own = await render({ itemName: 'Cheese Sword' });
        expect(groupHeader(own, 'Cheese Sword (').textContent).toContain('4 held, 2 spare');
    });

    test('reserve 0 spends every spare copy', async () => {
        stockOn(0);
        state.sellPrices = { [PROTECTOR]: 3_000 };
        state.inventory = [stack(PROTECTOR, 3)];
        const stats = await render();
        expect(groupHeader(stats, 'Cheese Sword Protector').textContent).toContain('3 held, 3 spare');
    });

    test('no spare stock, or the setting off, leaves the table exactly as it was', async () => {
        const baseline = (await render()).querySelector('#mwi-protsweep-table').innerHTML;

        state.inventory = [stack(PROTECTOR, 2), stack(SWORD, 3)];
        state.sellPrices = { [PROTECTOR]: 3_000, [SWORD]: 45_000 };
        const off = (await render()).querySelector('#mwi-protsweep-table').innerHTML;
        expect(off).toBe(baseline);

        // On, but everything held is within the reserve (the bench copy takes the sword to 2)
        stockOn(2);
        clearProtectSweepMemo();
        const within = await render();
        expect(within.querySelector('#mwi-protsweep-table').innerHTML).toBe(baseline);
        expect(within.querySelector('.mwi-protsweep-stock')).toBeNull();
    });

    test('the cheapest star weighs held stock with everything else', async () => {
        stockOn(2);
        // Copies that would fetch almost nothing are almost free to spend
        state.sellPrices = { [SWORD]: 1 };
        state.inventory = [stack(SWORD, 40)];
        const stats = await render();
        const starred = Array.from(stats.querySelectorAll('.mwi-protsweep-row')).filter((row) =>
            row.textContent.includes('★')
        );
        expect(starred).toHaveLength(1);
        expect(starred[0].dataset.item).toBe(SWORD);
    });

    test('a copy bought or sold redraws the rows rather than serving the remembered sweep', async () => {
        stockOn(2);
        state.sellPrices = { [PROTECTOR]: 3_000 };
        state.inventory = [stack(PROTECTOR, 3)];
        const before = await render();
        expect(groupHeader(before, 'Cheese Sword Protector').textContent).toContain('1 spare');
        // Protect from +2: the row that spends the most protections, so every spare copy counts
        const beforeRow = rowsFor(before, PROTECTOR)[0];
        const fromStock = (row) => parseFloat(row.querySelector('.mwi-protsweep-stock').textContent);
        expect(fromStock(beforeRow)).toBeGreaterThan(0);
        expect(fromStock(beforeRow)).toBeLessThan(1);
        const beforeCost = beforeRow.children[1].textContent;

        state.inventory = [stack(PROTECTOR, 6)];
        const after = await render();
        expect(groupHeader(after, 'Cheese Sword Protector').textContent).toContain('4 spare');
        const afterRow = rowsFor(after, PROTECTOR)[0];
        expect(fromStock(afterRow)).toBeGreaterThan(fromStock(beforeRow));
        expect(fromStock(afterRow)).toBeLessThan(4);
        expect(afterRow.children[1].textContent).not.toBe(beforeCost);
    });
});

describe("Philosopher's Mirror beside the protect-from sweep", () => {
    test('the mirror route is summarized whatever the slot holds, and the costs table keeps its columns', async () => {
        state.prices['/items/philosophers_mirror'] = 1;
        const panel = buildPanel({ protection: 'mirror_of_protection' });
        await displayEnhancementStats(panel, '/items/cheese_sword');
        const stats = panel.querySelector('#mwi-enhancement-stats');
        const line = stats.querySelector('.mwi-protsweep-mirror');
        expect(line).not.toBeNull();
        expect(line.textContent).toMatch(/use mirrors starting at \+\d+ — saves [\d.,]+[KMB]? to \+20/);
        // Visible with the sweep collapsed: it sits beside the toggle, not inside it
        expect(stats.querySelector('#mwi-enh-protsweep').contains(line)).toBe(false);
        // A non-mirror slot still draws today's costs table: no Mirror Cost column, no banner
        expect(stats.textContent).not.toContain('Mirror Cost');
        expect(stats.textContent).not.toContain("Philosopher's Mirror Strategy");
    });

    test('an unpriced mirror is no quote, not a saving', async () => {
        const panel = buildPanel({ protection: 'mirror_of_protection' });
        await displayEnhancementStats(panel, '/items/cheese_sword');
        expect(panel.querySelector('.mwi-protsweep-mirror').textContent).toContain('no quote');
    });

    test('with the mirror in the slot the banner and column stay, and the line agrees with the banner', async () => {
        state.prices['/items/philosophers_mirror'] = 1;
        const panel = buildPanel({ protection: 'philosophers_mirror' });
        await displayEnhancementStats(panel, '/items/cheese_sword');
        const stats = panel.querySelector('#mwi-enhancement-stats');
        expect(stats.textContent).toContain('Mirror Cost');
        expect(stats.textContent).toContain("Philosopher's Mirror Strategy");
        const bannerStart = stats.textContent.match(/Use mirrors starting at \+(\d+)/)[1];
        const lineStart = stats.querySelector('.mwi-protsweep-mirror').textContent.match(/starting at \+(\d+)/)[1];
        expect(lineStart).toBe(bannerStart);
    });
});
