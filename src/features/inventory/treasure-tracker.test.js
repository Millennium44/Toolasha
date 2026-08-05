/** @vitest-environment happy-dom */

import { describe, test, expect, afterEach, vi } from 'vitest';

/** Whether the panel is being drawn for a finger or a cursor */
const pointer = vi.hoisted(() => ({ touch: false }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (id, fallback) => fallback, Z_FLOATING_PANEL: 1100 },
}));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: async () => ({}), setJSON: async () => {} } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => (hrid === '/items/known' ? { name: 'Known Thing' } : null),
        getInitClientData: () => ({ openableLootDropMap: {} }),
        getCurrentCharacterId: () => 'char-1',
        getCurrentCharacterGameMode: () => 'standard',
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../utils/mobile.js', () => ({
    isMobileMode: () => pointer.touch,
    hasCoarsePointer: () => pointer.touch,
    detectedModeLabel: () => (pointer.touch ? 'mobile' : 'desktop'),
}));
// Geometry lives in IndexedDB and is never what these tests are about
vi.mock('../../utils/panel-geometry.js', () => ({
    restoreGeometry: async () => {},
    saveGeometry: () => {},
    clearPosition: () => {},
    saveOpenState: () => {},
    reopenIfLeftOpen: () => {},
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

describe('the header on a screen too narrow for it', () => {
    // A phone is about 400px wide. The header carries a title, two value
    // chips, a gear, a sort picker and a close button, which is more than fits
    // — and the one that fell off the end was the way out of the panel.
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

    /**
     * @param {HTMLElement} header - A built header
     * @returns {HTMLElement|undefined} The close button
     */
    const closeButton = (header) => [...header.querySelectorAll('button')].find((b) => b.textContent === '✕');

    afterEach(() => {
        pointer.touch = false;
    });

    test('the controls wrap instead of pushing each other off the side', () => {
        expect(build().style.flexWrap).toBe('wrap');
    });

    test('the close button is out of the flow, pinned to the corner', () => {
        const close = closeButton(build());

        expect(close.style.position).toBe('absolute');
        expect(close.style.right).toBeTruthy();
        expect(close.style.top).toBeTruthy();
    });

    test('and nothing flows underneath it', () => {
        const header = build();

        expect(parseFloat(header.style.paddingRight)).toBeGreaterThanOrEqual(28);
    });

    test('a finger gets something it can hit', () => {
        pointer.touch = true;
        const header = build();

        expect(parseFloat(closeButton(header).style.minWidth)).toBeGreaterThanOrEqual(32);
        expect(parseFloat(closeButton(header).style.minHeight)).toBeGreaterThanOrEqual(32);
        // The gutter has to grow with the button, or the picker runs under it
        expect(parseFloat(header.style.paddingRight)).toBeGreaterThanOrEqual(32);
    });

    test('pressing it closes the panel', () => {
        const hide = vi.spyOn(treasureTracker, 'hide').mockImplementation(() => {});
        closeButton(build()).click();

        expect(hide).toHaveBeenCalled();
        hide.mockRestore();
    });
});

describe('the popup’s header is the panel’s header', () => {
    // The popup is a second header built by a second method, and it got none of
    // the treatment the panel's did — its ✕ sat in the flow beside a title that
    // is a chest name, so the fix that pinned one of them left the other one
    // able to regress in exactly the same way
    const opening = { opened: 1, ratio: 1.1, actualValue: 45440, items: [] };
    const lifetime = { opened: 12, ratio: 0.98, actualValue: 500000 };
    const build = () => treasureTracker._buildPopup('/items/known', opening, lifetime);
    const header = (popup) => popup.firstChild;
    const closeButton = (popup) => [...popup.querySelectorAll('button')].find((b) => b.textContent === '✕');

    afterEach(() => {
        treasureTracker._removePopup();
        pointer.touch = false;
    });

    test('the title wraps instead of pushing the close button off the side', () => {
        expect(header(build()).style.flexWrap).toBe('wrap');
    });

    test('the close button is out of the flow, pinned to the corner', () => {
        const popup = build();
        const close = closeButton(popup);

        expect(close.style.position).toBe('absolute');
        expect(close.style.right).toBeTruthy();
        expect(close.style.top).toBeTruthy();
    });

    test('and nothing flows underneath it', () => {
        expect(parseFloat(header(build()).style.paddingRight)).toBeGreaterThanOrEqual(28);
    });

    test('a finger gets something it can hit', () => {
        pointer.touch = true;
        const popup = build();

        expect(parseFloat(closeButton(popup).style.minWidth)).toBeGreaterThanOrEqual(32);
        expect(parseFloat(closeButton(popup).style.minHeight)).toBeGreaterThanOrEqual(32);
        expect(parseFloat(header(popup).style.paddingRight)).toBeGreaterThanOrEqual(32);
    });

    test('pressing it takes the popup away', () => {
        const popup = build();
        document.body.appendChild(popup);
        treasureTracker.popup = popup;

        closeButton(popup).click();

        expect(document.getElementById(popup.id)).toBe(null);
    });
});

describe('the button in settings', () => {
    afterEach(() => {
        treasureTracker.panel = null;
        document.body.replaceChildren();
    });

    test('opens the panel, and the second press closes it again', () => {
        treasureTracker.settings = {
            capeValue: 'token',
            valueCowbells: true,
            hiddenChests: [],
            popupPinned: false,
            sortMode: 'luck',
        };

        treasureTracker.toggle();
        expect(document.getElementById('toolasha-treasure-panel')).not.toBe(null);

        treasureTracker.toggle();
        expect(document.getElementById('toolasha-treasure-panel')).toBe(null);
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
