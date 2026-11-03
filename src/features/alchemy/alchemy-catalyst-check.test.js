/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
    answers: new Map(),
    settings: {},
    settingHandlers: new Map(),
    setSetting: vi.fn(),
    inventory: [],
    actions: [],
    charId: 'char-1',
    categories: {},
    protectedList: null,
    evReady: true,
    evInit: vi.fn(),
    observerReady: [],
}));

const calculator = vi.hoisted(() => {
    const answer = (action, choice, item) => {
        const value = state.answers.get(`${action}:${choice}:${item}`);
        if (value instanceof Error) throw value;
        return value ?? null;
    };
    return {
        calculateCoinifyProfit: vi.fn((item, _enh, _live, _a, _b, choice) => answer('coinify', choice, item)),
        calculateDecomposeProfit: vi.fn((item, _enh, _live, _a, _b, choice) => answer('decompose', choice, item)),
        calculateTransmuteProfit: vi.fn((item, _live, _tea, choice) => answer('transmute', choice, item)),
    };
});

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => state.settings[key] ?? false,
        getSettingValue: (_key, fallback) => fallback,
        setSetting: (key, value) => {
            state.setSetting(key, value);
            state.settings[key] = value;
            for (const handler of state.settingHandlers.get(key) || []) handler(value);
        },
        onSettingChange: (key, handler) => {
            const handlers = state.settingHandlers.get(key) || new Set();
            handlers.add(handler);
            state.settingHandlers.set(key, handlers);
            return () => handlers.delete(handler);
        },
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: { getJSON: async () => state.protectedList, setJSON: async () => {} },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
        onReady: (_name, callback) => {
            callback();
            return () => {};
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: () => {},
        off: () => {},
        getCurrentCharacterId: () => state.charId,
        getInventory: () => state.inventory,
        getCurrentActions: () => state.actions,
        getInitClientData: () => null,
        getItemDetails: (hrid) => ({
            name: hrid.split('/').pop().replace(/_/g, ' '),
            categoryHrid: state.categories[hrid] || '/item_categories/resource',
        }),
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { priceVersion: 0, on: () => {}, off: () => {} } }));
vi.mock('../market/expected-value-calculator.js', () => ({
    default: {
        get isInitialized() {
            return state.evReady;
        },
        initialize: () => state.evInit(),
    },
}));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: calculator }));
vi.mock('../actions/action-panel-sort.js', () => ({
    default: { isPinned: () => false, togglePin: async () => {} },
}));

const { default: check, judgeCatalystPress, readSlottedCatalyst } = await import('./alchemy-catalyst-check.js');
const { default: protection } = await import('./alchemy-action-protection.js');
const { settingsGroups } = await import('../../core/settings-schema.js');
const { SETTING_PRESETS, resolvePresetValues } = await import('../settings/setting-presets.js');
const { conservativeOverrides } = await import('../settings/whats-new-core.js');

const CAT = '/items/catalyst_of_coinification';
const DECOMPOSE_CAT = '/items/catalyst_of_decomposition';
const PRIME = '/items/prime_catalyst';
const CHEESE = '/items/holy_cheese';
const SWISS = '/items/swiss_cheese';

const profit = (profitPerHour, extra = {}) => ({ profitPerHour, profitPerAction: profitPerHour / 1000, ...extra });
const option = (hrid, profitPerHour) => ({ key: hrid || 'none', hrid, profitPerHour });
const priced = (options) => ({ options, skipped: [], missingOutput: false, missingTea: false });

function setAnswers(action, item, byChoice) {
    for (const [choice, data] of Object.entries(byChoice)) state.answers.set(`${action}:${choice}:${item}`, data);
}

/** Best is the type catalyst by a mile; prime second; nothing last */
const clearWinner = (action = 'coinify', item = CHEESE) =>
    setAnswers(action, item, {
        none: profit(1_000_000),
        typeSpecific: profit(1_500_000),
        prime: profit(1_200_000),
    });

/** A sprite the way the game draws most item icons: on `xlink:href` alone */
const sprite = (hrid) => `<svg><use xlink:href="/items_sprite.svg#${hrid.replace('/items/', '')}"></use></svg>`;

function slotHtml(catalyst) {
    if (catalyst) {
        return `<div class="ItemSelector_itemSelector__2eTV6"><div class="Item_itemContainer__x">${sprite(catalyst)}</div></div>`;
    }
    return '<div class="ItemSelector_emptySlot__1ns6h"><div class="ItemSelector_label__22ds9">Consumed Item</div></div>';
}

