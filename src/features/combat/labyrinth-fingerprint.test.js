/**
 * The fingerprint's version rules. Records key on the value and are split into
 * cohorts by the stamp, so these pin what an absent, malformed or mismatched
 * version reads as, and that the level part is stable and complete.
 */

import { describe, test, expect } from 'vitest';
import {
    FINGERPRINT_VERSION,
    FINGERPRINT_PREFIX,
    FINGERPRINT_SPEC,
    SIM_COMBAT_SKILLS,
    fingerprintVersionOf,
    isCurrentFingerprintVersion,
    ABILITY_SLOTS,
    combatLevelsPart,
    abilitiesPart,
    houseRoomsPart,
    fingerprintInput,
    tagFingerprint,
} from './labyrinth-fingerprint.js';

const levels = (over = {}) => ({
    stamina: 90,
    intelligence: 80,
    attack: 95,
    defense: 92,
    melee: 99,
    ranged: 1,
    magic: 1,
    ...over,
});

describe('fingerprintVersionOf', () => {
    test('a record without the field is version 1 — the gear-only fingerprint', () => {
        expect(fingerprintVersionOf({})).toBe(1);
        expect(fingerprintVersionOf(null)).toBe(1);
        expect(fingerprintVersionOf(undefined)).toBe(1);
    });

    test('a stamped record reads its stamp', () => {
        expect(fingerprintVersionOf({ fingerprintVersion: 2 })).toBe(2);
        expect(fingerprintVersionOf({ fingerprintVersion: 3 })).toBe(3);
        expect(fingerprintVersionOf({ fingerprintVersion: 7 })).toBe(7);
    });

    test('a malformed stamp is not trusted, and reads as the pre-migration cohort', () => {
        // Number(null) is 0 and Number(undefined) is NaN, so the field is
        // checked for being a positive integer before it is believed
        for (const bad of [null, 0, -1, 1.5, '2', NaN, {}, true]) {
            expect(fingerprintVersionOf({ fingerprintVersion: bad })).toBe(1);
        }
    });
});

describe('isCurrentFingerprintVersion', () => {
    test('only an exact match is current', () => {
        expect(isCurrentFingerprintVersion({ fingerprintVersion: FINGERPRINT_VERSION })).toBe(true);
        expect(isCurrentFingerprintVersion({})).toBe(false);
    });

    test('v1, v2 and v3 are three cohorts, none poolable with another', () => {
        // Each bump changed what is hashed, so a record from an older version
        // describes a character the current sim is not simulating
        expect(FINGERPRINT_VERSION).toBe(3);
        for (const version of [1, 2]) {
            expect(isCurrentFingerprintVersion({ fingerprintVersion: version })).toBe(false);
        }
        // And measured against each other, not just against the current one
        expect(isCurrentFingerprintVersion({ fingerprintVersion: 2 }, 3)).toBe(false);
        expect(isCurrentFingerprintVersion({ fingerprintVersion: 3 }, 2)).toBe(false);
        expect(isCurrentFingerprintVersion({}, 2)).toBe(false);
    });

    test('a newer version is no more poolable than an older one', () => {
        // A record synced from a build ahead of this one describes a
        // fingerprint this build cannot compute, so it is not evidence either
        expect(isCurrentFingerprintVersion({ fingerprintVersion: FINGERPRINT_VERSION + 1 })).toBe(false);
    });
});

describe('combatLevelsPart', () => {
    test('exactly the seven levels the sim reads, in a fixed order', () => {
        const part = combatLevelsPart(levels());
        expect(part).toBe('levels=stamina:90,intelligence:80,attack:95,defense:92,melee:99,ranged:1,magic:1');
        expect(SIM_COMBAT_SKILLS).toHaveLength(7);
    });

    test('a level the sim does not read cannot reach the hash', () => {
        expect(combatLevelsPart({ ...levels(), woodcutting: 200, enhancing: 150 })).toBe(combatLevelsPart(levels()));
    });

    test('every one of the seven changes the string', () => {
        const base = combatLevelsPart(levels());
        for (const name of SIM_COMBAT_SKILLS) {
            expect(combatLevelsPart(levels({ [name]: 123 }))).not.toBe(base);
        }
    });

    test('unreadable levels are a placeholder, told apart from a levelled character', () => {
        expect(combatLevelsPart(null)).toBe('levels=unknown');
        expect(combatLevelsPart(undefined)).toBe('levels=unknown');
        expect(combatLevelsPart('nonsense')).toBe('levels=unknown');
        expect(combatLevelsPart({})).not.toBe('levels=unknown');
    });

    test('a missing or nonsense level within a known map counts as zero, not as absent', () => {
        expect(combatLevelsPart({})).toBe(
            'levels=stamina:0,intelligence:0,attack:0,defense:0,melee:0,ranged:0,magic:0'
        );
        expect(combatLevelsPart(levels({ melee: 'x' }))).toBe(combatLevelsPart(levels({ melee: 0 })));
    });
});

