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
const state = vi.hoisted(() => ({ account: null }));

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
    };
}

const text = () => accountPanel.panel?.textContent || '';

beforeEach(() => {
    store.data = {};
    state.account = sampleAccount();
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
