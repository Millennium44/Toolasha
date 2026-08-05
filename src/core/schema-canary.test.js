/**
 * The shape check, against a faked `initClientData`.
 *
 * Two things are worth asserting and they pull in opposite directions. One is
 * that a real change is caught — a renamed map, a retired item, a buff type that
 * no longer exists. The other, and the one that decides whether anybody keeps
 * paying attention to this pass, is that a *healthy* client is silent: no
 * failures for a fresh account, none for data that simply has not arrived, none
 * for a dungeon whose wave count the game declines to supply.
 */

import { describe, test, expect, vi } from 'vitest';

const game = vi.hoisted(() => ({ clientData: null }));

vi.mock('./data-manager.js', () => ({
    default: { getInitClientData: () => game.clientData },
}));

const {
    checkClientDataShape,
    collectBuffTypeHrids,
    runSchemaCanary,
    SCHEMA_REASON,
    REQUIRED_MAPS,
    SAMPLE_ITEM_HRIDS,
    SAMPLE_BUFF_TYPE_HRIDS,
    DUNGEON_WAVE_FALLBACKS,
} = await import('./schema-canary.js');

/**
 * A client data payload with everything the canary asks for, so each test can
 * break exactly one thing and see exactly one failure.
 * @param {Object} [overrides] - Keys to replace on the healthy payload
 * @returns {Object} Faked `initClientData`
 */
function healthyClientData(overrides = {}) {
    const itemDetailMap = {};
    for (const hrid of SAMPLE_ITEM_HRIDS) itemDetailMap[hrid] = { hrid, name: hrid.split('/').pop() };

    // The buff types are proven through teas, so the fake proves them the same way
    itemDetailMap['/items/blessed_tea'].consumableDetail = {
        buffs: SAMPLE_BUFF_TYPE_HRIDS.map((typeHrid) => ({ typeHrid, flatBoost: 0.1 })),
    };

    const actionDetailMap = {};
    for (const hrid of Object.keys(DUNGEON_WAVE_FALLBACKS)) {
        actionDetailMap[hrid] = { hrid, combatZoneInfo: { dungeonInfo: {} } };
    }

    const populated = { anything: {} };
    const base = {
        itemDetailMap,
        actionDetailMap,
        abilityDetailMap: populated,
        combatMonsterDetailMap: populated,
        houseRoomDetailMap: populated,
        guildBuffDetailMap: populated,
        taskShopItemDetailMap: populated,
        communityBuffTypeDetailMap: populated,
        enhancementLevelTotalBonusMultiplierTable: [1, 1.02, 1.05],
        levelExperienceTable: [0, 50, 120],
    };

    return { ...base, ...overrides };
}

/**
 * The failure keys a payload produces.
 * @param {Object} clientData - Faked `initClientData`
 * @returns {Array<string>} Keys
 */
function keysFor(clientData) {
    return checkClientDataShape(clientData).map((f) => f.key);
}

describe('a healthy client', () => {
    test('says nothing at all', () => {
        expect(checkClientDataShape(healthyClientData())).toEqual([]);
    });

    test('every required map is actually covered by the fixture', () => {
        // Guards the fixture rather than the code: a map added to REQUIRED_MAPS
        // and forgotten here would make every test below fail for the wrong reason
        const healthy = healthyClientData();
        for (const [key] of REQUIRED_MAPS) expect(healthy[key], `${key} missing from the fixture`).toBeTruthy();
    });
});

describe('data that has not arrived', () => {
    test('is not a failure — it is indistinguishable from data that is on its way', () => {
        expect(checkClientDataShape(null)).toEqual([]);
        expect(checkClientDataShape(undefined)).toEqual([]);
        expect(checkClientDataShape('not an object')).toEqual([]);
    });
});

describe('missing top-level maps', () => {
    test('each one is reported once, by name', () => {
        const failures = checkClientDataShape(healthyClientData({ combatMonsterDetailMap: undefined }));
        expect(failures).toHaveLength(1);
        expect(failures[0].key).toBe('schema:combatMonsterDetailMap');
        expect(failures[0].name).toContain('combatMonsterDetailMap');
        expect(failures[0].reason).toBe(SCHEMA_REASON);
    });

    test('an empty map counts as missing — `|| {}` is exactly what hides this', () => {
        expect(keysFor(healthyClientData({ houseRoomDetailMap: {} }))).toEqual(['schema:houseRoomDetailMap']);
    });

    test('an empty enhancement table counts too, array or not', () => {
        expect(keysFor(healthyClientData({ enhancementLevelTotalBonusMultiplierTable: [] }))).toEqual([
            'schema:enhancementLevelTotalBonusMultiplierTable',
        ]);
    });

    test('a renamed itemDetailMap is reported once, not once per item in it', () => {
        const failures = checkClientDataShape(healthyClientData({ itemDetailMap: undefined }));
        expect(failures).toHaveLength(1);
        expect(failures[0].key).toBe('schema:itemDetailMap');
    });
});

