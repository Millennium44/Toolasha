/**
 * Room skills
 *
 * Which skill's artwork stands for a house room.
 *
 * A room is recognised by its skill far faster than by its name — a sword says
 * Dojo before "Dojo" has been read, a milk bottle says Dairy Barn — and the game
 * has artwork for every skill but none for a room. JHouse makes the same
 * association; this is its map.
 *
 * Hardcoded because the room detail the game sends does not carry the link. A
 * room the game adds and this does not know falls back to its own name, which
 * finds no sprite and draws a spacer: a missing icon rather than a wrong one.
 *
 * Pure data and one lookup, on purpose. Both panels that draw rooms — the Houses
 * panel and the equipment savings row — used to carry their own copy of this,
 * because the module the first one lives in does work at import time and the
 * second one could not afford to pull that in for a map of seventeen strings.
 * Nothing here runs at import, so there is nothing left to avoid.
 */

/** Room name (the tail of its hrid) → the skill whose sprite stands for it */
export const ROOM_SKILLS = {
    dairy_barn: 'milking',
    garden: 'foraging',
    log_shed: 'woodcutting',
    forge: 'cheesesmithing',
    workshop: 'crafting',
    sewing_parlor: 'tailoring',
    kitchen: 'cooking',
    brewery: 'brewing',
    laboratory: 'alchemy',
    observatory: 'enhancing',
    dining_room: 'stamina',
    library: 'intelligence',
    dojo: 'attack',
    armory: 'defense',
    gym: 'melee',
    archery_range: 'ranged',
    mystical_study: 'magic',
};

/**
 * The skill sprite that stands for a room.
 * @param {string} houseRoomHrid - The room, e.g. `/house_rooms/dojo`
 * @returns {string} The skill sprite's id, or the room's own name when it is not
 *   one this knows
 */
export function roomSkill(houseRoomHrid) {
    const key = String(houseRoomHrid || '')
        .split('/')
        .pop();
    return ROOM_SKILLS[key] || key;
}
