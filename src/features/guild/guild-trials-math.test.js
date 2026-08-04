/**
 * Guild trial arithmetic, against hand-computed numbers.
 *
 * Every figure below was worked out from the rules quoted in the module doc
 * rather than from the code, which is the only way a payout table is worth
 * testing: a test that re-derives the formula it is checking agrees with any
 * bug the formula has.
 */

import { describe, test, expect } from 'vitest';

import {
    COMBAT_ENCOUNTERS,
    ELIGIBLE_TOKEN_SHARE,
    PARTICIPANT_BONUS_SHARE,
    TRIAL_ACTIVE_MS,
    TRIAL_MAX_LEVEL,
    TRIAL_MAX_TIER,
    TRIAL_START_LEVEL,
    eligibleMemberTokens,
    estimateGrowthPerTier,
    etaMs,
    guildPoints,
    levelFromTier,
    msUntilWeekReset,
    nextTierPreview,
    participantScale,
    payoutProjection,
    projectPace,
    projectTierTotal,
    ratePerMs,
    rescaleForParticipants,
    tierFromLevel,
    totalBasePoints,
    trailingRun,
    trialBasePoints,
    trialTimeLeftMs,
    trialWeekEnd,
    trialWeekStart,
} from './guild-trials-math.js';

describe('the ladder', () => {
    test('starts at level 100 and steps ten levels a tier to 300', () => {
        expect(TRIAL_START_LEVEL).toBe(100);
        expect(TRIAL_MAX_LEVEL).toBe(300);
        expect(TRIAL_MAX_TIER).toBe(21);
    });

    test('level 100 is tier 1 and every ten levels advances one', () => {
        expect(tierFromLevel(100)).toBe(1);
        expect(tierFromLevel(109)).toBe(1);
        expect(tierFromLevel(110)).toBe(2);
        expect(tierFromLevel(140)).toBe(5);
        expect(tierFromLevel(300)).toBe(21);
    });

    test('a level below the first tier is not a tier', () => {
        expect(tierFromLevel(99)).toBeNull();
        expect(tierFromLevel(0)).toBeNull();
        expect(tierFromLevel(NaN)).toBeNull();
    });

    test('a level above the ladder is clamped to the top tier rather than invented', () => {
        expect(tierFromLevel(500)).toBe(21);
    });

    test('tier and level are inverses inside the ladder', () => {
        for (let tier = 1; tier <= TRIAL_MAX_TIER; tier += 1) {
            expect(tierFromLevel(levelFromTier(tier))).toBe(tier);
        }
    });

    test('a tier off the ladder has no level', () => {
        expect(levelFromTier(0)).toBeNull();
        expect(levelFromTier(22)).toBeNull();
    });

    test('the five combat encounters are the five combat encounters', () => {
        expect(COMBAT_ENCOUNTERS).toEqual(['badger', 'chameleon', 'jellyfish', 'hedgehog', 'swarm']);
    });
});

describe('base points', () => {
    test('a skilling trial pays 200 for the first tier and 100 for each after it', () => {
        expect(trialBasePoints('skilling', 1)).toBe(200);
        expect(trialBasePoints('skilling', 2)).toBe(300);
        expect(trialBasePoints('skilling', 3)).toBe(400);
        expect(trialBasePoints('skilling', 10)).toBe(1100);
    });

    test('a combat trial pays 400 for the first tier and 200 for each after it', () => {
        expect(trialBasePoints('combat', 1)).toBe(400);
        expect(trialBasePoints('combat', 2)).toBe(600);
        expect(trialBasePoints('combat', 5)).toBe(1200);
    });

    test('a trial that cleared nothing pays nothing', () => {
        expect(trialBasePoints('skilling', 0)).toBe(0);
        expect(trialBasePoints('combat', 0)).toBe(0);
        expect(trialBasePoints('combat', -3)).toBe(0);
    });

    test('an unknown trial type pays nothing rather than guessing a table', () => {
        expect(trialBasePoints('gathering', 4)).toBe(0);
        expect(trialBasePoints(undefined, 4)).toBe(0);
    });

    test('a full week sums its trials', () => {
        // Four skilling trials clearing 3, 5, 1 and 0 tiers: 400 + 600 + 200 + 0
        // Two combat trials clearing 4 and 2: 1000 + 600
        const trials = [
            { type: 'skilling', tiersCleared: 3 },
            { type: 'skilling', tiersCleared: 5 },
            { type: 'skilling', tiersCleared: 1 },
            { type: 'skilling', tiersCleared: 0 },
            { type: 'combat', tiersCleared: 4 },
            { type: 'combat', tiersCleared: 2 },
        ];
        expect(totalBasePoints(trials)).toBe(400 + 600 + 200 + 0 + 1000 + 600);
        expect(totalBasePoints(trials)).toBe(2800);
    });

    test('no trials is no points', () => {
        expect(totalBasePoints([])).toBe(0);
        expect(totalBasePoints(undefined)).toBe(0);
    });
});