function requirementHtml(item, level) {
    const badge = level ? `<div class="Item_enhancementLevel__x">+${level}</div>` : '';
    return `<div class="Item_itemContainer__x"><svg><use href="/items_sprite.svg#${item.replace('/items/', '')}"></use></svg>${badge}</div>`;
}

/** The game's alchemy panel, in the shapes the rest of the suite and the live selectors use */
function mountPanel({ tab = 'Coinify', item = CHEESE, level = 0, catalyst = null } = {}) {
    document.body.innerHTML = `
        <div id="game-root">
            <div class="AlchemyPanel_tabsComponentContainer__x">
                <div role="tablist">
                    ${['Coinify', 'Decompose', 'Transmute', 'Unrefine', 'Current Action']
                        .map((name) => `<div role="tab" aria-selected="${name === tab}">${name}</div>`)
                        .join('')}
                </div>
            </div>
            <div class="SkillActionDetail_skillActionDetail__1jHU4">
                <div class="SkillActionDetail_alchemyComponent__1J55d">
                    <div class="SkillActionDetail_primaryItemSelectorContainer__nrvNW"></div>
                    <div class="SkillActionDetail_catalystItemInputContainer__5zmou">${slotHtml(catalyst)}</div>
                    <div class="SkillActionDetail_itemRequirements__3SPnA">${requirementHtml(item, level)}</div>
                    <div class="SkillActionDetail_buttonsContainer__sbg-V">
                        <button class="Button_button__1Fe9z Button_success__6d6kU" id="start">Start Now</button>
                        <button class="Button_button__1Fe9z" id="queue">Add to Queue</button>
                    </div>
                </div>
            </div>
            <button id="elsewhere">Something else</button>
        </div>`;
    game.mockClear();
    document.getElementById('game-root').addEventListener('click', (event) => {
        // React's root hears every click; only these are the game's own buttons
        if (event.target.closest('#start, #queue, #elsewhere')) game();
    });
}

/** What the game hears: only presses of its own buttons that nothing stopped on the way down */
const game = vi.fn();
const start = () => document.getElementById('start');
const queue = () => document.getElementById('queue');
const press = (button = start()) => button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const message = () => document.querySelector('.mwi-alchemy-catalyst-check');
const controlNamed = (name) => [...message().querySelectorAll('button')].find((b) => b.textContent === name);
const setSlot = (catalyst) => {
    document.querySelector('[class*="catalystItemInputContainer"]').innerHTML = slotHtml(catalyst);
};
const selectTab = (name) => {
    for (const tab of document.querySelectorAll('[role="tab"]')) {
        tab.setAttribute('aria-selected', String(tab.textContent === name));
    }
};
/** Let a held press settle into a decision, past the same-gesture window */
const pause = () => vi.advanceTimersByTimeAsync(400);
/** Let mutation observers report */
const settle = () => vi.advanceTimersByTimeAsync(1);

beforeEach(async () => {
    vi.useFakeTimers();
    state.answers.clear();
    state.settings = { alchemyCatalystCheck: true, alchemy_actionProtection: false };
    state.settingHandlers.clear();
    state.setSetting.mockClear();
    state.inventory = [{ itemHrid: CAT, count: 4, itemLocationHrid: '/item_locations/inventory' }];
    state.actions = [];
    state.charId = 'char-1';
    state.categories = {};
    state.protectedList = null;
    state.evReady = true;
    state.evInit.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    clearWinner();
    mountPanel();
    check.initialize();
});

afterEach(() => {
    const failures = console.error.mock.calls.map((c) => String(c[0]));
    check.disable();
    protection.disable();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    expect(failures.filter((m) => m.includes('AlchemyCatalyst'))).toEqual([]);
});

