/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    enabled: true,
    lines: {},
    side: 'ask',
    items: {},
    handlers: [],
    unregistered: 0,
    ready: [],
    settingListeners: [],
    marketListeners: [],
    marketOff: [],
    loadedListeners: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => mocks.enabled,
        onSettingsLoaded: (cb) => {
            mocks.loadedListeners.push(cb);
            return () => {
                mocks.unregistered++;
            };
        },
        onSettingChange: (key, cb) => {
            mocks.settingListeners.push([key, cb]);
            return () => {
                mocks.unregistered++;
            };
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => ({ itemDetailMap: mocks.items }) },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, className, cb) => {
            mocks.handlers.push([name, className, cb]);
            return () => {
                mocks.unregistered++;
            };
        },
        onReady: (name, cb) => {
            mocks.ready.push([name, cb]);
            return () => {
                mocks.unregistered++;
            };
        },
    },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: {
        on: (cb) => mocks.marketListeners.push(cb),
        off: (cb) => mocks.marketOff.push(cb),
    },
}));
vi.mock('../../utils/formatters.js', () => ({ formatKMB: (value) => String(Math.round(value)) }));
vi.mock('../../utils/patient-tick.js', () => ({
    PATIENT_TICK_SETTING_KEYS: ['profitCalc_patientTickBuy', 'profitCalc_patientTickSell'],
}));
vi.mock('../../utils/token-valuation.js', () => ({
    DUNGEON_TOKEN_HRIDS: new Set(['/items/chimerical_token', '/items/sinister_token']),
}));
// The numbers have their own suite; here the lines are handed in, and "best" is the rule that suite pins
vi.mock('./shop-token-values-logic.js', () => ({
    LABYRINTH_TOKEN_HRID: '/items/labyrinth_token',
    badgeSide: () => mocks.side,
    badgedCurrencies: () => ['/items/chimerical_token', '/items/sinister_token', '/items/labyrinth_token'],
    shopLineValues: (currencyHrid) => mocks.lines[currencyHrid] || [],
    bestLine: (lines) => {
        const priced = lines.filter((entry) => !entry.assumed && entry.perToken > 0);
        const top = priced.reduce((best, entry) => (!best || entry.perToken > best.perToken ? entry : best), null);
        return top ? { itemHrid: top.itemHrid, cost: top.cost } : null;
    },
}));

const { ShopTokenValues } = await import('./shop-token-values.js');

const CHIM = '/items/chimerical_token';
const LAB = '/items/labyrinth_token';

const line = (itemHrid, cost, perToken, extra = {}) => ({
    itemHrid,
    cost,
    outputCount: 1,
    perToken,
    assumed: false,
    assumedValue: 0,
    partial: false,
    ...extra,
});

const icon = (slug) => `<svg><use xlink:href="/static/items.svg#${slug}"></use></svg>`;

/** A Dungeon tile; the name is in whatever language the player runs the game in */
const dungeonTile = (slug, currencySlug, count, name = slug) =>
    `<div class="ShopPanel_shopItem__x"><div class="ShopPanel_name__x">${name}</div>
        <div class="ShopPanel_itemContainer__x">${icon(slug)}</div>
        <div class="ShopPanel_costs__x"><div>${icon(currencySlug)}<span>${count}</span></div></div></div>`;

const labyrinthTile = (slug) =>
    `<div class="LabyrinthPanel_item__x"><div class="LabyrinthPanel_itemName__x">${slug}</div>${icon(slug)}<div class="LabyrinthPanel_cost__x">x</div></div>`;

const badges = () => [...document.querySelectorAll('.mwi-shop-token-value')];

let feature;

beforeEach(() => {
    document.body.innerHTML = '';
    mocks.enabled = true;
    mocks.side = 'ask';
    mocks.handlers = [];
    mocks.unregistered = 0;
    mocks.ready = [];
    mocks.settingListeners = [];
    mocks.loadedListeners = [];
    mocks.marketListeners = [];
    mocks.marketOff = [];
    mocks.items = Object.fromEntries(
        [
            'essence',
            'bulk',
            'rare',
            'chimerical_quiver',
            'chimerical_token',
            'sinister_token',
            'coin',
            'labyrinth_token',
        ].map((slug) => [`/items/${slug}`, { name: slug }])
    );
    mocks.lines = {
        [CHIM]: [
            line('/items/essence', 10, 96),
            line('/items/bulk', 1, 960),
            line('/items/chimerical_quiver', 35000, 0, { assumed: true, assumedValue: 0, partial: true }),
        ],
        '/items/sinister_token': [line('/items/essence', 10, 50)],
        [LAB]: [line('/items/essence', 4, 2400), line('/items/rare', 30, 2880), line('/items/essence', 8, 1200)],
    };
    feature = new ShopTokenValues();
});

afterEach(() => feature.disable());

