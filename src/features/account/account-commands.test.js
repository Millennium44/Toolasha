/**
 * The Account View feature's palette wiring.
 *
 * The snapshot recorder has no lifecycle of its own — its switching listener is
 * registered once and deliberately never removed — so the feature that owns the
 * reader owns the verb too, and the thing worth pinning is that the verb comes
 * and goes with the feature rather than with the listener.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const account = vi.hoisted(() => ({
    written: true,
    snapshotCalls: 0,
    rowRegistrations: 0,
}));

vi.mock('./account-panel.js', () => ({
    accountPanel: { hide: vi.fn() },
    registerAccountRow: () => {
        account.rowRegistrations += 1;
    },
}));

vi.mock('../briefing/briefing-snapshot.js', () => ({
    initializeBriefingSnapshots: vi.fn(),
    snapshotNow: async () => {
        account.snapshotCalls += 1;
        return account.written;
    },
}));

vi.mock('./account-data.js', () => ({
    clearAccountCache: vi.fn(),
    rememberCurrentCharacter: vi.fn(async () => {}),
}));

const { default: accountFeature } = await import('./index.js');
const { registeredCommands, resetCommands } = await import('../../utils/command-registry.js');

/** @returns {Object|undefined} The verb, as the palette would see it */
const verb = () => registeredCommands().find((entry) => entry.name === 'Snapshot briefing now');

beforeEach(() => {
    resetCommands();
    account.written = true;
    account.snapshotCalls = 0;
    account.rowRegistrations = 0;
});

describe('the snapshot verb', () => {
    test('initialising offers it as a verb', async () => {
        await accountFeature.initialize();
        expect(verb()?.kind).toBe('verb');
    });

    test('switching the feature off takes it out of the palette', async () => {
        await accountFeature.initialize();
        accountFeature.cleanup();
        expect(verb()).toBeUndefined();
    });

    test('picking it writes one snapshot and says so', async () => {
        await accountFeature.initialize();

        expect(await verb().run()).toBe('snapshot written');
        expect(account.snapshotCalls).toBe(1);
    });

    test('nothing to snapshot is reported rather than claimed as a write', async () => {
        await accountFeature.initialize();
        account.written = false;

        expect(await verb().run()).toBe('no character to snapshot');
    });

    test('re-initialising does not list it twice', async () => {
        await accountFeature.initialize();
        await accountFeature.initialize();

        expect(registeredCommands().filter((entry) => entry.name === 'Snapshot briefing now')).toHaveLength(1);
    });
});
