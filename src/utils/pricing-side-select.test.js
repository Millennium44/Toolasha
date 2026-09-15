/** @vitest-environment happy-dom */

/**
 * The Buy / Sell pricing dropdowns: how a buy side and a sell side map onto the
 * stored pricing mode and the per-side tick settings, and how a dropdown shows
 * and follows them. The skill toolbar and the Best Items header both build
 * theirs from here; their own suites cover where the dropdowns sit.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

/** A small live config: values, and every write in order */
const live = vi.hoisted(() => ({ values: {}, writes: [] }));

vi.mock('../core/config.js', () => ({
    default: {
        getSetting: (key) => live.values[key],
        getSettingValue: (key, fallback) => live.values[key] ?? fallback,
        setSetting: (key, value) => {
            live.values[key] = value;
            live.writes.push([key, value]);
        },
        setSettingValue: (key, value) => {
            live.values[key] = value;
            live.writes.push([key, value]);
        },
    },
}));

vi.mock('./market-values.js', () => ({
    nextPriceUp: (price) => price + 1,
    nextPriceDown: (price) => price - 1,
    clampToBand: (price) => price,
}));

const {
    PRICING_SIDE_CHOICES,
    PRICING_SIDE_SETTING_KEYS,
    applyPricingSideChoice,
    createPricingSideSelect,
    currentPricingSideChoice,
    pricingModeFromSides,
    sidesOfPricingMode,
    syncPricingSideSelect,
} = await import('./pricing-side-select.js');

beforeEach(() => {
    live.values = {
        profitCalc_pricingMode: 'hybrid',
        profitCalc_patientTickBuy: false,
        profitCalc_patientTickSell: false,
        profitCalc_pricingNaming: false,
    };
    live.writes = [];
});

const optionTexts = (select) => Array.from(select.options).map((option) => option.textContent);

describe('a pricing mode is a buy side and a sell side', () => {
    test('each mode splits into its sides and joins back', () => {
        expect(sidesOfPricingMode('conservative')).toEqual({ buy: 'ask', sell: 'bid' });
        expect(sidesOfPricingMode('hybrid')).toEqual({ buy: 'ask', sell: 'ask' });
        expect(sidesOfPricingMode('optimistic')).toEqual({ buy: 'bid', sell: 'ask' });
        expect(sidesOfPricingMode('patientBuy')).toEqual({ buy: 'bid', sell: 'bid' });
        for (const mode of ['conservative', 'hybrid', 'optimistic', 'patientBuy']) {
            const { buy, sell } = sidesOfPricingMode(mode);
            expect(pricingModeFromSides(buy, sell)).toBe(mode);
        }
    });

    test('an unrecognised mode reads as hybrid, the default', () => {
        expect(sidesOfPricingMode('sideways')).toEqual({ buy: 'ask', sell: 'ask' });
    });

    test('a dropdown listens to the mode, the naming and both ticks', () => {
        expect([...PRICING_SIDE_SETTING_KEYS].sort()).toEqual(
            [
                'profitCalc_patientTickBuy',
                'profitCalc_patientTickSell',
                'profitCalc_pricingMode',
                'profitCalc_pricingNaming',
            ].sort()
        );
    });
});

