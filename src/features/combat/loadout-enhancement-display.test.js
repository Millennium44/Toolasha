/**
 * @vitest-environment happy-dom
 *
 * The loadout panel's "+N" badge is "highest enhancement level of this item
 * currently owned", read fresh from characterItems every time it draws. But
 * nothing used to re-trigger that draw when the inventory changed without
 * also touching the DOM — enhancing the equipped copy further, a trade
 * landing, or switching to a different character (1 main + 3 ironcow sharing
 * a browser) all leave the DOM untouched while the answer changes underneath
 * it. The module relied solely on the shared childList/subtree domObserver,
 * so the badge went stale until some unrelated DOM churn happened to sweep
 * the loadout panel.
 *
 * This drives the module against `items_updated` and `character_initialized`
 * events with no DOM mutation in between, proving the badge refreshes on
 * data changes alone.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const bus = vi.hoisted(() => ({ handlers: {} }));
const state = vi.hoisted(() => ({ inventory: [] }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => key === 'loadoutEnhancementDisplay',
        onSettingChange: () => {},
        COLOR_ACCENT: '#22c55e',
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => state.inventory,
        on: (event, handler) => {
            (bus.handlers[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            bus.handlers[event] = (bus.handlers[event] || []).filter((h) => h !== handler);
        },
        emit: (event, payload) => {
            for (const handler of bus.handlers[event] || []) handler(payload);
        },
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        register: () => () => {},
        // Mirrors the real DOMObserver.onReady in its already-attached steady state
        onReady: (name, callback) => {
            callback();
            return () => {};
        },
    },
}));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('loadout enhancement display — refresh without a DOM mutation', () => {
    let loadoutEnhancementDisplay;
    let itemDiv;

    beforeEach(async () => {
        vi.resetModules();
        bus.handlers = {};
        document.body.innerHTML = '';

        state.inventory = [{ itemHrid: '/items/sword', count: 1, enhancementLevel: 3 }];

        const selectedLoadout = document.createElement('div');
        selectedLoadout.className = 'LoadoutsPanel_selectedLoadout';
        const equipDiv = document.createElement('div');
        equipDiv.className = 'LoadoutsPanel_equipment';
        itemDiv = document.createElement('div');
        itemDiv.className = 'item';
        const iconContainer = document.createElement('div');
        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        const use = document.createElementNS(svgNS, 'use');
        use.setAttribute('href', 'items_sprite.svg#sword');
        svg.appendChild(use);
        iconContainer.appendChild(svg);
        itemDiv.appendChild(iconContainer);
        equipDiv.appendChild(itemDiv);
        selectedLoadout.appendChild(equipDiv);
        document.body.appendChild(selectedLoadout);

        ({ default: loadoutEnhancementDisplay } = await import('./loadout-enhancement-display.js'));
        loadoutEnhancementDisplay.initialize();
    });

    afterEach(() => {
        loadoutEnhancementDisplay.cleanup();
        document.body.innerHTML = '';
    });

    test('shows the initially-owned highest enhancement level', () => {
        const overlay = itemDiv.querySelector('.script_loadoutEnhLevel');
        expect(overlay?.textContent).toBe('+3');
    });

    test('updates after an items_updated event with no DOM mutation', async () => {
        // Player enhances their copy further (or a higher copy arrives via trade) —
        // the loadout panel's icon href never changes, only the inventory data.
        state.inventory = [{ itemHrid: '/items/sword', count: 1, enhancementLevel: 7 }];
        bus.handlers['items_updated']?.forEach((h) => h());

        await wait(300);

        const overlay = itemDiv.querySelector('.script_loadoutEnhLevel');
        expect(overlay?.textContent).toBe('+7');
    });

    test('updates on the character event a switch can actually deliver here', async () => {
        // Switching to a different character (ironcow alt) swaps the inventory
        // data entirely; the loadout DOM the alt shares is untouched.
        //
        // It has to be `character_initialized`. Both character events are
        // deferred a tick and delivered only to listeners still registered by
        // then (data-manager.js `emit`), and an ordinary switch runs this
        // module's `cleanup()` — which unregisters them — in the teardown that
        // runs first. So a `character_switched` subscription made in
        // `initialize()` is dead on the ordinary path (where the re-init's own
        // `annotateLoadout()` covers it anyway) and dead on the rapid path
        // (two inits inside RAPID_SWITCH_WINDOW_MS skip the teardown *and*
        // never emit `character_switched`). The rapid switch is the case with
        // no re-init to fall back on, and it is `character_initialized` that
        // still arrives there — with this module's listeners intact, because
        // nothing tore them down.
        expect(bus.handlers['character_switched'] ?? []).toEqual([]);

        state.inventory = [{ itemHrid: '/items/sword', count: 1, enhancementLevel: 0 }];
        bus.handlers['character_initialized']?.forEach((h) => h({ _isCharacterSwitch: true }));

        await wait(300);

        // Highest owned level is now 0 — no badge should remain.
        expect(itemDiv.querySelector('.script_loadoutEnhLevel')).toBeNull();
    });
});
