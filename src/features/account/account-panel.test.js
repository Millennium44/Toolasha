/** @vitest-environment happy-dom
 *
 * Whether the Account panel draws.
 *
 * The arithmetic is tested in `account-data.test.js`; what cannot be tested
 * there is that every section survives the data it is given. The panel catches
 * a failing draw and says so in place of the body, so the assertion that earns
 * its keep is that it never had to.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ data: {} }));
const state = vi.hoisted(() => ({ account: null, liveFacts: null, opened: [] }));

vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1100, getSetting: () => true } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        ready: Promise.resolve(true),
        getJSON: async (key, _name, fallback) => store.data[key] ?? fallback,
        setJSON: async (key, value) => {
            store.data[key] = value;
        },
    },
}));
// The live half of the "Needs attention" section. Mocked rather than let
// through because the real module reaches the enhancement tracker, the notice
// log and the undercut watcher on import, none of which this panel is about.
vi.mock('../briefing/session-briefing.js', () => ({
    collectFacts: () => state.liveFacts,
    OPENERS: { tasks: () => state.opened.push('tasks') },
}));
vi.mock('./account-data.js', async () => {
    const actual = await vi.importActual('./account-data.js');
    return {
        ...actual,
        cachedAccount: () => state.account,
        refreshAccount: () => Promise.resolve(state.account),
    };
});

const { accountPanel, registerAccountRow } = await import('./account-panel.js');
const { registeredRows } = await import('../../utils/overlay-rows.js');

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

/**
 * An account with two characters, one of them idle.
 * @returns {Object}
 */
function sampleAccount() {
    return {
        at: NOW,
        currentId: 'a',
        characters: [
            {
                id: 'a',
                name: 'Main',
                named: true,
                networth: 1_000_000,
                networthAt: NOW - HOUR,
                lastSeen: NOW - HOUR,
                points: 5,
                queue: { state: 'busy', remainingSeconds: 3600, stale: false, ageMs: HOUR },
                isCurrent: true,
            },
            {
                id: 'b',
                name: 'Alt',
                named: true,
                networth: 250_000,
                networthAt: NOW - 5 * HOUR,
                lastSeen: NOW - 5 * HOUR,
                points: 3,
                queue: { state: 'idle', remainingSeconds: 0, stale: false, ageMs: 5 * HOUR },
                isCurrent: false,
            },
        ],
        combined: Array.from({ length: 10 }, (_, i) => ({
            t: NOW - (9 - i) * HOUR,
            total: 1_000_000 + i * 25_000,
            contributors: 2,
        })),
        briefings: {
            b: { characterId: 'b', characterName: 'Alt', at: NOW - 5 * HOUR, facts: { tasksReady: 4 } },
        },
    };
}

const text = () => accountPanel.panel?.textContent || '';

/**
 * The rows of the "Needs attention" card, in the order they are drawn.
 * @returns {Array<string>} Each row's text
 */
function attentionRows() {
    const card = [...(accountPanel.panel?.querySelectorAll('div') || [])].find(
        (node) => node.firstElementChild?.textContent === 'Needs attention'
    );
    return [...(card?.children || [])].map((node) => node.textContent);
}

beforeEach(() => {
    store.data = {};
    state.account = sampleAccount();
    state.liveFacts = {};
    state.opened = [];
});

afterEach(() => {
    accountPanel.hide({ remember: false });
});

describe('drawing the account', () => {
    test('every section draws', () => {
        accountPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('Combined networth');
        expect(text()).toContain('Characters');
    });

    test('the total is the sum of the last known figures', () => {
        accountPanel.show({ remember: false });

        expect(text()).toContain('Total (2 of 2 characters)');
        expect(text()).toContain('1.25M');
    });

    test('an alt whose queue has run out reads as idle', () => {
        accountPanel.show({ remember: false });
        expect(text()).toContain('Idle');
    });

    test('a character with no networth history is counted out of the total, not into it', () => {
        state.account.characters.push({
            id: 'c',
            name: 'Fresh',
            named: false,
            networth: null,
            networthAt: null,
            lastSeen: null,
            points: 0,
            queue: { state: 'unknown', remainingSeconds: null, stale: false, ageMs: null },
            isCurrent: false,
        });

        accountPanel.show({ remember: false });

        expect(text()).toContain('Total (2 of 3 characters)');
        expect(text()).toContain('No queue snapshot');
    });

    test('the first frame, before any read has landed, is not an error', () => {
        state.account = null;
        accountPanel.show({ remember: false });

        expect(text()).toContain('Reading the account');
        expect(text()).not.toContain('could not be drawn');
    });
});

