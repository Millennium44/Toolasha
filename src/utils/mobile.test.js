/**
 * Whether this is a touch device, and whether to act like it.
 *
 * The fact and the choice are tested apart, because they are apart on purpose:
 * hardware detection keys sizing that is wrong on the other kind of pointer,
 * and the setting exists for the person whose hardware detection gets it wrong.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ coarse: false, mode: 'auto' }));

vi.mock('../core/config.js', () => ({
    default: { getSettingValue: (key, fallback) => (key === 'mobileMode' ? state.mode : fallback) },
}));

const { hasCoarsePointer, isMobileMode } = await import('./mobile.js');

beforeEach(() => {
    state.coarse = false;
    state.mode = 'auto';
    vi.stubGlobal('matchMedia', (query) => ({ matches: query.includes('coarse') && state.coarse }));
});

describe('the hardware fact', () => {
    test('a finger is coarse', () => {
        state.coarse = true;

        expect(hasCoarsePointer()).toBe(true);
    });

    test('a browser without matchMedia is a desktop, not a crash', () => {
        vi.stubGlobal('matchMedia', undefined);

        expect(hasCoarsePointer()).toBe(false);
    });
});

describe('the choice', () => {
    test('auto follows the hardware', () => {
        state.coarse = true;
        expect(isMobileMode()).toBe(true);

        state.coarse = false;
        expect(isMobileMode()).toBe(false);
    });

    test('on is on, whatever the pointer', () => {
        // Testing a mobile layout from a desktop needs this to be possible
        state.mode = 'on';

        expect(isMobileMode()).toBe(true);
    });

    test('off is off, even on a touchscreen', () => {
        // The touchscreen laptop that wants desktop layouts is exactly the
        // machine auto-detection gets wrong
        state.coarse = true;
        state.mode = 'off';

        expect(isMobileMode()).toBe(false);
    });
});
