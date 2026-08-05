/**
 * Dungeon chest → key maps
 *
 * Which key each dungeon chest costs. Two relationships, both 1:1 per chest:
 * a *regular* chest implies one entry key was spent to enter the dungeon that
 * dropped it, and *every* chest (regular or refinement) takes one chest key to
 * open.
 *
 * Shared here so combat-stats and the combat-sim adapter (and everything that
 * prices chests net of their key) read the same table instead of each keeping
 * a copy. For the dungeon-action → entry-key map, see `key-ledger.js`.
 */

/** Regular dungeon chest HRID → the entry key spent to earn it (1:1) */
export const DUNGEON_CHEST_ENTRY_KEYS = {
    '/items/chimerical_chest': '/items/chimerical_entry_key',
    '/items/sinister_chest': '/items/sinister_entry_key',
    '/items/enchanted_chest': '/items/enchanted_entry_key',
    '/items/pirate_chest': '/items/pirate_entry_key',
};

/** Dungeon chest HRID (regular and refinement) → the chest key that opens it (1:1) */
export const DUNGEON_CHEST_CHEST_KEYS = {
    '/items/chimerical_chest': '/items/chimerical_chest_key',
    '/items/sinister_chest': '/items/sinister_chest_key',
    '/items/enchanted_chest': '/items/enchanted_chest_key',
    '/items/pirate_chest': '/items/pirate_chest_key',
    '/items/chimerical_refinement_chest': '/items/chimerical_chest_key',
    '/items/sinister_refinement_chest': '/items/sinister_chest_key',
    '/items/enchanted_refinement_chest': '/items/enchanted_chest_key',
    '/items/pirate_refinement_chest': '/items/pirate_chest_key',
};
