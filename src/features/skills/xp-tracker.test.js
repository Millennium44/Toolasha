/** @vitest-environment happy-dom */

/**
 * The skill XP history is one record per character, written whole on every
 * action. These cover the ways that used to lose it: a read that could not be
 * made coming back as an empty map and being written over the stored one, and
 * a second tab overwriting the first's samples.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        storeFor,
        unavailable: false,
        // key → Promise, awaited inside tryGet before it answers. Lets a race
        // test make one character's probe resolve after another's despite
        // starting first.
        delays: new Map(),
        reset() {
            stores.clear();
            storageMock.unavailable = false;
            storageMock.delays.clear();
        },
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        tryGet: vi.fn(async (key, store = 'settings') => {
            const delay = storageMock.delays.get(key);
            if (delay) await delay;
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        }),
        set: vi.fn(async (key, value, store = 'settings') => {
            if (storageMock.unavailable) return false;
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
    };
});

const game = vi.hoisted(() => ({ characterId: 'char1', handlers: {}, skills: [], month: null }));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        characterData: null,
        getCurrentCharacterId: () => game.characterId,
        getCurrentCharacterGameMode: () => 'standard',
        getCurrentCharacterName: () => 'Main',
        getSkills: () => game.skills,
        on: (event, handler) => {
            game.handlers[event] = handler;
        },
        off: () => {},
    },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('./skill-checkpoints.js', () => ({ monthToDateFor: () => game.month }));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const { xpTracker, inLastInterval } = await import('./xp-tracker.js');

const KEY = 'xpHistory_char1';
const stored = () => storageMock.storeFor('xpHistory').get(KEY);
const HOUR = 60 * 60 * 1000;

/** An init_character_data payload with one milking sample. */
const init = (charId, t, xp) => ({
    character: { id: charId },
    currentTimestamp: new Date(t).toISOString(),
    characterSkills: [{ skillHrid: '/skills/milking', experience: xp }],
});

/** An action_completed payload with one milking sample. */
const action = (t, xp) => ({
    endCharacterSkills: [{ skillHrid: '/skills/milking', experience: xp, updatedAt: new Date(t).toISOString() }],
});

beforeEach(() => {
    storageMock.reset();
    game.characterId = 'char1';
    xpTracker.history.reset();
    xpTracker.characterId = null;
    game.skills = [{ skillHrid: '/skills/milking', experience: 12_000, level: 30 }];
    game.month = null;
});

describe('the XP history survives', () => {
    test('a load that cannot read storage keeps what is in memory instead of blanking it', async () => {
        storageMock.storeFor('xpHistory').set(KEY, { milking: [{ t: 1000, xp: 10 }] });
        await xpTracker._onCharacterInit(init('char1', 2 * HOUR, 20));
        await xpTracker.history.flushed();
        expect(stored().milking.map((s) => s.xp)).toEqual([10, 20]);

        storageMock.unavailable = true;
        // The re-initialise a reconnect does, with storage gone in between
        await xpTracker._onCharacterInit(init('char1', 3 * HOUR, 30));
        await xpTracker.history.flushed();

        expect(xpTracker.xpHistory.milking.map((s) => s.xp)).toEqual([10, 20, 30]);
        // And nothing was written over the stored record while it could not be read
        expect(stored().milking.map((s) => s.xp)).toEqual([10, 20]);
    });

    test('a sample taken while storage is unreadable lands with the next save once it is back', async () => {
        storageMock.storeFor('xpHistory').set(KEY, { milking: [{ t: 1000, xp: 10 }] });
        await xpTracker._onCharacterInit(init('char1', 2 * HOUR, 20));
        await xpTracker.history.flushed();

        storageMock.unavailable = true;
        xpTracker._onActionCompleted(action(3 * HOUR, 30));
        await xpTracker.history.flushed();
        expect(stored().milking.map((s) => s.xp)).toEqual([10, 20]);

        storageMock.unavailable = false;
        xpTracker._onActionCompleted(action(4 * HOUR, 40));
        await xpTracker.history.flushed();
        expect(stored().milking.map((s) => s.xp)).toEqual([10, 20, 30, 40]);
    });

    test('a save folds in samples another tab stored meanwhile', async () => {
        await xpTracker._onCharacterInit(init('char1', 2 * HOUR, 20));
        await xpTracker.history.flushed();

        // The other tab recorded a later sample and a skill this tab never saw
        storageMock.storeFor('xpHistory').set(KEY, {
            milking: [
                { t: 2 * HOUR, xp: 20 },
                { t: 3 * HOUR, xp: 30 },
            ],
            foraging: [{ t: 3 * HOUR, xp: 5 }],
        });

        xpTracker._onActionCompleted(action(4 * HOUR, 40));
        await xpTracker.history.flushed();

        expect(stored().milking.map((s) => s.xp)).toEqual([20, 30, 40]);
        expect(stored().foraging.map((s) => s.xp)).toEqual([5]);
    });

    test('a character switch starts from the new character’s record, not a fold of both', async () => {
        storageMock.storeFor('xpHistory').set('xpHistory_char2', { foraging: [{ t: 1000, xp: 7 }] });
        await xpTracker._onCharacterInit(init('char1', 2 * HOUR, 20));
        await xpTracker.history.flushed();

        game.characterId = 'char2';
        await xpTracker._onCharacterInit(init('char2', 3 * HOUR, 9));
        await xpTracker.history.flushed();

        expect(xpTracker.xpHistory.foraging.map((s) => s.xp)).toEqual([7]);
        expect(xpTracker.xpHistory.milking.map((s) => s.xp)).toEqual([9]);
        const theirs = storageMock.storeFor('xpHistory').get('xpHistory_char2');
        expect(theirs.foraging.map((s) => s.xp)).toEqual([7]);
        expect(theirs.milking.map((s) => s.xp)).toEqual([9]);
        expect(stored().milking.map((s) => s.xp)).toEqual([20]);
    });

    test('a slow init for the departing character does not bleed into the arriving one', async () => {
        // `character_initialized` handlers are fired unawaited by data-manager
        // (only its own internal state updates are serialised), so a second
        // switch's init can start, and finish, while the first one's is still
        // awaiting its storage probe — e.g. a player tabbing between
        // characters faster than one IndexedDB round trip.
        storageMock.delays.set(KEY, new Promise((resolve) => setTimeout(resolve, 20)));

        const staleInit = xpTracker._onCharacterInit(init('char1', 2 * HOUR, 20));

        // Flush microtasks so char1's call reaches its storage probe (and
        // parks on the delay) before char2 arrives — otherwise both calls
        // would race the same probe and the bug this test targets would not
        // be exercised.
        await new Promise((resolve) => setTimeout(resolve, 0));

        game.characterId = 'char2';
        await xpTracker._onCharacterInit(init('char2', 3 * HOUR, 9));
        await xpTracker.history.flushed();

        expect(xpTracker.xpHistory.milking.map((s) => s.xp)).toEqual([9]);

        // Let char1's stale init land. It must not push char1's reading into
        // what is now char2's record, nor persist it under char2's key.
        await staleInit;
        await xpTracker.history.flushed();

        expect(xpTracker.xpHistory.milking.map((s) => s.xp)).toEqual([9]);
        const theirs = storageMock.storeFor('xpHistory').get('xpHistory_char2');
        expect(theirs.milking.map((s) => s.xp)).toEqual([9]);
    });
});

