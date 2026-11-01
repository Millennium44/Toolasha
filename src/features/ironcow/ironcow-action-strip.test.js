/**
 * The Iron Bell cycle strip under the action bar: when it draws, what it says for every way the
 * queue can end, and that stopping it takes everything back off the page.
 *
 * The walk is stubbed with stages shaped as `walkQueueCoins` returns them (its own figures are
 * pinned against the real engine in `coin-reserve.test.js`); `bellBudget` and `summarizeCycle`
 * stay real, so these are the panel's numbers.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const STAR_FRUIT = '/items/star_fruit';
const ESSENCE = '/items/foraging_essence';
const FORAGE = '/actions/foraging/star_fruit';
const DECOMPOSE = '/actions/alchemy/decompose';
const COINIFY = '/actions/alchemy/coinify';

const game = vi.hoisted(() => ({
    state: null,
    actions: [],
    walked: null,
    engine: {},
    pricing: null,
    cap: 20,
    listeners: new Map(),
    market: new Set(),
    settings: new Map(),
    reads: 0,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.actions,
        getOfflineHourCap: () => game.cap,
        getCurrentCharacterGameMode: () => game.state?.gameMode ?? null,
        on: (event, fn) => {
            if (!game.listeners.has(event)) game.listeners.set(event, new Set());
            game.listeners.get(event).add(fn);
        },
        off: (event, fn) => game.listeners.get(event)?.delete(fn),
    },
}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback,
        onSettingChange: (key, fn) => {
            game.settings.set(key, fn);
            return () => game.settings.delete(key);
        },
    },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { on: (fn) => game.market.add(fn), off: (fn) => game.market.delete(fn) },
}));
const domOffs = vi.hoisted(() => ({ live: 0 }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => {
            domOffs.live++;
            return () => domOffs.live--;
        },
    },
}));
vi.mock('../../utils/bundle-bridge.js', async (importOriginal) => ({
    ...(await importOriginal()),
    actionTimeDisplay: () => game.engine,
}));
vi.mock('./ironcow-plan.js', () => ({
    isIronCowMode: (mode) => mode === 'ironcow',
    readCharacterState: () => {
        game.reads++;
        return game.state;
    },
}));
vi.mock('./loop-items.js', () => ({
    resolveLoopItems: () => ({ forageActionHrid: FORAGE, starfruitHrid: STAR_FRUIT, essenceHrid: ESSENCE }),
}));
vi.mock('./starfruit-loop.js', () => ({ cowbellPricing: () => game.pricing }));
vi.mock('./coin-reserve.js', async (importOriginal) => ({
    ...(await importOriginal()),
    walkQueueCoins: () => game.walked,
}));

const { default: strip, stripLines } = await import('./ironcow-action-strip.js');

const hash = (item) => `42::/item_locations/inventory::${item}::0`;
const action = (ordinal, actionHrid, item = null) => ({
    id: 100 + ordinal,
    actionHrid,
    primaryItemHash: item ? hash(item) : '',
    hasMaxCount: true,
    maxCount: 100,
    currentCount: 0,
    isDone: false,
    ordinal,
});
const stage = (actionHrid, itemHrid, label, count, coinDelta, earned, seconds) => ({
    actionHrid,
    itemHrid,
    label,
    count,
    coinDelta,
    earned,
    seconds,
});
/** A forage → decompose → coinify cycle: 450K of fees, 1.05M of coinify, 12,000 s */
const loopWalk = () => ({
    stages: [
        stage(FORAGE, null, 'Star Fruit', 100, 0, 0, 1000),
        stage(DECOMPOSE, STAR_FRUIT, 'Decompose: Star Fruit', 500, -450_000, 0, 5000),
        stage(COINIFY, ESSENCE, 'Coinify: Foraging Essence', 600, 0, 1_050_000, 6000),
    ],
    stoppedAt: null,
});

const text = () => stripLines().map((line) => line.text);
const page = () => document.querySelector('[data-mwi-ironbell-strip]')?.textContent ?? null;

beforeEach(() => {
    document.body.innerHTML = '<div><div class="Header_actionName_x1">Star Fruit</div></div>';
    game.state = { coins: 4_000_000, gameMode: 'ironcow' };
    game.actions = [action(1, FORAGE), action(2, DECOMPOSE, STAR_FRUIT), action(3, COINIFY, ESSENCE)];
    game.walked = loopWalk();
    game.engine = {};
    game.pricing = { price: 1000, quoted: true };
    game.cap = 20;
});

afterEach(() => {
    strip.stop();
    vi.useRealTimers();
});

describe('when the strip draws', () => {
    test('nothing for a character that is not an Iron Cow', () => {
        game.state.gameMode = 'standard';
        expect(stripLines()).toEqual([]);
    });

    test('a standard character is never read at all', () => {
        game.state.gameMode = 'standard';
        game.reads = 0;
        expect(stripLines()).toEqual([]);
        expect(game.reads).toBe(0);
    });

    test('nothing with no queue', () => {
        game.actions = [];
        expect(stripLines()).toEqual([]);
    });

    test('nothing while a non-loop action runs, even with loop legs queued behind it', () => {
        game.actions = [action(5, FORAGE), action(1, '/actions/cheesesmithing/cheese')];
        expect(stripLines()).toEqual([]);
    });

    test('reads the running action by queue order, not array position', () => {
        // A requeued repeat listed first with a higher ordinal is not what runs
        game.actions = [action(5, '/actions/cheesesmithing/cheese'), action(1, DECOMPOSE, STAR_FRUIT)];
        expect(stripLines().length).toBeGreaterThan(0);
    });

    test('a decompose of some other item is not a loop leg', () => {
        game.actions = [action(1, DECOMPOSE, '/items/egg')];
        expect(stripLines()).toEqual([]);
    });

    test('nothing before the actions bundle is there to walk the queue', () => {
        game.engine = null;
        expect(stripLines()).toEqual([]);
    });
});

