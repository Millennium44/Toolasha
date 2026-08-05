/**
 * Tests for the enhancement tooltip's stats source.
 *
 * The numbers themselves are the calculator's problem. What matters here is that the tooltip
 * can never quote one kit while labelling it as another: the source that produced the numbers,
 * the chip that names it, and the setting that persists the choice have to be the same answer.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const TRADEABLE = '/items/test_sword';
const UNTRADEABLE = '/items/soulbound_sword';

/** Persisted settings the mocked config reads and writes */
const settings = vi.hoisted(() => ({ store: {} }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settings.store[key] ?? false,
        setSetting: (key, value) => {
            settings.store[key] = value;
        },
        COLOR_TOOLTIP_WARNING: '#ffb020',
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            itemDetailMap: {
                [TRADEABLE]: { name: 'Test Sword' },
                [UNTRADEABLE]: { name: 'Soulbound Sword', isTradable: false },
            },
        }),
    },
}));

// Each source answers with a tagged object, so a test can say which one was consulted without
// knowing anything about enhancing arithmetic
vi.mock('../../utils/enhancement-config.js', () => ({
    getEnhancingParams: () => ({ kit: 'yours', paramsSource: 'auto', manualOverrides: [] }),
    getAutoDetectedParams: () => ({ kit: 'detected', paramsSource: 'auto', manualOverrides: [] }),
    getProRatesParams: () => ({ kit: 'pro', paramsSource: 'pro', manualOverrides: [] }),
    describeParamsSource: (params) =>
        params?.manualOverrides?.length ? `manual params: ${params.manualOverrides.join(', ')}` : null,
}));

const {
    PRO_RATES_SETTING,
    isProRatesActive,
    setProRatesActive,
    toggleProRates,
    getTooltipEnhancementParams,
    describeEnhancementSource,
    buildSourceChipHTML,
} = await import('./enhancement-params-source.js');

beforeEach(() => {
    settings.store = {};
});

describe('the active source', () => {
    test('defaults to the player’s own stats', () => {
        expect(isProRatesActive()).toBe(false);
        expect(getTooltipEnhancementParams(TRADEABLE).kit).toBe('yours');
    });

    test('switching to pro rates changes which parameters the tooltip is computed from', () => {
        expect(getTooltipEnhancementParams(TRADEABLE).kit).toBe('yours');

        toggleProRates();

        expect(getTooltipEnhancementParams(TRADEABLE).kit).toBe('pro');
        expect(getTooltipEnhancementParams(TRADEABLE).paramsSource).toBe('pro');
    });

    test('toggling twice comes back to the player’s stats', () => {
        expect(toggleProRates()).toBe(true);
        expect(toggleProRates()).toBe(false);
        expect(getTooltipEnhancementParams(TRADEABLE).kit).toBe('yours');
    });

    test('an untradeable item is quoted from the character even when pro rates are on', () => {
        // Nobody else can be enhancing a soulbound item, so a pro's costs would be a fiction
        setProRatesActive(true);

        expect(getTooltipEnhancementParams(UNTRADEABLE).kit).toBe('detected');
    });
});

describe('persistence', () => {
    test('the choice is written to a setting, not held in the module', async () => {
        setProRatesActive(true);

        expect(settings.store[PRO_RATES_SETTING]).toBe(true);

        // A fresh import is a fresh module instance; the choice survives because it lives in
        // settings, which is also what makes it survive a reload
        vi.resetModules();
        const reloaded = await import('./enhancement-params-source.js');

        expect(reloaded.isProRatesActive()).toBe(true);
        expect(reloaded.getTooltipEnhancementParams(TRADEABLE).kit).toBe('pro');
    });

    test('a stored choice of "yours" is honoured', () => {
        settings.store[PRO_RATES_SETTING] = false;
        expect(isProRatesActive()).toBe(false);
    });
});

describe('the source indicator', () => {
    test('names the character’s own stats', () => {
        const source = describeEnhancementSource({ paramsSource: 'auto', manualOverrides: [] });

        expect(source.kind).toBe('yours');
        expect(source.label).toBe('Yours');
    });

    test('names the pro kit, and says what it is', () => {
        const source = describeEnhancementSource({ paramsSource: 'pro' });

        expect(source.kind).toBe('pro');
        expect(source.label).toBe('Pro');
        expect(source.detail).toContain('140');
        expect(source.detail).toContain('Celestial');
    });

    test('names hand-entered parameters, listing which fields were edited', () => {
        const source = describeEnhancementSource({
            paramsSource: 'manual',
            manualOverrides: ['Enhancing level', 'Tea'],
        });

        expect(source.kind).toBe('manual');
        expect(source.label).toBe('Manual');
        expect(source.detail).toContain('Enhancing level');
    });
});

describe('the source chip', () => {
    test('shows the active source and offers the switch', () => {
        const chip = buildSourceChipHTML({ paramsSource: 'auto', manualOverrides: [] });

        expect(chip).toContain('Yours');
        expect(chip).toContain('toolasha-enh-source-chip');
        expect(chip).toContain('cursor: pointer');
    });

    test('is unmistakably highlighted on pro rates, so they cannot be read as your own', () => {
        const yours = buildSourceChipHTML({ paramsSource: 'auto', manualOverrides: [] });
        const pro = buildSourceChipHTML({ paramsSource: 'pro' });

        expect(pro).toContain('Pro');
        expect(pro).toContain('#ffb020');
        expect(pro).toContain('background: #ffb020');
        expect(yours).not.toContain('#ffb020');
    });

    test('says in its tooltip which way the click will move', () => {
        expect(buildSourceChipHTML({ paramsSource: 'auto' })).toContain('compare against pro rates');
        expect(buildSourceChipHTML({ paramsSource: 'pro' })).toContain('back to your own stats');
    });
});
