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
    isTrialName,
    MAX_TRIAL_NAME_CHARS,
    PARTICIPANT_BONUS_SHARE,
    TRIAL_ACTIVE_MS,
    TRIAL_MAX_LEVEL,
    TRIAL_MAX_TIER,
    TRIAL_START_LEVEL,
    combatDamageRate,
    eligibleMemberTokens,
    estimateGrowthPerTier,
    etaMs,
    exactTierTotal,
    guildPoints,
    levelFromTier,
    msUntilWeekReset,
    nextTierPreview,
    participantScale,
    payoutProjection,
    projectPace,
    projectTierTotal,
    ratePerMs,
    solveWorkLadder,
    rescaleForParticipants,
    inferBuildersHallBonus,
    baseWorkFromObservations,
    interpretCardPoints,
    tierPoolWork,
    tierFromLevel,
    tierFromWorkTarget,
    tierMarginalPoints,
    totalBasePoints,
    trailingRun,
    trialBankedBasePoints,
    trialBasePoints,
    trialFromHrid,
    withinMidTrialUpgrade,
    trialTimeLeftMs,
    trialWeekEnd,
    trialWeekStart,
} from './guild-trials-math.js';
import { NOTICE_BOARD_NAME } from './guild-notice-board.fixture.js';

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

describe('the skilling pool ladder', () => {
    // Watched through three tiers of a live trial with two members signed up:
    // 40,800 / 44,880 / 48,960. That is 40,000 / 44,000 / 48,000 with the same
    // 1%-per-participant multiplier the combat side uses, and those are the
    // first tier's work plus a tenth of it per tier. Linear, not geometric.
    test('reproduces the live trial exactly, on all five tiers watched', () => {
        // 40,800 / 44,880 / 48,960 / 53,040 / 57,120 — linear, +4,080 a tier,
        // which is a tenth of the first tier's work each time
        const baseWork = 40_000;
        const observed = [40_800, 44_880, 48_960, 53_040, 57_120];
        observed.forEach((total, index) => {
            expect(tierPoolWork({ baseWork, tier: index + 1, participants: 2 })).toBeCloseTo(total, 6);
        });
    });

    test('the tier after the last one watched', () => {
        // The fitted curve this replaces overshot to 63.3K on the same data;
        // the rule gives 61,200
        expect(tierPoolWork({ baseWork: 40_000, tier: 6, participants: 2 })).toBeCloseTo(61_200, 6);
    });

    test('one reading anywhere on the ladder gives the first tier', () => {
        expect(baseWorkFromObservations([{ tier: 3, total: 48_960 }], 2)).toBeCloseTo(40_000, 6);
        expect(baseWorkFromObservations([{ tier: 1, total: 40_800 }], 2)).toBeCloseTo(40_000, 6);
        expect(baseWorkFromObservations([{ tier: 5, total: 57_120 }], 2)).toBeCloseTo(40_000, 6);
    });

    test('nothing observed is nothing derived', () => {
        expect(baseWorkFromObservations([], 2)).toBeNull();
        expect(baseWorkFromObservations([{ tier: 0, total: 0 }], 2)).toBeNull();
        expect(tierPoolWork({ baseWork: 0, tier: 1 })).toBeNull();
        expect(tierPoolWork({ baseWork: 40_000, tier: 99 })).toBeNull();
    });

    test('the step is a tenth of the first tier, not a tenth of the last', () => {
        // Geometric growth would give 40,000 × 1.1² = 48,400 at tier three; the
        // game gives 48,000, which is the linear rule
        expect(tierPoolWork({ baseWork: 40_000, tier: 3 })).toBeCloseTo(48_000, 6);
    });
});

describe('the exact tier ladder, from one anchor', () => {
    // Both kinds' curves are ratios between tiers, so one observed {tier,
    // total} states every other tier — no fitting, and the participant factor
    // cancels without ever being known
    test('the live-trial fixture: T3 at 49,920 puts T4 at 54,080 exactly', () => {
        // 49,920 × 1.3 / 1.2 — the panel's own "59.0K" came from an observation
        // filed one tier low and can never come back
        expect(exactTierTotal({ kind: 'skilling', anchors: [{ tier: 3, total: 49_920 }], tier: 4 })).toBeCloseTo(
            54_080,
            6
        );
    });

    test('the combat ladder reproduces the recorded run to the unit', () => {
        // The T2 boss read 618,000 and the T3 boss 669,500 — exactly 120 → 130
        // of the (10 + level) rule
        expect(exactTierTotal({ kind: 'combat', anchors: [{ tier: 2, total: 618_000 }], tier: 3 })).toBeCloseTo(
            669_500,
            6
        );
        expect(exactTierTotal({ kind: 'combat', anchors: [{ tier: 3, total: 669_500 }], tier: 2 })).toBeCloseTo(
            618_000,
            6
        );
    });

    test('an anchor at the asked-for tier is returned unchanged', () => {
        expect(exactTierTotal({ kind: 'skilling', anchors: [{ tier: 3, total: 49_920 }], tier: 3 })).toBe(49_920);
    });

    test('the nearest anchor wins, so a poisoned old observation cannot outvote the bar in hand', () => {
        // A misfiled (1, 49,920) beside the live (3, 49,920): every projection
        // above T2 anchors on the live reading
        const anchors = [
            { tier: 1, total: 49_920 },
            { tier: 3, total: 49_920 },
        ];
        expect(exactTierTotal({ kind: 'skilling', anchors, tier: 4 })).toBeCloseTo(54_080, 6);
    });

    test('no anchors, an unknown kind, or a tier off the ladder is null', () => {
        expect(exactTierTotal({ kind: 'skilling', anchors: [], tier: 4 })).toBeNull();
        expect(exactTierTotal({ kind: 'mystery', anchors: [{ tier: 3, total: 49_920 }], tier: 4 })).toBeNull();
        expect(exactTierTotal({ kind: 'skilling', anchors: [{ tier: 3, total: 49_920 }], tier: 0 })).toBeNull();
        expect(exactTierTotal({ kind: 'skilling', anchors: [{ tier: 3, total: 49_920 }], tier: 99 })).toBeNull();
        expect(exactTierTotal({ kind: 'skilling', anchors: [{ tier: 99, total: 1 }], tier: 4 })).toBeNull();
    });
});

