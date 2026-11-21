/** @vitest-environment happy-dom
 *
 * Partymates' View Loadouts copied to GM storage for the Metz team import. Captures follow the
 * `loadout_shared` reply as measured on the test server (see utils/view-loadout.test.js): rows carry
 * `characterID`, gear is keyed `/item_locations/<slot>`.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({ charId: 100, core: null, handlers: new Map() }));

vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => game.charId },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            if (!game.handlers.has(type)) game.handlers.set(type, []);
            game.handlers.get(type).push(handler);
        },
        off: (type, handler) => {
            const list = game.handlers.get(type) || [];
            const index = list.indexOf(handler);
            if (index > -1) list.splice(index, 1);
        },
    },
}));
vi.mock('../../utils/profile-command.js', () => ({ getGameCore: () => game.core }));

const { fetchLoadout, VIEW_LOADOUT_CONTEXT, _resetViewLoadout } = await import('../../utils/view-loadout.js');
const {
    GM_PARTY_LOADOUTS_KEY,
    PARTY_LOADOUT_TTL_MS,
    MAX_PARTY_LOADOUTS,
    getPartyLoadout,
    recordPartyLoadouts,
    startMetzPartyLoadoutPublisher,
    stopMetzPartyLoadoutPublisher,
} = await import('./combat-sim-party-loadouts-metz.js');

const NOW = 1_800_000_000_000;
let gm;

function payload(
    rowId,
    { weapon = '/items/rippling_trident', level = 7, actionTypeHrid = '/action_types/combat' } = {}
) {
    return {
        sharableCharacter: { name: `Player ${rowId}` },
        hasLoadout: true,
        actionTypeHrid,
        wearableItemMap: {
            '/item_locations/main_hand': {
                itemLocationHrid: '/item_locations/main_hand',
                itemHrid: weapon,
                enhancementLevel: level,
                count: 1,
                characterID: rowId,
            },
        },
        equippedAbilities: [{ abilityHrid: '/abilities/aqua_arrow', level: 40, slotNumber: 1, characterID: rowId }],
        combatConsumables: [{ itemHrid: '/items/spaceberry_cake', itemLocationHrid: '', count: 50 }],
        abilityCombatTriggersMap: {},
        consumableCombatTriggersMap: {},
    };
}

function capture(memberId, overrides = {}) {
    return {
        characterId: String(memberId),
        name: `Player ${memberId}`,
        context: VIEW_LOADOUT_CONTEXT.Party,
        kind: '',
        hasLoadout: true,
        requested: true,
        capturedAt: NOW - 1000,
        ownerCharacterId: '100',
        loadout: payload(memberId),
        ...overrides,
    };
}

function stored() {
    return gm.has(GM_PARTY_LOADOUTS_KEY) ? JSON.parse(gm.get(GM_PARTY_LOADOUTS_KEY)) : null;
}

beforeEach(() => {
    gm = new Map();
    globalThis.GM_getValue = vi.fn((key, fallback) => (gm.has(key) ? gm.get(key) : fallback));
    globalThis.GM_setValue = vi.fn((key, value) => gm.set(key, value));
    game.charId = 100;
    game.core = null;
    game.handlers.clear();
});

afterEach(() => {
    stopMetzPartyLoadoutPublisher();
    _resetViewLoadout();
    delete globalThis.GM_getValue;
    delete globalThis.GM_setValue;
});

describe('recordPartyLoadouts', () => {
    test('files each loadout under its own character id, so swapped ids never cross', () => {
        recordPartyLoadouts([capture(7), capture(8, { loadout: payload(8, { weapon: '/items/gobo_stabber' }) })], NOW);

        expect(getPartyLoadout(100, 7, NOW).loadout.wearableItemMap['/item_locations/main_hand'].itemHrid).toBe(
            '/items/rippling_trident'
        );
        expect(getPartyLoadout(100, 8, NOW).loadout.wearableItemMap['/item_locations/main_hand'].itemHrid).toBe(
            '/items/gobo_stabber'
        );
    });

    test('refuses a capture filed under another character than its rows name', () => {
        // Filed as member 8, but every row says it is member 7's loadout
        recordPartyLoadouts([capture(8, { loadout: payload(7) })], NOW);

        expect(getPartyLoadout(100, 8, NOW)).toBeNull();
        expect(getPartyLoadout(100, 7, NOW)).toBeNull();
        expect(globalThis.GM_setValue).not.toHaveBeenCalled();
    });

    test('refuses a loadout whose rows name nobody, since only its request said whose it was', () => {
        const anonymous = payload(7);
        for (const row of Object.values(anonymous.wearableItemMap)) delete row.characterID;
        for (const row of anonymous.equippedAbilities) delete row.characterID;
        recordPartyLoadouts([capture(7, { loadout: anonymous })], NOW);

        expect(getPartyLoadout(100, 7, NOW)).toBeNull();
        expect(globalThis.GM_setValue).not.toHaveBeenCalled();
    });

    test('ignores guild trial, unknown-context and skilling captures', () => {
        recordPartyLoadouts(
            [
                capture(7, { context: VIEW_LOADOUT_CONTEXT.GuildTrial, kind: 'combat' }),
                capture(8, { context: null }),
                capture(9, { loadout: payload(9, { actionTypeHrid: '/action_types/milking' }) }),
            ],
            NOW
        );

        expect(stored()).toBeNull();
        expect(globalThis.GM_setValue).not.toHaveBeenCalled();
    });

    test('a party reply with no loadout drops that member, and an older late reply never replaces a newer one', () => {
        recordPartyLoadouts([capture(7, { capturedAt: NOW - 500 })], NOW);
        recordPartyLoadouts([capture(7, { capturedAt: NOW - 9000, loadout: payload(7, { level: 1 }) })], NOW);
        expect(getPartyLoadout(100, 7, NOW).loadout.wearableItemMap['/item_locations/main_hand'].enhancementLevel).toBe(
            7
        );

        recordPartyLoadouts([capture(7, { capturedAt: NOW - 100, hasLoadout: false })], NOW);
        expect(getPartyLoadout(100, 7, NOW)).toBeNull();
    });

    test('writes only when the stored copy changes', () => {
        expect(recordPartyLoadouts([capture(7)], NOW)).toBe(true);
        expect(recordPartyLoadouts([capture(7)], NOW)).toBe(false);
        expect(recordPartyLoadouts([capture(7, { context: VIEW_LOADOUT_CONTEXT.GuildTrial })], NOW)).toBe(false);
        expect(globalThis.GM_setValue).toHaveBeenCalledTimes(1);
    });

    test("another character's capture replaces the store, and the old owner's entries are not readable", () => {
        recordPartyLoadouts([capture(7)], NOW);
        recordPartyLoadouts([capture(9, { ownerCharacterId: '200' })], NOW);

        expect(stored().ownerCharacterId).toBe('200');
        expect(getPartyLoadout(100, 7, NOW)).toBeNull();
        expect(getPartyLoadout(200, 9, NOW)).not.toBeNull();
        // The exporting character must be the one that captured it
        expect(getPartyLoadout(100, 9, NOW)).toBeNull();
    });

    test('expired entries are not read even with no write since, are pruned on the next write, and the count is capped', () => {
        recordPartyLoadouts([capture(7, { capturedAt: NOW - 1000 })], NOW);
        expect(getPartyLoadout(100, 7, NOW + PARTY_LOADOUT_TTL_MS + 1)).toBeNull();

        const later = NOW + PARTY_LOADOUT_TTL_MS + 1;
        const many = Array.from({ length: MAX_PARTY_LOADOUTS + 3 }, (_, index) =>
            capture(300 + index, { capturedAt: later - index })
        );
        recordPartyLoadouts(many, later);
        const ids = Object.keys(stored().entries);
        expect(ids).toHaveLength(MAX_PARTY_LOADOUTS);
        expect(ids).not.toContain('7');
        expect(ids).toContain('300');
        expect(ids).not.toContain(String(300 + MAX_PARTY_LOADOUTS));
    });

    test('never stores your own loadout as a partymate', () => {
        recordPartyLoadouts([capture(100)], NOW);
        expect(stored()).toBeNull();
    });
});

describe('publisher', () => {
    test('a party View Loadout fetched through the game is stored as it arrives', async () => {
        game.core = {
            handleViewLoadout: (characterId) => {
                for (const handler of game.handlers.get('loadout_shared') || []) {
                    handler({ type: 'loadout_shared', loadout: payload(characterId) });
                }
            },
        };
        startMetzPartyLoadoutPublisher();
        const result = await fetchLoadout({ characterID: 7, name: 'Player 7' }, VIEW_LOADOUT_CONTEXT.Party, '', {
            closeGameModal: false,
        });

        expect(result.status).toBe('done');
        expect(getPartyLoadout(100, 7)).toMatchObject({
            loadout: { equippedAbilities: [{ abilityHrid: '/abilities/aqua_arrow', level: 40, slotNumber: 1 }] },
        });
    });

    test('a guild trial View Loadout is not stored', async () => {
        game.core = {
            handleViewLoadout: (characterId) => {
                for (const handler of game.handlers.get('loadout_shared') || []) {
                    handler({ type: 'loadout_shared', loadout: payload(characterId) });
                }
            },
        };
        startMetzPartyLoadoutPublisher();
        await fetchLoadout({ characterID: 7 }, VIEW_LOADOUT_CONTEXT.GuildTrial, 'combat', { closeGameModal: false });

        expect(getPartyLoadout(100, 7)).toBeNull();
        expect(globalThis.GM_setValue).not.toHaveBeenCalled();
    });
});