describe('hardcoded item hrids', () => {
    test('one that no longer exists is named', () => {
        const items = healthyClientData().itemDetailMap;
        delete items['/items/philosophers_mirror'];

        const failures = checkClientDataShape(healthyClientData({ itemDetailMap: items }));
        expect(failures).toHaveLength(1);
        expect(failures[0].key).toBe('schema:item:/items/philosophers_mirror');
        expect(failures[0].reason).toBe(SCHEMA_REASON);
    });

    test('extra items in the game are not the canary’s business', () => {
        const items = { ...healthyClientData().itemDetailMap, '/items/brand_new_thing': {} };
        expect(checkClientDataShape(healthyClientData({ itemDetailMap: items }))).toEqual([]);
    });
});

describe('buff type hrids', () => {
    test('are gathered from every place the script reads one', () => {
        const found = collectBuffTypeHrids({
            itemDetailMap: { a: { consumableDetail: { buffs: [{ typeHrid: '/buff_types/wisdom' }] } } },
            houseRoomDetailMap: {
                b: {
                    actionBuffs: [{ typeHrid: '/buff_types/efficiency' }],
                    globalBuffs: [{ typeHrid: '/buff_types/x' }],
                },
            },
            guildBuffDetailMap: { c: { buff: { typeHrid: '/buff_types/rare_find' } } },
        });

        expect([...found].sort()).toEqual([
            '/buff_types/efficiency',
            '/buff_types/rare_find',
            '/buff_types/wisdom',
            '/buff_types/x',
        ]);
    });

    test('one that stopped resolving is named', () => {
        const items = healthyClientData().itemDetailMap;
        items['/items/blessed_tea'].consumableDetail.buffs = SAMPLE_BUFF_TYPE_HRIDS.filter(
            (hrid) => hrid !== '/buff_types/artisan'
        ).map((typeHrid) => ({ typeHrid }));

        const failures = checkClientDataShape(healthyClientData({ itemDetailMap: items }));
        expect(failures).toHaveLength(1);
        expect(failures[0].key).toBe('schema:buff:/buff_types/artisan');
    });

    test('a buff carried by a house room instead of a tea still resolves', () => {
        const items = healthyClientData().itemDetailMap;
        items['/items/blessed_tea'].consumableDetail.buffs = SAMPLE_BUFF_TYPE_HRIDS.filter(
            (hrid) => hrid !== '/buff_types/gourmet'
        ).map((typeHrid) => ({ typeHrid }));

        const clientData = healthyClientData({
            itemDetailMap: items,
            houseRoomDetailMap: { '/house_rooms/kitchen': { actionBuffs: [{ typeHrid: '/buff_types/gourmet' }] } },
        });

        expect(checkClientDataShape(clientData)).toEqual([]);
    });
});

describe('dungeon wave counts', () => {
    const dungeon = '/actions/combat/chimerical_den';

    test('a game-supplied count that matches the fallback is silent', () => {
        const actions = healthyClientData().actionDetailMap;
        actions[dungeon].combatZoneInfo.dungeonInfo.maxWaves = DUNGEON_WAVE_FALLBACKS[dungeon];
        expect(checkClientDataShape(healthyClientData({ actionDetailMap: actions }))).toEqual([]);
    });

    test('a game-supplied count that disagrees with the fallback says both numbers', () => {
        const actions = healthyClientData().actionDetailMap;
        actions[dungeon].combatZoneInfo.dungeonInfo.maxWaves = 55;

        const failures = checkClientDataShape(healthyClientData({ actionDetailMap: actions }));
        expect(failures).toHaveLength(1);
        expect(failures[0].name).toContain('55');
        expect(failures[0].name).toContain(String(DUNGEON_WAVE_FALLBACKS[dungeon]));
    });

    test('no count supplied is the case the fallback exists for, and is not a failure', () => {
        // Every dungeon in the fixture is already shaped this way
        expect(checkClientDataShape(healthyClientData())).toEqual([]);

        const actions = healthyClientData().actionDetailMap;
        actions[dungeon].combatZoneInfo.dungeonInfo.maxWaves = 0;
        expect(checkClientDataShape(healthyClientData({ actionDetailMap: actions }))).toEqual([]);
    });

    test('a dungeon that is gone entirely is reported', () => {
        const actions = healthyClientData().actionDetailMap;
        delete actions[dungeon];

        const failures = checkClientDataShape(healthyClientData({ actionDetailMap: actions }));
        expect(failures).toHaveLength(1);
        expect(failures[0].name).toContain('no longer an action');
    });
});

describe('runSchemaCanary', () => {
    test('reads whatever the data manager loaded', () => {
        game.clientData = healthyClientData({ abilityDetailMap: undefined });
        expect(runSchemaCanary().map((f) => f.key)).toEqual(['schema:abilityDetailMap']);
    });

    test('a client with no data yet produces nothing', () => {
        game.clientData = null;
        expect(runSchemaCanary()).toEqual([]);
    });
});
