/** @vitest-environment happy-dom
 *
 * "Open in sim" on the game's View Loadout modal: only on a build that has View
 * Loadout, only on the loadout modal, and it says where the levels came from.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ core: null, opened: [], built: null }));

vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => 1 } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {}, onReady: () => () => {} } }));
vi.mock('../../utils/profile-command.js', () => ({ getGameCore: () => state.core }));
vi.mock('./combat-sim-ui.js', () => ({
    default: { openWithExternalDTO: (dto, name, options) => state.opened.push({ dto, name, options }) },
}));
vi.mock('./combat-sim-adapter.js', () => ({ buildPlayerDTOFromLoadout: async () => state.built }));

const { injectLoadoutSimButtons, openLoadoutInSim, LOADOUT_SIM_BUTTON_CLASS } = await import('./loadout-sim-button.js');
const { handleLoadoutShared, _resetViewLoadout } = await import('../../utils/view-loadout.js');

/** The game's loadout modal */
function openModal(name) {
    const container = document.createElement('div');
    container.className = 'Modal_modalContainer__abc';
    container.innerHTML = `<div class="Modal_modalContent__def">
        <div class="LoadoutModal_title__y">${name}'s Loadout</div>
        <button class="Modal_closeButton__ghi">×</button>
    </div>`;
    document.body.appendChild(container);
    return container;
}

const loadout = (characterID, name) => ({
    sharableCharacter: { name },
    hasLoadout: true,
    wearableItemMap: {
        '/item_locations/main_hand': {
            itemLocationHrid: '/item_locations/main_hand',
            itemHrid: '/items/rippling_trident',
            enhancementLevel: 7,
            count: 1,
            characterID,
        },
    },
    equippedAbilities: [],
    combatConsumables: [],
    abilityCombatTriggersMap: {},
    consumableCombatTriggersMap: {},
});

beforeEach(() => {
    _resetViewLoadout();
    document.body.innerHTML = '';
    state.core = { handleViewProfile: () => {}, handleViewLoadout: () => {} };
    state.opened = [];
    state.built = { dto: { hrid: 'x' }, levelsFrom: 'profile', profileCapturedAt: Date.now() };
});

describe('the Open in sim button', () => {
    test('is added to the loadout modal once, and not to other modals', () => {
        const modal = openModal('Ally');
        const other = document.createElement('div');
        other.className = 'Modal_modalContainer__abc';
        other.textContent = 'Settings';
        document.body.appendChild(other);

        expect(injectLoadoutSimButtons()).toBe(1);
        expect(injectLoadoutSimButtons()).toBe(0);
        expect(modal.querySelectorAll(`.${LOADOUT_SIM_BUTTON_CLASS}`)).toHaveLength(1);
        expect(other.querySelector(`.${LOADOUT_SIM_BUTTON_CLASS}`)).toBeNull();
    });

    test('is never added on a game build without View Loadout', () => {
        state.core = { handleViewProfile: () => {} };
        openModal('Ally');

        expect(injectLoadoutSimButtons()).toBe(0);
        expect(document.querySelector(`.${LOADOUT_SIM_BUTTON_CLASS}`)).toBeNull();
    });

    test('opens the captured loadout in the sim, naming where the levels came from', async () => {
        handleLoadoutShared({ type: 'loadout_shared', loadout: loadout(7, 'Ally') });

        expect(await openLoadoutInSim('Ally')).toBe(true);
        expect(state.opened[0].name).toBe('Ally');
        expect(state.opened[0].options.note).toContain('cached profile');
    });

    test('says the levels are unknown when there is no profile', async () => {
        handleLoadoutShared({ type: 'loadout_shared', loadout: loadout(7, 'Ally') });
        state.built = { dto: { hrid: 'x' }, levelsFrom: null, profileCapturedAt: null };

        await openLoadoutInSim('Ally');
        expect(state.opened[0].options.note).toContain('No cached profile');
    });

    test('opens nothing for a player with no loadout captured', async () => {
        const button = document.createElement('button');
        expect(await openLoadoutInSim('Nobody', button)).toBe(false);
        expect(button.textContent).toBe('No loadout captured');
        expect(state.opened).toEqual([]);
    });
});
