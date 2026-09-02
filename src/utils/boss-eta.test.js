import { describe, test, expect } from 'vitest';
import {
    battlesToBoss,
    wavesToDungeonBoss,
    addBattleGap,
    averageBattleMs,
    bossEtaMs,
    formatBossEta,
    bossEtaTooltip,
    DEFAULT_MAX_SAMPLES,
    DEFAULT_MAX_GAP_MS,
} from './boss-eta.js';

describe('battlesToBoss', () => {
    test('battle #323 with battlesPerBoss 10 puts the boss at #330, 7 battles out', () => {
        expect(battlesToBoss(323, 10)).toEqual({ battlesRemaining: 7, bossBattleNumber: 330, isBossNow: false });
    });

    test('a battle number that is an exact multiple of N is the boss battle itself', () => {
        expect(battlesToBoss(330, 10)).toEqual({ battlesRemaining: 0, bossBattleNumber: 330, isBossNow: true });
    });

    test('battle #1 of a fresh zone is 9 out from the first boss at 10', () => {
        expect(battlesToBoss(1, 10)).toEqual({ battlesRemaining: 9, bossBattleNumber: 10, isBossNow: false });
    });

    test('a dungeon-style call is handled by wavesToDungeonBoss, not this', () => {
        // battlesToBoss with battlesPerBoss 0 (a dungeon's fightInfo) returns
        // null, which is why the chip must route dungeons through the other
        // helper rather than this one.
        expect(battlesToBoss(45, 0)).toBeNull();
    });

    test('non-positive or non-finite inputs return null', () => {
        expect(battlesToBoss(0, 10)).toBeNull();
        expect(battlesToBoss(5, 0)).toBeNull();
        expect(battlesToBoss(5, -1)).toBeNull();
        expect(battlesToBoss(NaN, 10)).toBeNull();
        expect(battlesToBoss(5, undefined)).toBeNull();
    });
});

describe('addBattleGap', () => {
    test('accumulates gaps in order', () => {
        let samples = [];
        samples = addBattleGap(samples, 1000);
        samples = addBattleGap(samples, 2000);
        expect(samples).toEqual([1000, 2000]);
    });

    test('does not mutate the input array', () => {
        const samples = [1000];
        const next = addBattleGap(samples, 2000);
        expect(samples).toEqual([1000]);
        expect(next).toEqual([1000, 2000]);
    });

    test('drops a gap above the outlier cutoff — a disconnect, not a slow battle', () => {
        const samples = addBattleGap([1000], DEFAULT_MAX_GAP_MS + 1);
        expect(samples).toEqual([1000]);
    });

    test('keeps a gap right at the cutoff', () => {
        const samples = addBattleGap([], DEFAULT_MAX_GAP_MS);
        expect(samples).toEqual([DEFAULT_MAX_GAP_MS]);
    });

    test('drops zero and negative gaps (clock oddities, not real durations)', () => {
        expect(addBattleGap([1000], 0)).toEqual([1000]);
        expect(addBattleGap([1000], -50)).toEqual([1000]);
    });

    test('drops non-finite gaps', () => {
        expect(addBattleGap([1000], NaN)).toEqual([1000]);
        expect(addBattleGap([1000], undefined)).toEqual([1000]);
    });

    test('caps the window at maxSamples, dropping the oldest', () => {
        let samples = [];
        for (let i = 1; i <= DEFAULT_MAX_SAMPLES + 5; i++) {
            samples = addBattleGap(samples, i * 100);
        }
        expect(samples.length).toBe(DEFAULT_MAX_SAMPLES);
        // The oldest 5 (100..500) were pushed out; the window keeps the newest run
        expect(samples[0]).toBe(600);
        expect(samples[samples.length - 1]).toBe((DEFAULT_MAX_SAMPLES + 5) * 100);
    });

    test('a custom window size is honored', () => {
        let samples = [];
        for (let i = 1; i <= 5; i++) {
            samples = addBattleGap(samples, i * 100, { maxSamples: 3 });
        }
        expect(samples).toEqual([300, 400, 500]);
    });
});

describe('averageBattleMs', () => {
    test('null with no samples', () => {
        expect(averageBattleMs([])).toBeNull();
        expect(averageBattleMs(undefined)).toBeNull();
    });

    test('the mean of the samples', () => {
        expect(averageBattleMs([1000, 2000, 3000])).toBe(2000);
    });
});

