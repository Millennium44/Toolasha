import { describe, it, expect } from 'vitest';
import { buildSegmentsFromCharacterData } from './character-sheet.js';

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
