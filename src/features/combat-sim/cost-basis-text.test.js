import { describe, test, expect } from 'vitest';
import {
    budgetPartialCostText,
    compactCostLines,
    ladderSentence,
    partialCostFlagHtml,
    partialCostMarkHtml,
    partialCostOf,
} from './cost-basis-text.js';

const mirror = { mirrorPrice: 1_000_000_000, heldLevels: [10], mirrorCount: 1 };
const ladder = { fromLevel: 11, toLevel: 12, fresh: false, alreadyHeld: false, mirror };
const forgone = [
    {
        hrid: '/items/philosophers_earrings',
        name: "Philosopher's Earrings",
        enhancementLevel: 10,
        value: 3_700_000_000,
    },
];

describe('a mirror route that uses the worn piece', () => {
    const used = {
        ladder,
        gross: 5_200_000_000,
        credit: 0,
        net: 5_200_000_000,
        credits: [],
        source: 'mirror',
        forgone,
    };

    test('Details: what is paid, what sale is given up, and the total, with no duplicate held clause', () => {
        const text = ladderSentence(used.ladder, used.gross, used);
        expect(text).toContain("You pay 5.2B and use your +10 Philosopher's Earrings");
        expect(text).toContain('giving up 3.7B of sale: 8.9B in all.');
        expect(text).not.toContain('you hold');
        expect(text).not.toContain(' for 5.2B');
    });

    test('compact lines say the same', () => {
        const [line] = compactCostLines(used, {});
        expect(line.text).toContain("You pay 5.2B and use your +10 Philosopher's Earrings");
        expect(line.text).toContain('8.9B in all.');
        expect(line.text).not.toContain('you hold');
    });

    test('a spare also held keeps its own "you hold" note', () => {
        const both = { ...used, ladder: { ...ladder, mirror: { ...mirror, heldLevels: [10, 11] } } };
        const text = ladderSentence(both.ladder, both.gross, both);
        expect(text).toContain(', using the +11 you hold');
        expect(text).not.toContain('+10 you hold');
    });
});

describe('a mirror route that sells the replaced piece', () => {
    const sold = {
        ladder: { ...ladder, mirror: { ...mirror, heldLevels: [] } },
        gross: 10_300_000_000,
        credit: 3_700_000_000,
        net: 6_600_000_000,
        credits: [
            { hrid: '/items/philosophers_earrings', name: 'Earrings', enhancementLevel: 10, price: 3_700_000_000 },
        ],
        source: 'mirror',
    };

    test('Details: the gross is followed by the resale that lands on the Cost', () => {
        const text = ladderSentence(sold.ladder, sold.gross, sold);
        expect(text).toContain('for 10.3B, less 3.7B for your +10 sold = 6.6B.');
    });

    test('compact lines keep their resale clause and add no forgone sentence', () => {
        const [line] = compactCostLines(sold, {});
        expect(line.text).toContain('= 10.3B, less 3.7B for your +10 sold = 6.6B.');
        expect(line.text).not.toContain('giving up');
    });
});

describe('rows without the field', () => {
    test('a mirror row with neither a used nor a sold piece reads as before', () => {
        const plain = { ladder, gross: 5_200_000_000, credit: 0, net: 5_200_000_000, credits: [], source: 'mirror' };
        expect(ladderSentence(plain.ladder, plain.gross, plain)).toBe(
            "Mirror a +11 and a +10 copy into a +12 with a 1.0B Philosopher's Mirror for 5.2B, using the +10 you hold."
        );
        expect(ladderSentence(plain.ladder, plain.gross)).toBe(ladderSentence(plain.ladder, plain.gross, plain));
        expect(() => compactCostLines(plain, {})).not.toThrow();
    });

    test('an older saved detail without forgone renders in every ladder shape', () => {
        const old = { gross: 100, credit: 0, net: 100, credits: [], source: 'refine' };
        const refine = {
            ...old,
            ladder: {
                fromLevel: 6,
                toLevel: 7,
                refine: { baseCost: 0, materialCost: 5, lines: ['a'], mirror: { ...mirror, baseCost: 90 } },
            },
        };
        expect(ladderSentence(refine.ladder, refine.gross, refine)).not.toContain('NaN');
        expect(() => compactCostLines(refine, {})).not.toThrow();
        expect(() => ladderSentence(refine.ladder, 100, null)).not.toThrow();
    });
});