describe('the "Needs attention" section', () => {
    test('an alt’s recorded lines are shown under its name, with the age of the record', () => {
        accountPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('Needs attention');
        expect(text()).toContain('Tasks to claim');
        expect(text()).toContain('4 waiting');
        // The age of the snapshot, not of anything recomputed
        expect(text()).toContain('5h');
    });

    test('the character you are logged into is read from the game and marked as now', () => {
        state.liveFacts = { tasksReady: 1 };
        accountPanel.show({ remember: false });

        expect(text()).toContain('Main (here)');
        expect(text()).toContain('1 waiting');
        expect(text()).toContain('now');
    });

    test('a countdown recorded long enough ago to have run out is not shown at all', () => {
        // Recorded five hours ago with an hour of ale left
        state.account.briefings.b.facts = { consumable: { name: 'Ale', secondsLeft: 3600 } };
        state.liveFacts = { tasksReady: 1 };
        accountPanel.show({ remember: false });

        expect(text()).not.toContain('Ale');
        expect(text()).toContain('Nothing needs Alt.');
    });

    test('a countdown that is still running is restated as an instant, never as a duration', () => {
        state.account.briefings.b.facts = { consumable: { name: 'Ale', secondsLeft: 8 * 3600 } };
        accountPanel.show({ remember: false });

        expect(text()).toContain('Ale runs dry at');
        expect(text()).not.toContain('Ale in ');
    });

    test('quiet characters are one row, not a heading each', () => {
        state.account.briefings.b.facts = {};
        accountPanel.show({ remember: false });

        expect(text()).toContain('Nothing needs any of your characters.');
    });

    test('a character nobody has a snapshot for is named as unknown, not as fine', () => {
        state.account.characters.push({
            id: 'c',
            name: 'Fresh',
            named: true,
            networth: null,
            networthAt: null,
            lastSeen: null,
            points: 0,
            queue: { state: 'unknown', remainingSeconds: null, stale: false, ageMs: null },
            isCurrent: false,
        });

        accountPanel.show({ remember: false });

        expect(text()).toContain('No briefing recorded yet for Fresh.');
        expect(text()).not.toContain('Nothing needs Fresh');
    });

    test('the header names who to look at next, and what is worst about them', () => {
        // Alt has a full board that is already wasting; Main only has tasks
        // waiting, which is a reading
        state.account.briefings.b.facts = {
            taskSlots: { ok: true, isFull: true, msUntilWaste: 30 * 60_000, msUntilFull: 0 },
        };
        state.liveFacts = { tasksReady: 1 };

        accountPanel.show({ remember: false });

        expect(text()).toContain('Next: Alt — Task board: Full — tasks are being wasted');
    });

    test('the character you are already on is never the one you are sent to', () => {
        state.account.briefings.b.facts = {};
        state.liveFacts = { tasksReady: 3 };

        accountPanel.show({ remember: false });

        expect(text()).not.toContain('Next:');
    });

    test('the blocks are ordered worst first, not in character order', () => {
        // Main (first in every other list) has the milder problem
        state.account.briefings.b.facts = {
            taskSlots: { ok: true, isFull: true, msUntilWaste: 30 * 60_000, msUntilFull: 0 },
        };
        state.liveFacts = { tasksReady: 1 };

        accountPanel.show({ remember: false });

        // Read off the section's own rows rather than the panel's whole text —
        // every character is named in the networth card above it too
        const rows = attentionRows();
        const alt = rows.findIndex((line) => line.startsWith('Alt'));
        const main = rows.findIndex((line) => line.startsWith('Main (here)'));
        expect(alt).toBeGreaterThanOrEqual(0);
        expect(alt).toBeLessThan(main);
    });

    test('a never-recorded character is not ranked among the rest, however bad they are', () => {
        state.account.characters.push({
            id: 'c',
            name: 'Fresh',
            named: true,
            networth: null,
            networthAt: null,
            lastSeen: null,
            points: 0,
            queue: { state: 'unknown', remainingSeconds: null, stale: false, ageMs: null },
            isCurrent: false,
        });

        accountPanel.show({ remember: false });

        expect(text()).toContain('No briefing recorded yet for Fresh.');
        expect(text()).not.toContain('Next: Fresh');
    });

    test('the section says outright that it only learns anything when you switch here', () => {
        accountPanel.show({ remember: false });
        expect(text()).toContain('playing elsewhere does not update them');
    });

    test('only the current character’s lines are clickable — an alt’s would open your own board', () => {
        state.liveFacts = { tasksReady: 1 };
        accountPanel.show({ remember: false });

        const rows = [...accountPanel.panel.querySelectorAll('div')].filter((node) =>
            node.textContent.startsWith('Tasks to claim')
        );
        const clickable = rows.filter((node) => node.style.cursor === 'pointer');
        expect(clickable).toHaveLength(1);

        clickable[0].click();
        expect(state.opened).toEqual(['tasks']);
    });

    test('a live read that throws leaves the rest of the section standing', () => {
        state.account.briefings.a = { characterId: 'a', at: NOW - HOUR, facts: { tasksReady: 7 } };
        Object.defineProperty(state, 'liveFacts', {
            get() {
                throw new Error('the collector is gone');
            },
            configurable: true,
        });

        accountPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        // Fallen back to the current character's own snapshot
        expect(text()).toContain('7 waiting');

        delete state.liveFacts;
        Object.defineProperty(state, 'liveFacts', { value: {}, writable: true, configurable: true });
    });
});

describe('the overlay tile', () => {
    test('it registers with a way to open the panel', () => {
        registerAccountRow();

        const row = registeredRows().find((entry) => entry.key === 'accountView');
        expect(typeof row.onOpen).toBe('function');
    });

    test('it counts the characters that have stopped', () => {
        registerAccountRow();
        const row = registeredRows().find((entry) => entry.key === 'accountView');

        const container = document.createElement('div');
        row.render(container);

        expect(container.textContent).toContain('1 idle');
        expect(container.title).toContain('Alt');
    });

    test('it draws nothing rather than a zero when there is no history', () => {
        state.account = { at: NOW, currentId: 'a', characters: [], combined: [] };
        registerAccountRow();
        const row = registeredRows().find((entry) => entry.key === 'accountView');

        const container = document.createElement('div');
        row.render(container);

        expect(container.textContent).not.toContain('idle');
    });
});
