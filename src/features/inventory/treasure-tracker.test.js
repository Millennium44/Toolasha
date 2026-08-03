/** @vitest-environment happy-dom */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => false, Z_FLOATING_PANEL: 1100 } }));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: async () => ({}), setJSON: async () => {} } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/data-manager.js', () => ({
    default: { getItemDetails: (hrid) => (hrid === '/items/known' ? { name: 'Known Thing' } : null) },
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: () => 1, getPricingMode: () => 'bid' }));
// Pricing untradables at their token cost reaches the market API, which opens a
// socket on import; the unit under test here is the formatting, not the pricing
vi.mock('../../utils/token-valuation.js', () => ({ calculateDungeonTokenValue: () => 0 }));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));

const {
    formatReturn,
    itemName,
    worthShowing,
    capHeightToWindow,
    pricingBasis,
    default: treasureTracker,
} = await import('./treasure-tracker.js');

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

describe('which drop-table rows are worth a line', () => {
    const row = (actualCount, expectedCount) => ({ actualCount, expectedCount });

    test('a rare that came is kept however unlikely it was', () => {
        // Precisely the row worth seeing — one in eight thousand, and it landed
        expect(worthShowing([row(1, 0.0001)])).toHaveLength(1);
    });

    test('an expectation that rounds to nothing and did not drop is dropped', () => {
        // It would read "0, 0.00 expected, -100%" — three figures agreeing that
        // nothing happened, pushing the rows that did happen off the bottom
        expect(worthShowing([row(0, 0.004)])).toHaveLength(0);
        expect(worthShowing([row(0, 0)])).toHaveLength(0);
    });

    test('an expectation big enough to print is kept even at zero', () => {
        // "0 of 0.12 expected" is a real statement about a rare not turning up
        expect(worthShowing([row(0, 0.12)])).toHaveLength(1);
        expect(worthShowing([row(0, 0.005)])).toHaveLength(1);
    });

    test('nothing at all is nothing, not a crash', () => {
        expect(worthShowing([])).toEqual([]);
        expect(worthShowing(null)).toEqual([]);
    });
});

describe('the popup gets a height of its own', () => {
    const popup = (natural) => ({
        offsetHeight: natural,
        getBoundingClientRect: () => ({ height: natural }),
        style: {},
    });

    test('a short popup keeps the height it wants', () => {
        const element = popup(220);
        capHeightToWindow(element, 1000);

        expect(element.style.height).toBe('220px');
    });

    test('a chest with thirty drop-table rows is cut to fit the window', () => {
        const element = popup(2000);
        capHeightToWindow(element, 600);

        expect(element.style.height).toBe('420px');
    });

    test('and to the cap on a tall screen, so it does not run the full height', () => {
        const element = popup(2000);
        capHeightToWindow(element, 1600);

        expect(element.style.height).toBe('560px');
    });

    test('it writes height rather than max-height', () => {
        // The bug: the resize grip writes `height`, so a `max-height` above it
        // meant dragging the corner downwards changed a number nothing rendered
        const element = popup(2000);
        capHeightToWindow(element, 1000);

        expect(element.style.maxHeight).toBeUndefined();
        expect(element.style.height).toBeTruthy();
    });
});

describe('the header when the settings arrive late', () => {
    // The panel is reopened at start-up and builds its header before the
    // settings come back from storage, so the header sat there claiming the
    // defaults until it was closed and opened again
    const build = () => {
        treasureTracker.settings = {
            capeValue: 'token',
            valueCowbells: true,
            hiddenChests: [],
            popupPinned: false,
            sortMode: 'luck',
        };
        return treasureTracker._createHeader();
    };

    test('the toggles catch up', () => {
        const header = build();
        expect(header.textContent).toContain('Token value');
        expect(header.textContent).toContain('Cowbells counted');

        treasureTracker.settings.capeValue = 'zero';
        treasureTracker.settings.valueCowbells = false;
        treasureTracker._refreshToggles();

        expect(header.textContent).toContain('No value');
        expect(header.textContent).toContain('Cowbells at zero');
    });

    test('and so does the sort picker', () => {
        build();
        treasureTracker.settings.sortMode = 'name';
        treasureTracker._refreshToggles();

        expect(treasureTracker.sortPicker.value).toBe('name');
    });

    test('a stored order the list no longer offers falls back rather than blanking', () => {
        build();
        treasureTracker.settings.sortMode = 'by-vibes';
        treasureTracker._refreshToggles();

        expect(treasureTracker.sortPicker.value).toBe('luck');
    });
});

describe('which side of the book the figures are', () => {
    test('is said, because it is a setting rather than a constant', () => {
        // TReasure always prices at bid and says "bid"; Toolasha follows the
        // profit pricing mode, so the same chest can be worth two different
        // numbers and neither of them is wrong
        expect(pricingBasis()).toBe('bid');
    });
});