describe('judgeCatalystPress', () => {
    const three = priced([option(null, 1_000_000), option(CAT, 1_500_000), option(PRIME, 1_200_000)]);

    test('holds with the best, the current choice and the gap', () => {
        const verdict = judgeCatalystPress(three, null);
        expect(verdict.hold).toBe(true);
        expect(verdict.best.hrid).toBe(CAT);
        expect(verdict.current.hrid).toBe(null);
        expect(verdict.gap).toBe(500_000);
    });

    test.each([
        ['no answer at all', null, null, 'notReady'],
        ['nothing priced', priced([]), null, 'notReady'],
        ['one priced option', priced([option(null, 100)]), null, 'tooFew'],
        ['a catalyst with no price', { ...three, skipped: [PRIME] }, null, 'partial'],
        ['an unpriced drop', { ...three, missingOutput: true }, null, 'partial'],
        ['an unpriced tea', { ...three, missingTea: true }, null, 'partial'],
        ['every option equal', priced([option(null, 5e5), option(CAT, 5e5), option(PRIME, 5e5)]), null, 'tie'],
        ['a tie at the top', priced([option(null, 1), option(CAT, 5e5), option(PRIME, 5e5)]), null, 'tie'],
        ['the best already slotted', three, CAT, 'alreadyBest'],
        ['a catalyst the options do not cover', three, DECOMPOSE_CAT, 'unknownCurrent'],
    ])('%s lets the press through', (_name, answer, current, reason) => {
        const verdict = judgeCatalystPress(answer, current);
        expect(verdict.hold).toBe(false);
        expect(verdict.reason).toBe(reason);
    });

    test('the margin: at least 10K an hour and at least 5% of the best figure', () => {
        const pair = (best, current) => priced([option(CAT, best), option(null, current)]);
        // 4% of a million: over the coin floor, under the share
        expect(judgeCatalystPress(pair(1_000_000, 960_000), null).reason).toBe('smallGap');
        expect(judgeCatalystPress(pair(1_000_000, 950_000), null).hold).toBe(true);
        // A huge share of very little: under the coin floor
        expect(judgeCatalystPress(pair(15_000, 6_000), null).reason).toBe('smallGap');
        expect(judgeCatalystPress(pair(15_000, 5_000), null).hold).toBe(true);
    });

    test('the margin holds on losing figures, measured against the size of the best one', () => {
        const pair = (best, current) => priced([option(null, best), option(CAT, current)]);
        expect(judgeCatalystPress(pair(-1_000_000, -1_040_000), CAT).reason).toBe('smallGap');
        expect(judgeCatalystPress(pair(-1_000_000, -1_100_000), CAT).hold).toBe(true);
        // A best near zero has a tiny 5%, so only the coin floor speaks
        expect(judgeCatalystPress(pair(1_000, -100_000), CAT).hold).toBe(true);
    });
});

describe('readSlottedCatalyst', () => {
    test('reads a sprite on xlink:href alone, and on href', () => {
        setSlot(PRIME);
        expect(readSlottedCatalyst()).toBe(PRIME);
        document.querySelector('[class*="catalystItemInputContainer"] use').removeAttribute('xlink:href');
        document
            .querySelector('[class*="catalystItemInputContainer"] use')
            .setAttribute('href', '/items_sprite.svg#catalyst_of_coinification');
        expect(readSlottedCatalyst()).toBe(CAT);
    });

    test('the dashed placeholder is an empty slot', () => {
        expect(readSlottedCatalyst()).toBeNull();
    });

    test('no slot, a tile with no sprite and an unknown shape are unreadable, not empty', () => {
        document.querySelector('[class*="catalystItemInputContainer"]').innerHTML =
            '<div class="Item_itemContainer__x"></div>';
        expect(readSlottedCatalyst()).toBeUndefined();
        document.querySelector('[class*="catalystItemInputContainer"]').innerHTML = '<div class="Whatever__x"></div>';
        expect(readSlottedCatalyst()).toBeUndefined();
        document.querySelector('[class*="catalystItemInputContainer"]').remove();
        expect(readSlottedCatalyst()).toBeUndefined();
    });

    test('tiles of a picker open inside the slot are the choices, not the choice', () => {
        const slot = document.querySelector('[class*="catalystItemInputContainer"]');
        const menu = document.createElement('div');
        menu.className = 'ItemSelector_menu__x';
        menu.innerHTML = `<div class="Item_itemContainer__x">${sprite(PRIME)}</div>`;
        slot.prepend(menu);
        expect(readSlottedCatalyst()).toBeNull();

        setSlot(CAT);
        const second = document.createElement('div');
        second.className = 'ItemSelector_menu__x';
        second.innerHTML = `<div class="Item_itemContainer__x">${sprite(PRIME)}</div>`;
        slot.prepend(second);
        expect(readSlottedCatalyst()).toBe(CAT);
    });
});

