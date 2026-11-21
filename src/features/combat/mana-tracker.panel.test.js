/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ characterId: 'char1', handlers: {}, ws: {}, self: null, detailMap: {} }));

vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1000, getSetting: () => true } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => state.characterId,
        getInitClientData: () => ({ abilityDetailMap: state.detailMap }),
        on: (event, handler) => {
            state.handlers[event] = handler;
        },
        off: (event, handler) => {
            if (state.handlers[event] === handler) delete state.handlers[event];
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: vi.fn((event, handler) => {
            state.ws[event] = handler;
        }),
        off: vi.fn(),
    },
}));
vi.mock('../../core/character-abilities.js', () => ({ findOwnBattlePlayer: () => state.self }));
vi.mock('../../utils/profit-helpers.js', () => ({ resolveItemPrice: () => ({ price: null }) }));
vi.mock('../../utils/mp-optimizer.js', () => ({
    buildMpCandidates: () => [],
    findBestOptimAllocation: () => null,
    findMaxMpAllocation: () => null,
}));
vi.mock('../../utils/overlay-rows.js', () => ({ registerRow: vi.fn() }));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: vi.fn(),
    unregisterFloatingPanel: vi.fn(),
    bringPanelToFront: vi.fn(),
    isPanelFrontmost: () => true,
    cascadedPanelPosition: () => ({ left: 20, top: 20 }),
}));
vi.mock('../../utils/floating-panel.js', () => ({ makeDraggable: () => () => {}, makeResizable: () => () => {} }));
vi.mock('../../utils/panel-geometry.js', () => ({
    restoreGeometry: vi.fn(),
    saveGeometry: vi.fn(),
    saveOpenState: vi.fn(),
    reopenIfLeftOpen: vi.fn(),
}));
vi.mock('../../utils/panel-minimize.js', () => ({
    attachMinimize: ({ beforeEl }) => {
        const button = document.createElement('button');
        beforeEl.before(button);
        return { button, collapsed: false, setCollapsed: vi.fn(), destroy: () => button.remove() };
    },
}));
vi.mock('../../utils/panel-escape.js', () => ({ registerEscapeClose: () => ({ raise: vi.fn(), release: vi.fn() }) }));

const manaTracker = (await import('./mana-tracker.js')).default;
const { manaPanel, resetMpPlanner, resetManaTally } = await import('./mana-tracker.js');

describe('Mana target input', () => {
    beforeEach(() => {
        state.characterId = 'char1';
    });

    afterEach(() => {
        manaTracker.cleanup();
        manaPanel.hide({ remember: false });
        resetMpPlanner();
        vi.useRealTimers();
        document.body.replaceChildren();
    });

    test('an unsubmitted target survives the panel refresh after input loses focus', () => {
        vi.useFakeTimers();
        manaPanel.show({ remember: false });

        const input = document.querySelector('[data-mp-target="true"]');
        input.focus();
        input.value = '400';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        vi.advanceTimersByTime(3000);
        expect(document.querySelector('[data-mp-target="true"]')).toBe(input);

        input.blur();
        vi.advanceTimersByTime(3000);

        const refreshed = document.querySelector('[data-mp-target="true"]');
        expect(refreshed).not.toBe(input);
        expect(refreshed.value).toBe('400');
    });

    test('a draft-only target is cleared after switching characters while disabled', () => {
        manaTracker.initialize();
        manaPanel.show({ remember: false });
        const input = document.querySelector('[data-mp-target="true"]');
        input.value = '400';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        manaTracker.cleanup();
        state.characterId = 'char2';
        manaTracker.initialize();
        manaPanel.render();

        expect(document.querySelector('[data-mp-target="true"]').value).toBe('');
    });

    test('Calculate applies the draft, and Reset leaves the target unchanged', () => {
        manaPanel.show({ remember: false });
        let input = document.querySelector('[data-mp-target="true"]');
        input.value = '400';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-mp-calculate="true"]').click();

        input = document.querySelector('[data-mp-target="true"]');
        expect(input.value).toBe('400');

        document.querySelector('[data-reset-mana="true"]').click();
        expect(document.querySelector('[data-mp-target="true"]').value).toBe('400');
    });

    test('character changes clear an unsubmitted target draft', () => {
        manaTracker.initialize();
        manaPanel.show({ remember: false });
        const input = document.querySelector('[data-mp-target="true"]');
        input.value = '400';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        state.characterId = 'char2';
        state.handlers.character_switching();
        manaPanel.render();

        expect(document.querySelector('[data-mp-target="true"]').value).toBe('');
    });

    test('disabling and re-enabling for the same character keeps an unsubmitted target draft', () => {
        manaTracker.initialize();
        manaPanel.show({ remember: false });
        const input = document.querySelector('[data-mp-target="true"]');
        input.value = '400';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        manaTracker.cleanup();
        manaTracker.initialize();
        manaPanel.render();

        expect(document.querySelector('[data-mp-target="true"]').value).toBe('400');
    });
});

describe('the refused-casts figure on the mana panel', () => {
    const DRAIN = '/abilities/life_drain';

    afterEach(() => {
        manaTracker.cleanup();
        manaPanel.hide({ remember: false });
        resetManaTally();
        state.self = null;
        state.detailMap = {};
        vi.useRealTimers();
        document.body.replaceChildren();
    });

    const text = () => document.body.textContent;

    test('shows zero before anything is refused, and says it is an estimate', () => {
        manaPanel.show({ remember: false });
        expect(text()).toContain('Refused casts (est.)');
        expect(text()).not.toContain('could not be drawn');
        const line = [...document.querySelectorAll('[title]')].find((el) => el.title.startsWith('An estimate.'));
        expect(line).toBeTruthy();
    });

    test('a refused Life Drain is counted on the run and on its own row', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        state.detailMap = { [DRAIN]: { manaCost: 100, cooldownDuration: 10e9, name: 'Life Drain' } };
        state.self = {
            combatAbilities: [{ abilityHrid: DRAIN }],
            combatDetails: { combatStats: {} },
            currentManapoints: 500,
            attackAttemptCounter: 10,
            isPreparingAutoAttack: false,
            preparingAbilityHrid: DRAIN,
        };
        manaTracker.initialize();
        state.ws.new_battle({ battleId: 7, players: [state.self] });
        state.ws.battle_consumable_ability_updated({ ability: { abilityHrid: DRAIN } });
        state.ws.battle_updated({ battleId: 7, pMap: { 0: { atkCounter: 11, cMP: 30, isAutoAtk: true } } });
        vi.setSystemTime(11_000);
        state.ws.battle_updated({ battleId: 7, pMap: { 0: { atkCounter: 12, cMP: 30, isAutoAtk: true } } });

        manaPanel.show({ remember: false });
        expect(text()).toContain('1 refused');
        expect(text()).not.toContain('could not be drawn');
    });
});
