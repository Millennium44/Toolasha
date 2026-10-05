import { describe, expect, test, vi } from 'vitest';
vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => ({ guildTrialDetailMap: { test: true } }) },
}));
vi.mock('./combat-sim-adapter.js', () => ({ buildGameDataPayload: () => ({ combatMonsterDetailMap: {} }) }));
import {
    buildTrialGameData,
    trialBuildingBuffs,
    memberFromSkillingReading,
    baseWorkFromSkillingReading,
} from './guild-trial-adapter.js';
import { GUILD_SKILLING_TICKS } from '../guild/guild-trial-messages.fixture.js';
const GUILD_SKILLING_UPDATED = GUILD_SKILLING_TICKS[0];

describe('trial inputs from the game', () => {
    test('uses the real Crafting message shape, including already-resolved work power', () => {
        const member = memberFromSkillingReading(GUILD_SKILLING_UPDATED);
        expect(member).toMatchObject({
            referenceTier: 10,
            workPower: 161,
            actionSeconds: 4.464,
            doubleChance: 0,
        });
        expect(member.successRate).toBeCloseTo(0.08);
        expect(baseWorkFromSkillingReading(GUILD_SKILLING_UPDATED)).toBeCloseTo(40000);
    });
    test('anchors the game curve on a single reading and flags a capped one as a lower bound', () => {
        const below = memberFromSkillingReading({ ...GUILD_SKILLING_UPDATED, tier: 1, successRate: 0.828 });
        expect(below.effectiveLevel).toBeCloseTo(107);
        expect(below.successBonus).toBe(0);
        expect(below.successLowerBound).toBe(false);
        expect(below.source).toContain('anchored on this reading');
        const capped = memberFromSkillingReading({ ...GUILD_SKILLING_UPDATED, tier: 2, successRate: 1 });
        expect(capped.effectiveLevel).toBe(160);
        expect(capped.successLowerBound).toBe(true);
        expect(capped.source).toContain('lower bound');
        const enhancing = memberFromSkillingReading({
            ...GUILD_SKILLING_UPDATED,
            trialHrid: '/guild_skilling/enhancing',
            tier: 2,
            successRate: 1,
        });
        expect(enhancing).toMatchObject({ effectiveLevel: 110, successBonus: 0.25, successLowerBound: true });
        expect(enhancing.source).toContain('steepest decline');
    });
    test('does not infer a pool without the full participant count', () => {
        expect(baseWorkFromSkillingReading({ ...GUILD_SKILLING_UPDATED, participantIds: [] })).toBeNull();
        expect(memberFromSkillingReading({ successRate: 0.8 })).toBeNull();
    });
    test.each(['tier', 'successRate', 'progressPerAction', 'actionTimeMs', 'doubleProgressChance'])(
        'rejects a null %s instead of turning it into a numeric zero',
        (field) => {
            expect(memberFromSkillingReading({ ...GUILD_SKILLING_UPDATED, [field]: null })).toBeNull();
        }
    );
    test.each([
        ['tier', 1.5],
        ['successRate', 0],
        ['successRate', 1.01],
        ['progressPerAction', -1],
        ['progressPerAction', 1e7 + 1],
        ['actionTimeMs', 0],
        ['actionTimeMs', 3_600_001],
        ['doubleProgressChance', -0.01],
        ['doubleProgressChance', 1.01],
    ])('rejects an out-of-range %s reading (%s)', (field, value) => {
        expect(memberFromSkillingReading({ ...GUILD_SKILLING_UPDATED, [field]: value })).toBeNull();
    });
    test.each([[910001, 910001], [910001, null], [true], [[910001]], ['910001'], [910001, 'not-a-character-id']])(
        'does not count an invalid participant roster %j as full signup count',
        (...participantIds) => {
            expect(baseWorkFromSkillingReading({ ...GUILD_SKILLING_UPDATED, participantIds })).toBeNull();
        }
    );
    test('includes the encounter map in the worker payload', () => {
        expect(buildTrialGameData().guildTrialDetailMap).toEqual({ test: true });
    });
    test('resolves only explicitly combat-scoped building buffs and leaves definitions alone', () => {
        const data = {
            guildBuildingDetailMap: {
                room: {
                    buffs: [
                        {
                            typeHrid: '/buff_types/attack_level',
                            flatBoost: 1,
                            flatBoostLevelBonus: 1,
                            ratioBoost: 0,
                        },
                        { typeHrid: '/buff_types/crafting_level', flatBoost: 1 },
                    ],
                },
            },
            buffTypeDetailMap: {
                '/buff_types/attack_level': { isCombat: true },
                '/buff_types/crafting_level': { isCombat: false },
            },
        };
        const before = structuredClone(data);
        expect(trialBuildingBuffs(data, { room: 3 })).toHaveLength(1);
        expect(trialBuildingBuffs(data, { room: 3 })[0].flatBoost).toBe(3);
        expect(data).toEqual(before);
    });
});