describe('holding a press', () => {
    test('the first press stops short of the game and says what is best and what the choice costs', () => {
        press();
        expect(game).not.toHaveBeenCalled();
        const text = message().textContent;
        expect(text).toContain('Best catalyst: catalyst of coinification, +1.5M/hr');
        expect(text).toContain('Your choice, no catalyst: +1.0M/hr, which is 500.0K/hr less');
        expect(text).toContain('Press again to go ahead');
        expect(text).not.toContain('You have none');
    });

    test('one more press goes ahead and clears the message', async () => {
        press();
        await pause();
        press();
        expect(game).toHaveBeenCalledTimes(1);
        expect(message()).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });

    test('the press after that is a new first press', async () => {
        press();
        await pause();
        press();
        await pause();
        press();
        expect(game).toHaveBeenCalledTimes(1);
        expect(message()).not.toBeNull();
    });

    test('the second press may be the other button: both act on the same setup', async () => {
        press(queue());
        expect(game).not.toHaveBeenCalled();
        await pause();
        press(start());
        expect(game).toHaveBeenCalledTimes(1);
    });

    test('a double-click is one gesture, not a decision', async () => {
        press();
        await vi.advanceTimersByTimeAsync(100);
        press();
        expect(game).not.toHaveBeenCalled();
        expect(message()).not.toBeNull();
        await pause();
        press();
        expect(game).toHaveBeenCalledTimes(1);
    });

    test('names a best catalyst the player does not own', async () => {
        setAnswers('coinify', CHEESE, { none: profit(1e6), typeSpecific: profit(1.1e6), prime: profit(2e6) });
        press();
        expect(message().textContent).toContain('Best catalyst: prime catalyst');
        expect(message().textContent).toContain('You have none of the best one');
    });

    test('an inventory that has not loaded says nothing about what is owned', () => {
        state.inventory = null;
        press();
        expect(message().textContent).not.toContain('You have none');
    });

    test('no catalyst being best: a slotted catalyst is what gets the press held', () => {
        setAnswers('coinify', CHEESE, { none: profit(500_000), typeSpecific: profit(-300_000), prime: profit(-9e5) });
        mountPanel({ catalyst: CAT });
        press();
        expect(message().textContent).toContain('Best catalyst: no catalyst, +500.0K/hr');
        expect(message().textContent).toContain('Your choice, catalyst of coinification: -300.0K/hr');
        expect(message().textContent).not.toContain('You have none');
    });

    test('decompose and transmute read their own figures and catalyst', () => {
        setAnswers('decompose', CHEESE, { none: profit(1e6), typeSpecific: profit(2e6), prime: profit(1.5e6) });
        mountPanel({ tab: 'Decompose', catalyst: PRIME });
        press();
        expect(message().textContent).toContain('Best catalyst: catalyst of decomposition');
        expect(message().textContent).toContain('Your choice, prime catalyst');

        setAnswers('transmute', CHEESE, { none: profit(1e6), typeSpecific: profit(1.1e6), prime: profit(3e6) });
        check.clearPending();
        mountPanel({ tab: 'Transmute', catalyst: '/items/catalyst_of_transmutation' });
        press();
        expect(message().textContent).toContain('Best catalyst: prime catalyst');
    });

    test('a nonzero enhancement level is priced at that level', () => {
        mountPanel({ level: 5 });
        press();
        expect(calculator.calculateCoinifyProfit.mock.calls.at(-1)[1]).toBe(5);
    });

    test('each press asks the calculator afresh, so changed gear or drinks are in the figure', async () => {
        press();
        await pause();
        press();
        const before = calculator.calculateCoinifyProfit.mock.calls.length;
        setAnswers('coinify', CHEESE, { none: profit(100_000), typeSpecific: profit(900_000), prime: profit(800_000) });
        await pause();
        press();
        expect(calculator.calculateCoinifyProfit.mock.calls.length).toBeGreaterThan(before);
        expect(message().textContent).toContain('+900.0K/hr');
    });

    test('never clicks, selects or starts anything: the only clicks are the two the player made', async () => {
        const seen = [];
        const spy = (event) => seen.push(event.type);
        const types = ['click', 'mousedown', 'pointerdown', 'change', 'input'];
        // Ahead of the check's own capture listener, which stops the held press
        check.disable();
        for (const type of types) document.addEventListener(type, spy, true);
        check.initialize();

        press();
        await pause();
        press();
        await vi.advanceTimersByTimeAsync(20_000);
        for (const type of types) document.removeEventListener(type, spy, true);

        expect(seen).toEqual(['click', 'click']);
        expect(game).toHaveBeenCalledTimes(1);
    });
});

