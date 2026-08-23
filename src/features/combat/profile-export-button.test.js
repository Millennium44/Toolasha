/**
 * @vitest-environment happy-dom
 *
 * The Export to Clipboard button on a profile.
 *
 * What it puts on the clipboard is the whole point: the simulator's "Player 1
 * import" field takes the player object itself, not the five-slot wrapper the
 * export function returns, so the button has to unwrap it. The rest is the
 * button telling you which of the three things happened — copied, no data, or
 * the browser refused the clipboard.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    observers: {},
    exportResult: null,
    exportError: null,
    currentProfileId: null,
    stored: {},
    clipboard: [],
    clipboardError: null,
    alerts: [],
}));

vi.mock('./combat-sim-export.js', () => ({
    constructExportObject: vi.fn(async (profileId, singlePlayer) => {
        if (harness.exportError) throw harness.exportError;
        harness.lastCall = { profileId, singlePlayer };
        return harness.exportResult;
    }),
}));

vi.mock('../../core/config.js', () => ({ default: { COLOR_ACCENT: '#ffd700' } }));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key) => (key === 'currentProfileId' ? harness.currentProfileId : null),
        set: async (key, value) => {
            harness.stored[key] = value;
            return true;
        },
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        register: (id, callback) => {
            harness.observers[id] = callback;
            return () => delete harness.observers[id];
        },
    },
}));

const profileExportButton = (await import('./profile-export-button.js')).default;
const { constructExportObject } = await import('./combat-sim-export.js');

const button = () => document.getElementById('toolasha-profile-export-button');

/** Put a profile page on screen and let the observer notice it. */
function openProfile() {
    const tab = document.createElement('div');
    tab.className = 'SharableProfile_overviewTab__W4dCV';
    document.body.appendChild(tab);
    harness.observers['ProfileExportButton-ProfileTab']?.();
    return tab;
}

beforeEach(() => {
    document.body.innerHTML = '';
    harness.observers = {};
    harness.exportResult = { exportObj: { player: { attackLevel: 90 }, zone: '/actions/combat/fly' } };
    harness.exportError = null;
    harness.currentProfileId = null;
    harness.stored = {};
    harness.clipboard = [];
    harness.clipboardError = null;
    harness.alerts = [];
    harness.lastCall = null;
    constructExportObject.mockClear();

    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
            writeText: async (text) => {
                if (harness.clipboardError) throw harness.clipboardError;
                harness.clipboard.push(text);
            },
        },
    });
    window.alert = (message) => harness.alerts.push(message);

    profileExportButton.initialize();
});

afterEach(() => {
    // The feature holds its observers until it is told to let go; without this
    // the next initialize() is a no-op and every test after the first draws a
    // blank page, which is exactly the double-registration guard doing its job
    profileExportButton.cleanup();
    vi.useRealTimers();
});

describe('putting the button on the page', () => {
    test('it appears once the profile page does', () => {
        openProfile();

        expect(button()).toBeTruthy();
        expect(button().textContent).toBe('Export to Clipboard');
        expect(button().style.backgroundColor).toBeTruthy();
    });

    test('initialising twice does not leave two sets of observers running', () => {
        profileExportButton.initialize();
        profileExportButton.initialize();

        expect(Object.keys(harness.observers)).toHaveLength(2);

        profileExportButton.cleanup();
        expect(Object.keys(harness.observers)).toHaveLength(0);

        // Put it back for the shared afterEach
        profileExportButton.initialize();
    });

    test('no profile page, no button', () => {
        harness.observers['ProfileExportButton-ProfileTab']?.();
        expect(button()).toBeNull();
    });

    test('a second look at the same page does not add a second button', () => {
        openProfile();
        harness.observers['ProfileExportButton-ProfileTab']?.();

        expect(document.querySelectorAll('#toolasha-profile-export-button')).toHaveLength(1);
    });

    test('closing the profile forgets whose it was', async () => {
        openProfile();
        document.body.innerHTML = '';

        harness.observers['ProfileExportButton-ProfileClose']?.();
        await vi.waitFor(() => expect(harness.stored).toHaveProperty('currentProfileId'));

        expect(harness.stored.currentProfileId).toBeNull();
    });

    test('an open profile is not forgotten', async () => {
        openProfile();

        harness.observers['ProfileExportButton-ProfileClose']?.();
        await Promise.resolve();

        expect(harness.stored).not.toHaveProperty('currentProfileId');
    });
});

describe('what lands on the clipboard', () => {
    test('the player object itself, not the export wrapper', async () => {
        openProfile();

        button().click();
        await vi.waitFor(() => expect(harness.clipboard).toHaveLength(1));

        expect(JSON.parse(harness.clipboard[0])).toEqual({
            player: { attackLevel: 90 },
            zone: '/actions/combat/fly',
        });
        expect(button().textContent).toBe('✓ Copied');
    });

    test('the profile being viewed is exported, in single-player format', async () => {
        harness.currentProfileId = 'stranger';
        openProfile();

        button().click();
        await vi.waitFor(() => expect(harness.clipboard).toHaveLength(1));

        expect(harness.lastCall).toEqual({ profileId: 'stranger', singlePlayer: true });
    });

    test('your own data is exported when no profile is being viewed', async () => {
        openProfile();

        button().click();
        await vi.waitFor(() => expect(harness.clipboard).toHaveLength(1));

        expect(harness.lastCall).toEqual({ profileId: null, singlePlayer: true });
    });

    test('the button goes back to normal after its moment of triumph', async () => {
        vi.useFakeTimers();
        openProfile();

        button().click();
        await vi.waitFor(() => expect(harness.clipboard).toHaveLength(1));
        vi.advanceTimersByTime(3000);

        expect(button().textContent).toBe('Export to Clipboard');
        expect(button().style.backgroundColor).toBe('#ffd700');
    });
});

describe('when there is nothing to copy', () => {
    test('no export data says so on the button and in a dialog', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        harness.exportResult = null;
        openProfile();

        button().click();
        await vi.waitFor(() => expect(harness.alerts).toHaveLength(1));

        expect(button().textContent).toBe('✗ No Data');
        expect(harness.clipboard).toHaveLength(0);
        expect(harness.alerts[0]).toContain('No character data found');
        error.mockRestore();
    });

    test('a refused clipboard is explained as a permission problem', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        harness.clipboardError = Object.assign(new Error('nope'), { name: 'NotAllowedError' });
        openProfile();

        button().click();
        await vi.waitFor(() => expect(harness.alerts).toHaveLength(1));

        expect(button().textContent).toBe('✗ Failed');
        expect(harness.alerts[0]).toContain('Clipboard access denied');
        error.mockRestore();
    });

    test('any other failure is reported with its message', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        harness.exportError = new Error('the sim exploded');
        openProfile();

        button().click();
        await vi.waitFor(() => expect(harness.alerts).toHaveLength(1));

        expect(button().textContent).toBe('✗ Failed');
        expect(harness.alerts[0]).toBe('Export failed: the sim exploded');
        error.mockRestore();
    });

    test('a failed button recovers so it can be tried again', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.useFakeTimers();
        harness.exportResult = null;
        openProfile();

        button().click();
        await vi.waitFor(() => expect(harness.alerts).toHaveLength(1));
        vi.advanceTimersByTime(3000);

        expect(button().textContent).toBe('Export to Clipboard');
        error.mockRestore();
    });
});