describe('refine and enhance rows name the resale credit that lands the Cost', () => {
    const credits = [{ hrid: '/items/kraken_tunic', name: 'Kraken Tunic', enhancementLevel: 0, price: 80_000_000 }];
    const base = { gross: 245_000_000, credit: 78_900_000, net: 166_100_000, credits };

    test('refine ladder: ladder less credit equals Cost', () => {
        const refine = {
            ...base,
            source: 'refine',
            ladder: {
                fromLevel: 10,
                toLevel: 10,
                refine: { lines: ['100 × Pirate Refinement Shard @ 2.45M = 245.00M'], materialCost: 245_000_000 },
            },
        };
        const text = ladderSentence(refine.ladder, refine.gross, refine);
        expect(text).toContain('= 245.0M, less 78.9M for your +0 sold = 166.1M.');
    });

    test('enhance ladder on a spare also names the credit', () => {
        const enhance = { ...base, source: 'enhance', ladder: { fromLevel: 5, toLevel: 10, fresh: false } };
        expect(ladderSentence(enhance.ladder, enhance.gross, enhance)).toContain(
            'on the spare copy you hold, less 78.9M for your +0 sold = 166.1M.'
        );
    });

    test('no credit leaves the refine sentence unchanged', () => {
        const refine = {
            gross: 100,
            credit: 0,
            net: 100,
            credits: [],
            source: 'refine',
            ladder: { fromLevel: 10, toLevel: 10, refine: { lines: ['x'], materialCost: 100 } },
        };
        expect(ladderSentence(refine.ladder, 100, refine)).toBe(
            'Refine your spare +10 (all levels transfer): x = 100.'
        );
    });
});

describe('a price that leaves something out or guesses at it', () => {
    const floor = { partialCost: 'guild tokens not priced', partialCostKind: 'floor' };
    const assumed = {
        costDetail: { partialCost: 'guild tokens valued at an assumed exchange rate', partialCostKind: 'assumed' },
    };

    test('is read off the row, or off its cost breakdown, one lookup for every reader', () => {
        expect(partialCostOf(floor)).toEqual({ reason: 'guild tokens not priced', kind: 'floor' });
        expect(partialCostOf(assumed)).toEqual({
            reason: 'guild tokens valued at an assumed exchange rate',
            kind: 'assumed',
        });
        expect(partialCostOf({ cost: 100 })).toBeNull();
        expect(partialCostOf(null)).toBeNull();
    });

    test('a whole price is left exactly as drawn', () => {
        expect(partialCostMarkHtml({ cost: 100 }, '1.2M')).toBe('1.2M');
        expect(partialCostFlagHtml({ cost: 100 })).toBe('');
    });

    test('a floor reads as "at least" for a cost and "at most" for a return, with the reason on hover', () => {
        const cost = partialCostMarkHtml(floor, '1.2M');
        const roi = partialCostMarkHtml(floor, '40%', { inverse: true });

        expect(cost).toContain('≥ 1.2M');
        expect(cost).toContain('data-cost-partial');
        expect(cost).toContain('guild tokens not priced');
        expect(cost).toContain('higher');
        expect(roi).toContain('≤ 40%');
        expect(roi).toContain('lower');
    });

    test('a guess reads as approximate on either side, and is not a floor', () => {
        const html = partialCostMarkHtml(assumed, '1.2M');
        const roi = partialCostMarkHtml(assumed, '40%', { inverse: true });

        expect(html).toContain('≈ 1.2M');
        expect(html).toContain('guessed');
        expect(roi).toContain('≈ 40%');
        expect(html).not.toContain('≥');
    });

    test('the reason is escaped in the hover', () => {
        const html = partialCostMarkHtml({ partialCost: 'a "b" <c>', partialCostKind: 'floor' }, '1');

        expect(html).toContain('a &quot;b&quot; &lt;c&gt;');
    });

    test('a derived figure like the Score carries a flag, worded for what it is built on', () => {
        expect(partialCostFlagHtml(floor)).toContain('partial price');
        expect(partialCostFlagHtml(assumed)).toContain('guessed price');
    });

    test('the plan footer names each reason, a floor with a plus and a guess in brackets', () => {
        expect(
            budgetPartialCostText({ partialCostNotes: [{ reason: 'guild tokens not priced', kind: 'floor' }] })
        ).toBe('+ guild tokens not priced');
        expect(
            budgetPartialCostText({
                partialCostNotes: [
                    { reason: 'guild tokens not priced', kind: 'floor' },
                    { reason: 'tokens at a guess', kind: 'assumed' },
                ],
            })
        ).toBe('+ guild tokens not priced (tokens at a guess)');
        // A plan saved before the notes existed was only ever a floor
        expect(budgetPartialCostText({ partialCostPicks: ['x'] })).toBe('+ guild tokens not priced');
    });
});