describe('payouts', () => {
    test('Guild Points are base times one plus the Builders Hall bonus', () => {
        expect(guildPoints(2800, 0)).toBe(2800);
        expect(guildPoints(2800, 0.25)).toBe(3500);
        expect(guildPoints(2800)).toBe(2800);
    });

    test('every eligible member gets half the base points, raised by the Treasury', () => {
        expect(ELIGIBLE_TOKEN_SHARE).toBe(0.5);
        expect(eligibleMemberTokens(2800, 0)).toBe(1400);
        expect(eligibleMemberTokens(2800, 0.1)).toBeCloseTo(1540, 9);
    });

    test('a participant gets that again plus half of it', () => {
        expect(PARTICIPANT_BONUS_SHARE).toBe(0.5);
        const payout = payoutProjection({
            trials: [{ type: 'combat', tiersCleared: 2 }],
            buildersHallBonus: 0,
            treasuryBonus: 0,
        });
        // 600 base → 300 eligible tokens → 150 bonus → 450 for a participant
        expect(payout.basePoints).toBe(600);
        expect(payout.eligibleTokens).toBe(300);
        expect(payout.participantBonusTokens).toBe(150);
        expect(payout.participantTokens).toBe(450);
    });

    test('the whole week, hand-computed end to end', () => {
        const payout = payoutProjection({
            trials: [
                { type: 'skilling', tiersCleared: 3, name: 'Trial Milking' },
                { type: 'skilling', tiersCleared: 5 },
                { type: 'skilling', tiersCleared: 1 },
                { type: 'skilling', tiersCleared: 0 },
                { type: 'combat', tiersCleared: 4 },
                { type: 'combat', tiersCleared: 2 },
            ],
            buildersHallBonus: 0.2,
            treasuryBonus: 0.1,
        });

        expect(payout.basePoints).toBe(2800);
        expect(payout.guildPoints).toBeCloseTo(3360, 9); // 2800 × 1.2
        expect(payout.eligibleTokens).toBeCloseTo(1540, 9); // 0.5 × 2800 × 1.1
        expect(payout.participantBonusTokens).toBeCloseTo(770, 9);
        expect(payout.participantTokens).toBeCloseTo(2310, 9);
        expect(payout.bonusesKnown).toBe(true);
        expect(payout.perTrial[0]).toMatchObject({ name: 'Trial Milking', basePoints: 400, guildPoints: 480 });
    });

    test('an unknown bonus falls back to un-bonused figures and says so', () => {
        const payout = payoutProjection({
            trials: [{ type: 'combat', tiersCleared: 2 }],
            buildersHallBonus: null,
            treasuryBonus: 0.1,
        });

        expect(payout.bonusesKnown).toBe(false);
        expect(payout.guildPoints).toBe(600);
        expect(payout.eligibleTokens).toBeCloseTo(330, 9);
    });

    test('a trial with no tiers contributes nothing to any line', () => {
        const payout = payoutProjection({ trials: [{ type: 'skilling', tiersCleared: 0 }] });
        expect(payout.basePoints).toBe(0);
        expect(payout.guildPoints).toBe(0);
        expect(payout.eligibleTokens).toBe(0);
        expect(payout.participantTokens).toBe(0);
    });

    test('no input at all is a zero payout rather than a throw', () => {
        expect(payoutProjection()).toMatchObject({ basePoints: 0, participantTokens: 0 });
    });
});