const kit = (over = {}) => ({
    equipped: [
        { hrid: '/abilities/berserk', level: 20, triggers: null },
        { hrid: '/abilities/cleave', level: 15, triggers: null },
        null,
        null,
        null,
    ],
    learned: { '/abilities/berserk': 20, '/abilities/cleave': 15 },
    ...over,
});

/** One equipped slot list, padded to the five slots both DTO builders write */
const slots = (...abilities) => [...abilities, null, null, null, null, null].slice(0, 5);

describe('abilitiesPart', () => {
    test('every slot is written, empty ones included, so a kit cannot shift under the hash', () => {
        const part = abilitiesPart(kit());
        expect(ABILITY_SLOTS).toBe(5);
        expect(part).toContain('0:/abilities/berserk@20[default]');
        expect(part).toContain('1:/abilities/cleave@15[default]');
        expect(part).toContain('2:-,3:-,4:-');
        expect(part).toContain('learned=/abilities/berserk@20,/abilities/cleave@15');
    });

    test('an ability level change moves the string', () => {
        const base = abilitiesPart(kit());
        const levelled = kit({
            equipped: slots(
                { hrid: '/abilities/berserk', level: 21, triggers: null },
                { hrid: '/abilities/cleave', level: 15, triggers: null }
            ),
            learned: { '/abilities/berserk': 21, '/abilities/cleave': 15 },
        });
        expect(abilitiesPart(levelled)).not.toBe(base);
    });

    test('swapping an ability, and reordering the same two, both move it', () => {
        const base = abilitiesPart(kit());
        const swapped = kit({
            equipped: slots(
                { hrid: '/abilities/berserk', level: 20, triggers: null },
                { hrid: '/abilities/precision', level: 15, triggers: null }
            ),
        });
        expect(abilitiesPart(swapped)).not.toBe(base);

        // Slot order is cast priority: CombatSimulator fires the first slot
        // whose triggers pass, so the same two abilities the other way round is
        // a different rotation and must hash differently
        const reordered = kit({
            equipped: slots(
                { hrid: '/abilities/cleave', level: 15, triggers: null },
                { hrid: '/abilities/berserk', level: 20, triggers: null }
            ),
        });
        expect(abilitiesPart(reordered)).not.toBe(base);
    });

    test('a trigger change moves it, and no triggers is not the same as default triggers', () => {
        const triggered = kit({
            equipped: slots(
                {
                    hrid: '/abilities/berserk',
                    level: 20,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/less_than_equal',
                            value: 50,
                        },
                    ],
                },
                { hrid: '/abilities/cleave', level: 15, triggers: null }
            ),
        });
        expect(abilitiesPart(triggered)).not.toBe(abilitiesPart(kit()));

        // Ability.createFromDTO passes null through as "use the ability's own
        // defaults" and an empty array as "no conditions", which are different
        // rotations
        const empty = kit({ equipped: slots({ hrid: '/abilities/berserk', level: 20, triggers: [] }) });
        const dflt = kit({ equipped: slots({ hrid: '/abilities/berserk', level: 20, triggers: null }) });
        expect(abilitiesPart(empty)).not.toBe(abilitiesPart(dflt));
    });

    test('the learned levels are sorted, so map key order is not part of the build', () => {
        const one = abilitiesPart(kit({ learned: { '/abilities/berserk': 20, '/abilities/cleave': 15 } }));
        const other = abilitiesPart(kit({ learned: { '/abilities/cleave': 15, '/abilities/berserk': 20 } }));
        expect(one).toBe(other);
    });

    test('a loadout-named ability levelling up moves it even with the kit untouched', () => {
        // A labyrinth room with a loadout sims the snapshot's abilities at the
        // character's current levels, which the snapshot does not carry
        const base = abilitiesPart(kit());
        expect(abilitiesPart(kit({ learned: { '/abilities/berserk': 20, '/abilities/cleave': 16 } }))).not.toBe(base);
    });

    test('unreadable abilities are a placeholder, told apart from an empty kit', () => {
        expect(abilitiesPart(null)).toBe('abilities=unknown');
        expect(abilitiesPart({})).toBe('abilities=unknown');
        expect(abilitiesPart('nonsense')).toBe('abilities=unknown');
        expect(abilitiesPart({ equipped: [] })).not.toBe('abilities=unknown');
    });
});

