import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => false, Z_FLOATING_PANEL: 1100 } }));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: async () => ({}), setJSON: async () => {} } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/data-manager.js', () => ({
    default: { getItemDetails: (hrid) => (hrid === '/items/known' ? { name: 'Known Thing' } : null) },
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: () => 1 }));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));

const { formatReturn, itemName } = await import('./treasure-tracker.js');

describe('formatReturn', () => {
    test('reads as a gain or a shortfall against expectation', () => {
        expect(formatReturn(1.2).text).toBe('+20.0%');
        expect(formatReturn(0.8).text).toBe('-20.0%');
    });

    test('a run near expectation is not coloured as news', () => {
        // Every chest sits a percent or two off; colouring that would make the
        // panel a wall of red and green saying nothing
        expect(formatReturn(1.02).color).toBe(formatReturn(0.98).color);
        expect(formatReturn(1.2).color).not.toBe(formatReturn(0.8).color);
    });

    test('nothing opened is not a verdict of zero', () => {
        // A ratio of null must not render as -100%
        expect(formatReturn(null).text).toBe('—');
        expect(formatReturn(undefined).text).toBe('—');
    });
});

describe('itemName', () => {
    test('uses the game name when there is one', () => {
        expect(itemName('/items/known')).toBe('Known Thing');
    });

    test('falls back to the hrid so an unknown item still reads as something', () => {
        // Drop tables outrun the item map after a game update
        expect(itemName('/items/mystery_box')).toBe('mystery box');
    });
});
