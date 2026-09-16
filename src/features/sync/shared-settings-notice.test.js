/**
 * The one message the player gets about the device-wide carry-over.
 *
 * What these pin: a disagreement is never silent, a palette's worth of them is
 * still readable, the advice fits what actually got left behind, and the record
 * is cleared so it is shown once rather than every load.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ record: null, cleared: 0, toasts: [] }));

vi.mock('../../core/settings-storage.js', () => ({
    default: {
        sharedScopeConflicts: async () => state.record,
        clearSharedScopeConflicts: async () => {
            state.cleared += 1;
        },
    },
}));

vi.mock('../../utils/toast.js', () => ({
    showToast: (message, options) => state.toasts.push({ message, options }),
}));

const { showSharedSettingsNotice } = await import('./shared-settings-notice.js');

/** One conflict record entry */
function conflict(id, { resolved = true, winner = 'Alice', characters = ['Alice', 'Bob'] } = {}) {
    return { id, resolved, winner, characters };
}

beforeEach(() => {
    state.record = null;
    state.cleared = 0;
    state.toasts = [];
});

describe('the carry-over notice', () => {
    test('nothing to say means nothing shown and nothing cleared', async () => {
        expect(await showSharedSettingsNotice()).toBe(false);
        expect(state.toasts).toHaveLength(0);
        expect(state.cleared).toBe(0);
    });

    test('a resolved disagreement names the setting, the winner, and where the loser went', async () => {
        state.record = { at: 1, conflicts: [conflict('sync_token')] };

        expect(await showSharedSettingsNotice()).toBe(true);

        const { message, options } = state.toasts[0];
        expect(message).toContain('shared by every character on this device');
        expect(message).toContain('Alice');
        expect(message).toContain('still on the characters that had them');
        expect(options.kind).toBe('warn');
        expect(state.cleared).toBe(1);
    });

    test('a palette-sized disagreement names a few and counts the rest', async () => {
        const ids = [
            'color_profit',
            'color_loss',
            'color_warning',
            'color_info',
            'color_essence',
            'color_gold',
            'color_accent',
        ];
        state.record = { at: 1, conflicts: ids.map((id) => conflict(id)) };

        await showSharedSettingsNotice();

        const { message } = state.toasts[0];
        // Three named, four counted — not seven sentences nobody reads
        expect(message).toContain('and 4 more');
        expect(message).not.toContain('color_essence');
        expect(message.length).toBeLessThan(500);
    });

    test('an undecided color is not sent to the sync copy button', async () => {
        state.record = {
            at: 1,
            conflicts: [conflict('color_profit', { resolved: false, winner: null, characters: ['Bob', 'Carol'] })],
        };

        await showSharedSettingsNotice();

        const { message } = state.toasts[0];
        expect(message).toContain('Bob, Carol');
        expect(message).toContain('re-pick them there');
        expect(message).not.toContain('Copy sync setup');
    });

    test('an undecided token still points at the button that copies one', async () => {
        state.record = {
            at: 1,
            conflicts: [conflict('sync_token', { resolved: false, winner: null, characters: ['Bob', 'Carol'] })],
        };

        await showSharedSettingsNotice();

        expect(state.toasts[0].message).toContain('Copy sync setup');
    });

    test('resolved and undecided are reported in one message, not two', async () => {
        state.record = {
            at: 1,
            conflicts: [
                conflict('color_profit'),
                conflict('color_loss', { resolved: false, winner: null, characters: ['Bob', 'Carol'] }),
            ],
        };

        await showSharedSettingsNotice();

        expect(state.toasts).toHaveLength(1);
        expect(state.toasts[0].message).toContain('this device now uses Alice');
        expect(state.toasts[0].message).toContain('were left alone');
    });
});
