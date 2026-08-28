/**
 * @vitest-environment happy-dom
 *
 * The character-select block, built rather than reasoned about.
 *
 * The load-bearing assertion is the dull one: given a character-select screen and a stored
 * record, a block appears in every populated slot and it says something. A renamed helper, a
 * method that was called and never written, a property read off something that stopped having
 * it — none of those are arithmetic, and only building the thing catches them.
 *
 * The async-slot case gets its own test because it is the failure this feature actually had:
 * the native screen mounts its root before `loadCharacters()` resolves and inserts the slots
 * afterwards, so a renderer that only watches for the root draws into an empty page and never
 * looks again.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

/** The stored records, keyed by character id, swapped between tests */
const store = vi.hoisted(() => ({ records: {}, prefs: { enabled: true, dateFormat: 'MM-DD', timeFormat: '24hour' } }));

/** The class handlers the renderer registers on the shared observer */
const observer = vi.hoisted(() => ({ handlers: [], readyHandlers: [], domReady: true }));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, classNames, callback) => {
            const handler = { name, classNames, callback };
            observer.handlers.push(handler);
            return () => {
                observer.handlers = observer.handlers.filter((h) => h !== handler);
            };
        },
        // Mirrors the real DOMObserver.onReady: fires immediately when the observer is already
        // attached (the default here, matching the observer's steady-state in production), or
        // defers until `observer.domReady` is flipped on and the handler is invoked by hand —
        // the TLA-025 readiness-gap case below.
        onReady: (name, callback) => {
            const handler = { name, callback };
            observer.readyHandlers.push(handler);
            if (observer.domReady) callback();
            return () => {
                observer.readyHandlers = observer.readyHandlers.filter((h) => h !== handler);
            };
        },
    },
}));

// The sprite manifest is a network fetch, and the icon is not what this file is about
vi.mock('../../utils/asset-manifest.js', () => ({
    default: { getSpriteUrl: async () => '/static/media/skills.svg' },
}));

vi.mock('./character-activity-storage.js', () => ({
    MAX_RECORD_AGE_MS: 7 * 24 * 60 * 60 * 1000,
    loadCharacterActivity: async (id) => store.records[id] || null,
    loadAccountPreferences: async () => store.prefs,
}));

const renderer = (await import('./character-select-renderer.js')).default;
const { BLOCK_CLASS } = await import('./character-select-renderer.js');

const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

/**
 * A stored record whose queue ends `endsInMs` from now.
 * @param {string} id
 * @param {number} endsInMs
 * @returns {Object}
 */
function storedRecord(id, endsInMs) {
    return {
        version: 1,
        characterId: id,
        characterName: `Char ${id}`,
        observedAt: NOW,
        offline: { hourCap: null, mooPassExpireTime: null },
        projection: {
            segments: [
                {
                    actionHrid: '/actions/milking/cow',
                    actionName: 'Cow',
                    actionTypeHrid: '/action_types/milking',
                    startAt: NOW,
                    endAt: NOW + endsInMs,
                    queuedIndex: 0,
                    certainty: 'trustworthy',
                    stopCause: 'count',
                },
            ],
            terminalCause: 'queue',
            terminalAt: NOW + endsInMs,
            certainty: 'trustworthy',
        },
    };
}

/**
 * Build the native character-select markup.
 * @param {string[]} ids - Character ids to give populated slots
 * @param {boolean} withSlots - Whether the slots container exists yet
 * @returns {Element} The character-select root
 */
function mountCharacterSelect(ids, withSlots = true) {
    const root = document.createElement('div');
    root.className = 'CharacterSelectPage_characterSelectPage__abc123';
    document.body.appendChild(root);
    if (withSlots) addSlots(root, ids);
    return root;
}

/**
 * Insert the slots container the way `loadCharacters()` does.
 * @param {Element} root
 * @param {string[]} ids
 * @returns {Element} The slots container
 */
function addSlots(root, ids, { nestedLink = false } = {}) {
    const container = document.createElement('div');
    container.className = 'CharacterSelectPage_characterSlots__def456';
    for (const id of ids) {
        // The live page's slot IS the anchor; nestedLink covers a markup where
        // the link sits inside a wrapper instead
        let slot;
        if (nestedLink) {
            slot = document.createElement('div');
            slot.className = 'CharacterSelectPage_slot__ghi789';
            const link = document.createElement('a');
            link.setAttribute('href', `/game?characterId=${id}`);
            link.textContent = `Char ${id}`;
            slot.appendChild(link);
        } else {
            slot = document.createElement('a');
            slot.className = 'MuiLink-root CharacterSelectPage_slot__ghi789';
            slot.setAttribute('href', `/game?characterId=${id}`);
            slot.textContent = `Char ${id}`;
        }
        container.appendChild(slot);
    }
    // The empty "create character" slot: same class, no navigation link
    const empty = document.createElement('div');
    empty.className = 'CharacterSelectPage_slot__ghi789';
    container.appendChild(empty);

    root.appendChild(container);
    return container;
}

