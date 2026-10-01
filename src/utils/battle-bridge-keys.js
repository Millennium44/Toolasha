/**
 * GM-storage keys for the `new_battle` bridge.
 *
 * GM storage is shared by every game tab, so one battle key would let a second tab's fight
 * replace the one a simulator was just opened for. The battle is stored per character instead;
 * the unsuffixed key is the legacy slot an external simulator page reads directly, written only
 * when a simulator is opened from a game tab.
 */

/** Legacy shared payload key (its `_meta` sibling carries the owner stamp). */
export const BATTLE_BRIDGE_KEY = 'toolasha_new_battle';

/** GM key holding the character ids that currently have a per-character battle, newest first. */
export const BATTLE_BRIDGE_INDEX_KEY = 'toolasha_new_battle_index';

/** Most characters kept in the per-character battle bridge; older ones are deleted on write. */
export const MAX_BATTLE_BRIDGE_CHARACTERS = 6;

/**
 * Payload key for one character's bridged battle.
 * @param {string|number} characterId - Character the battle belongs to
 * @returns {string} GM key; its owner stamp lives at `${key}_meta`
 */
export function battleBridgeKeyFor(characterId) {
    return `${BATTLE_BRIDGE_KEY}:${characterId}`;
}