describe('participant scaling', () => {
    test('each participant adds one percent', () => {
        expect(participantScale(0)).toBe(1);
        expect(participantScale(1)).toBeCloseTo(1.01, 12);
        expect(participantScale(21)).toBeCloseTo(1.21, 12);
    });

    test('an unknown party size scales by nothing rather than by NaN', () => {
        expect(participantScale(undefined)).toBe(1);
        expect(participantScale(-4)).toBe(1);
    });

    test('a total measured with one party re-scales to another', () => {
        // 618,000 at 20 heads is 515,000 before the penalty; at 30 heads, 669,500
        expect(rescaleForParticipants(618_000, 20, 20)).toBeCloseTo(618_000, 6);
        expect(rescaleForParticipants(618_000, 20, 30)).toBeCloseTo((618_000 / 1.2) * 1.3, 6);
    });

    test('an unusable total re-scales to nothing', () => {
        expect(rescaleForParticipants(null, 5, 6)).toBeNull();
    });
});

describe('tier growth, fitted from observations', () => {
    test('a clean doubling every tier is measured as a doubling', () => {
        const growth = estimateGrowthPerTier([
            { tier: 1, total: 100 },
            { tier: 2, total: 200 },
            { tier: 3, total: 400 },
        ]);
        expect(growth).toBeCloseTo(2, 9);
    });

    test('a gap of several tiers is weighted by the gap, not counted once', () => {
        // 100 → 800 over three tiers is ×2 a tier, not ×8
        expect(
            estimateGrowthPerTier([
                { tier: 1, total: 100 },
                { tier: 4, total: 800 },
            ])
        ).toBeCloseTo(2, 9);
    });

    test('one tier is not a curve', () => {
        expect(estimateGrowthPerTier([{ tier: 3, total: 500 }])).toBeNull();
        expect(estimateGrowthPerTier([])).toBeNull();
        expect(estimateGrowthPerTier(undefined)).toBeNull();
    });

    test('two readings of the same tier are still one tier', () => {
        expect(
            estimateGrowthPerTier([
                { tier: 3, total: 500 },
                { tier: 3, total: 500 },
            ])
        ).toBeNull();
    });

    test('rubbish observations are skipped rather than poisoning the fit', () => {
        const growth = estimateGrowthPerTier([
            { tier: 1, total: 100 },
            { tier: 2, total: 0 },
            { tier: 2, total: 200 },
            { tier: 'x', total: 9 },
        ]);
        expect(growth).toBeCloseTo(2, 9);
    });

    test('a projected tier compounds from the nearest observation', () => {
        const observations = [
            { tier: 1, total: 100 },
            { tier: 2, total: 200 },
        ];
        expect(projectTierTotal({ observations, tier: 3 })).toBeCloseTo(400, 6);
        expect(projectTierTotal({ observations, tier: 5 })).toBeCloseTo(1600, 6);
    });

    test('a tier already observed is reported, not extrapolated', () => {
        const observations = [
            { tier: 1, total: 100 },
            { tier: 2, total: 250 },
        ];
        expect(projectTierTotal({ observations, tier: 2 })).toBe(250);
    });

    test('without a second tier there is nothing to project with', () => {
        expect(projectTierTotal({ observations: [{ tier: 1, total: 100 }], tier: 2 })).toBeNull();
        expect(projectTierTotal({ observations: [], tier: 2 })).toBeNull();
    });

    test('an explicit growth factor overrides the fit', () => {
        const observations = [{ tier: 4, total: 1000 }];
        expect(projectTierTotal({ observations, tier: 5, growthPerTier: 1.5 })).toBeCloseTo(1500, 6);
    });
});

