import { describe, test, expect } from 'vitest';
import { combatZones, zoneDrops, openableItems, openableDrops } from './drop-sources.js';

const itemDetailMap = {
    '/items/coin': { name: 'Coin' },
    '/items/cheese': { name: 'Cheese' },
    '/items/rare_hat': { name: 'Rare Hat' },
    '/items/boss_tooth': { name: 'Boss Tooth' },
    '/items/dungeon_key': { name: 'Dungeon Key' },
    '/items/purples_gift': { name: "Purple's Gift" },
};

const combatMonsterDetailMap = {
    '/monsters/rat': {
        dropTable: [{ itemHrid: '/items/coin' }, { itemHrid: '/items/cheese' }],
        rareDropTable: [{ itemHrid: '/items/rare_hat' }],
    },
    '/monsters/king_rat': {
        dropTable: [{ itemHrid: '/items/cheese' }],
        rareDropTable: [{ itemHrid: '/items/boss_tooth' }],
    },
};

const actionDetailMap = {
    '/actions/combat/rat_hole': {
        name: 'Rat Hole',
        combatZoneInfo: {
            fightInfo: {
                randomSpawnInfo: { spawns: [{ combatMonsterHrid: '/monsters/rat' }] },
                bossSpawns: [{ combatMonsterHrid: '/monsters/king_rat' }],
            },
        },
    },
    '/actions/combat/deep_vault': {
        name: 'Deep Vault',
        combatZoneInfo: {
            isDungeon: true,
            dungeonInfo: { rewardDropTable: [{ itemHrid: '/items/dungeon_key' }, { itemHrid: '/items/coin' }] },
            fightInfo: { randomSpawnInfo: { spawns: [{ combatMonsterHrid: '/monsters/rat' }] } },
        },
    },
    '/actions/cheesesmithing/cheese': { name: 'Cheese' },
};

const openableLootDropMap = {
    '/items/purples_gift': [{ itemHrid: '/items/rare_hat' }, { itemHrid: '/items/coin' }],
};

const data = { actionDetailMap, combatMonsterDetailMap, itemDetailMap, openableLootDropMap };

describe('combatZones', () => {
    test('is every combat zone and nothing else, keyed by the hrid its contents are looked up with', () => {
        const zones = combatZones(actionDetailMap);
        expect(zones.map((zone) => zone.id).sort()).toEqual(['/actions/combat/deep_vault', '/actions/combat/rat_hole']);
    });

    test('read from the game rather than listed, so an update adds itself', () => {
        // A hardcoded list of fifteen planets guarantees the sixteenth is missed
        const withNewZone = {
            ...actionDetailMap,
            '/actions/combat/new_place': { name: 'New Place', combatZoneInfo: { fightInfo: {} } },
        };
        expect(combatZones(withNewZone).map((zone) => zone.id)).toContain('/actions/combat/new_place');
    });

    test('dungeons are marked, since they drop differently', () => {
        expect(combatZones(actionDetailMap).find((zone) => zone.id === '/actions/combat/deep_vault').isDungeon).toBe(
            true
        );
    });

    test('nothing loaded is an empty list rather than a crash', () => {
        expect(combatZones(null)).toEqual([]);
    });
});

describe('zoneDrops', () => {
    test('walks both tables of every spawn, ordinary and boss', () => {
        const drops = zoneDrops('/actions/combat/rat_hole', data).map((drop) => drop.hrid);

        expect(drops).toContain('/items/cheese');
        // The rare table is where the reason to track a zone usually lives, and
        // reading only dropTable omits exactly that
        expect(drops).toContain('/items/rare_hat');
        expect(drops).toContain('/items/boss_tooth');
    });

    test('coins are not an item anybody tracks', () => {
        expect(zoneDrops('/actions/combat/rat_hole', data).map((d) => d.hrid)).not.toContain('/items/coin');
    });

    test('an item two monsters both drop appears once', () => {
        const cheese = zoneDrops('/actions/combat/rat_hole', data).filter((d) => d.hrid === '/items/cheese');
        expect(cheese).toHaveLength(1);
    });

    test('a dungeon comes from its reward table, not from its monsters', () => {
        // Read as an ordinary zone this finds cheese and a hat, which is wrong
        const drops = zoneDrops('/actions/combat/deep_vault', data).map((d) => d.hrid);
        expect(drops).toEqual(['/items/dungeon_key']);
    });

    test('names come from the game, not from the hrid', () => {
        expect(zoneDrops('/actions/combat/rat_hole', data).find((d) => d.hrid === '/items/rare_hat').name).toBe(
            'Rare Hat'
        );
    });

    test('an item the item map has never heard of still reads as something', () => {
        const stranger = {
            ...data,
            combatMonsterDetailMap: { '/monsters/rat': { dropTable: [{ itemHrid: '/items/odd_thing' }] } },
        };
        expect(zoneDrops('/actions/combat/rat_hole', stranger)[0].name).toBe('odd thing');
    });

    test('a zone that is not one has no drops rather than an error', () => {
        expect(zoneDrops('/actions/cheesesmithing/cheese', data)).toEqual([]);
        expect(zoneDrops('/actions/combat/nowhere', data)).toEqual([]);
    });
});

describe('openableItems', () => {
    test('is everything with a loot table', () => {
        expect(openableItems(data)).toEqual([
            { id: '/items/purples_gift', hrid: '/items/purples_gift', name: "Purple's Gift" },
        ]);
    });

    test('nothing loaded is an empty list', () => {
        expect(openableItems(null)).toEqual([]);
    });
});

describe('openableDrops', () => {
    test('is the contents, and the chest itself', () => {
        // An unopened chest is a thing you hold and a thing with a price, so a
        // list of its contents without it cannot value the pile
        const drops = openableDrops('/items/purples_gift', data).map((d) => d.hrid);
        expect(drops).toEqual(['/items/purples_gift', '/items/rare_hat']);
    });

    test('coins are excluded here too', () => {
        expect(openableDrops('/items/purples_gift', data).map((d) => d.hrid)).not.toContain('/items/coin');
    });

    test('something that does not open has nothing in it', () => {
        expect(openableDrops('/items/cheese', data)).toEqual([]);
    });
});