describe('what it says', () => {
    test('a whole loop: spendable now, the cycle left, its end and what it earns', () => {
        const [spend, cycle, ...rest] = text();
        // 4M less 450K of fees and the 3M buffer leaves 550K = 55 bags at 10K a bag
        expect(spend).toBe('Iron Bell: spend now 550 bells (55 bags) · keeps 3.5M for the queue');
        expect(cycle).toContain('100 forage · 500 decompose · 600 coinify left');
        expect(cycle).toContain('(in 3h 20m 00s)');
        // Net 1.05M − 450K, at 1,000 a bell
        expect(cycle).toContain('~+600.0K gold (~600 bells, 60 bags) by then');
        // 12,000 s is inside a 20 h cap, and the coins cover every fee
        expect(rest).toEqual([]);
    });

    test('the cycle outlasting the offline cap is noted beside it', () => {
        game.cap = 2;
        expect(text().some((line) => line.startsWith('Offline cap 2h'))).toBe(true);
    });

    test('a fee shortfall names the leg that stalls and when', () => {
        game.state.coins = 200_000;
        const warning = text().find((line) => line.startsWith('⚠'));
        // 200K pays 222 of 500 decomposes: 1,000 s + 2,220 s in
        expect(warning).toContain('Gold runs out on Decompose: Star Fruit at');
        expect(warning).toContain('(in 0h 53m 40s)');
        expect(warning).toContain('250.0K short');
    });

    test('coins between the fees and the fees plus the buffer: no bells, and no shortfall warning', () => {
        // 450K of fees are covered; the 3M buffer is not, so nothing is spendable but no leg stalls
        game.state.coins = 1_000_000;
        const lines = text();
        expect(lines[0]).toContain('spend now 0 bells (0 bags)');
        expect(lines[0]).toContain('keeps 3.5M for the queue');
        expect(lines.some((line) => line.startsWith('⚠'))).toBe(false);
    });

    test('zero gold: nothing to spend, and the first fee stalls now', () => {
        game.state.coins = 0;
        game.walked.stages.shift();
        const lines = text();
        expect(lines[0]).toContain('spend now 0 bells (0 bags)');
        expect(lines.find((line) => line.startsWith('⚠'))).toContain('Decompose: Star Fruit now: 450.0K short');
    });

    test('an unreadable queue says so, and nothing else', () => {
        game.walked = null;
        expect(text()).toEqual(['Iron Bell: the queue could not be read in full']);
    });

    test('no cowbell price: the cycle is still shown, with no bells', () => {
        game.pricing = { price: null, quoted: false };
        const [spend, cycle] = text();
        expect(spend).toBe('Iron Bell: no cowbell price to buy at');
        expect(cycle).toContain('~+600.0K gold by then');
        expect(cycle).not.toContain('bells,');
    });

    test('an infinite leg: no end time, and the cap is noted', () => {
        game.walked = { stages: [], stoppedAt: 'Star Fruit' };
        const lines = text();
        expect(lines[1]).toContain('Star Fruit repeats forever, so the cycle has no end');
        expect(lines[1]).toContain('up to that row');
        expect(lines.some((line) => line.startsWith('Offline cap 20h'))).toBe(true);
    });

    test('a fight that cannot be timed leaves the end unknown', () => {
        game.walked.stages.push(stage('/actions/combat/fly', null, 'Fly', 10, 0, 0, Infinity));
        expect(text()[1]).toContain('end time unknown');
        expect(text()[1]).toContain('10 other actions');
    });

    test('hover text says what the reserve holds back, in the panel’s words', () => {
        const [spend] = stripLines();
        expect(spend.title).toContain('Keeps 3.5M back: what Decompose: Star Fruit spends plus a 3.0M safety buffer.');
    });
});

describe('lifetime', () => {
    test('draws under the action bar, redraws on a queue change, and stop() takes it all away', () => {
        vi.useFakeTimers();
        strip.start();
        expect(page()).toContain('spend now 550 bells');

        game.state.coins = 5_000_000;
        for (const fn of game.listeners.get('actions_updated')) fn();
        vi.advanceTimersByTime(400);
        expect(page()).toContain('spend now 1,550 bells');

        strip.stop();
        expect(page()).toBeNull();
        expect([...game.listeners.values()].every((set) => set.size === 0)).toBe(true);
        expect(game.market.size).toBe(0);
        expect(game.settings.size).toBe(0);
        expect(domOffs.live).toBe(0);

        // Nothing comes back on a late timer
        vi.advanceTimersByTime(60_000);
        expect(page()).toBeNull();
    });

    test('the strip comes off when the running action stops being a loop leg', () => {
        vi.useFakeTimers();
        strip.start();
        expect(page()).not.toBeNull();
        game.actions = [action(1, '/actions/cheesesmithing/cheese')];
        for (const fn of game.listeners.get('actions_updated')) fn();
        vi.advanceTimersByTime(400);
        expect(page()).toBeNull();
    });
});
