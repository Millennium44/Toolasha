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
        getSettingValue: (key, fallback) => settings.store[key] ?? fallback,
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
                [TRADEABLE]: { name: 'Test Sword', isTradable: true },
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
    enhancementParamsFor,
    describeEnhancementSource,
    buildSourceChipHTML,
} = await import('./enhancement-params-source.js');

beforeEach(() => {
    settings.store = {};
});

describe('the active source', () => {
    test('defaults to the player’s own stats', () => {
        expect(isProRatesActive()).toBe(false);
        expect(enhancementParamsFor('tooltip', TRADEABLE).kit).toBe('yours');
    });

    test('switching to pro rates changes which parameters the tooltip is computed from', () => {
        expect(enhancementParamsFor('tooltip', TRADEABLE).kit).toBe('yours');

        toggleProRates();

        expect(enhancementParamsFor('tooltip', TRADEABLE).kit).toBe('pro');
        expect(enhancementParamsFor('tooltip', TRADEABLE).paramsSource).toBe('pro');
    });

    test('toggling twice comes back to the player’s stats', () => {
        expect(toggleProRates()).toBe(true);
        expect(toggleProRates()).toBe(false);
        expect(enhancementParamsFor('tooltip', TRADEABLE).kit).toBe('yours');
    });

    test('an untradeable item is quoted from the character', () => {
        // Nobody else can be enhancing a soulbound item, so the simulator's manual bench would
        // be describing a run that cannot be made
        expect(enhancementParamsFor('tooltip', UNTRADEABLE).kit).toBe('detected');
    });

    test('pro rates do NOT reach a soulbound item — a pro can never enhance it for you', () => {
        // The maintainer's ruling, 2026-08-30: an untradable piece can only ever be enhanced
        // at YOUR bench, so the own-bench rule sits above the toggle. Pro answers "what would
        // buying the finished run cost" — a question with no answer for a piece nobody can
        // hand over.
        setProRatesActive(true);

        expect(enhancementParamsFor('tooltip', UNTRADEABLE).kit).toBe('detected');
    });

    test('every market-facing surface answers the same toggle', () => {
        setProRatesActive(true);

        for (const surface of ['tooltip', 'advisor', 'lab:route', 'lab:ranking', 'planner']) {
            expect(enhancementParamsFor(surface, TRADEABLE).kit).toBe('pro');
        }
        // The savings card is always on its own bench — its enhancing path only
        // fires for a piece with no ask, and the own-bench rule outranks Pro
        expect(enhancementParamsFor('savings', TRADEABLE).kit).toBe('detected');
    });

    test('the savings card is on its own bench whatever the simulator says', () => {
        // Its enhancing path only fires when the finished piece has no ask at any price
        expect(enhancementParamsFor('savings', TRADEABLE).kit).toBe('detected');
    });

    test('a surface with no item to ask about takes the simulator’s answer', () => {
        expect(enhancementParamsFor('lab:ranking').kit).toBe('yours');
    });

    test('the planner’s training rate is the character’s own bench, whatever the toggle says', () => {
        // It rates how fast THIS character's skill climbs; a pro's bench cannot earn them XP.
        // It used to be asked as the item-rule surface with '/items/coin' as a stand-in, which
        // left the bench choice riding on coin's `isTradable` flag.
        expect(enhancementParamsFor('planner:training').kit).toBe('detected');

        setProRatesActive(true);
        expect(enhancementParamsFor('planner:training').kit).toBe('detected');
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
        expect(reloaded.enhancementParamsFor('tooltip', TRADEABLE).kit).toBe('pro');
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

    test('says Manual for a manual bench even when no field was named', () => {
        // "Yours" means detected, everywhere. A manual run with nothing overridden is still the
        // bench the player told it about; this used to print "Yours" beside the same numbers a
        // genuinely detected run printed it beside.
        const source = describeEnhancementSource({ paramsSource: 'manual', manualOverrides: [] });

        expect(source.kind).toBe('manual');
        expect(source.label).toBe('Manual');
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

    test('surfaces the P hotkey as a visible affordance on desktop', () => {
        const chip = buildSourceChipHTML({ paramsSource: 'auto' });
        expect(chip).toContain('>P</span>');
        expect(chip).toContain('press P');
    });

    test('on a touch device it invites a tap and drops the key it cannot press', () => {
        settings.store.mobileMode = 'on';
        const chip = buildSourceChipHTML({ paramsSource: 'auto' });
        delete settings.store.mobileMode;

        expect(chip).toContain('>tap</span>');
        expect(chip).toContain('Tap to compare against pro rates');
        expect(chip).not.toContain('press P');
    });
});