describe('every press that goes straight through shows nothing', () => {
    const passes = () => {
        press();
        expect(game).toHaveBeenCalledTimes(1);
        expect(message()).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    };

    test('the best catalyst is already slotted', () => {
        mountPanel({ catalyst: CAT });
        passes();
    });

    test('the difference is below the margin', () => {
        setAnswers('coinify', CHEESE, { none: profit(1e6), typeSpecific: profit(1.03e6), prime: profit(1.01e6) });
        passes();
    });

    test('the options tie', () => {
        setAnswers('coinify', CHEESE, { none: profit(100), typeSpecific: profit(5e5), prime: profit(5e5) });
        passes();
    });

    test('every option earns the same', () => {
        setAnswers('coinify', CHEESE, { none: profit(0), typeSpecific: profit(0), prime: profit(0) });
        passes();
    });

    test('the market has not loaded: nothing is priced', () => {
        state.answers.clear();
        passes();
    });

    test('only one option can be priced', () => {
        state.answers.clear();
        setAnswers('coinify', CHEESE, { none: profit(100) });
        passes();
    });

    test('a catalyst has no price', () => {
        state.answers.clear();
        setAnswers('coinify', CHEESE, { none: profit(1e6), typeSpecific: profit(2e6) });
        passes();
    });

    test('a drop has no price', () => {
        const unpriced = { unpricedOutputs: ['/items/x'] };
        setAnswers('coinify', CHEESE, {
            none: profit(1e6, unpriced),
            typeSpecific: profit(2e6, unpriced),
            prime: profit(1.5e6, unpriced),
        });
        passes();
    });

    test('a tea has no price', () => {
        setAnswers('coinify', CHEESE, {
            none: profit(1e6, { hasMissingPrices: true }),
            typeSpecific: profit(2e6),
            prime: profit(1.5e6),
        });
        passes();
    });

    test('the calculator throws', () => {
        setAnswers('coinify', CHEESE, { prime: new Error('boom') });
        passes();
        // Reported by the shared calculation, and the press still went
        expect(console.error).toHaveBeenCalled();
        console.error.mockClear();
    });

    test('the expected-value calculator is not up: it is asked to start, for the next press', () => {
        state.evReady = false;
        passes();
        expect(state.evInit).toHaveBeenCalled();
    });

    test('no input is selected', () => {
        document.querySelector('[class*="itemRequirements"]').innerHTML = '';
        passes();
    });

    test('the catalyst slot cannot be read', () => {
        document.querySelector('[class*="catalystItemInputContainer"]').remove();
        passes();
    });

    test('a catalyst the options do not cover is slotted', () => {
        mountPanel({ catalyst: DECOMPOSE_CAT });
        passes();
    });

    test('Unrefine takes no catalyst', () => {
        mountPanel({ tab: 'Unrefine' });
        passes();
    });

    test('the Current Action tab is not an action to choose for', () => {
        mountPanel({ tab: 'Current Action' });
        passes();
    });

    test('this exact setup is already running', () => {
        state.actions = [
            {
                actionHrid: '/actions/alchemy/coinify',
                primaryItemHash: `161296::/item_locations/inventory::${CHEESE}::0`,
                secondaryItemHash: '',
                ordinal: 3,
            },
        ];
        passes();
    });

    test('a press that is not on the action buttons is none of its business', () => {
        press(document.getElementById('elsewhere'));
        expect(game).toHaveBeenCalledTimes(1);
        expect(message()).toBeNull();
    });

    test('a disabled button is left alone', () => {
        start().disabled = true;
        start().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(message()).toBeNull();
    });
});

describe('a running action that is not this setup does not excuse the press', () => {
    const coinifying = (overrides) => ({
        actionHrid: '/actions/alchemy/coinify',
        primaryItemHash: `161296::/item_locations/inventory::${CHEESE}::0`,
        secondaryItemHash: '',
        ordinal: 3,
        ...overrides,
    });

    test.each([
        ['another item', { primaryItemHash: `1::/item_locations/inventory::${SWISS}::0` }],
        ['another level of it', { primaryItemHash: `1::/item_locations/inventory::${CHEESE}::5` }],
        ['another catalyst', { secondaryItemHash: `2::/item_locations/inventory::${CAT}::0` }],
        ['another alchemy action', { actionHrid: '/actions/alchemy/decompose' }],
    ])('%s', (_name, overrides) => {
        state.actions = [coinifying(overrides)];
        press();
        expect(game).not.toHaveBeenCalled();
        expect(message()).not.toBeNull();
    });

    test('the same setup merely queued behind something else', () => {
        state.actions = [
            coinifying({ ordinal: 9 }),
            { actionHrid: '/actions/cooking/cheese', primaryItemHash: '', secondaryItemHash: '', ordinal: 1 },
        ];
        press();
        expect(game).not.toHaveBeenCalled();
    });
});

