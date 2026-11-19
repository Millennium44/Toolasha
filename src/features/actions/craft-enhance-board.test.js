/** @vitest-environment happy-dom */

/**
 * The Craft & Enhance window, drawn.
 *
 * The ranking is mocked (`craft-enhance.test.js` and `craft-enhance-rank.test.js` own the arithmetic) and
 * the panel shell is a plain container. What this proves is the wiring: the button lands only on gear
 * skill pages, no section "could not be drawn", every column draws for priced, unpriced, sunk and
 * volume-unknown rows, a missing figure reads "—" and never 0, the controls change the ranking's inputs,
 * volume is requested only for rows on screen, and an Iron Cow character gets nothing.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetSpriteSheetCache } from '../../utils/overlay-format.js';

const state = vi.hoisted(() => ({
    rows: [],
    rankCalls: [],
    cleared: 0,
    settings: { actions_craftEnhance: true },
    setCalls: [],
    ironCow: false,
    volume: {},
    volumeCalls: [],
    panel: null,
    destroyed: 0,
    stamp: 1,
    gear: 'a',
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => state.settings[key],
        getSettingValue: (key, fallback) => (key in state.settings ? state.settings[key] : fallback),
        setSettingValue: (key, value) => {
            state.setCalls.push([key, value]);
            state.settings[key] = value;
        },
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../utils/simple-panel.js', () => ({
    createPanel: ({ draw }) => {
        const panel = document.createElement('div');
        const body = document.createElement('div');
        panel.appendChild(body);
        const api = {
            render: () => {
                body.replaceChildren();
                try {
                    draw(body);
                } catch (error) {
                    const failed = document.createElement('div');
                    failed.textContent = `This could not be drawn: ${error.message}`;
                    body.appendChild(failed);
                }
            },
            show: () => {
                if (!panel.isConnected) document.body.appendChild(panel);
                api.render();
            },
            destroy: () => {
                state.destroyed++;
                panel.remove();
            },
            get panel() {
                return panel;
            },
        };
        state.panel = api;
        return api;
    },
}));
vi.mock('../../utils/item-navigation.js', () => ({
    navigateToAction: vi.fn(() => true),
    navigateToItem: vi.fn(() => true),
}));
vi.mock('../../utils/liquidity-cap.js', () => ({
    itemDailyVolume: async (itemHrid, level) => {
        state.volumeCalls.push(`${itemHrid}:${level}`);
        return state.volume[itemHrid] ?? { itemHrid, unitsPerDay: 0, days: 0, known: false };
    },
}));
vi.mock('./production-arbitrage.js', () => ({
    PRODUCTION_SKILLS: [
        { skillHrid: '/skills/cheesesmithing', label: 'Cheesesmithing' },
        { skillHrid: '/skills/crafting', label: 'Crafting' },
        { skillHrid: '/skills/tailoring', label: 'Tailoring' },
        { skillHrid: '/skills/cooking', label: 'Cooking' },
    ],
}));
vi.mock('./craft-enhance.js', () => ({
    CRAFT_ENHANCE_SETTING: 'actions_craftEnhance',
    TARGET_LEVEL_SETTING: 'actions_craftEnhance_targetLevel',
    OWNED_MODE_SETTING: 'actions_craftEnhance_ownedDrops',
    clearCraftEnhanceCache: () => {
        state.cleared++;
    },
    craftEnhanceAvailable: () => !state.ironCow,
    craftEnhanceStateKey: () =>
        [
            state.stamp,
            state.gear,
            state.settings.actions_craftEnhance_targetLevel,
            state.settings.actions_craftEnhance_ownedDrops,
        ].join('|'),
    rankCraftEnhance: async (options) => {
        state.rankCalls.push({ targetLevel: options.targetLevel, ownedMode: options.ownedMode });
        options.onProgress?.(state.rows.length, state.rows.length, state.rows);
        return state.rows;
    },
}));

const { default: board, OPEN_BUTTON_CLASS } = await import('./craft-enhance-board.js');

const level = (over = {}) => ({
    level: 5,
    status: 'ok',
    reasons: [],
    unpricedInputs: [],
    craftCostPerUnit: 1970,
    enhanceCost: 1500,
    saleAfterTax: 8640,
    profitPerUnit: 5170,
    unitsPerHour: 37.5,
    profitPerHour: 193875,
    craftXpPerHour: 3750,
    enhanceXpPerHour: 15000,
    ...over,
});

const unpricedLevel = (reasons, over = {}) =>
    level({
        status: 'unpriced',
        reasons,
        profitPerUnit: null,
        unitsPerHour: null,
        profitPerHour: null,
        craftXpPerHour: null,
        enhanceXpPerHour: null,
        ...over,
    });

function row(name, over = {}) {
    return {
        itemHrid: `/items/${name}`,
        itemName: name,
        actionHrid: `/actions/cheesesmithing/${name}`,
        actionName: name,
        skillHrid: '/skills/cheesesmithing',
        skillLabel: 'Cheesesmithing',
        requiredLevel: 10,
        level: 60,
        levelMet: true,
        targetLevel: 5,
        base: level({ level: 0, enhanceCost: 0, saleAfterTax: 1920, profitPerUnit: -50, profitPerHour: -5000 }),
        target: level(),
        dungeonInputs: [],
        sunkInputs: [],
        notes: [],
        volume: null,
        ...over,
    };
}

const text = () => state.panel.panel.textContent;
const flush = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
    resetSpriteSheetCache?.();
    document.body.innerHTML = '';
    state.rows = [row('sword'), row('robe', { target: unpricedLevel(['sale']), base: level({ level: 0 }) })];
    state.rankCalls = [];
    state.cleared = 0;
    state.setCalls = [];
    state.settings = { actions_craftEnhance: true };
    state.ironCow = false;
    state.volume = {};
    state.volumeCalls = [];
    state.destroyed = 0;
    state.stamp = 1;
    state.gear = 'a';
    board.disable();
    // A panel remembers its selections between openings, which is right for a panel and wrong for a test
    Object.assign(board, {
        sort: 'hour',
        descending: true,
        profitableOnly: false,
        craftableOnly: false,
        skillHrid: null,
        query: '',
        error: null,
    });
});

afterEach(() => {
    board.disable();
});

function openBoard() {
    board.initialize();
    board.open();
}

describe('the open button', () => {
    function titleWith(text) {
        const title = document.createElement('div');
        title.className = 'GatheringProductionSkillPanel_title__x';
        title.innerHTML = `<div>${text}</div>`;
        document.body.appendChild(title);
        return title;
    }

    test('lands on gear skill pages, once, and not on cooking or gathering', () => {
        board.initialize();
        for (const name of ['Cheesesmithing', 'Crafting', 'Tailoring']) {
            const title = titleWith(name);
            board.injectOpenButton(title);
            board.injectOpenButton(title);
            expect(title.querySelectorAll(`.${OPEN_BUTTON_CLASS}`)).toHaveLength(1);
        }
        for (const name of ['Cooking', 'Foraging']) {
            const title = titleWith(name);
            board.injectOpenButton(title);
            expect(title.querySelector(`.${OPEN_BUTTON_CLASS}`)).toBeNull();
        }
    });

    test('joins the mobile controls row when there is one', () => {
        board.initialize();
        const title = titleWith('Tailoring');
        const row = document.createElement('div');
        row.id = 'mwi-action-controls';
        title.prepend(row);
        board.injectOpenButton(title);
        expect(row.querySelector(`.${OPEN_BUTTON_CLASS}`)).not.toBeNull();
    });

    test('clicking it opens the window and starts the ranking at the stored target', async () => {
        board.initialize();
        const title = titleWith('Crafting');
        board.injectOpenButton(title);
        title.querySelector(`.${OPEN_BUTTON_CLASS}`).click();
        await flush();
        expect(state.rankCalls).toEqual([{ targetLevel: 5, ownedMode: 'market' }]);
        expect(text()).toContain('sword');
    });

    test('disable removes the buttons and releases the panel', () => {
        board.initialize();
        const title = titleWith('Crafting');
        board.injectOpenButton(title);
        board.disable();
        expect(title.querySelector(`.${OPEN_BUTTON_CLASS}`)).toBeNull();
        expect(state.destroyed).toBe(1);
    });
});

describe('Iron Cow and the setting', () => {
    test('an Iron Cow character gets no window and no button', () => {
        state.ironCow = true;
        board.initialize();
        expect(board.initialized).toBe(false);
        expect(board.panel).toBeNull();
        board.open();
        expect(state.rankCalls).toEqual([]);
    });

    test('the setting off leaves it idle, and turning it on starts it again', () => {
        state.settings.actions_craftEnhance = false;
        board.initialize();
        expect(board.initialized).toBe(false);
        state.settings.actions_craftEnhance = true;
        board.initialize();
        expect(board.initialized).toBe(true);
    });
});

describe('the table', () => {
    test('draws every column without a section failing, for a priced and an unpriced row', async () => {
        openBoard();
        await flush();
        expect(text()).not.toContain('could not be drawn');
        const header = [...state.panel.panel.querySelectorAll('th')].map((th) => th.textContent);
        expect(header.join('|')).toContain('Craft cost');
        expect(header.join('|')).toContain('Enhance to +5');
        expect(header.join('|')).toContain('Sale +5 (after tax)');
        expect(header.join('|')).toContain('Profit/hr +5');
        expect(header.join('|')).toContain('Profit/item +0');
        expect(header.join('|')).toContain('Craft XP/hr');
        expect(header.join('|')).toContain('Enhance XP/hr');
        expect(header.join('|')).toContain('Vol/day +5');
        expect(state.panel.panel.querySelectorAll('[data-ce-row]')).toHaveLength(2);
    });

    test('a missing figure reads "—" with a reason, never 0', async () => {
        openBoard();
        await flush();
        const robe = state.panel.panel.querySelector('[data-ce-row$="/robe"]');
        const missing = robe.querySelectorAll('[data-ce-missing]');
        expect(missing.length).toBeGreaterThan(0);
        for (const cell of missing) expect(cell.textContent).toBe('—');
        expect(robe.querySelector('[data-ce-data]').getAttribute('data-ce-data')).toBe('unpriced');
        expect(robe.querySelector('[data-ce-data]').textContent).toContain('no sale quote');
        // The priced row has none
        const sword = state.panel.panel.querySelector('[data-ce-row$="/sword"]');
        expect(sword.querySelector('[data-ce-data]').getAttribute('data-ce-data')).toBe('ok');
    });

    test('every way a row can end draws: unpriced input, unpriced enhance, no rate, sunk, unmet level', async () => {
        state.rows = [
            row('a', {
                target: unpricedLevel(['input'], {
                    unpricedInputs: [{ itemHrid: '/items/griffin_leather', reason: 'input' }],
                    craftCostPerUnit: null,
                }),
                base: unpricedLevel(['input'], { craftCostPerUnit: null }),
            }),
            row('b', { target: unpricedLevel(['enhance'], { enhanceCost: null }) }),
            row('c', { target: unpricedLevel(['rate']), base: unpricedLevel(['rate']) }),
            row('d', { sunkInputs: ['/items/griffin_leather'] }),
            row('e', { levelMet: false }),
            row('f', { target: level({ craftXpPerHour: null, enhanceXpPerHour: null }) }),
        ];
        openBoard();
        await flush();
        expect(text()).not.toContain('could not be drawn');
        expect(state.panel.panel.querySelectorAll('[data-ce-row]')).toHaveLength(6);
        expect(state.panel.panel.querySelector('[data-ce-row$="/a"]').textContent).toContain('input unpriced');
        expect(state.panel.panel.querySelector('[data-ce-row$="/b"]').textContent).toContain('enhance unpriced');
        expect(state.panel.panel.querySelector('[data-ce-row$="/c"]').textContent).toContain('no output rate');
        expect(state.panel.panel.querySelector('[data-ce-row$="/e"]').textContent).toContain('✗');
    });

    test('a sunk row is badged, and the badge is not a data flag', async () => {
        state.rows = [row('d', { sunkInputs: ['/items/griffin_leather'] })];
        openBoard();
        await flush();
        const sunk = state.panel.panel.querySelector('[data-ce-sunk]');
        expect(sunk).not.toBeNull();
        expect(sunk.title).toContain('griffin leather');
        expect(state.panel.panel.querySelector('[data-ce-data]').getAttribute('data-ce-data')).toBe('ok');
    });

    test('an empty ranking says what qualifies', async () => {
        state.rows = [];
        openBoard();
        await flush();
        expect(text()).toContain('takes a dungeon drop or token-shop item');
    });

    test('a failed ranking is said, not silently empty', async () => {
        state.rows = null;
        openBoard();
        await flush();
        expect(text()).not.toContain('could not be drawn');
    });
});

describe('the controls', () => {
    test('changing the target stores it and costs again at the new level', async () => {
        openBoard();
        await flush();
        const select = state.panel.panel.querySelector('[data-ce-level]');
        expect(select.value).toBe('5');
        select.value = '7';
        select.dispatchEvent(new Event('change'));
        await flush();
        expect(state.setCalls).toContainEqual(['actions_craftEnhance_targetLevel', 7]);
        expect(state.rankCalls.at(-1)).toEqual({ targetLevel: 7, ownedMode: 'market' });
        expect(text()).toContain('Enhance to +7');
    });

    test('Sunk stores the mode and costs again', async () => {
        openBoard();
        await flush();
        state.panel.panel.querySelector('[data-ce-owned="sunk"]').click();
        await flush();
        expect(state.setCalls).toContainEqual(['actions_craftEnhance_ownedDrops', 'sunk']);
        expect(state.rankCalls.at(-1).ownedMode).toBe('sunk');
        expect(text()).toContain('counted at 0');
    });

    test('a target changed in the settings panel is picked up on the next draw', async () => {
        openBoard();
        await flush();
        state.settings.actions_craftEnhance_targetLevel = 3;
        state.panel.render();
        await flush();
        expect(state.rankCalls.at(-1).targetLevel).toBe(3);
    });

    test('three owned-drops modes, each stored and each costed again', async () => {
        openBoard();
        await flush();
        const buttons = [...state.panel.panel.querySelectorAll('[data-ce-owned]')].map((b) =>
            b.getAttribute('data-ce-owned')
        );
        expect(buttons).toEqual(['market', 'buy', 'sunk']);
        state.panel.panel.querySelector('[data-ce-owned="buy"]').click();
        await flush();
        expect(state.setCalls).toContainEqual(['actions_craftEnhance_ownedDrops', 'buy']);
        expect(state.rankCalls.at(-1).ownedMode).toBe('buy');
        expect(text()).toContain('buy price');
    });

    test('rows built on older market data are costed again on the next draw', async () => {
        openBoard();
        await flush();
        const before = state.rankCalls.length;
        state.stamp = 2;
        state.panel.render();
        await flush();
        expect(state.rankCalls.length).toBe(before + 1);
        // and not again while the stamp stands
        state.panel.render();
        await flush();
        expect(state.rankCalls.length).toBe(before + 1);
    });

    test('an input priced from an estimate is noted in the Data column without being a gap', async () => {
        state.rows = [row('est', { estimatedInputs: ['/items/cheese'] })];
        openBoard();
        await flush();
        const data = state.panel.panel.querySelector('[data-ce-data]');
        expect(data.textContent).toContain('price estimated');
        expect(data.getAttribute('data-ce-data')).toBe('estimated');
    });

    test('an unpriced drink reads as a drink, not an input', async () => {
        state.rows = [row('tea', { target: unpricedLevel(['tea'], { craftCostPerUnit: null }) })];
        openBoard();
        await flush();
        expect(state.panel.panel.querySelector('[data-ce-data]').textContent).toContain('drink unpriced');
    });

    test('Profitable only hides the unpriced row', async () => {
        openBoard();
        await flush();
        state.panel.panel.querySelector('[data-ce-profitable]').click();
        await flush();
        const rows = [...state.panel.panel.querySelectorAll('[data-ce-row]')];
        expect(rows.map((r) => r.getAttribute('data-ce-row'))).toEqual(['/actions/cheesesmithing/sword']);
    });

    test('clicking a header sorts, and again reverses', async () => {
        state.rows = [
            row('low', { target: level({ profitPerHour: 10 }) }),
            row('high', { target: level({ profitPerHour: 90 }) }),
        ];
        openBoard();
        await flush();
        const order = () =>
            [...state.panel.panel.querySelectorAll('[data-ce-row]')].map((r) =>
                r.getAttribute('data-ce-row').split('/').pop()
            );
        expect(order()).toEqual(['high', 'low']);
        state.panel.panel.querySelector('[data-ce-sort="hour"]').click();
        await flush();
        expect(order()).toEqual(['low', 'high']);
    });

    test('Recompute clears the cache and costs again', async () => {
        openBoard();
        await flush();
        const before = state.rankCalls.length;
        state.panel.panel.querySelector('[data-ce-recompute]').click();
        await flush();
        expect(state.cleared).toBeGreaterThan(0);
        expect(state.rankCalls.length).toBe(before + 1);
    });
});

describe('volume', () => {
    test('is asked for the rows on screen at the target level, once each, and unknown reads "?"', async () => {
        state.volume = { '/items/sword': { unitsPerDay: 42, known: true } };
        openBoard();
        await flush();
        await flush();
        expect(state.volumeCalls.sort()).toEqual(['/items/robe:5', '/items/sword:5']);
        const sword = state.panel.panel.querySelector('[data-ce-row$="/sword"] [data-ce-volume]');
        const robe = state.panel.panel.querySelector('[data-ce-row$="/robe"] [data-ce-volume]');
        expect(sword.getAttribute('data-ce-volume')).toBe('known');
        expect(sword.textContent).toBe('42');
        // Not measurable is "?", apart from a measured 0
        expect(robe.getAttribute('data-ce-volume')).toBe('unknown');
        expect(robe.textContent).toBe('?');
    });

    test('a measured zero reads 0, not "?"', async () => {
        state.volume = { '/items/sword': { unitsPerDay: 0, known: true } };
        openBoard();
        await flush();
        await flush();
        const sword = state.panel.panel.querySelector('[data-ce-row$="/sword"] [data-ce-volume]');
        expect(sword.textContent).toBe('0');
        expect(sword.getAttribute('data-ce-volume')).toBe('known');
    });

    test('rows hidden by a filter are not looked up', async () => {
        board.query = 'sword';
        openBoard();
        await flush();
        await flush();
        expect(state.volumeCalls).toEqual(['/items/sword:5']);
    });

    test('is not asked again on a redraw', async () => {
        openBoard();
        await flush();
        await flush();
        const asked = state.volumeCalls.length;
        state.panel.render();
        await flush();
        expect(state.volumeCalls.length).toBe(asked);
    });
});

describe('volume lookups that outlive their run', () => {
    test('a stale lookup cannot clear the marker of a newer one for the same key', async () => {
        board.initialize();
        const first = {};
        const second = {};
        board.volumePending.set('/items/x:5', second);
        // The first lookup finished late: it does not own the marker, so it leaves it and stores nothing
        board.volumes.clear();
        await board.loadVolume('/items/x:5', '/items/x', 5, first, board.generation);
        expect(board.volumePending.get('/items/x:5')).toBe(second);
        expect(board.volumes.has('/items/x:5')).toBe(false);
    });
});

describe('rows held while the character changes', () => {
    test('changed gear, drinks, levels or pricing (anything in the state key) costs the rows again on the next draw', async () => {
        openBoard();
        await flush();
        const before = state.rankCalls.length;
        state.gear = 'b';
        state.panel.render();
        await flush();
        expect(state.rankCalls.length).toBe(before + 1);
    });
});

describe('the enhancement route', () => {
    const route = (over = {}) => ({
        route: 'refine-base',
        offered: true,
        baseHrid: '/items/sinister_ring',
        directCost: 5000,
        baseCost: 3000,
        saved: 2000,
        ...over,
    });

    test('the base route is badged and the tooltip names both runs and the saving', async () => {
        state.rows = [row('ring', { route: route(), target: level({ enhanceCost: 3000 }) })];
        openBoard();
        await flush();
        expect(text()).not.toContain('could not be drawn');
        const cells = state.panel.panel.querySelectorAll('[data-ce-row$="/ring"] td');
        const badge = state.panel.panel.querySelector('[data-ce-route="refine-base"]');
        expect(badge.textContent).toContain('via base');
        const enhanceCell = badge.parentElement;
        expect([...cells]).toContain(enhanceCell);
        expect(enhanceCell.title).toContain('Enhance the star item itself to +5: 5.0K');
        expect(enhanceCell.title).toContain('Enhance sinister ring to +5, then refine it');
        expect(enhanceCell.title).toContain('saves 2.0K');
    });

    test('with only the base route priced, the tooltip claims no saving', async () => {
        state.rows = [
            row('ring', { route: route({ directCost: null, saved: 0 }), target: level({ enhanceCost: 3000 }) }),
        ];
        openBoard();
        await flush();
        const badge = state.panel.panel.querySelector('[data-ce-route="refine-base"]');
        expect(badge.parentElement.title).toContain('Enhance the star item itself to +5: could not be priced');
        expect(badge.parentElement.title).toContain('Only the base route could be priced.');
        expect(badge.parentElement.title).not.toContain('saves');
    });

    test('a held base is badged with its level, and the tooltip says what share of the hour it serves and what it saves', async () => {
        state.rows = [
            row('ring', {
                route: route({
                    route: 'held-base',
                    heldBase: {
                        level: 3,
                        count: 2,
                        unitValue: 960,
                        via: 'sale',
                        total: 140,
                        saved: 220,
                        coverage: 0.25,
                    },
                }),
                target: level({ enhanceCost: 900 }),
            }),
        ];
        openBoard();
        await flush();
        expect(text()).not.toContain('could not be drawn');
        const badge = state.panel.panel.querySelector('[data-ce-route="held-base"]');
        expect(badge.textContent).toContain('via held +3 base');
        const title = badge.parentElement.title;
        expect(title).toContain('Starts from your held +3 sinister ring (you hold 2)');
        expect(title).toContain('counted at 960 (what it would sell for)');
        expect(title).toContain("It serves 25% of an hour's crafts");
        expect(title).toContain('220 cheaper per item');
    });

    test('a held base valued through tokens says so, not "sell for"', async () => {
        state.rows = [
            row('ring', {
                route: route({
                    route: 'held-base',
                    heldBase: { level: 0, count: 1, unitValue: 480, via: 'token', total: 10, saved: 5, coverage: 1 },
                }),
            }),
        ];
        openBoard();
        await flush();
        const title = state.panel.panel.querySelector('[data-ce-route="held-base"]').parentElement.title;
        expect(title).toContain('its value through the tokens it costs');
        expect(title).not.toContain('what it would sell for');
    });

    test('a held base chosen with nothing to compare against claims no saving', async () => {
        state.rows = [
            row('ring', {
                route: route({
                    route: 'held-base',
                    heldBase: { level: 0, count: 1, unitValue: 0, via: null, total: 10, saved: null },
                }),
            }),
        ];
        openBoard();
        await flush();
        const title = state.panel.panel.querySelector('[data-ce-route="held-base"]').parentElement.title;
        expect(title).toContain('counted at 0 (sunk)');
        expect(title).toContain("It covers a full hour's crafts.");
        expect(title).not.toContain('the rest start from a bought base');
        expect(title).toContain('nothing was compared');
        expect(title).not.toContain('cheaper per item');
    });

    test('a craft cost that rests on held units says the stock is spread over the hour', async () => {
        state.rows = [
            row('sword', {
                heldInputs: [{ itemHrid: '/items/griffin_leather', needed: 20, held: 5, bought: 15, stock: 5 }],
            }),
        ];
        openBoard();
        await flush();
        const cell = state.panel.panel.querySelector('[data-ce-row$="/sword"] td:nth-child(4)');
        expect(cell.title).toContain('griffin leather: holds 5, an hour of crafts needs 20 (15 bought)');
        expect(cell.title).toContain('spread over that hour');
    });

    test('the direct route has no badge but still explains the comparison', async () => {
        state.rows = [row('ring', { route: route({ route: 'craft', directCost: 2000, baseCost: 3000, saved: 1000 }) })];
        openBoard();
        await flush();
        expect(state.panel.panel.querySelector('[data-ce-route]')).toBeNull();
        const cell = state.panel.panel.querySelector('[data-ce-row$="/ring"] td:nth-child(5)');
        expect(cell.title).toContain('Enhancing the star item itself is cheaper');
    });

    test('a base run that could not be priced says so instead of showing a number', async () => {
        state.rows = [row('ring', { route: route({ route: 'craft', baseCost: null, saved: 0 }) })];
        openBoard();
        await flush();
        const cell = state.panel.panel.querySelector('[data-ce-row$="/ring"] td:nth-child(5)');
        expect(cell.title).toContain('could not be priced');
    });

    test('a recipe with no base route, and a row from before routes, draw as they always did', async () => {
        state.rows = [row('sword', { route: { route: 'craft', offered: false, baseHrid: null } }), row('robe')];
        openBoard();
        await flush();
        expect(text()).not.toContain('could not be drawn');
        expect(state.panel.panel.querySelector('[data-ce-route]')).toBeNull();
        expect(state.panel.panel.querySelectorAll('[data-ce-row]')).toHaveLength(2);
    });

    test('an unpriced enhancement shows "—", not a route badge', async () => {
        state.rows = [
            row('ring', {
                route: route({ route: null, directCost: null, baseCost: null, saved: 0 }),
                target: unpricedLevel(['enhance'], { enhanceCost: null }),
            }),
        ];
        openBoard();
        await flush();
        expect(state.panel.panel.querySelector('[data-ce-route]')).toBeNull();
        expect(state.panel.panel.querySelector('[data-ce-row$="/ring"] [data-ce-missing]')).not.toBeNull();
    });
});

describe('protection copies crafted at craft cost', () => {
    const run = (over = {}) => ({ selfCopyCrafts: 2.5, extraCraftSeconds: 90, ...over });

    test('the Enhance cell says how many copies are crafted, of the item or of the base', async () => {
        state.rows = [
            row('sword', { route: { route: 'craft', offered: false, enhance: run() } }),
            row('ring', {
                route: { route: 'refine-base', offered: true, baseHrid: '/items/sinister_ring', enhance: run() },
            }),
        ];
        openBoard();
        await flush();
        expect(text()).not.toContain('could not be drawn');
        const title = (name) => {
            const cells = state.panel.panel.querySelectorAll(`[data-ce-row$="/${name}"] td`);
            return cells[4].title;
        };
        expect(title('sword')).toContain('2.5 copies of sword crafted at craft cost');
        expect(title('sword')).toContain('90 s more per item');
        expect(title('ring')).toContain('2.5 copies of sinister ring crafted at craft cost');
    });

    test('a run that crafts none says nothing about it', async () => {
        state.rows = [row('sword', { route: { route: 'craft', offered: false, enhance: run({ selfCopyCrafts: 0 }) } })];
        openBoard();
        await flush();
        const cells = state.panel.panel.querySelectorAll('[data-ce-row$="/sword"] td');
        expect(cells[4].title).not.toContain('crafted at craft cost');
    });
});

describe('profit per hour held to what the market trades', () => {
    const hourCell = (name) => state.panel.panel.querySelectorAll(`[data-ce-row$="/${name}"] td`)[7];
    const zeroHourCell = (name) => state.panel.panel.querySelectorAll(`[data-ce-row$="/${name}"] td`)[9];
    const names = () =>
        [...state.panel.panel.querySelectorAll('[data-ce-row]')].map((tr) => tr.getAttribute('data-ce-row'));

    test('a known volume below the hourly output caps the figure, muted, and the tooltip gives both', async () => {
        // 24 a day is 1 an hour; 37.5 an hour could be made at 5170 each
        state.volume = { '/items/sword': { unitsPerDay: 24, known: true } };
        openBoard();
        await flush();
        await flush();
        expect(text()).not.toContain('could not be drawn');
        const capped = hourCell('sword');
        expect(capped.getAttribute('data-ce-capped')).toBe('true');
        expect(capped.textContent).toBe('5.2K');
        expect(capped.title).toContain('about 24 traded a day at +5');
        expect(capped.title).toContain('Uncapped: 193.9K an hour');
    });

    test('a measured zero caps to 0, and an unknown volume caps nothing', async () => {
        state.volume = { '/items/sword': { unitsPerDay: 0, known: true } };
        openBoard();
        await flush();
        await flush();
        expect(hourCell('sword').textContent).toBe('0');
        expect(hourCell('sword').getAttribute('data-ce-capped')).toBe('true');
        // The robe's volume was not measurable: its (unpriced) cell is unchanged, and a priced one would be too
        expect(hourCell('robe').hasAttribute('data-ce-capped')).toBe(false);
    });

    test('an unknown volume leaves a priced figure uncapped', async () => {
        state.rows = [row('sword')];
        state.volume = { '/items/sword': { unitsPerDay: 0, days: 0, known: false } };
        openBoard();
        await flush();
        await flush();
        expect(hourCell('sword').hasAttribute('data-ce-capped')).toBe(false);
        expect(hourCell('sword').textContent).toBe('193.9K');
    });

    test('before the volume arrives the figure is uncapped', async () => {
        state.rows = [row('sword')];
        openBoard();
        expect(hourCell('sword').textContent).toBe('193.9K');
        expect(hourCell('sword').hasAttribute('data-ce-capped')).toBe(false);
    });

    test('a volume above the hourly output does not cap', async () => {
        state.rows = [row('sword')];
        state.volume = { '/items/sword': { unitsPerDay: 10_000, known: true } };
        openBoard();
        await flush();
        await flush();
        expect(hourCell('sword').hasAttribute('data-ce-capped')).toBe(false);
        expect(hourCell('sword').textContent).toBe('193.9K');
    });

    test('a level that loses on every unit keeps its uncapped figure', async () => {
        state.rows = [row('sword', { target: level({ profitPerUnit: -100, profitPerHour: -3750 }) })];
        state.volume = { '/items/sword': { unitsPerDay: 0, known: true } };
        openBoard();
        await flush();
        await flush();
        expect(hourCell('sword').hasAttribute('data-ce-capped')).toBe(false);
        expect(hourCell('sword').textContent).toBe('-3.8K');
    });

    test('rows keep their uncapped order when volumes arrive', async () => {
        state.rows = [row('sword'), row('axe', { target: level({ profitPerUnit: 100, profitPerHour: 3750 }) })];
        openBoard();
        expect(names()).toEqual(['/actions/cheesesmithing/sword', '/actions/cheesesmithing/axe']);
        // Capped, the sword would earn far less than the axe
        state.volume = {
            '/items/sword': { unitsPerDay: 24, known: true },
            '/items/axe': { unitsPerDay: 1e9, known: true },
        };
        await flush();
        await flush();
        expect(names()).toEqual(['/actions/cheesesmithing/sword', '/actions/cheesesmithing/axe']);
        expect(hourCell('sword').getAttribute('data-ce-capped')).toBe('true');
    });

    test('+0 is capped only when its own volume has been measured: none is looked up for it', async () => {
        state.rows = [row('sword', { base: level({ level: 0, profitPerUnit: 400, profitPerHour: 15000 }) })];
        state.volume = { '/items/sword': { unitsPerDay: 24, known: true } };
        openBoard();
        await flush();
        await flush();
        expect(state.volumeCalls).toEqual(['/items/sword:5']);
        expect(zeroHourCell('sword').hasAttribute('data-ce-capped')).toBe(false);
        board.volumes.set('/items/sword:0', { unitsPerDay: 24, known: true });
        state.panel.render();
        expect(zeroHourCell('sword').getAttribute('data-ce-capped')).toBe('true');
        expect(zeroHourCell('sword').textContent).toBe('400');
    });
});

describe('the best level column', () => {
    const entry = (lvl, over = {}) => level({ level: lvl, route: null, ...over });
    const bestCell = (name) => state.panel.panel.querySelector(`[data-ce-row$="/${name}"] [data-ce-best]`);

    test('shows the level and its profit an hour, and the tooltip lists every level with the missing ones explained', async () => {
        const sweep = [
            entry(0, { profitPerHour: 5000 }),
            entry(1, { profitPerHour: 12000, route: 'craft' }),
            unpricedLevel(['sale'], { level: 2, route: null }),
            unpricedLevel(['enhance'], { level: 3, route: null }),
            entry(4, { profitPerHour: 9000, route: 'held-base' }),
            entry(5, { profitPerHour: 8000, route: 'refine-base' }),
        ];
        state.rows = [
            row('sword', { sweep, best: { level: 1, profitPerHour: 12000, profitPerUnit: 200, route: 'craft' } }),
        ];
        openBoard();
        await flush();
        expect(text()).not.toContain('could not be drawn');
        const cell = bestCell('sword');
        expect(cell.getAttribute('data-ce-best')).toBe('1');
        expect(cell.textContent).toBe('+1 12.0K');
        expect(cell.title).toContain('+0: 5.0K an hour');
        expect(cell.title).toContain('+1: 12.0K an hour (volume not checked yet)  ← best');
        expect(cell.title).toContain('+2: no figure (no sale quote)');
        expect(cell.title).toContain('+3: no figure (enhance unpriced)');
        expect(cell.title).toContain('+4: 9.0K an hour (via a held base) (volume not checked yet)');
        expect(cell.title).toContain('+5: 8.0K an hour (via base) (volume unknown)');
    });

    test('a row with no priced level reads "—", never 0, and says why', async () => {
        const sweep = [unpricedLevel(['input'], { level: 0 }), unpricedLevel(['input'], { level: 5 })];
        state.rows = [row('sword', { sweep, best: null })];
        openBoard();
        await flush();
        const cell = bestCell('sword');
        expect(cell.getAttribute('data-ce-best')).toBe('none');
        expect(cell.textContent).toBe('—');
        expect(cell.title).toContain('+0: no figure (input unpriced)');
    });

    test('a best level that loses money is shown as a loss, in red', async () => {
        state.rows = [
            row('sword', {
                sweep: [entry(0, { profitPerHour: -4000 })],
                best: { level: 0, profitPerHour: -4000, profitPerUnit: -40, route: null },
            }),
        ];
        openBoard();
        await flush();
        expect(bestCell('sword').textContent).toBe('+0 -4.0K');
    });

    test('a row without a sweep draws a dash and does not break the table', async () => {
        state.rows = [row('sword')];
        openBoard();
        await flush();
        expect(text()).not.toContain('could not be drawn');
        expect(bestCell('sword').textContent).toBe('—');
    });

    test('the column is not a sort key, so the ranking and volumes leave the order alone', async () => {
        openBoard();
        await flush();
        const header = [...state.panel.panel.querySelectorAll('th')].find((th) =>
            th.textContent.startsWith('Best level')
        );
        expect(header.textContent).toBe('Best level');
        expect(header.hasAttribute('data-ce-sort')).toBe(false);
    });
});

describe('the best level column and the volume cap', () => {
    const cellOf = (name, attr) => state.panel.panel.querySelector(`[data-ce-row$="/${name}"] [${attr}]`);
    const sweepRow = (bestLevel) => {
        const levels = [0, 1, 5].map((lvl) =>
            level({ level: lvl, route: null, profitPerHour: lvl === bestLevel ? 193875 : 1000 })
        );
        return row('sword', {
            sweep: levels,
            best: { level: bestLevel, profitPerHour: 193875, profitPerUnit: 5170, route: null },
        });
    };

    test('a best level of +N shows the same capped figure and note as Profit/hr +N', async () => {
        state.rows = [sweepRow(5)];
        state.volume = { '/items/sword': { unitsPerDay: 24, known: true } };
        openBoard();
        await flush();
        await flush();
        const best = cellOf('sword', 'data-ce-best');
        const hour = state.panel.panel.querySelectorAll('[data-ce-row$="/sword"] td')[7];
        expect(best.getAttribute('data-ce-capped')).toBe('true');
        expect(best.textContent).toBe('+5 5.2K');
        expect(best.textContent.split(' ')[1]).toBe(hour.textContent);
        expect(best.title).toContain('+5: 5.2K an hour, held to about 24 traded a day (uncapped 193.9K)');
    });

    test('a best level below +N stays uncapped, and the hover says why', async () => {
        state.rows = [sweepRow(1)];
        state.volume = { '/items/sword': { unitsPerDay: 0, known: true } };
        openBoard();
        await flush();
        await flush();
        const best = cellOf('sword', 'data-ce-best');
        expect(best.hasAttribute('data-ce-capped')).toBe(false);
        expect(best.textContent).toBe('+1 193.9K');
        expect(best.title).toContain('+5: 0 an hour, held to about 0 traded a day (uncapped 1.0K)');
    });

    test('an unknown or pending volume leaves a best +N uncapped', async () => {
        state.rows = [sweepRow(5)];
        openBoard();
        expect(cellOf('sword', 'data-ce-best').textContent).toBe('+5 193.9K');
        await flush();
        await flush();
        expect(cellOf('sword', 'data-ce-best').hasAttribute('data-ce-capped')).toBe(false);
    });
});

describe('the best level looks at the usual sale levels and each one volume', () => {
    const entry = (lvl, hour, over = {}) =>
        level({ level: lvl, route: null, profitPerHour: hour, profitPerUnit: hour / 37.5, ...over });
    const necklace = () =>
        row('necklace', {
            targetLevel: 5,
            target: entry(5, 628_000),
            candidateLevels: [0, 3, 5],
            sweep: [entry(0, 1000), entry(1, 463_000), entry(3, 2000), entry(4, 9000), entry(5, 628_000)],
            best: { level: 5, profitPerHour: 628_000, profitPerUnit: 1, route: null },
        });
    const bestCell = () => state.panel.panel.querySelector('[data-ce-row$="/necklace"] [data-ce-best]');

    test('volume is looked up at +0, the breakpoints and the target, and nowhere else', async () => {
        state.rows = [necklace()];
        openBoard();
        await flush();
        await flush();
        expect(state.volumeCalls.sort()).toEqual(['/items/necklace:0', '/items/necklace:3', '/items/necklace:5']);
    });

    test('a candidate nobody trades is held to 0 and the next best level is named instead of "+N 0"', async () => {
        state.rows = [necklace()];
        state.volume = { '/items/necklace': { unitsPerDay: 0, known: true } };
        openBoard();
        await flush();
        await flush();
        // Every candidate measured at 0: all held to 0, ties go to the lowest
        expect(bestCell().textContent).toBe('+0 0');
        // Only +5 untraded; the others unmeasured (uncapped): the best is the best of those, not +5 at 0
        state.volume = {};
        board.volumes.clear();
        board.volumes.set('/items/necklace:5', { unitsPerDay: 0, known: true });
        board.volumes.set('/items/necklace:0', { known: false, unitsPerDay: 0 });
        board.volumes.set('/items/necklace:3', { known: false, unitsPerDay: 0 });
        state.panel.render();
        expect(bestCell().textContent).toBe('+3 2.0K');
    });

    test('an unchecked volume is uncapped and says so; the cell redraws as each volume lands', async () => {
        state.rows = [necklace()];
        openBoard();
        expect(bestCell().getAttribute('data-ce-volume')).toBe('pending');
        expect(bestCell().title).toContain('(volume not checked yet)');
        state.volume = { '/items/necklace': { unitsPerDay: 24, known: true } };
        await flush();
        await flush();
        expect(bestCell().getAttribute('data-ce-capped')).toBe('true');
        expect(bestCell().title).toContain('held to about 24 traded a day');
        expect(bestCell().title).not.toContain('+1:');
    });

    test('row order still uses the uncapped +N figure', async () => {
        state.rows = [necklace(), row('sword')];
        state.volume = { '/items/necklace': { unitsPerDay: 0, known: true } };
        openBoard();
        await flush();
        await flush();
        const names = [...state.panel.panel.querySelectorAll('[data-ce-row]')].map((tr) =>
            tr.getAttribute('data-ce-row')
        );
        // Held to 0 in Best, the necklace still ranks on its uncapped +5 figure
        expect(names[0]).toContain('necklace');
    });
});
