/**
 * Tests for the GM-storage bridge ownership guard in combat-sim-export.js.
 *
 * Covers the read side of the character-clobber fix: websocket.js stamps every GM-bridged
 * payload with a sibling `${key}_meta` key ({characterId, characterName, writtenAt}); these
 * tests exercise checkBridgeStamp()'s pass-through / refuse / stale-warn / legacy-accept
 * behavior, plus one end-to-end check through constructExportObject() to confirm the guard is
 * actually wired into the character-data read path that feeds the "Import from Toolasha" button.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { dataManagerMock } = vi.hoisted(() => ({
    dataManagerMock: {
        characterData: null,
        battleData: null,
        characterEquipment: new Map(),
        getInitClientData: vi.fn(() => null),
        getCurrentCharacterId: vi.fn(() => null),
    },
}));

vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));

vi.mock('../../core/storage.js', () => ({
    default: {
        available: false,
        getJSON: vi.fn(async () => null),
        setJSON: vi.fn(async () => {}),
    },
}));

const { checkBridgeStamp, getLastBridgeIssue, getCharacterData, constructExportObject } =
    await import('./combat-sim-export.js');

function metaFor(characterId, { characterName = 'Hero', writtenAt = Date.now() } = {}) {
    return JSON.stringify({ characterId, characterName, writtenAt });
}

beforeEach(() => {
    dataManagerMock.characterData = null;
    dataManagerMock.battleData = null;
    dataManagerMock.characterEquipment = new Map();
    dataManagerMock.getInitClientData.mockReset().mockReturnValue(null);
    dataManagerMock.getCurrentCharacterId.mockReset().mockReturnValue(null);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    delete globalThis.GM_getValue;
    vi.restoreAllMocks();
});

describe('checkBridgeStamp', () => {
    test('no GM_getValue available (non-Tampermonkey context) is treated as safe to use', () => {
        expect(checkBridgeStamp('toolasha_init_character_data', 'Character data', { enforceOwner: true })).toBe(true);
        expect(getLastBridgeIssue()).toBeNull();
    });

    test('legacy unstamped value (no meta key at all) is accepted with a "legacy, unverified" note', () => {
        globalThis.GM_getValue = vi.fn(() => null);

        const ok = checkBridgeStamp('toolasha_init_character_data', 'Character data', { enforceOwner: true });

        expect(ok).toBe(true);
        expect(getLastBridgeIssue()).toBeNull();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('legacy, unverified'));
    });

    test('matching read (stamp characterId equals the current character) passes through unchanged', () => {
        dataManagerMock.getCurrentCharacterId.mockReturnValue('char-1');
        globalThis.GM_getValue = vi.fn(() => metaFor('char-1'));

        const ok = checkBridgeStamp('toolasha_init_character_data', 'Character data', { enforceOwner: true });

        expect(ok).toBe(true);
        expect(getLastBridgeIssue()).toBeNull();
    });

    test('matching numeric and string character IDs are the same bridge owner', () => {
        dataManagerMock.getCurrentCharacterId.mockReturnValue(30404);
        globalThis.GM_getValue = vi.fn(() => metaFor('30404'));

        const ok = checkBridgeStamp('toolasha_init_character_data', 'Character data', { enforceOwner: true });

        expect(ok).toBe(true);
        expect(getLastBridgeIssue()).toBeNull();
    });

    test('mismatched read refuses with a clear console warning and a user-facing message', () => {
        dataManagerMock.getCurrentCharacterId.mockReturnValue('char-2');
        globalThis.GM_getValue = vi.fn(() => metaFor('char-1', { characterName: 'OtherToon' }));

        const ok = checkBridgeStamp('toolasha_init_character_data', 'Character data', { enforceOwner: true });

        expect(ok).toBe(false);
        expect(getLastBridgeIssue()).toEqual(expect.stringContaining('OtherToon'));
        expect(getLastBridgeIssue()).toEqual(expect.stringContaining('another tab'));
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Refusing'));
    });

    test('mismatch is not refused when enforceOwner is false (e.g. client data / profile list)', () => {
        dataManagerMock.getCurrentCharacterId.mockReturnValue('char-2');
        globalThis.GM_getValue = vi.fn(() => metaFor('char-1'));

        const ok = checkBridgeStamp('toolasha_init_client_data', 'Client data', { enforceOwner: false });

        expect(ok).toBe(true);
        expect(getLastBridgeIssue()).toBeNull();
    });

    test('a stale payload warns but does not block, even when the character matches', () => {
        dataManagerMock.getCurrentCharacterId.mockReturnValue('char-1');
        const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
        globalThis.GM_getValue = vi.fn(() => metaFor('char-1', { writtenAt: twoHoursAgo }));

        const ok = checkBridgeStamp('toolasha_new_battle', 'Battle data', { enforceOwner: true });

        expect(ok).toBe(true);
        expect(getLastBridgeIssue()).toBeNull();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('may be stale'));
    });

    test('a corrupt ownership stamp is refused for character-specific data', () => {
        globalThis.GM_getValue = vi.fn(() => '{not valid json');

        const ok = checkBridgeStamp('toolasha_init_character_data', 'Character data', { enforceOwner: true });

        expect(ok).toBe(false);
        expect(getLastBridgeIssue()).toContain('corrupt ownership stamp');
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('re-focus the game tab'));
    });

    test('a present stamp without a character id is also refused', () => {
        globalThis.GM_getValue = vi.fn(() => JSON.stringify({ writtenAt: Date.now() }));

        expect(checkBridgeStamp('toolasha_init_character_data', 'Character data', { enforceOwner: true })).toBe(false);
        expect(getLastBridgeIssue()).toContain('corrupt ownership stamp');
    });

    test('corrupt metadata does not block shared client data', () => {
        globalThis.GM_getValue = vi.fn(() => '{not valid json');

        expect(checkBridgeStamp('toolasha_init_client_data', 'Client data', { enforceOwner: false })).toBe(true);
        expect(getLastBridgeIssue()).toBeNull();
    });
});

describe('constructExportObject with the GM-storage fallback', () => {
    test('reads inventory from the bridged snapshot alone, ignoring a leftover per-action inventory key', () => {
        // An earlier build rewrote a separate inventory key on every action. The snapshot the game
        // tab writes when it opens a simulator is now the only inventory source, so a leftover
        // copy of that key must not overlay it with older items.
        dataManagerMock.getCurrentCharacterId.mockReturnValue(null);
        const snapshotItems = [{ id: 'now', count: 3 }];
        globalThis.GM_getValue = vi.fn((key) => {
            if (key === 'toolasha_init_character_data') {
                return JSON.stringify({ character: { id: 'char-mine', name: 'Me' }, characterItems: snapshotItems });
            }
            if (key === 'toolasha_init_character_data_meta' || key === 'toolasha_character_items_meta') {
                return metaFor('char-mine');
            }
            if (key === 'toolasha_character_items') {
                return JSON.stringify({ characterId: 'char-mine', characterItems: [{ id: 'old', count: 1 }] });
            }
            return null;
        });

        expect(getCharacterData().characterItems).toEqual(snapshotItems);
    });

    test('refuses and returns null when the character-data bridge belongs to another character', async () => {
        dataManagerMock.characterData = null; // force the GM fallback
        dataManagerMock.getCurrentCharacterId.mockReturnValue('char-mine');

        globalThis.GM_getValue = vi.fn((key) => {
            if (key === 'toolasha_init_character_data') {
                return JSON.stringify({ character: { id: 'char-theirs', name: 'NotMe' }, characterSkills: [] });
            }
            if (key === 'toolasha_init_character_data_meta') {
                return metaFor('char-theirs', { characterName: 'NotMe' });
            }
            return null;
        });

        const result = await constructExportObject();

        expect(result).toBeNull();
        expect(getLastBridgeIssue()).toEqual(expect.stringContaining('NotMe'));
    });

    test('uses the GM fallback normally when its stamp matches the current character', async () => {
        dataManagerMock.characterData = null;
        dataManagerMock.getCurrentCharacterId.mockReturnValue('char-mine');

        globalThis.GM_getValue = vi.fn((key) => {
            if (key === 'toolasha_init_character_data') {
                return JSON.stringify({ character: { id: 'char-mine', name: 'Me' }, characterSkills: [] });
            }
            if (key === 'toolasha_init_character_data_meta') {
                return metaFor('char-mine', { characterName: 'Me' });
            }
            return null;
        });

        const result = await constructExportObject();

        expect(result).not.toBeNull();
        expect(result.playerIDs[0]).toBe('Me');
        expect(getLastBridgeIssue()).toBeNull();
    });
});

describe('guildCombatBuffLevels in the export', () => {
    const SHRINE_KEYS = ['force', 'tempo', 'spirit', 'rarity', 'scholar'];

    function selfCharacter(extra = {}) {
        return {
            character: { id: 'char-mine', name: 'Me' },
            characterSkills: [],
            ...extra,
        };
    }

    afterEach(() => {
        delete dataManagerMock.getCharacterGuildBuffLevel;
    });

    test("the character's own guild buff map becomes all five short keys, zeros included", async () => {
        dataManagerMock.characterData = selfCharacter({
            characterGuildBuffMap: {
                '/guild_buffs/force_combat': { level: 4 },
                '/guild_buffs/tempo_combat': { level: 4 },
                '/guild_buffs/spirit_combat': { level: 1 },
                '/guild_buffs/scholar_combat': { level: 3 },
            },
        });

        const result = await constructExportObject();
        const player = JSON.parse(result.exportObj[1]);

        expect(player.guildCombatBuffLevels).toEqual({ force: 4, tempo: 4, spirit: 1, rarity: 0, scholar: 3 });
        expect(Object.keys(player.guildCombatBuffLevels)).toEqual(SHRINE_KEYS);
    });

    test('skilling shrines never appear, and levels are clamped to non-negative integers', async () => {
        dataManagerMock.characterData = selfCharacter({
            characterGuildBuffMap: {
                '/guild_buffs/force_combat': { level: 2.7 },
                '/guild_buffs/tempo_combat': { level: -3 },
                '/guild_buffs/gathering_quantity': { level: 8 },
                '/guild_buffs/production_efficiency': { level: 5 },
            },
        });

        const result = await constructExportObject();
        const player = JSON.parse(result.exportObj[1]);

        expect(Object.keys(player.guildCombatBuffLevels)).toEqual(SHRINE_KEYS);
        expect(player.guildCombatBuffLevels.force).toBe(2);
        expect(player.guildCombatBuffLevels.tempo).toBe(0);
    });

    test('with no buff map on the snapshot, the live levels dataManager holds are used', async () => {
        dataManagerMock.characterData = selfCharacter();
        dataManagerMock.getCharacterGuildBuffLevel = vi.fn((hrid) => (hrid === '/guild_buffs/rarity_combat' ? 6 : 0));

        const result = await constructExportObject();
        const player = JSON.parse(result.exportObj[1]);

        expect(player.guildCombatBuffLevels).toEqual({ force: 0, tempo: 0, spirit: 0, rarity: 6, scholar: 0 });
    });

    test('a shrine bought since login outranks the level the login snapshot carried', async () => {
        dataManagerMock.characterData = selfCharacter({
            characterGuildBuffMap: {
                '/guild_buffs/force_combat': { level: 3 },
                '/guild_buffs/tempo_combat': { level: 2 },
            },
        });
        dataManagerMock.getCharacterGuildBuffLevel = vi.fn((hrid) => (hrid === '/guild_buffs/force_combat' ? 4 : 0));

        const result = await constructExportObject();
        const player = JSON.parse(result.exportObj[1]);

        expect(player.guildCombatBuffLevels).toEqual({ force: 4, tempo: 2, spirit: 0, rarity: 0, scholar: 0 });
    });

    test('a character whose shrine levels are simply unknown gets no key at all, and nor do blank slots', async () => {
        dataManagerMock.characterData = selfCharacter({ characterGuildBuffMap: {} });

        const result = await constructExportObject();
        const player = JSON.parse(result.exportObj[1]);

        expect(player).not.toHaveProperty('guildCombatBuffLevels');
        for (const slot of [2, 3, 4, 5]) {
            expect(JSON.parse(result.exportObj[slot])).not.toHaveProperty('guildCombatBuffLevels');
        }
    });

    test('the single-player format carries the block too', async () => {
        dataManagerMock.characterData = selfCharacter({
            characterGuildBuffMap: { '/guild_buffs/spirit_combat': { level: 9 } },
        });

        const result = await constructExportObject(null, true);

        expect(result.exportObj.guildCombatBuffLevels).toEqual({
            force: 0,
            tempo: 0,
            spirit: 9,
            rarity: 0,
            scholar: 0,
        });
    });

    test('party members get their levels from a shared profile, and no key when the profile cannot say', async () => {
        dataManagerMock.characterData = selfCharacter({
            characterGuildBuffMap: { '/guild_buffs/force_combat': { level: 1 } },
            partyInfo: {
                party: { actionHrid: '/actions/combat/fly', difficultyTier: 0 },
                partySlotMap: {
                    1: { characterID: 'char-mine' },
                    2: { characterID: 'char-mate' },
                    3: { characterID: 'char-old' },
                },
            },
        });
        globalThis.GM_getValue = vi.fn((key) =>
            key === 'toolasha_profile_list'
                ? JSON.stringify([
                      {
                          characterID: 'char-mate',
                          characterName: 'Mate',
                          profile: { guildBuffLevelMap: { '/guild_buffs/tempo_combat': 5 } },
                      },
                      { characterID: 'char-old', characterName: 'Oldie', profile: {} },
                  ])
                : null
        );

        const result = await constructExportObject();

        expect(JSON.parse(result.exportObj[1]).guildCombatBuffLevels.force).toBe(1);
        expect(JSON.parse(result.exportObj[2]).guildCombatBuffLevels).toEqual({
            force: 0,
            tempo: 5,
            spirit: 0,
            rarity: 0,
            scholar: 0,
        });
        expect(JSON.parse(result.exportObj[3])).not.toHaveProperty('guildCombatBuffLevels');
    });

    test('an externally exported profile carries its own shrine levels', async () => {
        dataManagerMock.characterData = selfCharacter();
        globalThis.GM_getValue = vi.fn((key) =>
            key === 'toolasha_profile_list'
                ? JSON.stringify([
                      {
                          characterID: 'char-other',
                          characterName: 'Other',
                          profile: { guildBuffLevelMap: { '/guild_buffs/scholar_combat': 2 } },
                      },
                  ])
                : null
        );

        const result = await constructExportObject('char-other');

        expect(JSON.parse(result.exportObj[1]).guildCombatBuffLevels).toEqual({
            force: 0,
            tempo: 0,
            spirit: 0,
            rarity: 0,
            scholar: 2,
        });
    });
});

describe('party members whose cached profile cannot be trusted', () => {
    const DAY = 24 * 60 * 60 * 1000;

    /** Game-page character in a four-member party */
    function partyCharacter() {
        return {
            character: { id: 'char-mine', name: 'Me' },
            characterSkills: [],
            partyInfo: {
                party: { actionHrid: '/actions/combat/fly', difficultyTier: 0 },
                partySlotMap: {
                    1: { characterID: 'char-mine' },
                    2: { characterID: 'char-fresh' },
                    3: { characterID: 'char-shy' },
                    4: { characterID: 'char-ghost', characterName: 'Ghost' },
                },
            },
        };
    }

    /** `profile_list` entries in the shape websocket.js stores them */
    function profiles(now) {
        return [
            {
                characterID: 'char-fresh',
                characterName: 'Fresh',
                timestamp: now - 60 * 1000,
                profile: {
                    characterSkills: [{ skillHrid: '/skills/attack', level: 90 }],
                    wearableItemMap: {
                        '/item_locations/main_hand': {
                            itemLocationHrid: '/item_locations/main_hand',
                            itemHrid: '/items/granite_bludgeon',
                            enhancementLevel: 3,
                        },
                    },
                },
            },
            {
                characterID: 'char-shy',
                characterName: 'Shy',
                timestamp: now - 3 * DAY,
                profile: {
                    characterSkills: [{ skillHrid: '/skills/stamina', level: 80 }],
                    hideWearableItems: true,
                    wearableItemMap: {},
                },
            },
        ];
    }

    test('a gearless member is still exported at their levels, with a warning; a missing one is named', async () => {
        const now = Date.now();
        dataManagerMock.characterData = partyCharacter();
        globalThis.GM_getValue = vi.fn((key) =>
            key === 'toolasha_profile_list' ? JSON.stringify(profiles(now)) : null
        );

        const result = await constructExportObject();

        expect(result.importedPlayerPositions).toEqual([true, true, true, false, false]);
        const shy = JSON.parse(result.exportObj[3]);
        expect(shy.player.staminaLevel).toBe(80);
        expect(shy.player.equipment).toEqual([]);
        expect(result.profileWarnings).toEqual([
            expect.objectContaining({ name: 'Shy', level: 'gearless' }),
            expect.objectContaining({ name: 'Ghost', level: 'missing' }),
        ]);
        expect(result.profileWarnings[0].text).toContain('hides equipment');
    });

    test('an old but geared profile warns without changing what is exported', async () => {
        const now = Date.now();
        const list = profiles(now);
        list[0].timestamp = now - 2 * DAY;
        dataManagerMock.characterData = {
            ...partyCharacter(),
            partyInfo: {
                party: { actionHrid: '/actions/combat/fly', difficultyTier: 0 },
                partySlotMap: { 1: { characterID: 'char-mine' }, 2: { characterID: 'char-fresh' } },
            },
        };
        globalThis.GM_getValue = vi.fn((key) => (key === 'toolasha_profile_list' ? JSON.stringify(list) : null));

        const result = await constructExportObject();

        expect(JSON.parse(result.exportObj[2]).player.equipment).toHaveLength(1);
        expect(result.profileWarnings).toEqual([
            expect.objectContaining({ name: 'Fresh', level: 'stale', text: expect.stringContaining('2 d old') }),
        ]);
    });

    test('a character switch inside the profile read exports nothing', async () => {
        dataManagerMock.characterData = partyCharacter();
        globalThis.GM_getValue = vi.fn((key) => {
            if (key !== 'toolasha_profile_list') return null;
            dataManagerMock.characterData = { character: { id: 'char-alt', name: 'Alt' }, characterSkills: [] };
            return JSON.stringify(profiles(Date.now()));
        });

        expect(await constructExportObject()).toBeNull();
    });
});