describe('houseRoomsPart', () => {
    test('hrid and level, sorted, so map key order is not part of the build', () => {
        expect(houseRoomsPart({ '/house_rooms/gym': 4, '/house_rooms/armory': 7 })).toBe(
            'house=/house_rooms/armory:7,/house_rooms/gym:4'
        );
    });

    test('a house room level change moves the string', () => {
        const base = houseRoomsPart({ '/house_rooms/gym': 4 });
        expect(houseRoomsPart({ '/house_rooms/gym': 5 })).not.toBe(base);
        expect(houseRoomsPart({ '/house_rooms/gym': 4, '/house_rooms/armory': 1 })).not.toBe(base);
    });

    test('a room at level 0 is not part of the build, so it is not part of the hash', () => {
        // Player.createFromDTO pushes a HouseRoom only for level > 0
        expect(houseRoomsPart({ '/house_rooms/gym': 4, '/house_rooms/dairy_barn': 0 })).toBe(
            houseRoomsPart({ '/house_rooms/gym': 4 })
        );
        expect(houseRoomsPart({})).toBe('house=');
    });

    test('every room counts, not a combat-room subset', () => {
        // HouseRoom applies each room's action buffs with no action-type filter,
        // so there is no read that would justify excluding a "skilling" room
        expect(houseRoomsPart({ '/house_rooms/kitchen': 3 })).not.toBe(houseRoomsPart({}));
    });

    test('unreadable rooms are a placeholder, told apart from a house with nothing built', () => {
        expect(houseRoomsPart(null)).toBe('house=unknown');
        expect(houseRoomsPart(undefined)).toBe('house=unknown');
        expect(houseRoomsPart('nonsense')).toBe('house=unknown');
        expect(houseRoomsPart({})).not.toBe('house=unknown');
    });
});

describe('what v3 deliberately leaves out', () => {
    test('nothing in the hashed input can carry a tea, a drink or a food', () => {
        // Consumables move a sim, and they are out on purpose: they change
        // several times an hour, so hashing them would restart the cohort
        // before it could ever reach the fights a reading needs. The parts have
        // no channel for one - this pins that there is no way to smuggle it in.
        const consumable = { hrid: '/items/super_magic_coffee', level: 1, triggers: null };
        const emptyKit = { equipped: slots(), learned: {} };
        expect(abilitiesPart(emptyKit)).toBe(abilitiesPart({ ...emptyKit, drinks: [consumable], food: [consumable] }));
        expect(houseRoomsPart({ '/house_rooms/gym': 4 })).toBe(
            houseRoomsPart({ '/house_rooms/gym': 4, '/items/super_magic_coffee': 0 })
        );
        expect(combatLevelsPart({ ...levels(), coffee: 3 })).toBe(combatLevelsPart(levels()));

        // And the spec says so, so an exporter reading it is not left guessing
        expect(FINGERPRINT_SPEC).toContain('excludes skilling levels, buffs and consumables');
    });
});

describe('the hashed input and its tag', () => {
    test('all five parts reach the string', () => {
        const all = { stored: 'a', worn: 'b', levels: 'c', abilities: 'd', houseRooms: 'e' };
        const base = fingerprintInput(all);
        for (const key of Object.keys(all)) {
            expect(fingerprintInput({ ...all, [key]: 'z' })).not.toBe(base);
        }
    });

    test('the tag is what makes a cross-version collision impossible rather than unlikely', () => {
        // Two definitions can collide on a hash; they cannot collide on the
        // prefix in front of it, and a v1 value carries none
        expect(tagFingerprint('123')).toBe(`${FINGERPRINT_PREFIX}123`);
        expect(tagFingerprint('123')).not.toBe('123');
    });

    test('the spec names the version it describes', () => {
        expect(FINGERPRINT_SPEC).toContain(`v${FINGERPRINT_VERSION}`);
        expect(FINGERPRINT_PREFIX).toBe(`v${FINGERPRINT_VERSION}:`);
    });
});
