/**
 * @vitest-environment happy-dom
 *
 * Chest key zone labels ("5·7·8·10") used to sit top-left in one line (a
 * previous fix moved them there to get them off the bottom row), which
 * collided with the ask/bid stack-value badge inventory-sort.js draws
 * top-right: on a tile as narrow as the game's inventory icons the two ran
 * together ("5·7·8·1043M").
 *
 * Moving the whole label to bottom-left (matching entry keys) traded one
 * collision for another: verified live on the test server, a chest key
 * stack routinely runs 5 digits ("10000"), and that count sits bottom-right
 * — a one-line "10·11" ran straight into it.
 *
 * The label now stays top-left (where nothing else on the tile reaches from
 * the left) and wraps two zones per line, capped at a max-width so it can't
 * grow into the top-right value badge even in a worst case. Entry keys
 * ("D1"–"D4") are short enough already and are unaffected — bottom-left,
 * one line, as before this whole label ever moved.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = { itemIconLevel: false, showsKeyInfoInIcon: true };

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settings[key] ?? false,
        onSettingChange: () => {},
        SCRIPT_COLOR_MAIN: '#22c55e',
        COLOR_ACCENT: '#22c55e',
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        // A key/fragment has item details too — just neither equipmentDetail nor
        // abilityBookDetail — so addItemLevels falls through to the key branch.
        getItemDetails: () => ({}),
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        register: () => () => {},
        onClass: () => () => {},
        onReady: (name, callback) => {
            callback();
            return () => {};
        },
    },
}));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeItemContainer(hrefName) {
    const container = document.createElement('div');
    container.className = 'Item_itemContainer__x7kH1';
    container.innerHTML = `
        <div class="Item_item__2De2O Item_clickable__3viV6">
            <svg><use href="#${hrefName}"></use></svg>
        </div>
    `;
    return container;
}

describe('equipment level display — chest key zone label placement', () => {
    let equipmentLevelDisplay;

    beforeEach(async () => {
        vi.resetModules();
        document.body.innerHTML = '';
        ({ default: equipmentLevelDisplay } = await import('./equipment-level-display.js'));
    });

    afterEach(() => {
        equipmentLevelDisplay.disable();
        document.body.innerHTML = '';
    });

    test('chest key label sits top-left, wrapped two zones per line, width-capped', async () => {
        const container = document.body.appendChild(makeItemContainer('sinister_chest_key'));
        equipmentLevelDisplay.initialize();
        await wait(0);

        const overlay = container.querySelector('.script_itemLevel');
        expect(overlay).toBeTruthy();

        // Anchored top-left, never bottom-anchored (where a 5-digit stack count can
        // sit, bottom-right) and never right-anchored (where the ask/bid stack-value
        // badge sits, top-right).
        expect(overlay.style.cssText).toMatch(/top:\s*2px/);
        expect(overlay.style.cssText).toMatch(/left:\s*2px/);
        expect(overlay.style.cssText).not.toMatch(/bottom:/);
        expect(overlay.style.cssText).not.toMatch(/right:/);

        // Wrapped two zones per line rather than one long "5·7·8·10" line, and
        // width-capped so it can't grow into the value badge's corner even in a
        // worst case.
        expect(overlay.innerHTML).toBe('5·7<br>8·10');
        expect(overlay.querySelectorAll('br')).toHaveLength(1);
        expect(overlay.style.cssText).toMatch(/max-width:\s*55%/);
    });

    test('entry key label stays a single line, bottom-left', async () => {
        const container = document.body.appendChild(makeItemContainer('sinister_entry_key'));
        equipmentLevelDisplay.initialize();
        await wait(0);

        const overlay = container.querySelector('.script_itemLevel');
        expect(overlay).toBeTruthy();
        expect(overlay.textContent).toBe('D2');
        expect(overlay.querySelectorAll('br')).toHaveLength(0);
        expect(overlay.style.cssText).toMatch(/bottom:\s*2px/);
        expect(overlay.style.cssText).toMatch(/left:\s*2px/);
    });
});