describe('Dungeon shop tiles', () => {
    test('each entry shows its value per token, the best is starred, and a coin-priced tile is left alone', () => {
        document.body.innerHTML = `<div class="ShopPanel_shopItems__x">
            ${dungeonTile('essence', 'chimerical_token', '10')}
            ${dungeonTile('bulk', 'chimerical_token', '1')}
            ${dungeonTile('bulk', 'coin', '1')}
        </div>`;
        feature.isInitialized = true;
        feature.refreshAll();

        const shown = badges();
        expect(shown).toHaveLength(2);
        expect(shown[0].textContent).toBe('96/token');
        expect(shown[0].dataset.mwiBest).toBe('false');
        expect(shown[1].textContent).toBe('★ 960/token');
        expect(shown[1].dataset.mwiBest).toBe('true');
    });

    test('the item is read from the icon sprite, not the displayed name, so a translated game still matches', () => {
        document.body.innerHTML = `<div class="ShopPanel_shopItems__x">
            ${dungeonTile('essence', 'chimerical_token', '10', '精华')}
        </div>`;
        feature.isInitialized = true;
        feature.refreshAll();

        expect(badges()[0].textContent).toBe('96/token');
    });

    test('the same item sold for a different token uses that token’s line, read from the cost icon', () => {
        document.body.innerHTML = `<div class="ShopPanel_shopItems__x">
            ${dungeonTile('essence', 'sinister_token', '10')}
        </div>`;
        feature.isInitialized = true;
        feature.refreshAll();

        // The Sinister line is the only line of its token, so it is its best
        expect(badges()[0].textContent).toBe('★ 50/token');
    });

    test('an untradable cape shows its assumed value with an asterisk and is never starred', () => {
        mocks.lines[CHIM][2] = line('/items/chimerical_quiver', 35000, 900000, {
            assumed: true,
            assumedValue: 31_500_000_000,
        });
        document.body.innerHTML = `<div class="ShopPanel_shopItems__x">
            ${dungeonTile('chimerical_quiver', 'chimerical_token', '35,000')}
        </div>`;
        feature.isInitialized = true;
        feature.refreshAll();

        const [badge] = badges();
        expect(badge.textContent).toBe('900000/token*');
        expect(badge.dataset.mwiAssumed).toBe('true');
        expect(badge.dataset.mwiBest).toBe('false');
        expect(badge.title).toContain('never taxed');
    });

    test('a cape valued at nothing shows a dash and says the setting values it at nothing', () => {
        document.body.innerHTML = `<div class="ShopPanel_shopItems__x">
            ${dungeonTile('chimerical_quiver', 'chimerical_token', '35,000')}
        </div>`;
        feature.isInitialized = true;
        feature.refreshAll();

        const [badge] = badges();
        expect(badge.textContent).toBe('—/token*');
        expect(badge.title).toContain('at nothing');
    });

    test('the best is the best of the whole shop, not of the tiles on screen', () => {
        // Only the weaker tile is on the page; the stronger line still takes the star away from it
        document.body.innerHTML = `<div class="ShopPanel_shopItems__x">${dungeonTile('essence', 'chimerical_token', '10')}</div>`;
        feature.isInitialized = true;
        feature.refreshAll();

        expect(badges()[0].dataset.mwiBest).toBe('false');
    });

    test('a tile whose item the game data does not know, or with no matching line, gets no badge', () => {
        document.body.innerHTML = `<div class="ShopPanel_shopItems__x">
            ${dungeonTile('mystery', 'chimerical_token', '10')}
            ${dungeonTile('essence', 'chimerical_token', '99')}
        </div>`;
        feature.isInitialized = true;
        feature.refreshAll();

        expect(badges()).toHaveLength(0);
    });
});

describe('Labyrinth shop tiles', () => {
    test('an item offered twice is told apart by the cost on the tile, and the best line is starred', () => {
        document.body.innerHTML = `<div class="LabyrinthPanel_buyableGrid__x">
            ${labyrinthTile('rare')}
            <div class="LabyrinthPanel_item__y">${icon('essence')}<span>8</span></div>
        </div>`;
        feature.isInitialized = true;
        feature.refreshAll();

        const [rare, essence] = badges();
        expect(rare.textContent).toBe('★ 2880/token');
        expect(essence.textContent).toBe('1200/token');
        expect(essence.dataset.mwiBest).toBe('false');
    });
});

describe('Labyrinth tile selection', () => {
    test('only the tile itself is badged, never a node inside it whose class starts the same', () => {
        document.body.innerHTML = `<div class="LabyrinthPanel_buyableGrid__x">
            <div class="LabyrinthPanel_item__y">${icon('rare')}<div class="LabyrinthPanel_itemName__z">rare</div></div>
        </div>`;
        feature.isInitialized = true;
        feature.refreshAll();

        expect(badges()).toHaveLength(1);
        expect(badges()[0].parentElement.className).toBe('LabyrinthPanel_item__y');
    });
});