describe('a held press does not outlive what it was about', () => {
    /** The press after a change is judged on its own figures: held again here, for the new setup */
    const heldAgainFor = async (expected) => {
        await pause();
        game.mockClear();
        press();
        expect(game).not.toHaveBeenCalled();
        expect(message().textContent).toContain(expected);
    };

    test('it expires, and the next press is a first press', async () => {
        press();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(message()).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
        press();
        expect(game).not.toHaveBeenCalled();
        expect(message()).not.toBeNull();
    });

    test('picking another catalyst clears the message at once, and that one is judged in turn', async () => {
        press();
        setSlot(PRIME);
        await settle();
        expect(message()).toBeNull();
        await heldAgainFor('Your choice, prime catalyst');
    });

    test('picking the best catalyst clears it, and the press goes straight through', async () => {
        press();
        setSlot(CAT);
        await settle();
        expect(message()).toBeNull();
        press();
        expect(game).toHaveBeenCalledTimes(1);
    });

    test('a sprite swapped in place by attribute counts as a change', async () => {
        mountPanel({ catalyst: PRIME });
        press();
        document
            .querySelector('[class*="catalystItemInputContainer"] use')
            .setAttribute('xlink:href', '/items_sprite.svg#catalyst_of_coinification');
        await settle();
        expect(message()).toBeNull();
    });

    test('changing the input item clears it', async () => {
        setAnswers('coinify', SWISS, { none: profit(1e6), typeSpecific: profit(9e6), prime: profit(2e6) });
        press();
        document.querySelector('[class*="itemRequirements"]').innerHTML = requirementHtml(SWISS, 0);
        await settle();
        expect(message()).toBeNull();
        await heldAgainFor('+9.0M/hr');
    });

    test('changing the enhancement level clears it', async () => {
        press();
        document.querySelector('[class*="itemRequirements"]').innerHTML = requirementHtml(CHEESE, 5);
        await settle();
        expect(message()).toBeNull();
    });

    test('changing the action type clears it', async () => {
        setAnswers('decompose', CHEESE, { none: profit(1e6), typeSpecific: profit(7e6), prime: profit(2e6) });
        press();
        selectTab('Decompose');
        await settle();
        expect(message()).toBeNull();
        await heldAgainFor('+7.0M/hr');
    });

    test('a change the observers missed is still caught by the second press', async () => {
        press();
        await pause();
        for (const observer of check.pending.observers) observer.disconnect();
        setSlot(PRIME);
        press();
        expect(game).not.toHaveBeenCalled();
        expect(message().textContent).toContain('Your choice, prime catalyst');
    });

    test('a panel mounted again starts over, and the old press does not pass the new panel', async () => {
        press();
        await pause();
        mountPanel();
        expect(message()).toBeNull();
        press();
        expect(game).not.toHaveBeenCalled();
        expect(message()).not.toBeNull();
        await pause();
        press();
        expect(game).toHaveBeenCalledTimes(1);
    });

    test('a message React took away is no longer armed: the press is not let through unseen', async () => {
        press();
        await pause();
        message().remove();
        press();
        expect(game).not.toHaveBeenCalled();
        expect(message()).not.toBeNull();
    });

    test('a character switch: teardown clears it', async () => {
        press();
        check.disable();
        expect(message()).toBeNull();
        expect(check.pending).toBeNull();
        state.charId = 'char-2';
        check.initialize();
        await pause();
        press();
        expect(game).not.toHaveBeenCalled();
        expect(message()).not.toBeNull();
    });

    test('a character switch with no teardown yet: the identity alone disarms it', async () => {
        press();
        await pause();
        state.charId = 'char-2';
        press();
        expect(game).not.toHaveBeenCalled();
    });
});