/** @returns {Element[]} Every injected block currently in the document */
const blocks = () => [...document.querySelectorAll(`.${BLOCK_CLASS}`)];

/**
 * Let the renderer's un-awaited async work finish. The catch-up scan is fire-and-forget by
 * design, and the fake clock means a timer-based wait would never tick on its own.
 * @returns {Promise<void>}
 */
async function flush() {
    for (let i = 0; i < 25; i++) await Promise.resolve();
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    store.records = {};
    store.prefs = { enabled: true, dateFormat: 'MM-DD', timeFormat: '24hour' };
    observer.handlers = [];
    observer.readyHandlers = [];
    observer.domReady = true;
    document.body.innerHTML = '';
});

afterEach(() => {
    renderer.stopWatching();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('drawing into character select', () => {
    test('a populated slot gets a block, and the block says something', async () => {
        store.records['1234'] = storedRecord('1234', 4 * HOUR);
        const root = mountCharacterSelect(['1234']);

        await renderer.onCharacterSelectMounted(root);

        expect(blocks()).toHaveLength(1);
        expect(blocks()[0].textContent).toContain('Cow');
        expect(blocks()[0].textContent).toContain('Queue ends');
    });

    test('a slot whose link is nested inside a wrapper still resolves', async () => {
        const root = mountCharacterSelect([], false);
        addSlots(root, ['30404'], { nestedLink: true });
        await renderer.onCharacterSelectMounted(root);

        expect(blocks()).toHaveLength(1);
    });

    test('every populated slot is drawn, and the empty one is left alone', async () => {
        store.records['1'] = storedRecord('1', 4 * HOUR);
        store.records['2'] = storedRecord('2', 30 * 60 * 1000);
        const root = mountCharacterSelect(['1', '2']);

        await renderer.onCharacterSelectMounted(root);

        expect(blocks()).toHaveLength(2);
    });

    test('a character with no record still gets an honest block rather than nothing', async () => {
        const root = mountCharacterSelect(['1234']);

        await renderer.onCharacterSelectMounted(root);

        expect(blocks()[0].textContent).toContain('No activity data yet');
    });

    test('redrawing the same slot replaces the block instead of stacking them', async () => {
        store.records['1234'] = storedRecord('1234', 4 * HOUR);
        const root = mountCharacterSelect(['1234']);

        await renderer.onCharacterSelectMounted(root);
        await renderer.onCharacterSelectMounted(root);

        expect(blocks()).toHaveLength(1);
    });

    test('the setting being off means no block at all', async () => {
        store.prefs = { ...store.prefs, enabled: false };
        store.records['1234'] = storedRecord('1234', 4 * HOUR);
        const root = mountCharacterSelect(['1234']);

        await renderer.onCharacterSelectMounted(root);

        expect(blocks()).toHaveLength(0);
    });
});

describe('slots that arrive after the root', () => {
    test('a root mounted empty draws nothing yet, and draws once the slots land', async () => {
        store.records['1234'] = storedRecord('1234', 4 * HOUR);
        const root = mountCharacterSelect([], false);

        renderer.startWatching();
        expect(blocks()).toHaveLength(0);

        const container = addSlots(root, ['1234']);
        for (const handler of observer.handlers) await handler.callback(container);

        expect(blocks()).toHaveLength(1);
    });

    test('the observer watches for the slots container, not only the root', () => {
        renderer.startWatching();

        expect(observer.handlers).toHaveLength(1);
        expect(observer.handlers[0].classNames).toContain('CharacterSelectPage_characterSelectPage');
        expect(observer.handlers[0].classNames).toContain('CharacterSelectPage_characterSlots');
    });

    test('a screen already loaded when watching starts is caught up with', async () => {
        store.records['1234'] = storedRecord('1234', 4 * HOUR);
        mountCharacterSelect(['1234']);

        renderer.startWatching();
        await flush();

        expect(blocks()).toHaveLength(1);
    });

    // TLA-025 REOPEN: at @run-at document-start the shared observer may not be attached yet
    // because document.body does not exist. Character Select can fully mount during that gap,
    // producing no observable mutation after the observer finally attaches. Readiness must
    // trigger a bounded catch-up at the moment observing actually becomes active.
    test('catches up when Character Select fully mounts before the shared observer becomes ready', async () => {
        observer.domReady = false;
        store.records['1234'] = storedRecord('1234', 4 * HOUR);

        renderer.startWatching();
        expect(observer.readyHandlers).toHaveLength(1);

        // Native UI fully mounts while the central observer is still waiting for body/readiness.
        mountCharacterSelect(['1234']);
        expect(blocks()).toHaveLength(0);

        // The real DOMObserver emits readiness only after it actually attaches to document.body.
        observer.domReady = true;
        await observer.readyHandlers[0].callback();
        await flush();

        expect(blocks()).toHaveLength(1);

        // Re-notification/remount catch-up remains idempotent.
        await observer.readyHandlers[0].callback();
        await flush();
        expect(blocks()).toHaveLength(1);
    });

    test('a node outside character select is ignored', async () => {
        const stray = document.createElement('div');
        stray.className = 'SomeOtherPage_thing';
        document.body.appendChild(stray);

        renderer.startWatching();
        for (const handler of observer.handlers) await handler.callback(stray);

        expect(blocks()).toHaveLength(0);
    });
});

describe('the icon tracks the currently-active segment', () => {
    /**
     * A stored record with two queued segments: milking, then cheesesmithing.
     * @param {string} id
     * @returns {Object}
     */
    function twoSegmentRecord(id) {
        return {
            version: 1,
            characterId: id,
            characterName: `Char ${id}`,
            observedAt: NOW,
            offline: { hourCap: null, mooPassExpireTime: null },
            projection: {
                segments: [
                    {
                        actionHrid: '/actions/milking/cow',
                        actionName: 'Cow',
                        actionTypeHrid: '/action_types/milking',
                        startAt: NOW,
                        endAt: NOW + HOUR,
                        queuedIndex: 0,
                        certainty: 'trustworthy',
                        stopCause: 'count',
                    },
                    {
                        actionHrid: '/actions/cheesesmithing/cheese',
                        actionName: 'Cheese',
                        actionTypeHrid: '/action_types/cheesesmithing',
                        startAt: NOW + HOUR,
                        endAt: NOW + 3 * HOUR,
                        queuedIndex: 1,
                        certainty: 'trustworthy',
                        stopCause: 'count',
                    },
                ],
                terminalCause: 'queue',
                terminalAt: NOW + 3 * HOUR,
                certainty: 'trustworthy',
            },
        };
    }

    /** @returns {string|null} The `use` href of the injected icon, or null if there is none */
    function iconHref() {
        return blocks()[0]?.querySelector('use')?.getAttribute('href') ?? null;
    }

    test('the icon matches the first queued action while it is still running', async () => {
        store.records['1234'] = twoSegmentRecord('1234');
        const root = mountCharacterSelect(['1234']);

        await renderer.onCharacterSelectMounted(root);

        expect(iconHref()).toContain('#milking');
    });

    test('once the first segment ends, the icon follows the text onto the next one', async () => {
        store.records['1234'] = twoSegmentRecord('1234');
        const root = mountCharacterSelect(['1234']);
        await renderer.onCharacterSelectMounted(root);
        expect(iconHref()).toContain('#milking');

        // The character has moved on to segment two, but the stored record — read from the
        // same snapshot taken while it was still on segment one — never changes.
        vi.setSystemTime(NOW + 2 * HOUR);
        await renderer.renderAllTrackedSlots();

        expect(blocks()[0].textContent).toContain('Cheese');
        expect(iconHref()).toContain('#cheesesmithing');
        expect(iconHref()).not.toContain('#milking');
    });
});

describe('teardown', () => {
    test('stopWatching removes the blocks and the observer registration', async () => {
        store.records['1234'] = storedRecord('1234', 4 * HOUR);
        const root = mountCharacterSelect(['1234']);

        renderer.startWatching();
        await renderer.onCharacterSelectMounted(root);
        expect(blocks()).toHaveLength(1);

        renderer.stopWatching();

        expect(blocks()).toHaveLength(0);
        expect(observer.handlers).toHaveLength(0);
        expect(observer.readyHandlers).toHaveLength(0);
    });
});
