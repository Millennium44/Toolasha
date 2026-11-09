import { describe, it, expect } from 'vitest';
import { buildCharacterSheetLink, buildSegmentsFromCharacterData } from './character-sheet.js';

const clientData = {
    abilityDetailMap: {
        '/abilities/poke': { isSpecialAbility: false },
        '/abilities/scratch': { isSpecialAbility: false },
        '/abilities/smack': { isSpecialAbility: false },
        '/abilities/impale': { isSpecialAbility: false },
        '/abilities/berserk': { isSpecialAbility: true },
    },
};

const ab = (name, level) => ({ abilityHrid: `/abilities/${name}`, level });

describe('character sheet ability slots', () => {
    it('puts the special ability in slot 5 even with fewer than 4 normals', () => {
        const segments = buildSegmentsFromCharacterData(
            { equippedAbilities: [ab('berserk', 3), ab('poke', 2), ab('scratch', 1), ab('smack', 4)] },
            clientData
        );
        expect(segments.abilities.split(',')).toEqual(['poke.2', 'scratch.1', 'smack.4', '', 'berserk.3', '', '', '']);
    });

    it('keeps the special in slot 5 with four normals', () => {
        const segments = buildSegmentsFromCharacterData(
            {
                equippedAbilities: [ab('poke', 1), ab('scratch', 1), ab('smack', 1), ab('impale', 1), ab('berserk', 5)],
            },
            clientData
        );
        expect(segments.abilities.split(',')).toEqual([
            'poke.1',
            'scratch.1',
            'smack.1',
            'impale.1',
            'berserk.5',
            '',
            '',
            '',
        ]);
    });
});

describe('saved-loadout aura export', () => {
    const abilityDetailMap = Object.fromEntries(
        ['critical', 'speed', 'fierce', 'mystic', 'toughness'].map((name) => [
            `/abilities/${name}_aura`,
            { isSpecialAbility: true },
        ])
    );
    for (const name of ['frenzy', 'berserk', 'puncture', 'penetrating_strike']) {
        abilityDetailMap[`/abilities/${name}`] = { isSpecialAbility: false };
    }
    const client = { abilityDetailMap };
    const loadout = (id, aura, ordinal, extra = {}) => ({
        id,
        characterID: 'char-1',
        name: 'Same name',
        ordinal,
        actionTypeHrid: '/action_types/combat',
        // The game uses slot 1 for its special aura; the external card places it fifth.
        abilityMap: { 1: `/abilities/${aura}_aura`, 2: '/abilities/frenzy' },
        ...extra,
    });
    const character = () => ({
        character: { id: 'char-1', name: 'Player' },
        combatUnit: {
            combatAbilities: [
                ab('critical_aura', 21),
                ab('frenzy', 61),
                ab('berserk', 70),
                ab('puncture', 70),
                ab('penetrating_strike', 75),
            ],
        },
        characterAbilities: [
            ab('critical_aura', 21),
            ab('speed_aura', 30),
            ab('fierce_aura', 45),
            ab('mystic_aura', 30),
            ab('toughness_aura', 90),
        ],
        // Insertion/key order deliberately differs from saved loadout order.
        characterLoadoutMap: {
            50: loadout(50, 'toughness', 4),
            20: loadout(20, 'fierce', 2),
            10: loadout(10, 'speed', 1),
            30: loadout(30, 'mystic', 3),
            40: loadout(40, 'critical', 0),
        },
    });
    const slots = (data, enabled = true) =>
        buildSegmentsFromCharacterData(data, client, null, null, { includeLoadoutAuras: enabled }).abilities.split(',');

    it('exports the eight-tile example, with extras capped and ordered by loadouts', () => {
        expect(slots(character()).join(',')).toBe(
            'frenzy.61,berserk.70,puncture.70,penetrating_strike.75,critical_aura.21,speed_aura.30,fierce_aura.45,mystic_aura.30'
        );
    });

    it('keeps the original equipped-only export when disabled or not requested', () => {
        const data = character();
        expect(slots(data, false).slice(5)).toEqual(['', '', '']);
        expect(buildSegmentsFromCharacterData(data, client).abilities).toBe(slots(data, false).join(','));
    });

    it('deduplicates equipped and repeated auras across same-named loadouts', () => {
        const data = character();
        data.characterLoadoutMap[5] = loadout(5, 'speed', 0);
        data.characterLoadoutMap[6] = loadout(6, 'speed', 0);
        expect(slots(data).slice(5)).toEqual(['speed_aura.30', 'fierce_aura.45', 'mystic_aura.30']);
    });

    it('uses learned levels rather than assuming an unequipped aura is level one', () => {
        const data = character();
        data.characterAbilities.find((a) => a.abilityHrid === '/abilities/speed_aura').level = 53;
        expect(slots(data)[5]).toBe('speed_aura.53');
    });

    it('does not fill unused normal or equipped-aura slots with extra auras', () => {
        const data = character();
        data.combatUnit.combatAbilities = [ab('frenzy', 61)];
        expect(slots(data)).toEqual([
            'frenzy.61',
            '',
            '',
            '',
            '',
            'critical_aura.21',
            'speed_aura.30',
            'fierce_aura.45',
        ]);
    });

    it('includes all-skills loadouts but not a skill-specific loadout', () => {
        const data = character();
        data.characterLoadoutMap[10].actionTypeHrid = '/action_types/milking';
        data.characterLoadoutMap[20].actionTypeHrid = '';
        expect(slots(data).slice(5)).toEqual(['fierce_aura.45', 'mystic_aura.30', 'toughness_aura.90']);
    });

    it('rejects unknown, unlearned, non-aura, and invalid-level entries', () => {
        const data = character();
        data.characterLoadoutMap[5] = loadout(5, 'unknown', -1);
        data.characterAbilities.push(ab('unknown_aura', 40));
        data.characterLoadoutMap[10].abilityMap[2] = '/abilities/berserk';
        data.characterAbilities.push(ab('berserk', 70));
        data.characterAbilities = data.characterAbilities.filter((a) => a.abilityHrid !== '/abilities/mystic_aura');
        data.characterAbilities.find((a) => a.abilityHrid === '/abilities/fierce_aura').level = 0;
        expect(slots(data).slice(5)).toEqual(['speed_aura.30', 'toughness_aura.90', '']);
    });

    it('rejects loadouts and learned abilities tagged with another character id', () => {
        const data = character();
        data.characterLoadoutMap[10].characterID = 'other';
        data.characterAbilities.find((a) => a.abilityHrid === '/abilities/fierce_aura').characterID = 'other';
        expect(slots(data).slice(5)).toEqual(['mystic_aura.30', 'toughness_aura.90', '']);
    });

    it.each(['characterAbilities', 'characterLoadoutMap', 'character'])(
        'leaves extras blank when %s is unavailable',
        (field) => {
            const data = character();
            delete data[field];
            expect(slots(data).slice(5)).toEqual(['', '', '']);
        }
    );

    it('uses a shared profile’s own data and does not mutate the character or loadouts', () => {
        const data = character();
        data.sharableCharacter = data.character;
        delete data.character;
        data.equippedAbilities = data.combatUnit.combatAbilities;
        delete data.combatUnit;
        const original = structuredClone(data);
        expect(slots(data)[5]).toBe('speed_aura.30');
        expect(data).toEqual(original);
    });

    it('threads the option through the final external URL', () => {
        const url = buildCharacterSheetLink(null, 'https://sheet.test', character(), client, null, 12.5, {
            includeLoadoutAuras: true,
        });
        expect(url.split(';')[3]).toBe(slots(character()).join(','));
    });
});