describe('skipping', () => {
    test('Skip until reload starts nothing, clears the message, and the next presses go straight through', async () => {
        press();
        await pause();
        controlNamed('Skip until reload').click();
        expect(game).toHaveBeenCalledTimes(0);
        expect(message()).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
        expect(state.setSetting).not.toHaveBeenCalled();

        press();
        press();
        expect(game).toHaveBeenCalledTimes(2);
        expect(message()).toBeNull();
    });

    test('a skip ends with a reload or character switch, which is a teardown', async () => {
        press();
        await pause();
        controlNamed('Skip until reload').click();
        check.disable();
        check.initialize();
        press();
        expect(game).not.toHaveBeenCalled();
        expect(message()).not.toBeNull();
    });

    test('Turn this check off clears the setting and starts nothing', async () => {
        press();
        await pause();
        controlNamed('Turn this check off').click();
        expect(state.setSetting).toHaveBeenCalledWith('alchemyCatalystCheck', false);
        expect(game).toHaveBeenCalledTimes(0);
        expect(message()).toBeNull();
        press();
        expect(game).toHaveBeenCalledTimes(1);
    });

    test('the second half of a double-tap landing on a control does nothing', async () => {
        press();
        await vi.advanceTimersByTimeAsync(100);
        controlNamed('Turn this check off').click();
        expect(state.setSetting).not.toHaveBeenCalled();
        expect(message()).not.toBeNull();
    });

    test('the controls sit outside the button strip, where the protected-category guard would claim them', () => {
        press();
        expect(message().closest('[class*="SkillActionDetail_buttonsContainer"]')).toBeNull();
        expect(message().previousElementSibling.className).toContain('SkillActionDetail_buttonsContainer');
    });

    test('at phone width: real buttons that wrap, a thumb tall, with nothing behind a hover', () => {
        press();
        const controls = message().querySelector('button').parentElement;
        expect(message().style.overflowWrap).toBe('anywhere');
        expect(message().style.maxWidth).toBe('100%');
        expect(controls.style.flexWrap).toBe('wrap');
        for (const button of message().querySelectorAll('button')) {
            expect(button.type).toBe('button');
            expect(button.style.minHeight).toBe('36px');
            expect(button.textContent.length).toBeGreaterThan(0);
        }
        expect(message().title).toBe('');
        expect(message().textContent).toContain('Press again');
    });
});

describe('turning it off', () => {
    test('between the two presses: the button is not left blocked, and the message goes', async () => {
        press();
        await pause();
        state.settings.alchemyCatalystCheck = false;
        press();
        expect(game).toHaveBeenCalledTimes(1);
        expect(message()).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });

    test('the setting change alone clears a held press, without waiting for a click', () => {
        press();
        state.settings.alchemyCatalystCheck = false;
        for (const handler of state.settingHandlers.get('alchemyCatalystCheck')) handler(false);
        expect(message()).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });

    test('disable clears every listener, timer and node, and re-enable works', async () => {
        press();
        expect(message()).not.toBeNull();
        check.disable();

        expect(message()).toBeNull();
        expect(check.pending).toBeNull();
        expect(check.clickHandler).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
        expect(state.settingHandlers.get('alchemyCatalystCheck').size).toBe(0);
        press();
        expect(game).toHaveBeenCalledTimes(1);
        expect(message()).toBeNull();

        check.initialize();
        press();
        expect(game).toHaveBeenCalledTimes(1);
        expect(message()).not.toBeNull();
        await pause();
        press();
        expect(game).toHaveBeenCalledTimes(2);
    });

    test('every way a held press ends disconnects the observers it was watching with', async () => {
        const endings = [
            () => check.disable(),
            () => vi.advanceTimersByTime(15_000),
            async () => {
                await pause();
                press();
            },
        ];
        for (const end of endings) {
            check.initialize();
            press();
            const observers = [...check.pending.observers];
            expect(observers).toHaveLength(2);
            const disconnects = observers.map((observer) => vi.spyOn(observer, 'disconnect'));
            await end();
            for (const disconnect of disconnects) expect(disconnect).toHaveBeenCalled();
            expect(check.pending).toBeNull();
        }
    });

    test('disable twice and initialize twice leave one listener', () => {
        check.initialize();
        check.disable();
        check.disable();
        check.initialize();
        check.initialize();
        press();
        expect(document.querySelectorAll('.mwi-alchemy-catalyst-check')).toHaveLength(1);
    });

    test('off by setting, it installs nothing', () => {
        check.disable();
        state.settings.alchemyCatalystCheck = false;
        check.initialize();
        expect(check.isInitialized).toBe(false);
        expect(check.clickHandler).toBeNull();
        press();
        expect(game).toHaveBeenCalledTimes(1);
    });

    test('it asks the expected-value calculator to start with the feature, so the first press has figures', () => {
        check.disable();
        state.evReady = false;
        check.initialize();
        expect(state.evInit).toHaveBeenCalled();
    });
});

