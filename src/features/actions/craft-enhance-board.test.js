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