describe('inLastInterval', () => {
    const HALF_HOUR = 1800_000;

    test('keeps the samples inside the window and drops the rest', () => {
        const now = Date.now();
        const samples = [
            { t: now - 3 * HOUR, xp: 10 },
            { t: now - HALF_HOUR, xp: 20 },
            { t: now - 60_000, xp: 30 },
        ];

        expect(inLastInterval(samples, HOUR).map((s) => s.xp)).toEqual([20, 30]);
    });

    test('does not assume the series is in time order', () => {
        // A cross-device sync merge folds another tab's samples into this one's, and the
        // window used to be found by walking back from the end and stopping at the first
        // sample that was too old — one out-of-order entry and everything before it vanished
        const now = Date.now();
        const interleaved = [
            { t: now - 3 * HOUR, xp: 10 },
            { t: now - 60_000, xp: 30 },
            { t: now - HALF_HOUR, xp: 20 },
        ];

        expect(inLastInterval(interleaved, HOUR).map((s) => s.xp)).toEqual([30, 20]);
    });

    test('an empty or missing series is empty, not a crash', () => {
        expect(inLastInterval([], HOUR)).toEqual([]);
        expect(inLastInterval(undefined, HOUR)).toEqual([]);
    });
});

describe('the month line in a skill tooltip', () => {
    /** The tooltip the game renders: name, level, progress, "XP to next level" */
    const tooltip = (name) => {
        const el = document.createElement('div');
        for (const line of [name, 'Level 30', '12,000 / 20,000', 'XP to next level: 8,000']) {
            const div = document.createElement('div');
            div.textContent = line;
            el.appendChild(div);
        }
        return el;
    };

    test('shows what the skill has gained this month, and where the measurement starts', () => {
        game.month = { gained: 4200, since: '2026-03-01', start: '2026-02-11' };
        const el = tooltip('Milking');

        xpTracker._addMonthGain(el);

        const line = el.querySelector('.mwi-xp-month-gain');
        expect(line.textContent).toContain('This month');
        expect(line.textContent).toContain('4.2K');
        // The start date is the difference between "you gained little" and
        // "nothing was recording", so it is never left off
        expect(line.title).toContain('Checkpoint history starts 2026-02-11');
    });

    test('says so in words when the month is only partly recorded', () => {
        game.month = { gained: 600, since: '2026-03-09', start: '2026-03-09' };
        const el = tooltip('Milking');

        xpTracker._addMonthGain(el);

        expect(el.querySelector('.mwi-xp-month-gain').title).toContain(
            'Measured from 2026-03-09 — the first day recorded this month'
        );
    });

    test('nothing recorded yet shows no line at all rather than a zero', () => {
        game.month = null;
        const el = tooltip('Milking');

        xpTracker._addMonthGain(el);

        expect(el.querySelector('.mwi-xp-month-gain')).toBeNull();
    });

    test('a redraw of the same tooltip does not stack two lines', () => {
        game.month = { gained: 4200, since: '2026-03-01', start: '2026-02-11' };
        const el = tooltip('Milking');

        xpTracker._addMonthGain(el);
        xpTracker._addMonthGain(el);

        expect(el.querySelectorAll('.mwi-xp-month-gain')).toHaveLength(1);
    });

    test('a tooltip for something that is not a tracked skill is left alone', () => {
        game.month = { gained: 4200, since: '2026-03-01', start: '2026-02-11' };
        const el = tooltip('Not A Skill');

        xpTracker._addMonthGain(el);

        expect(el.querySelector('.mwi-xp-month-gain')).toBeNull();
    });
});
