import { describe, test, expect } from 'vitest';
import {
    copyReplayInputs,
    replayCandidates,
    replayBuildSummary,
    MIN_REPLAY_FIGHTS,
} from './labyrinth-replay-inputs.js';
import { MIN_LAB_FIGHTS } from './labyrinth-replay-check.js';
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

/**
 * A cohort of `n` identical fights. Cohort splitting is what most of these
 * tests are about, and a cohort under MIN_REPLAY_FIGHTS is not a candidate at
 * all, so the smallest cohort a splitting test can use is that many fights.
 * @param {number} n - How many fights
 * @param {Object} [extra] - Overrides applied to each
 * @returns {Array<Object>}
 */
const cohort = (n, extra = {}) => Array.from({ length: n }, () => fight(extra));

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
                ...cohort(3, { replayInputs: original }),
                ...cohort(3, { replayInputs: metadataOnly }),
                ...cohort(3, { replayInputs: combatChanged }),
            ],
            null
        );
        expect(candidates.map(({ group }) => group.fights)).toEqual([6, 3]);
    });
    test('noncombat levels and food disabled by the labyrinth worker do not split a build', () => {
        const other = inputs();
        other.playerDTO.woodcuttingLevel = 99;
        other.playerDTO.food = [{ hrid: '/items/apple' }];
        other.playerDTO.drinks = [{ hrid: '/items/tea' }];
        expect(
            replayCandidates([...cohort(3), ...cohort(3, { replayInputs: other })], null).candidates[0].group.fights
        ).toBe(6);
    });
    test('a supported saved-input schema survives a global fingerprint migration', () => {
        expect(replayCandidates(cohort(3, { fingerprintVersion: 1 }), 'new').candidates).toHaveLength(1);
        expect(
            replayCandidates(cohort(3, { fingerprintVersion: 1, replayInputs: null }), 'old-build').excluded.legacy
        ).toBe(3);
    });
    test('saved inputs survive a change to the current build', () => {
        const { candidates, excluded } = replayCandidates(cohort(MIN_REPLAY_FIGHTS), 'new-build');
        expect(candidates).toHaveLength(1);
        expect(candidates[0].group.fights).toBe(MIN_REPLAY_FIGHTS);
        expect(candidates[0].inputs.playerDTO.attackLevel).toBe(10);
        expect(excluded.build).toBe(0);
    });
    test('a cohort under the minimum is reported, not simulated', () => {
        const { candidates, excluded } = replayCandidates(cohort(MIN_REPLAY_FIGHTS - 1), 'new-build');
        expect(candidates).toHaveLength(0);
        expect(excluded.tooFew).toBe(MIN_REPLAY_FIGHTS - 1);
    });
    test('a cohort between the two bars may explore but never states a verdict', () => {
        const exploring = replayCandidates(cohort(MIN_REPLAY_FIGHTS), 'new-build').candidates;
        expect(exploring).toHaveLength(1);
        expect(exploring[0].exploratory).toBe(true);
        const judging = replayCandidates(cohort(MIN_LAB_FIGHTS), 'new-build').candidates;
        expect(judging).toHaveLength(1);
        expect(judging[0].exploratory).toBe(false);
    });
    test('different effective builds never pool, while unrelated global fingerprints do not split them', () => {
        const { candidates } = replayCandidates(
            [
                ...cohort(3),
                ...cohort(3, { fingerprint: 'unrelated-loadout-changed' }),
                ...cohort(3, { replayInputs: inputs(11) }),
            ],
            'current'
        );
        expect(candidates.map(({ group }) => group.fights)).toEqual([6, 3]);
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
        const old = cohort(3, { replayInputs: null });
        expect(replayCandidates(old, 'old-build').candidates).toHaveLength(1);
        expect(replayCandidates(old, null).candidates).toHaveLength(0);
    });
    test('object key ordering does not split equivalent inputs', () => {
        const other = inputs();
        other.playerDTO = { abilities: [], attackLevel: 10, hrid: 'player1' };
        expect(
            replayCandidates([...cohort(3), ...cohort(3, { replayInputs: other })], null).candidates[0].group.fights
        ).toBe(6);
    });
});
