/**
 * "Open in sim" on the game's View Loadout modal.
 *
 * The game opens a "<Name>'s Loadout" modal from the party member menu and the
 * guild trial roster. This puts a button beside that title which loads the
 * player into the sim editor: gear, abilities, consumables and triggers from the
 * loadout the game just shared, skill levels, house and buffs from their cached
 * shared profile when Toolasha has one — and the editor says which, and says so
 * when there is no profile to take levels from.
 *
 * Found by its title text through `findLoadoutModals`, never by a hashed class
 * beyond the modal container (`SharableProfile_modalContainer` on the build measured),
 * and only on a game build that has View Loadout.
 */

import domObserver from '../../core/dom-observer.js';
import combatSimUI from './combat-sim-ui.js';
import { buildPlayerDTOFromLoadout } from './combat-sim-adapter.js';
import { findLoadoutModals, getLoadout, isViewLoadoutAvailable } from '../../utils/view-loadout.js';
import { formatProfileAge, profileAgeMs } from '../../utils/shared-profile-status.js';

export const LOADOUT_SIM_BUTTON_CLASS = 'toolasha-loadout-sim-btn';

/**
 * The editor note for a player opened from their loadout.
 * @param {string} name
 * @param {{levelsFrom: 'profile'|null, profileCapturedAt: number|null}} built
 * @returns {string}
 */
export function loadoutSimNote(name, built) {
    if (built.levelsFrom === 'profile') {
        const age = formatProfileAge(profileAgeMs(built.profileCapturedAt));
        return (
            `${name}: gear, abilities and consumables from their loadout; skill levels, house and ` +
            `buffs from their cached profile (${age}).`
        );
    }
    return (
        `${name}: gear, abilities and consumables from their loadout. No cached profile, so skill ` +
        'levels are 1 and house and buffs are empty — open their profile in game, then Open in sim again.'
    );
}

/**
 * Show a short failure on the button, then put its label back.
 * @param {HTMLButtonElement} button
 * @param {string} text
 */
function flash(button, text) {
    button.textContent = text;
    setTimeout(() => {
        button.textContent = 'Open in sim';
    }, 3000);
}

/**
 * Load a player's captured loadout into the sim editor.
 * @param {string} name - The player's name, as the modal title states it
 * @param {HTMLButtonElement} [button] - Where to report a failure
 * @returns {Promise<boolean>} True when the sim was opened
 */
export async function openLoadoutInSim(name, button = null) {
    try {
        const entry = getLoadout(name);
        if (!entry || !entry.hasLoadout) {
            if (button) flash(button, entry ? 'No loadout set' : 'No loadout captured');
            return false;
        }
        const built = await buildPlayerDTOFromLoadout(entry);
        if (!built) {
            if (button) flash(button, 'No game data');
            return false;
        }
        const playerName = entry.name || name;
        combatSimUI.openWithExternalDTO(built.dto, playerName, { note: loadoutSimNote(playerName, built) });
        return true;
    } catch (error) {
        console.error('[LoadoutSimButton] Opening the loadout in the sim failed:', error);
        if (button) flash(button, 'Failed');
        return false;
    }
}

/**
 * Add the button to every open loadout modal that lacks one.
 * @param {ParentNode} [root=document]
 * @returns {number} Buttons added
 */
export function injectLoadoutSimButtons(root = document) {
    if (!isViewLoadoutAvailable()) return 0;
    let added = 0;
    for (const modal of findLoadoutModals(root)) {
        if (modal.container.querySelector(`.${LOADOUT_SIM_BUTTON_CLASS}`)) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = LOADOUT_SIM_BUTTON_CLASS;
        button.textContent = 'Open in sim';
        button.title = "Load this loadout into Toolasha's combat sim";
        button.style.cssText =
            'margin-left:8px; padding:2px 8px; border-radius:4px; border:none; cursor:pointer; font-size:12px; ' +
            'color:#fff; background:linear-gradient(135deg, #3a7bd5, #5f3dc4); font-family:inherit;';
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            openLoadoutInSim(modal.name, button);
        });
        modal.title.insertAdjacentElement('afterend', button);
        added++;
    }
    return added;
}

/**
 * Watch for loadout modals. Idempotent per returned stop function.
 * @returns {() => void} Stop watching and remove the buttons
 */
export function watchLoadoutModals() {
    const unregisterers = [
        domObserver.onClass(
            'LoadoutSimButton',
            [
                'SharableProfile_modalContainer',
                'SharableProfile_modalContent',
                'Modal_modalContainer',
                'Modal_modalContent',
            ],
            () => injectLoadoutSimButtons(),
            { debounce: true, debounceDelay: 100 }
        ),
        domObserver.onReady('LoadoutSimButtonCatchUp', () => injectLoadoutSimButtons()),
    ];
    return () => {
        for (const unregister of unregisterers) unregister();
        document.querySelectorAll(`.${LOADOUT_SIM_BUTTON_CLASS}`).forEach((button) => button.remove());
    };
}