describe('applyPricingSideChoice', () => {
    // [buy choice][sell choice] → the stored mode
    const MODE_FOR = {
        instant: { instant: 'conservative', patient: 'hybrid', patientTick: 'hybrid' },
        patient: { instant: 'patientBuy', patient: 'optimistic', patientTick: 'optimistic' },
        patientTick: { instant: 'patientBuy', patient: 'optimistic', patientTick: 'optimistic' },
    };
    // Where the settings stood before the two choices, including a tick left
    // on behind an instant side from the Settings panel
    const STARTS = [
        { mode: 'hybrid', tickBuy: false, tickSell: false },
        { mode: 'patientBuy', tickBuy: true, tickSell: true },
        { mode: 'conservative', tickBuy: true, tickSell: false },
    ];
    const cases = [];
    for (const start of STARTS) {
        for (const buy of PRICING_SIDE_CHOICES) {
            for (const sell of PRICING_SIDE_CHOICES) cases.push({ start, buy, sell });
        }
    }

    test.each(cases)('from $start.mode: Buy $buy × Sell $sell', ({ start, buy, sell }) => {
        live.values.profitCalc_pricingMode = start.mode;
        live.values.profitCalc_patientTickBuy = start.tickBuy;
        live.values.profitCalc_patientTickSell = start.tickSell;

        applyPricingSideChoice('buy', buy);
        applyPricingSideChoice('sell', sell);

        expect(live.values.profitCalc_pricingMode).toBe(MODE_FOR[buy][sell]);
        expect(live.values.profitCalc_patientTickBuy).toBe(buy === 'patientTick');
        expect(live.values.profitCalc_patientTickSell).toBe(sell === 'patientTick');
        // and the dropdowns read the same choices back
        expect(currentPricingSideChoice('buy')).toBe(buy);
        expect(currentPricingSideChoice('sell')).toBe(sell);
    });

    test('writes the mode first, then the tick, and only what changes', () => {
        expect(applyPricingSideChoice('buy', 'patientTick')).toBe(true);
        expect(live.writes).toEqual([
            ['profitCalc_pricingMode', 'optimistic'],
            ['profitCalc_patientTickBuy', true],
        ]);

        live.writes = [];
        expect(applyPricingSideChoice('buy', 'patientTick')).toBe(false);
        expect(live.writes).toEqual([]);

        // Patient +1 → Patient only drops the tick; the side is already the bid
        expect(applyPricingSideChoice('buy', 'patient')).toBe(true);
        expect(live.writes).toEqual([['profitCalc_patientTickBuy', false]]);
    });

    test("choosing Instant clears that side's tick even where the mode already priced it instantly", () => {
        // Ticked from the Settings panel while the buy side was instant: nothing shows it
        live.values.profitCalc_pricingMode = 'conservative';
        live.values.profitCalc_patientTickBuy = true;
        expect(currentPricingSideChoice('buy')).toBe('instant');

        applyPricingSideChoice('buy', 'instant');

        expect(live.writes).toEqual([['profitCalc_patientTickBuy', false]]);
    });

    test("one side's choice never touches the other side's tick", () => {
        live.values.profitCalc_patientTickSell = true;
        applyPricingSideChoice('buy', 'instant');
        applyPricingSideChoice('buy', 'patientTick');
        expect(live.values.profitCalc_patientTickSell).toBe(true);
    });

    test('an unknown side or choice writes nothing', () => {
        expect(applyPricingSideChoice('hold', 'patient')).toBe(false);
        expect(applyPricingSideChoice('buy', 'eventually')).toBe(false);
        expect(live.writes).toEqual([]);
    });
});

describe('the dropdown element', () => {
    test('three options in the Ask/Bid naming', () => {
        expect(optionTexts(createPricingSideSelect('buy'))).toEqual(['Buy: Ask', 'Buy: Bid', 'Buy: Bid +1']);
        expect(optionTexts(createPricingSideSelect('sell'))).toEqual(['Sell: Bid', 'Sell: Ask', 'Sell: Ask −1']);
    });

    test('three options in the Instant/Patient naming', () => {
        live.values.profitCalc_pricingNaming = true;
        expect(optionTexts(createPricingSideSelect('buy'))).toEqual([
            'Buy: Instant',
            'Buy: Patient',
            'Buy: Patient +1',
        ]);
        expect(optionTexts(createPricingSideSelect('sell'))).toEqual([
            'Sell: Instant',
            'Sell: Patient',
            'Sell: Patient −1',
        ]);
    });

    test('a naming change retexts the options on the next sync', () => {
        const select = createPricingSideSelect('sell');
        live.values.profitCalc_pricingNaming = true;
        syncPricingSideSelect(select);
        expect(optionTexts(select)).toEqual(['Sell: Instant', 'Sell: Patient', 'Sell: Patient −1']);
    });

    test('shows the current choice, and follows a change made elsewhere on sync', () => {
        live.values.profitCalc_pricingMode = 'optimistic';
        live.values.profitCalc_patientTickSell = true;
        const buy = createPricingSideSelect('buy');
        const sell = createPricingSideSelect('sell');
        expect(buy.value).toBe('patient');
        expect(sell.value).toBe('patientTick');

        live.values.profitCalc_pricingMode = 'patientBuy';
        live.values.profitCalc_patientTickBuy = true;
        syncPricingSideSelect(buy);
        syncPricingSideSelect(sell);
        expect(buy.value).toBe('patientTick');
        expect(sell.value).toBe('instant');
    });

    test('a change hands the choice to onChoose and writes nothing itself', () => {
        const onChoose = vi.fn();
        const select = createPricingSideSelect('buy', { onChoose });
        select.value = 'patient';
        select.dispatchEvent(new Event('change'));

        expect(onChoose).toHaveBeenCalledWith('patient');
        expect(live.writes).toEqual([]);
    });

    test('carries the given style and a tooltip explaining the tick', () => {
        const buy = createPricingSideSelect('buy', { cssText: 'border-radius: 4px; font-size: 14px;' });
        const sell = createPricingSideSelect('sell');
        expect(buy.style.borderRadius).toBe('4px');
        expect(buy.style.fontSize).toBe('14px');
        expect(buy.title).toMatch(/one market tick above the bid/);
        expect(sell.title).toMatch(/one market tick below the ask/);
    });
});