describe('redrawing', () => {
    test('is idempotent: a second pass updates the badge instead of adding another', () => {
        document.body.innerHTML = `<div class="ShopPanel_shopItems__x">${dungeonTile('bulk', 'chimerical_token', '1')}</div>`;
        feature.isInitialized = true;
        feature.refreshAll();
        mocks.lines[CHIM][1] = line('/items/bulk', 1, 123);
        feature.refreshAll();

        expect(badges()).toHaveLength(1);
        expect(badges()[0].textContent).toBe('★ 123/token');
    });

    test('a line that stops being priced removes its badge', () => {
        document.body.innerHTML = `<div class="ShopPanel_shopItems__x">${dungeonTile('bulk', 'chimerical_token', '1')}</div>`;
        feature.isInitialized = true;
        feature.refreshAll();
        mocks.lines[CHIM] = [];
        feature.refreshAll();

        expect(badges()).toHaveLength(0);
    });

    test('with no shop tiles on the page nothing is read', () => {
        feature.isInitialized = true;
        feature.refreshAll();
        expect(badges()).toHaveLength(0);
    });
});

describe('lifecycle', () => {
    test('does nothing while the setting is off, and starts when it is switched on', () => {
        mocks.enabled = false;
        feature.initialize();
        expect(mocks.handlers).toHaveLength(0);
        expect(feature.isInitialized).toBe(false);

        mocks.enabled = true;
        feature.initialize();
        expect(mocks.handlers.length).toBeGreaterThan(0);
        expect(feature.isInitialized).toBe(true);
    });

    test('initializing twice registers once', () => {
        feature.initialize();
        const first = mocks.handlers.length;
        feature.initialize();
        expect(mocks.handlers).toHaveLength(first);
        expect(mocks.marketListeners).toHaveLength(1);
    });

    test('disable removes every badge and every listener, cancels a pending redraw, and a later enable starts clean', () => {
        vi.useFakeTimers();
        try {
            document.body.innerHTML = `<div class="ShopPanel_shopItems__x">${dungeonTile('bulk', 'chimerical_token', '1')}</div>`;
            feature.initialize();
            const registered =
                mocks.handlers.length +
                mocks.ready.length +
                mocks.settingListeners.length +
                mocks.loadedListeners.length;
            feature.refreshAll();
            expect(badges()).toHaveLength(1);
            feature.scheduleRefresh();

            feature.disable();

            expect(badges()).toHaveLength(0);
            expect(mocks.unregistered).toBe(registered);
            expect(mocks.marketOff).toEqual(mocks.marketListeners);
            expect(feature.isInitialized).toBe(false);
            // The cancelled redraw never draws a badge back
            vi.advanceTimersByTime(5000);
            expect(badges()).toHaveLength(0);

            // A trigger arriving after disable does nothing either
            feature.scheduleRefresh();
            vi.advanceTimersByTime(5000);
            expect(badges()).toHaveLength(0);

            feature.initialize();
            expect(feature.isInitialized).toBe(true);
            expect(mocks.marketListeners).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });

    test('a price tick or a changed pricing / cape setting redraws', () => {
        vi.useFakeTimers();
        try {
            document.body.innerHTML = `<div class="ShopPanel_shopItems__x">${dungeonTile('bulk', 'chimerical_token', '1')}</div>`;
            feature.initialize();
            mocks.marketListeners[0]();
            vi.advanceTimersByTime(200);
            expect(badges()).toHaveLength(1);

            mocks.lines[CHIM][1] = line('/items/bulk', 1, 7);
            const keys = mocks.settingListeners.map(([key]) => key);
            expect(keys).toEqual(
                expect.arrayContaining([
                    'profitCalc_pricingMode',
                    'expectedValue_respectPricingMode',
                    'profitCalc_patientTickSell',
                    'untradableCapeBaseValue',
                ])
            );
            mocks.settingListeners[0][1]();
            vi.advanceTimersByTime(200);
            expect(badges()[0].textContent).toBe('7/token');

            // Each watched setting redraws, the patient sell tick included
            mocks.lines[CHIM][1] = line('/items/bulk', 1, 9);
            mocks.settingListeners.find(([key]) => key === 'profitCalc_patientTickSell')[1]();
            vi.advanceTimersByTime(200);
            expect(badges()[0].textContent).toBe('9/token');
        } finally {
            vi.useRealTimers();
        }
    });

    test('an Iron Cow valuation change or a settings load redraws', () => {
        vi.useFakeTimers();
        try {
            document.body.innerHTML = `<div class="ShopPanel_shopItems__x">${dungeonTile('bulk', 'chimerical_token', '1')}</div>`;
            feature.initialize();
            mocks.marketListeners[0]();
            vi.advanceTimersByTime(200);

            mocks.lines[CHIM][1] = line('/items/bulk', 1, 11);
            mocks.settingListeners.find(([key]) => key === 'profitCalc_ironCowValuation')[1]();
            vi.advanceTimersByTime(200);
            expect(badges()[0].textContent).toBe('11/token');

            mocks.lines[CHIM][1] = line('/items/bulk', 1, 13);
            expect(mocks.loadedListeners).toHaveLength(1);
            mocks.loadedListeners[0]();
            vi.advanceTimersByTime(200);
            expect(badges()[0].textContent).toBe('13/token');
        } finally {
            vi.useRealTimers();
        }
    });
});
