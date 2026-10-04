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
    test('does not infer a pool without the full participant count', () => {
        expect(baseWorkFromSkillingReading({ ...GUILD_SKILLING_UPDATED, participantIds: [] })).toBeNull();
        expect(memberFromSkillingReading({ successRate: 0.8 })).toBeNull();
    });
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