describe('with the protected-category guard', () => {
    const protectCheese = () => {
        state.settings.alchemy_actionProtection = true;
        state.protectedList = { coinify: ['/item_categories/food'], decompose: [], transmute: [], unrefine: [] };
        state.categories[CHEESE] = '/item_categories/food';
    };
    const warning = () => document.querySelector('.mwi-alchemy-protection-warning');

    /** The guard's whole cycle: refused for three seconds, then one confirming press */
    const runGuardCycle = async () => {
        press();
        expect(game).not.toHaveBeenCalled();
        expect(warning().textContent).toContain('Protected category');
        expect(message()).toBeNull();

        // Locked: another press is refused, and still says why
        await vi.advanceTimersByTimeAsync(1000);
        press();
        expect(game).not.toHaveBeenCalled();
        expect(warning()).not.toBeNull();

        await vi.advanceTimersByTimeAsync(2000);
        expect(warning().textContent).toContain('Click again to confirm');
        press();
        expect(game).toHaveBeenCalledTimes(1);
        expect(warning()).toBeNull();
        expect(message()).toBeNull();
    };

    test('the guard wins and this check stays out, with the guard listening first', async () => {
        check.disable();
        protectCheese();
        await protection.initialize();
        check.initialize();
        await runGuardCycle();
    });

    test('the guard wins and this check stays out, with this check listening first', async () => {
        check.disable();
        protectCheese();
        check.initialize();
        await protection.initialize();
        await runGuardCycle();
    });

    test('an item outside the protected categories gets this check, and the guard leaves it alone', async () => {
        check.disable();
        protectCheese();
        await protection.initialize();
        check.initialize();
        state.categories[CHEESE] = '/item_categories/resource';
        press();
        expect(game).not.toHaveBeenCalled();
        expect(warning()).toBeNull();
        expect(message()).not.toBeNull();
        await pause();
        press();
        expect(game).toHaveBeenCalledTimes(1);
    });

    test('a held press gives way if its item comes under protection', async () => {
        check.disable();
        protectCheese();
        await protection.initialize();
        check.initialize();
        state.categories[CHEESE] = '/item_categories/resource';
        press();
        await pause();
        state.categories[CHEESE] = '/item_categories/food';
        press();
        expect(game).not.toHaveBeenCalled();
        expect(warning()).not.toBeNull();

        await vi.advanceTimersByTimeAsync(3000);
        press();
        expect(game).toHaveBeenCalledTimes(1);
        expect(message()).toBeNull();
        expect(check.pending).toBeNull();
    });

    test('the guard switched off leaves the item to this check', async () => {
        check.disable();
        protectCheese();
        await protection.initialize();
        check.initialize();
        state.settings.alchemy_actionProtection = false;
        press();
        expect(game).not.toHaveBeenCalled();
        expect(warning()).toBeNull();
        expect(message()).not.toBeNull();
    });

    test('a guard that is not on the page yet answers nothing and does not throw', () => {
        // The guard's feature has never started: no list loaded
        state.settings.alchemy_actionProtection = true;
        expect(protection.protectedCategoryFor(start())).toBeNull();
        press();
        expect(message()).not.toBeNull();
    });
});

describe('the setting', () => {
    const definition = settingsGroups.alchemy
        ? settingsGroups.alchemy.settings.alchemyCatalystCheck
        : Object.values(settingsGroups).find((group) => group.settings.alchemyCatalystCheck).settings
              .alchemyCatalystCheck;

    test('defaults off, sits beside the mark, and its help states the margin', () => {
        expect(definition.default).toBe(false);
        expect(definition.type).toBe('checkbox');
        expect(definition.help).toContain('10K coins an hour');
        expect(definition.help).toContain('5%');
        expect(definition.help).toContain('one more press goes ahead');
    });

    test('the margin in the help is the margin in the code', async () => {
        const { MARGIN_MIN_COINS, MARGIN_RATIO } = await import('./alchemy-catalyst-check.js');
        expect(MARGIN_MIN_COINS).toBe(10_000);
        expect(MARGIN_RATIO).toBe(0.05);
    });

    test('no bulk write turns it on: every preset leaves an intrusive switch off', () => {
        for (const preset of SETTING_PRESETS) {
            expect(resolvePresetValues(preset).alchemyCatalystCheck, preset.id).toBe(false);
        }
    });

    test('"New settings start turned off" has nothing to hold back, since it arrives off', () => {
        expect(conservativeOverrides(['alchemyCatalystCheck'], () => definition)).toEqual([]);
    });
});