describe('the tier a work target identifies', () => {
    test('the two confirmed guilds both back out to base 40,000, and back in to their tiers', () => {
        // Learning: 49,920 = 40,000 × 1.2 × 1.04 (T3, 4 participants) and
        // 88,920 = 40,000 × 1.9 × 1.17 (T10, 17 participants)
        expect(baseWorkFromObservations([{ tier: 3, total: 49_920 }], 4)).toBeCloseTo(40_000, 6);
        expect(baseWorkFromObservations([{ tier: 10, total: 88_920 }], 17)).toBeCloseTo(40_000, 6);

        // Inference: the same two targets identify their tiers from the base
        expect(tierFromWorkTarget({ target: 49_920, baseWork: 40_000, participants: 4 })).toBe(3);
        expect(tierFromWorkTarget({ target: 88_920, baseWork: 40_000, participants: 17 })).toBe(10);
    });

    test('a target that fits no whole tier is null, never the nearest guess', () => {
        expect(tierFromWorkTarget({ target: 51_000, baseWork: 40_000, participants: 4 })).toBeNull();
        expect(tierFromWorkTarget({ target: 51_000, baseWork: 40_000, participants: 0 })).toBeNull();
    });

    test('an unknown party size is solved jointly when the target factors uniquely', () => {
        // The live case: the In Progress tab states no sign-up count, and the
        // second character's bar read 8,276/51,360 — 40,000 × 1.2 × 1.07, tier
        // 3 with 7 signed up, and no other (t, p) on the ladder produces it
        expect(solveWorkLadder({ target: 51_360, baseWork: 40_000 })).toEqual({ tier: 3, participants: 7 });
        expect(tierFromWorkTarget({ target: 51_360, baseWork: 40_000, participants: 0 })).toBe(3);
        // A *stale* stated count self-heals through the same search
        expect(tierFromWorkTarget({ target: 51_360, baseWork: 40_000, participants: 4 })).toBe(3);
        // And the first guild's own target solves with its count missing too
        expect(tierFromWorkTarget({ target: 49_920, baseWork: 40_000, participants: 0 })).toBe(3);
    });

    test('a target that factors more than one way stays honestly unknown', () => {
        // 52,800 is 40,000 × 1.32: T1 with 32 signed, T2 with 20, and T3 with
        // 10 all produce it exactly, and nothing may pick between them
        expect(solveWorkLadder({ target: 52_800, baseWork: 40_000 })).toBeNull();
        expect(tierFromWorkTarget({ target: 52_800, baseWork: 40_000, participants: 0 })).toBeNull();
    });

    test('the combat ladder identifies the tier from the boss health maximum', () => {
        // Trial Chameleon, base 550,000: the T1 boss with 4 signed up reads
        // 572,000 = 550,000 × (110/110) × 1.04, and the recorded T2 with 3
        // signed up read 618,000 = 550,000 × (120/110) × 1.03
        expect(tierFromWorkTarget({ target: 572_000, baseWork: 550_000, participants: 4, kind: 'combat' })).toBe(1);
        expect(tierFromWorkTarget({ target: 618_000, baseWork: 550_000, participants: 3, kind: 'combat' })).toBe(2);
        // …and back out to the same base
        expect(baseWorkFromObservations([{ tier: 1, total: 572_000 }], 4, 'combat')).toBeCloseTo(550_000, 6);
        expect(baseWorkFromObservations([{ tier: 2, total: 618_000 }], 3, 'combat')).toBeCloseTo(550_000, 6);
    });

    test('the combat pool bar identifies the tier with no participant factor at all', () => {
        // The fight view's second bar, observed live: 547,970/550,000 at T1
        // became 597,970/600,000 at T2 — exactly 110 → 120 on a 5,000-per-unit
        // base, unscaled by the party
        expect(tierFromWorkTarget({ target: 550_000, baseWork: 550_000, participants: 0, kind: 'combat' })).toBe(1);
        expect(tierFromWorkTarget({ target: 600_000, baseWork: 550_000, participants: 0, kind: 'combat' })).toBe(2);
        // A combat target that fits no tier is refused the same way
        expect(tierFromWorkTarget({ target: 580_000, baseWork: 550_000, participants: 0, kind: 'combat' })).toBeNull();
    });

    test('unusable input is null', () => {
        expect(tierFromWorkTarget({ target: 0, baseWork: 40_000, participants: 4 })).toBeNull();
        expect(tierFromWorkTarget({ target: 49_920, baseWork: 0, participants: 4 })).toBeNull();
        expect(tierFromWorkTarget({ target: 49_920, baseWork: null, participants: 4 })).toBeNull();
        expect(tierFromWorkTarget({})).toBeNull();
    });

    test('a tier off the ladder is refused even when the arithmetic is whole', () => {
        // base × (1 + 0.1 × 21) is "tier 22", which does not exist. The joint
        // search may still find a legitimate in-ladder reading of the same
        // figure — 40,000 × 3.1 is also 40,000 × 2.5 × 1.24, T16 with 24
        // signed — but nothing ever answers past the ladder's top.
        const solved = solveWorkLadder({ target: 40_000 * 3.1, baseWork: 40_000 });
        expect(solved === null || solved.tier <= TRIAL_MAX_TIER).toBe(true);
        // The combat ladder has no joint fallback, so the refusal is plain there
        expect(
            tierFromWorkTarget({ target: 550_000 * ((100 + 10 * 22) / 110), baseWork: 550_000, kind: 'combat' })
        ).toBeNull();
    });
});

