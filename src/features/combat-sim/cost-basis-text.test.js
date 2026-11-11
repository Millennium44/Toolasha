import { describe, test, expect } from 'vitest';
import { ladderSentence, compactCostLines } from './cost-basis-text.js';

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