describe('bossEtaMs', () => {
    test('null without an average yet', () => {
        expect(bossEtaMs(7, null)).toBeNull();
        expect(bossEtaMs(7, 0)).toBeNull();
        expect(bossEtaMs(7, NaN)).toBeNull();
    });

    test('spans the remaining battles plus one more for the unfinished current one', () => {
        // 7 full battles (#324-#330) + the unfinished #323, approximated as one
        // more average battle => 8 battles total
        expect(bossEtaMs(7, 10_000)).toBe(80_000);
    });

    test('the boss-now edge is still one full average battle, never zero', () => {
        expect(bossEtaMs(0, 10_000)).toBe(10_000);
    });
});

describe('formatBossEta', () => {
    test('null info renders nothing', () => {
        expect(formatBossEta(null, 10_000)).toBe('');
    });

    test('count only before enough samples exist', () => {
        expect(formatBossEta({ battlesRemaining: 7, isBossNow: false }, null)).toBe('7 to boss');
    });

    test('boss-now with no average yet', () => {
        expect(formatBossEta({ battlesRemaining: 0, isBossNow: true }, null)).toBe('boss now');
    });

    test('count plus time once an average exists', () => {
        // 8 battles (7 remaining + 1 for the unfinished current one) * 10s = 80s,
        // which formatEta's 15s-step rounding for sub-10-minute estimates settles to 1m15s
        expect(formatBossEta({ battlesRemaining: 7, isBossNow: false }, 10_000)).toBe('7 to boss · ~1m 15s left');
    });

    test('boss-now with an average shows non-zero time left, never "0s"', () => {
        expect(formatBossEta({ battlesRemaining: 0, isBossNow: true }, 10_000)).toBe('boss now · ~10s left');
    });
});

describe('bossEtaTooltip', () => {
    test('null info renders nothing', () => {
        expect(bossEtaTooltip(null, 10_000)).toBe('');
    });

    test('spells out the boss battle number and the arithmetic', () => {
        const text = bossEtaTooltip({ battlesRemaining: 7, bossBattleNumber: 330, isBossNow: false }, 10_000);
        expect(text).toContain('#330');
        expect(text).toContain('7 more battle');
        expect(text).toContain('8 battle');
    });

    test('names the current battle as the boss on the boss-now edge', () => {
        const text = bossEtaTooltip({ battlesRemaining: 0, bossBattleNumber: 330, isBossNow: true }, 10_000);
        expect(text).toContain('This battle is the boss');
        expect(text).toContain('#330');
    });

    test('says there is not enough data without an average', () => {
        const text = bossEtaTooltip({ battlesRemaining: 7, bossBattleNumber: 330, isBossNow: false }, null);
        expect(text).toContain('Not enough battles tracked yet');
    });

    test('the wave noun reworks the whole tooltip for a dungeon', () => {
        const text = bossEtaTooltip({ battlesRemaining: 5, bossBattleNumber: 50, isBossNow: false }, 10_000, 'wave');
        expect(text).toContain('Boss is wave #50');
        expect(text).toContain('5 more waves first');
        expect(text).toContain('6 waves');
        expect(text).not.toContain('battle');
    });
});

describe('wavesToDungeonBoss', () => {
    test('wave 45 of a 50-wave dungeon is 5 out from the boss wave', () => {
        expect(wavesToDungeonBoss(45, 50)).toEqual({ battlesRemaining: 5, bossBattleNumber: 50, isBossNow: false });
    });

    test('the final wave is the boss itself', () => {
        expect(wavesToDungeonBoss(50, 50)).toEqual({ battlesRemaining: 0, bossBattleNumber: 50, isBossNow: true });
    });

    test('a wave past the max (a stale reading) clamps to the boss rather than going negative', () => {
        expect(wavesToDungeonBoss(51, 50)).toEqual({ battlesRemaining: 0, bossBattleNumber: 50, isBossNow: true });
    });

    test('non-positive or non-finite inputs return null', () => {
        expect(wavesToDungeonBoss(0, 50)).toBeNull();
        expect(wavesToDungeonBoss(5, 0)).toBeNull();
        expect(wavesToDungeonBoss(NaN, 50)).toBeNull();
        expect(wavesToDungeonBoss(5, NaN)).toBeNull();
    });

    test('its shape feeds formatBossEta and reads as "to boss" like a boss zone', () => {
        const info = wavesToDungeonBoss(45, 50);
        expect(formatBossEta(info, null)).toBe('5 to boss');
        expect(formatBossEta(info, 10_000)).toMatch(/^5 to boss · ~.*left$/);
    });
});