describe('the next tier preview', () => {
    test('names the tier, its level, its size and the party penalty already in it', () => {
        const preview = nextTierPreview({
            observations: [
                { tier: 4, total: 500_000 },
                { tier: 5, total: 618_000 },
            ],
            currentTier: 5,
            participants: 21,
        });

        expect(preview.tier).toBe(6);
        expect(preview.level).toBe(150);
        expect(preview.growthPerTier).toBeCloseTo(1.236, 6);
        expect(preview.total).toBeCloseTo(618_000 * 1.236, 3);
        expect(preview.participantPenalty).toBeCloseTo(0.21, 12);
    });

    test('there is no tier after the last one', () => {
        expect(
            nextTierPreview({
                observations: [
                    { tier: 20, total: 1 },
                    { tier: 21, total: 2 },
                ],
                currentTier: TRIAL_MAX_TIER,
            })
        ).toBeNull();
    });

    test('one observed tier is not enough to preview the next', () => {
        expect(nextTierPreview({ observations: [{ tier: 1, total: 100 }], currentTier: 1 })).toBeNull();
    });
});

describe('rates from samples', () => {
    const at = (points) => points.map(([t, value]) => ({ t, value }));

    test('a rising pool reads its own rate', () => {
        expect(
            ratePerMs(
                at([
                    [0, 0],
                    [1000, 500],
                    [2000, 1000],
                ]),
                1
            )
        ).toBeCloseTo(0.5, 9);
    });

    test('a falling boss bar reads the same magnitude', () => {
        expect(
            ratePerMs(
                at([
                    [0, 1000],
                    [1000, 500],
                    [2000, 0],
                ]),
                -1
            )
        ).toBeCloseTo(0.5, 9);
    });

    test('a tier rollover is cut out rather than averaged through', () => {
        // The pool filled to 1000, cleared, and restarted at 0
        const samples = at([
            [0, 800],
            [1000, 1000],
            [2000, 0],
            [3000, 300],
            [4000, 600],
        ]);
        expect(trailingRun(samples, 1)).toEqual(
            at([
                [2000, 0],
                [3000, 300],
                [4000, 600],
            ])
        );
        expect(ratePerMs(samples, 1)).toBeCloseTo(0.3, 9);
    });

    test('a boss bar refilling for the next tier is likewise cut out', () => {
        const samples = at([
            [0, 400],
            [1000, 100],
            [2000, 900_000],
            [3000, 800_000],
        ]);
        expect(ratePerMs(samples, -1)).toBeCloseTo(100, 9);
    });

    test('one sample is not a rate, and neither is a flat pair', () => {
        expect(ratePerMs(at([[0, 100]]), 1)).toBeNull();
        expect(
            ratePerMs(
                at([
                    [0, 100],
                    [1000, 100],
                ]),
                1
            )
        ).toBeNull();
    });

    test('two readings at the same instant do not divide by zero', () => {
        expect(
            ratePerMs(
                at([
                    [500, 0],
                    [500, 900],
                ]),
                1
            )
        ).toBeNull();
    });

    test('an ETA is what is left over how fast it is going', () => {
        expect(etaMs(1000, 0.5)).toBe(2000);
        expect(etaMs(0, 0.5)).toBe(0);
    });

    test('no rate is no ETA', () => {
        expect(etaMs(1000, null)).toBeNull();
        expect(etaMs(1000, 0)).toBeNull();
        expect(etaMs(null, 1)).toBeNull();
    });
});