describe('the pace walk on the exact ladder — the live-trial regression', () => {
    test('a mid-trial join at T3 clears far past T3, not “3 tiers”', () => {
        // The observed fixture: 405 work/s, 8,535 left of T3's 49,920, and
        // 54m45s on the clock. The starved walk reported "3 tiers → T3"; the
        // trial then cleared far beyond it.
        const anchors = [{ tier: 3, total: 49_920 }];
        const rate = 405 / 1000; // per millisecond
        const timeLeftMs = 54.75 * 60_000;

        // The expected final tier, computed from the ladder here rather than
        // read back out of the code under test
        let expected = 3;
        let workBudget = timeLeftMs * rate - 8_535;
        for (let tier = 4; tier <= TRIAL_MAX_TIER; tier += 1) {
            const cost = (49_920 * (1 + 0.1 * (tier - 1))) / 1.2;
            if (workBudget < cost) break;
            workBudget -= cost;
            expected = tier;
        }
        // The point of the regression: the hour clears most of the ladder
        expect(expected).toBeGreaterThan(10);

        const pace = projectPace({
            currentTier: 3,
            remainingInTier: 8_535,
            rate,
            timeLeftMs,
            totalForTier: (tier) => exactTierTotal({ kind: 'skilling', anchors, tier }),
            tiersAlreadyCleared: 2,
        });

        expect(pace.limitedBy).toBe('time');
        expect(pace.finalTier).toBe(expected);
        expect(pace.tiersCleared).toBe(2 + (expected - 3) + 1);
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

describe('combatDamageRate', () => {
    // A combat trial is a ladder of bosses. The bar does not run down once, it
    // runs down repeatedly and jumps back up bigger, and a rate fitted to a
    // monotonic run of samples gives up at the first jump — which is why a live
    // combat card produced no DPS at all for the whole hour it was watched.
    const at = (t, current, max) => ({ t, current, max });

    test('within one tier it is the health that came off', () => {
        const measured = combatDamageRate([at(0, 600_000, 618_000), at(10_000, 500_000, 618_000)]);
        expect(measured.damage).toBe(100_000);
        expect(measured.rate).toBeCloseTo(10, 6);
        expect(measured.boundaries).toBe(0);
        expect(measured.multiTier).toBe(false);
    });

    test('across a tier clear, the recorded trial to the digit', () => {
        // Straight from `Toolasha.debug.exportTrialData()`: tier 2's boss with
        // 23,031 left, then tier 3's boss — 669,500 max, which is the ladder's
        // own step up from 618,000 — already down to 506,273. The party dealt
        // the 23,031 that finished the first and the 163,227 off the second.
        const measured = combatDamageRate(
            [at(1_785_944_109_576, 23_031, 618_000), at(1_785_944_524_243, 506_273, 669_500)],
            { growthPerTier: 669_500 / 618_000 }
        );

        expect(measured.boundaries).toBe(1);
        expect(measured.damage).toBe(186_258);
        expect(measured.multiTier).toBe(false);
        // 186,258 over 414.667 s is a shade under 450 dmg/s
        expect(measured.rate * 1000).toBeCloseTo(449.2, 1);
    });

    test('a jump too big for one step is a lower bound, and says so', () => {
        const measured = combatDamageRate([at(0, 10_000, 618_000), at(10_000, 500_000, 900_000)], {
            growthPerTier: 1.08,
        });
        expect(measured.boundaries).toBe(1);
        expect(measured.multiTier).toBe(true);
    });

    test('with no fitted growth a boundary cannot be shown to be one tier', () => {
        const measured = combatDamageRate([at(0, 10_000, 618_000), at(10_000, 500_000, 669_500)]);
        expect(measured.multiTier).toBe(true);
        expect(measured.damage).toBe(10_000 + 169_500);
    });

    test('readings older than the hour a trial runs for are left out', () => {
        const hour = 60 * 60 * 1000;
        const measured = combatDamageRate([
            at(0, 618_000, 618_000),
            at(hour + 60_000, 600_000, 618_000),
            at(hour + 70_000, 500_000, 618_000),
        ]);
        expect(measured.samples).toBe(2);
        expect(measured.damage).toBe(100_000);
    });

    test('one reading, or none, is not a rate', () => {
        expect(combatDamageRate([at(0, 1, 2)]).rate).toBeNull();
        expect(combatDamageRate([]).rate).toBeNull();
        expect(combatDamageRate(null).rate).toBeNull();
    });

    test('a boss that only healed is no damage rather than negative damage', () => {
        const measured = combatDamageRate([at(0, 100, 618_000), at(10_000, 100, 618_000)]);
        expect(measured.rate).toBeNull();
        expect(measured.damage).toBe(0);
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

describe('the points ladder, across three guilds', () => {
    // Cross-guild, cross-bonus, and exact at every point — which is what makes
    // these rules rather than a fit. Each figure is a card's stated Guild Points
    // divided by that guild's own Builder's Hall bonus
    test('a combat trial banks 200 × (tier + 1)', () => {
        const cases = [
            { stated: 3808, bonus: 0.12, tier: 16 }, // MilkMaxxing, Trial Badger
            { stated: 2912, bonus: 0.12, tier: 12 }, // MilkMaxxing, Trial Hedgehog
            { stated: 480, bonus: 0.2, tier: 1 }, // the first guild watched
            { stated: 944, bonus: 0.18, tier: 3 }, // the Lazy guild, Trial Chameleon
        ];

        for (const { stated, bonus, tier } of cases) {
            expect(trialBasePoints('combat', tier)).toBe(200 * (tier + 1));
            expect(stated / (1 + bonus)).toBeCloseTo(200 * (tier + 1), 6);
            expect(
                interpretCardPoints({ type: 'combat', tier, statedPoints: stated, buildersHallBonus: bonus })
                    .interpretation
            ).toBe('cumulative');
        }
    });

    test('a skilling trial banks 100 × (tier + 1)', () => {
        const cases = [
            { stated: 236, bonus: 0.18, tier: 1 },
            { stated: 354, bonus: 0.18, tier: 2 },
            { stated: 472, bonus: 0.18, tier: 3 },
            { stated: 590, bonus: 0.18, tier: 4 },
            { stated: 840, bonus: 0.2, tier: 6 },
            { stated: 1080, bonus: 0.2, tier: 8 },
        ];

        for (const { stated, bonus, tier } of cases) {
            expect(trialBasePoints('skilling', tier)).toBe(100 * (tier + 1));
            expect(stated / (1 + bonus)).toBeCloseTo(100 * (tier + 1), 6);
        }
    });

    test('the ladder is uniform: high tiers follow the same rule', () => {
        // No high-tier wrinkle. MilkMaxxing's T10/T11/T12 look off only because
        // they were banked across a Builder's Hall upgrade
        expect(trialBasePoints('skilling', 10)).toBe(1100);
        expect(trialBasePoints('skilling', 11)).toBe(1200);
        expect(trialBasePoints('skilling', 12)).toBe(1300);
        expect(trialBasePoints('combat', 16)).toBe(3400);
    });

    test('a total banked across a Builder’s Hall upgrade decomposes exactly', () => {
        // Points bank live, tier by tier, at the bonus in force when each tier
        // clears. The Hall went 5 → 6 (+10% → +12%) during the skilling hour
        expect(500 * 1.1 + 600 * 1.12).toBeCloseTo(1222, 9); // Milking T10, base 1,100
        expect(600 * 1.1 + 600 * 1.12).toBeCloseTo(1332, 9); // Foraging T11, base 1,200
        expect(600 * 1.1 + 700 * 1.12).toBeCloseTo(1444, 9); // Crafting T12, base 1,300

        // The combat hour ran afterwards, entirely at +12%, which is why those
        // cards divided cleanly
        expect(2912 / 1.12).toBeCloseTo(trialBasePoints('combat', 12), 6);
    });

    test('and is reported as an upgrade rather than as a disagreement', () => {
        for (const { stated, tier } of [
            { stated: 1222, tier: 10 },
            { stated: 1332, tier: 11 },
            { stated: 1444, tier: 12 },
        ]) {
            const reading = interpretCardPoints({
                type: 'skilling',
                tier,
                statedPoints: stated,
                buildersHallBonus: 0.12,
            });

            expect(reading.interpretation).toBe('mid-trial-upgrade');
        }
    });

    test('the envelope is exactly one or two Builder’s Hall levels wide', () => {
        // Open at the bottom by two levels, closed at the top — a total that
        // matches today's bonus is `cumulative` and never reaches this
        expect(withinMidTrialUpgrade(1100 * 1.12, 1100, 0.12)).toBe(false);
        expect(withinMidTrialUpgrade(1100 * 1.1, 1100, 0.12)).toBe(true);
        expect(withinMidTrialUpgrade(1100 * 1.08, 1100, 0.12)).toBe(true);
        // Three levels below is not a building this guild has ever had
        expect(withinMidTrialUpgrade(1100 * 1.06, 1100, 0.12)).toBe(false);
        // And nothing above today's bonus is an upgrade downwards
        expect(withinMidTrialUpgrade(1100 * 1.2, 1100, 0.12)).toBe(false);
    });

    test('a figure genuinely wrong is still called wrong', () => {
        const reading = interpretCardPoints({
            type: 'skilling',
            tier: 10,
            statedPoints: 700,
            buildersHallBonus: 0.12,
        });
        expect(reading.interpretation).toBe('disagrees');
    });

    test('the card still states the Guild Points, but the base comes off the ladder', () => {
        // Dividing by today's bonus recovers the base exactly only when one
        // bonus applied throughout. Across an upgrade it lands under the truth,
        // and tokens are paid on base — so 1,222 ÷ 1.12 = 1,091 would quietly
        // short every member by nine points' worth
        const banked = trialBankedBasePoints({
            type: 'skilling',
            bankedTiers: 10,
            pointsByTier: { 10: 1222 },
            buildersHallBonus: 0.12,
        });

        expect(banked.guildPoints).toBe(1222);
        expect(banked.basePoints).toBe(1100);
        expect(banked.basePoints).not.toBeCloseTo(1222 / 1.12, 2);
        // The base is the ladder's and the Guild Points are the card's
        expect(banked.source).toBe('mixed');
    });

    test('a cleanly-dividing card is untouched, because the two already agree', () => {
        const banked = trialBankedBasePoints({
            type: 'combat',
            bankedTiers: 12,
            pointsByTier: { 12: 2912 },
            buildersHallBonus: 0.12,
        });

        expect(banked.guildPoints).toBe(2912);
        expect(banked.basePoints).toBeCloseTo(2600, 6);
        expect(banked.source).toBe('game');
    });

    test('the token sum uses the ladder base, not the divided one', () => {
        const projection = payoutProjection({
            trials: [{ type: 'skilling', tiersCleared: 10, basePointsOverride: 1100, guildPointsOverride: 1222 }],
            buildersHallBonus: 0.12,
            treasuryBonus: 0.1,
        });

        expect(projection.basePoints).toBe(1100);
        expect(projection.guildPoints).toBe(1222);
        // Half the base at the Treasury's +10%, paid once at the end
        expect(projection.eligibleTokens).toBeCloseTo(0.5 * 1100 * 1.1, 6);
    });

    test('the game’s own card confirms the level maps to tiers banked', () => {
        // With Toolasha disabled the trial card reads "Crafting Lv.210, 1,664
        // pts" and nothing else — the tier chip beside the level is this
        // script's own rendering. The points settle what the level means:
        // 1,664 is the twelve-tier base of 1,300 at a +28% Builder's Hall
        // exactly — a whole number of 2% steps at no other banked count — and
        // tierFromLevel(210) is 12. So the level names the tier *banked*, and
        // the tier in progress is one past it, exactly as the badge rule reads.
        expect(tierFromLevel(210)).toBe(12);
        expect(trialBasePoints('skilling', 12)).toBe(1_300);
        expect(1_664 / 1_300).toBeCloseTo(1.28, 12);
        expect(
            interpretCardPoints({ type: 'skilling', tier: 12, statedPoints: 1_664, buildersHallBonus: 0.28 })
                .interpretation
        ).toBe('cumulative');
        // The alternative reading — Lv.210 as eleven banked — needs a hall
        // bonus that is not a whole number of levels, and is refused
        expect((1_664 / trialBasePoints('skilling', 11) - 1) / 0.02).not.toBeCloseTo(
            Math.round((1_664 / trialBasePoints('skilling', 11) - 1) / 0.02),
            2
        );
    });

    test('a card older than the banked count is topped up the ladder’s steps', () => {
        // The live figures: the crafting card was last read at T8 stating
        // 1,080 pts, and fourteen tiers stood banked by the time the payout
        // rendered — which showed the stale 1,080 against a Trials tab
        // stating 1,800. Six tiers × 100 base × 1.2 tops it up exactly.
        const banked = trialBankedBasePoints({
            type: 'skilling',
            bankedTiers: 14,
            pointsByTier: { 8: 1080 },
            buildersHallBonus: 0.2,
        });

        expect(banked.basePoints).toBeCloseTo(1_500, 9);
        expect(banked.guildPoints).toBeCloseTo(1_800, 9);
        // Part card, part ladder — and the caption machinery says so
        expect(banked.source).toBe('mixed');
        expect(banked.interpretation).toBe('cumulative');
    });

    test('a card at the banked count is used exactly as stated, as before', () => {
        const banked = trialBankedBasePoints({
            type: 'skilling',
            bankedTiers: 8,
            pointsByTier: { 8: 1080 },
            buildersHallBonus: 0.2,
        });

        expect(banked.basePoints).toBeCloseTo(900, 9);
        expect(banked.guildPoints).toBe(1080);
        expect(banked.source).toBe('game');
    });
});

describe('trialFromHrid', () => {
    // The socket names a trial by hrid where every other source names it in
    // prose off a card, and both halves of the feature have to agree
    test('the two families the game uses', () => {
        expect(trialFromHrid('/guild_combat/badger')).toEqual({ kind: 'combat', key: 'badger', name: 'Trial Badger' });
        expect(trialFromHrid('/guild_skilling/crafting')).toEqual({
            kind: 'skilling',
            key: 'crafting',
            name: 'Crafting',
        });
    });

    test('the name it produces is the name a card carries', () => {
        // Which is what the record is keyed by
        expect(isTrialName(trialFromHrid('/guild_combat/badger').name)).toBe(true);
        expect(isTrialName(trialFromHrid('/guild_skilling/crafting').name)).toBe(true);
    });

    test('an hrid it does not recognise is not a trial', () => {
        expect(trialFromHrid('/guild_skilling/knitting')).toBeNull();
        expect(trialFromHrid('/monsters/chimerical_beast')).toBeNull();
        expect(trialFromHrid('')).toBeNull();
        expect(trialFromHrid(null)).toBeNull();
    });
});

describe('isTrialName', () => {
    test('the five encounters and the ten skills a trial can run in', () => {
        expect(isTrialName('Trial Chameleon')).toBe(true);
        expect(isTrialName('Milking')).toBe(true);
        expect(isTrialName('Alchemy')).toBe(true);
        expect(isTrialName('Enhancing')).toBe(true);
    });

    test('nothing else on the guild page is a trial', () => {
        // This is the one filter standing between the card reader and the rest
        // of the panel, now that cards are found by shape rather than by class
        expect(isTrialName('Treasury')).toBe(false);
        expect(isTrialName('Builders Hall')).toBe(false);
        expect(isTrialName('Guild Experience')).toBe(false);
        expect(isTrialName('MillenniumTest')).toBe(false);
        expect(isTrialName('')).toBe(false);
    });
});

describe('a name has to be a name before it is matched', () => {
    // A guild's whole notice board — braille art, a welcome, three Discord links
    // and the kick rules, 987 characters over twenty lines — arrived here as a
    // card name on a live client. The matcher happened to reject that paragraph;
    // a filter should not depend on happening to
    test('a multiline notice is refused before any matching happens', () => {
        expect(isTrialName(NOTICE_BOARD_NAME)).toBe(false);
        expect(NOTICE_BOARD_NAME.length).toBeGreaterThan(MAX_TRIAL_NAME_CHARS);
        expect(NOTICE_BOARD_NAME).toContain('\n');
    });

    test('a newline is disqualifying even when a line of it is a trial', () => {
        expect(isTrialName('Milking\nJoin our Discord')).toBe(false);
        expect(isTrialName('Trial Chameleon\n')).toBe(false);
    });

    test('a name longer than a name is refused whatever it says', () => {
        expect(isTrialName(`Milking${' '.repeat(MAX_TRIAL_NAME_CHARS)}`)).toBe(false);
    });

    test('and every real decoration still fits inside the limit', () => {
        expect('Trial Chameleon Lv.140 T6'.length).toBeLessThan(MAX_TRIAL_NAME_CHARS);
        expect(isTrialName('Trial Chameleon Lv.140 T6')).toBe(true);
        expect(isTrialName('Cheesesmithing Lv.200 T11')).toBe(true);
    });
});

describe('a name that is not a card\u2019s', () => {
    // The reported failure: the trial panel drew itself over the guild's
    // Overview tab. The notice board is prose, prose mentions skills, and the
    // guild XP bar reads "4,120 / 20,000" — which looks exactly like a progress
    // reading. A substring test on the name was the last thing standing between
    // a paragraph and a trial card, and it let one through.
    test('prose that mentions a skill is not a trial', () => {
        expect(isTrialName('We are milking at Level 90 if anyone wants to join')).toBe(false);
        expect(isTrialName('Welcome! Read the rules before crafting anything')).toBe(false);
        expect(isTrialName('Guild Experience')).toBe(false);
        expect(isTrialName('Exp to Next Level')).toBe(false);
    });

    test('a card\u2019s own name still is, decorations and all', () => {
        expect(isTrialName('Milking')).toBe(true);
        expect(isTrialName('Alchemy')).toBe(true);
        expect(isTrialName('Trial Chameleon')).toBe(true);
        expect(isTrialName('Milking Lv.130')).toBe(true);
        expect(isTrialName('Trial Jellyfish Lv.170')).toBe(true);
        expect(isTrialName('Alchemy T6')).toBe(true);
        expect(isTrialName('  Cheesesmithing  ')).toBe(true);
    });

    test('nothing is not a trial', () => {
        expect(isTrialName('')).toBe(false);
        expect(isTrialName(null)).toBe(false);
        expect(isTrialName('Lv.130')).toBe(false);
    });
});

describe('tierMarginalPoints', () => {
    test('the first tier is worth more than the ones after it', () => {
        expect(tierMarginalPoints('skilling', 1)).toBe(200);
        expect(tierMarginalPoints('skilling', 2)).toBe(100);
        expect(tierMarginalPoints('combat', 1)).toBe(400);
        expect(tierMarginalPoints('combat', 7)).toBe(200);
    });

    test('an unusable tier or type is null', () => {
        expect(tierMarginalPoints('skilling', 0)).toBeNull();
        expect(tierMarginalPoints('fishing', 3)).toBeNull();
    });
});

describe('interpretCardPoints', () => {
    // A card states Guild Points — base × (1 + Builders Hall) — and the ladder
    // states base. Comparing them without dividing the bonus back out made every
    // card in the game look like a disagreement, and put a warning on screen
    // saying the ladder needed correcting when it did not.
    test('a running total is recognised as one, once the bonus is off it', () => {
        // Skilling tier 5 cumulative is 200 + 100×4 = 600 of base, and the card
        // states 720 against a +20% Builder's Hall
        const reading = interpretCardPoints({
            type: 'skilling',
            tier: 5,
            statedPoints: 720,
            buildersHallBonus: 0.2,
        });
        expect(reading.interpretation).toBe('cumulative');
        expect(reading.basePoints).toBeCloseTo(600, 6);
        expect(reading.ladderCumulative).toBe(600);
        expect(reading.ambiguous).toBe(false);
    });

    test('the live cards, to the digit', () => {
        // The three cards on the day the guild announced "2880 Guild Points
        // earned", against its Builder's Hall at level 10
        const read = (type, tier, statedPoints) =>
            interpretCardPoints({ type, tier, statedPoints, buildersHallBonus: 0.2 });

        expect(read('skilling', 6, 840)).toMatchObject({ interpretation: 'cumulative' });
        expect(read('skilling', 8, 1080)).toMatchObject({ interpretation: 'cumulative' });
        expect(read('combat', 3, 960)).toMatchObject({ interpretation: 'cumulative' });
        expect(read('combat', 1, 480)).toMatchObject({ interpretation: 'cumulative' });
        expect(read('skilling', 6, 840).basePoints).toBeCloseTo(700, 6);
    });

    test('a per-tier step is recognised as one', () => {
        const reading = interpretCardPoints({ type: 'combat', tier: 4, statedPoints: 240, buildersHallBonus: 0.2 });
        expect(reading.interpretation).toBe('marginal');
        expect(reading.ladderMarginal).toBe(200);
    });

    test('at tier one the two readings are the same number and it says so', () => {
        const reading = interpretCardPoints({ type: 'skilling', tier: 1, statedPoints: 200, buildersHallBonus: 0 });
        expect(reading.ambiguous).toBe(true);
    });

    test('a figure matching neither is reported rather than rounded towards one', () => {
        const reading = interpretCardPoints({ type: 'skilling', tier: 5, statedPoints: 725, buildersHallBonus: 0.2 });
        expect(reading.interpretation).toBe('disagrees');
    });

    test('without the bonus the figure cannot be divided down, and it says so', () => {
        // Guessing the 1.2 that is true of one guild would corrupt every other
        const reading = interpretCardPoints({ type: 'skilling', tier: 6, statedPoints: 840 });
        expect(reading.interpretation).toBe('unbonused');
        expect(reading.basePoints).toBeNull();
        expect(reading.bonusKnown).toBe(false);
    });

    test('unusable input is null', () => {
        expect(interpretCardPoints({ type: 'skilling', tier: 5 })).toBeNull();
        expect(interpretCardPoints({ type: 'fishing', tier: 5, statedPoints: 600 })).toBeNull();
        expect(interpretCardPoints()).toBeNull();
    });
});

describe('inferBuildersHallBonus', () => {
    test('the bonus falls out of the cards themselves', () => {
        // 840/700, 1,080/900 and 960/800 are all 1.2 — the guild's Builder's
        // Hall at level 10, recovered without the Buildings tab
        const inferred = inferBuildersHallBonus([
            { type: 'skilling', pointsByTier: { 6: 840, 8: 1080 } },
            { type: 'combat', pointsByTier: { 3: 960 } },
        ]);
        expect(inferred).toMatchObject({ bonus: 0.2, level: 10, cards: 3 });
    });

    test('cards that disagree infer nothing', () => {
        expect(inferBuildersHallBonus([{ type: 'combat', pointsByTier: { 4: 1111, 5: 1200 } }])).toBeNull();
    });

    test('a ratio that is not a whole number of 2% steps infers nothing', () => {
        expect(inferBuildersHallBonus([{ type: 'skilling', pointsByTier: { 5: 725 } }])).toBeNull();
    });

    test('a ratio beyond twenty levels infers nothing', () => {
        expect(inferBuildersHallBonus([{ type: 'skilling', pointsByTier: { 5: 1200 } }])).toBeNull();
        expect(inferBuildersHallBonus([])).toBeNull();
    });
});

describe('a card that states nothing yet', () => {
    test('zero points is not a figure to disagree with', () => {
        // Reported live: "Trial Chameleon T1 states 0 pts, which is neither the
        // running total nor the per-tier step…" — on a combat trial that had not
        // started. A card reading 0 is a card with nothing to say.
        const banked = trialBankedBasePoints({
            type: 'combat',
            bankedTiers: 0,
            pointsByTier: { 1: 0 },
            buildersHallBonus: 0.2,
        });

        expect(banked.interpretation).toBeNull();
        expect(banked.quoted).toBeNull();
        expect(banked.source).toBe('ladder');
    });

    test('a real figure beside a zero is still read', () => {
        const banked = trialBankedBasePoints({
            type: 'skilling',
            bankedTiers: 6,
            pointsByTier: { 6: 840, 7: 0 },
            buildersHallBonus: 0.2,
        });

        expect(banked.quoted).toEqual({ tier: 6, statedPoints: 840 });
        expect(banked.guildPoints).toBe(840);
    });
});

describe('trialBankedBasePoints', () => {
    test('with no card seen it is the ladder, and says so', () => {
        const banked = trialBankedBasePoints({ type: 'combat', bankedTiers: 3 });
        expect(banked).toMatchObject({ basePoints: 800, source: 'ladder' });
    });

    test('the card is what the trial has earned, at the tier the card names', () => {
        // The bug this replaces: the figure was looked up under this script's
        // own "tier on screen minus one" inference, which is not the tier the
        // card files its points under. It missed every time and fell through to
        // the ladder — a whole tier short on every trial of every week.
        const banked = trialBankedBasePoints({
            type: 'skilling',
            bankedTiers: 5,
            pointsByTier: { 6: 840 },
            buildersHallBonus: 0.2,
        });
        expect(banked).toMatchObject({ guildPoints: 840, source: 'game', interpretation: 'cumulative', cardTier: 6 });
        expect(banked.basePoints).toBeCloseTo(700, 6);
    });

    test('marginal cards are added up, and the ladder fills the tiers never seen', () => {
        const banked = trialBankedBasePoints({
            type: 'skilling',
            bankedTiers: 3,
            // Tier 3's card states 120, which is the per-tier step of 100 bonused
            pointsByTier: { 3: 120 },
            buildersHallBonus: 0.2,
        });
        // Tiers 1 and 2 were never on screen, so 200 + 100 comes from the ladder
        expect(banked).toMatchObject({ source: 'mixed', interpretation: 'marginal' });
        expect(banked.basePoints).toBeCloseTo(400, 6);
        expect(banked.guildPoints).toBeCloseTo(480, 6);
    });

    test('a card that agrees with neither reading is flagged and still believed', () => {
        const banked = trialBankedBasePoints({
            type: 'skilling',
            bankedTiers: 4,
            pointsByTier: { 5: 725 },
            buildersHallBonus: 0.2,
        });
        expect(banked.interpretation).toBe('disagrees');
        expect(banked.guildPoints).toBe(725);
    });

    test('without a Builders Hall bonus the card is shown but not converted', () => {
        const banked = trialBankedBasePoints({ type: 'skilling', bankedTiers: 5, pointsByTier: { 6: 840 } });
        expect(banked).toMatchObject({
            guildPoints: 840,
            basePoints: 600,
            source: 'ladder',
            needsBuildersHall: true,
        });
    });
});

describe('payoutProjection with the game’s own figures', () => {
    test('an override wins over the ladder and is labelled', () => {
        const payout = payoutProjection({
            trials: [{ type: 'skilling', tiersCleared: 4, basePointsOverride: 555 }],
            buildersHallBonus: 0.2,
            treasuryBonus: 0,
        });

        expect(payout.basePoints).toBe(555);
        expect(payout.perTrial[0].basePointsSource).toBe('game');
        expect(payout.guildPoints).toBeCloseTo(666);
    });

    test('without one, nothing changes', () => {
        const payout = payoutProjection({ trials: [{ type: 'skilling', tiersCleared: 4 }] });
        expect(payout.basePoints).toBe(500);
        expect(payout.perTrial[0].basePointsSource).toBe('ladder');
    });
});

describe('a card the ladder cannot explain', () => {
    test('is still believed, and the highest tier quoted is the one read', () => {
        // "Prefer the game's number where they disagree": the card is the game
        // talking about this trial, and the ladder is prose reconstructed
        const banked = trialBankedBasePoints({
            type: 'combat',
            bankedTiers: 4,
            pointsByTier: { 4: 1111, 5: 1200 },
            buildersHallBonus: 0.2,
        });

        expect(banked.guildPoints).toBe(1200);
        expect(banked.basePoints).toBeCloseTo(1000, 6);
        expect(banked.source).toBe('game');
        expect(banked.ladder).toBe(1000);
        expect(banked.quoted).toEqual({ tier: 5, statedPoints: 1200 });
        // Combat T5 is 1,200 of base on the ladder, so a card stating 1,200 of
        // *Guild Points* is 1,000 of base and agrees with neither reading. It is
        // used as stated all the same — the card is the game talking
        expect(banked.interpretation).toBe('disagrees');
    });
});

describe('the payout, against four days of the guild’s own announcements', () => {
    // The only ground truth this feature has ever had. Chat, on four
    // consecutive days, with this guild's Builder's Hall at level 10 (+20%) and
    // its Treasury at level 5 (+10%):
    //
    //   2,160 points → 990 tokens each, participants +495
    //   1,920 points → 880 each, +440
    //   3,000 points → 1,375 each, +688 (687.5 rounded)
    //   2,880 points → 1,320 each, +660
    //
    // The "extra ×1.1" those numbers imply over half the base is the Treasury.
    // Nothing was invented to fit them; this is the model as the guide states it.
    test.each([
        [2160, 990],
        [1920, 880],
        [3000, 1375],
        [2880, 1320],
    ])('%i announced Guild Points pays %i tokens per eligible member', (announced, tokens) => {
        const payout = payoutProjection({
            trials: [
                {
                    type: 'skilling',
                    tiersCleared: 0,
                    basePointsOverride: announced / 1.2,
                    guildPointsOverride: announced,
                },
            ],
            buildersHallBonus: 0.2,
            treasuryBonus: 0.1,
        });

        expect(payout.guildPoints).toBe(announced);
        expect(payout.eligibleTokens).toBeCloseTo(tokens, 6);
        expect(payout.participantBonusTokens).toBeCloseTo(tokens / 2, 6);
    });

    test('the three cards of the watched day sum to the announced total', () => {
        const hall = 0.2;
        const trials = [
            { type: 'skilling', tier: 6, stated: 840 },
            { type: 'skilling', tier: 8, stated: 1080 },
            { type: 'combat', tier: 3, stated: 960 },
        ].map(({ type, tier, stated }) => {
            const banked = trialBankedBasePoints({
                type,
                bankedTiers: tier - 1,
                pointsByTier: { [tier]: stated },
                buildersHallBonus: hall,
            });
            return {
                type,
                tiersCleared: tier,
                basePointsOverride: banked.basePoints,
                guildPointsOverride: banked.guildPoints,
            };
        });

        const payout = payoutProjection({ trials, buildersHallBonus: hall, treasuryBonus: 0.1 });
        expect(payout.guildPoints).toBe(2880);
        expect(payout.basePoints).toBeCloseTo(2400, 6);
        expect(payout.eligibleTokens).toBeCloseTo(1320, 6);
        expect(payout.participantTokens).toBeCloseTo(1980, 6);
    });
});
