import { describe, test, expect } from 'vitest';
import { copyReplayInputs, replayCandidates, replayBuildSummary } from './labyrinth-replay-inputs.js';
import { FINGERPRINT_VERSION } from './labyrinth-fingerprint.js';

const inputs = (level = 10) => ({
    version: 1,
    playerDTO: { hrid: 'player1', attackLevel: level, abilities: [] },
    crates: [],
    communityBuffs: [],
    labyrinthCombatBuffs: [],
    fullAbilities: true,
});
const fight = (extra = {}) => ({
    monsterHrid: '/monsters/fly',
    roomLevel: 10,
    seconds: 20,
    outcome: 'clear',
    cleared: true,
    complete: true,
    playerMaxHp: 100,
    playerHpStart: 100,
    monsterDamage: 100,
    playerDamageTaken: 50,
    fingerprint: 'old-build',
    fingerprintVersion: FINGERPRINT_VERSION,
    replayInputs: inputs(),
    ...extra,
});

describe('recorded replay builds', () => {
    test('build references stay stable for equivalent inputs and reveal only a short weapon description', () => {
        const original = inputs();
        original.playerDTO.equipment = {
            '/equipment_types/two_hand': { hrid: '/items/steel_sword', enhancementLevel: 7 },
        };
        const metadataOnly = structuredClone(original);
        metadataOnly.playerDTO.food = [{ hrid: '/items/apple' }];
        metadataOnly.playerDTO.tokenUpgrades = { speed: 2 };
        const items = { '/items/steel_sword': { name: 'Steel Sword' } };
        const summary = replayBuildSummary(original, items);
        expect(replayBuildSummary(metadataOnly, items)).toEqual(summary);
        expect(summary.label).toBe(`Build ${summary.id} · Steel Sword +7`);
        expect(JSON.stringify(summary)).not.toContain('/items/');
        const different = structuredClone(original);
        different.playerDTO.abilities = [{ hrid: '/abilities/slash', level: 1 }];
        expect(replayBuildSummary(different, items).id).not.toBe(summary.id);
    });
    test('noncombat DTO metadata does not split a build while resolved combat buffs still do', () => {
        const original = inputs();
        original.playerDTO.tokenUpgrades = { speed: 1, experience: 1 };
        original.playerDTO.communityBuffLevels = { productionEfficiency: 1, experience: 1 };
        original.playerDTO.guildShrineLevels = { '/guild_buffs/force': 1 };
        original.playerDTO.guildCombatBuffs = [{ typeHrid: '/buff_types/physical_damage', ratioBoost: 0.01 }];
        const metadataOnly = structuredClone(original);
        metadataOnly.playerDTO.tokenUpgrades.speed = 2;
        metadataOnly.playerDTO.communityBuffLevels.productionEfficiency = 2;
        metadataOnly.playerDTO.guildShrineLevels['/guild_buffs/force'] = 2;
        const combatChanged = structuredClone(metadataOnly);
        combatChanged.playerDTO.guildCombatBuffs[0].ratioBoost = 0.02;
        const { candidates } = replayCandidates(
            [
                fight({ replayInputs: original }),
                fight({ replayInputs: metadataOnly }),
                fight({ replayInputs: combatChanged }),
            ],
            null
        );
        expect(candidates.map(({ group }) => group.fights)).toEqual([2, 1]);
    });
    test('noncombat levels and food disabled by the labyrinth worker do not split a build', () => {
        const other = inputs();
        other.playerDTO.woodcuttingLevel = 99;
        other.playerDTO.food = [{ hrid: '/items/apple' }];
        other.playerDTO.drinks = [{ hrid: '/items/tea' }];
        expect(replayCandidates([fight(), fight({ replayInputs: other })], null).candidates[0].group.fights).toBe(2);
    });
    test('a supported saved-input schema survives a global fingerprint migration', () => {
        expect(replayCandidates([fight({ fingerprintVersion: 1 })], 'new').candidates).toHaveLength(1);
        expect(
            replayCandidates([fight({ fingerprintVersion: 1, replayInputs: null })], 'old-build').excluded.legacy
        ).toBe(1);
    });
    test('saved inputs survive a change to the current build and permit a single exploratory fight', () => {
        const { candidates, excluded } = replayCandidates([fight()], 'new-build');
        expect(candidates).toHaveLength(1);
        expect(candidates[0].group.fights).toBe(1);
        expect(candidates[0].inputs.playerDTO.attackLevel).toBe(10);
        expect(excluded.build).toBe(0);
    });
    test('different effective builds never pool, while unrelated global fingerprints do not split them', () => {
        const { candidates } = replayCandidates(
            [fight(), fight({ fingerprint: 'unrelated-loadout-changed' }), fight({ replayInputs: inputs(11) })],
            'current'
        );
        expect(candidates.map(({ group }) => group.fights)).toEqual([2, 1]);
    });
    test('copying freezes historical inputs against later loadout mutation', () => {
        const original = inputs();
        const saved = copyReplayInputs(original);
        original.playerDTO.attackLevel = 99;
        expect(saved.playerDTO.attackLevel).toBe(10);
    });
    test('reports build mismatches, malformed snapshots, partial and wounded starts separately', () => {
        const { candidates, excluded } = replayCandidates(
            [
                fight({ replayInputs: null }),
                fight({ replayInputs: { version: 2 } }),
                fight({ complete: false }),
                fight({ playerHpStart: 20 }),
            ],
            'new-build'
        );
        expect(candidates).toHaveLength(0);
        expect(excluded).toMatchObject({ build: 1, invalidSnapshot: 1, incomplete: 1, wounded: 1 });
    });
    test('legacy recordings still require a known matching build', () => {
        const old = fight({ replayInputs: null });
        expect(replayCandidates([old], 'old-build').candidates).toHaveLength(1);
        expect(replayCandidates([old], null).candidates).toHaveLength(0);
    });
    test('object key ordering does not split equivalent inputs', () => {
        const other = inputs();
        other.playerDTO = { abilities: [], attackLevel: 10, hrid: 'player1' };
        expect(replayCandidates([fight(), fight({ replayInputs: other })], null).candidates[0].group.fights).toBe(2);
    });
});