describe('pace', () => {
    // Tiers cost 100, 200, 400, 800 … and the party does one unit a millisecond
    const totalForTier = (tier) => 100 * Math.pow(2, tier - 1);

    test('counts only the tiers that fit whole in the time left', () => {
        // 100 left of tier 1, then 200 and 400: 100 + 200 = 300 fits in 500ms,
        // the 400 does not
        const pace = projectPace({
            currentTier: 1,
            remainingInTier: 100,
            rate: 1,
            timeLeftMs: 500,
            totalForTier,
        });

        expect(pace.clears.map((clear) => clear.tier)).toEqual([1, 2]);
        expect(pace.finalTier).toBe(2);
        expect(pace.tiersCleared).toBe(2);
        expect(pace.partialFraction).toBeCloseTo(0.5, 9); // 200 of the 400 done
        expect(pace.limitedBy).toBe('time');
    });

    test('tiers already banked are added to the ones projected', () => {
        const pace = projectPace({
            currentTier: 5,
            remainingInTier: 100,
            rate: 1,
            timeLeftMs: 100,
            totalForTier,
            tiersAlreadyCleared: 4,
        });
        expect(pace.tiersCleared).toBe(5);
        expect(pace.finalTier).toBe(5);
    });

    test('a tier that does not fit at all clears nothing', () => {
        const pace = projectPace({ currentTier: 3, remainingInTier: 100, rate: 1, timeLeftMs: 40, totalForTier });
        expect(pace.clears).toEqual([]);
        expect(pace.finalTier).toBeNull();
        expect(pace.tiersCleared).toBe(0);
        expect(pace.partialFraction).toBeCloseTo(0.4, 9);
    });

    test('stops at the top of the ladder rather than climbing past it', () => {
        const pace = projectPace({
            currentTier: TRIAL_MAX_TIER,
            remainingInTier: 1,
            rate: 1,
            timeLeftMs: TRIAL_ACTIVE_MS,
            totalForTier: () => 1,
        });
        expect(pace.finalTier).toBe(TRIAL_MAX_TIER);
        expect(pace.limitedBy).toBe('ladder');
    });

    test('stops honestly when the next tier is unknown', () => {
        const pace = projectPace({
            currentTier: 2,
            remainingInTier: 100,
            rate: 1,
            timeLeftMs: 10_000,
            totalForTier: () => null,
        });
        expect(pace.clears.map((clear) => clear.tier)).toEqual([2]);
        expect(pace.limitedBy).toBe('unknown-next-tier');
    });

    test('there is no projection without a rate', () => {
        expect(projectPace({ currentTier: 1, remainingInTier: 100, rate: null, timeLeftMs: 1000, totalForTier })).toBe(
            null
        );
        expect(projectPace({ currentTier: 1, remainingInTier: 100, rate: 0, timeLeftMs: 1000, totalForTier })).toBe(
            null
        );
    });
});

describe('the trial week', () => {
    test('resets Friday 00:00 UTC', () => {
        // 2026-08-04 is a Tuesday; the Friday before it is 2026-07-31
        const now = Date.parse('2026-08-04T12:00:00Z');
        expect(new Date(trialWeekStart(now)).toISOString()).toBe('2026-07-31T00:00:00.000Z');
        expect(new Date(trialWeekEnd(now)).toISOString()).toBe('2026-08-07T00:00:00.000Z');
    });

    test('a Friday belongs to the week it starts, not the one before', () => {
        const fridayMorning = Date.parse('2026-08-07T00:00:01Z');
        expect(new Date(trialWeekStart(fridayMorning)).toISOString()).toBe('2026-08-07T00:00:00.000Z');
    });

    test('the instant before the reset still belongs to the old week', () => {
        const lastMoment = Date.parse('2026-08-06T23:59:59Z');
        expect(new Date(trialWeekStart(lastMoment)).toISOString()).toBe('2026-07-31T00:00:00.000Z');
        expect(msUntilWeekReset(lastMoment)).toBe(1000);
    });

    test('a trial runs an hour of active time', () => {
        expect(TRIAL_ACTIVE_MS).toBe(3_600_000);
        const started = Date.parse('2026-08-04T12:00:00Z');
        expect(trialTimeLeftMs(started, started + 15 * 60_000)).toBe(45 * 60_000);
        expect(trialTimeLeftMs(started, started + 2 * 3_600_000)).toBe(0);
    });

    test('no start time is no answer', () => {
        expect(trialTimeLeftMs(null, Date.now())).toBeNull();
    });
});
