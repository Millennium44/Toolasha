/** @vitest-environment happy-dom */

/**
 * Tests for the source toggle on an enhancement tooltip section.
 *
 * A chip that names the source is only half the promise; the other half is that flipping it
 * actually recomputes the table from the other kit, in place, while the tooltip is still open.
 * These tests drive the real builders so a chip saying "Pro" over the player's own arithmetic
 * would fail here rather than in front of a player about to price a listing.
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import * as mathjs from 'mathjs';

const ITEM = '/items/test_sword';
const MATERIAL = '/items/test_material';
const MIRROR = '/items/philosophers_mirror';
const PROTECTION = '/items/mirror_of_protection';

const prices = {
    [ITEM]: { ask: 100, bid: 90 },
    [MATERIAL]: { ask: 5000, bid: 4800 },
    [MIRROR]: { ask: 2000, bid: 1900 },
    [PROTECTION]: { ask: 900000, bid: 850000 },
};

const settings = vi.hoisted(() => ({ store: {} }));

const gameData = {
    itemDetailMap: {
        [ITEM]: { name: 'Test Sword', itemLevel: 10, enhancementCosts: [{ itemHrid: MATERIAL, count: 1 }] },
        [MATERIAL]: { name: 'Test Material', sellPrice: 100 },
        [MIRROR]: { name: "Philosopher's Mirror", sellPrice: 1 },
        [PROTECTION]: { name: 'Mirror of Protection', sellPrice: 1 },
    },
    actionDetailMap: {},
};

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => gameData,
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
        getAchievementBuffFlatBoost: () => 0,
        characterData: null,
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        isFeatureEnabled: () => false,
        getSetting: (key) => settings.store[key] ?? false,
        getSettingValue: (key, fallback) => settings.store[key] ?? fallback,
        setSetting: (key, value) => {
            settings.store[key] = value;
        },
        COLOR_MIRROR: '#fff',
        COLOR_BORDER: '#fff',
        COLOR_TOOLTIP_INFO: '#fff',
        COLOR_TOOLTIP_PROFIT: '#fff',
        COLOR_TOOLTIP_LOSS: '#fff',
        COLOR_TOOLTIP_WARNING: '#ffb020',
        COLOR_XP_RATE: '#fff',
    },
}));

// Two kits far enough apart that the same item cannot cost the same under both
const YOURS = {
    enhancingLevel: 1,
    houseLevel: 0,
    toolBonus: 0,
    speedBonus: 0,
    experienceBonus: 0,
    guzzlingBonus: 1,
    blessedTeaBonus: 0.01,
    teas: { blessed: false },
    paramsSource: 'auto',
    manualOverrides: [],
};

const PRO = {
    ...YOURS,
    enhancingLevel: 148,
    houseLevel: 8,
    toolBonus: 25,
    speedBonus: 60,
    teas: { blessed: true, ultraEnhancing: true },
    paramsSource: 'pro',
    manualOverrides: [],
};

vi.mock('../../utils/enhancement-config.js', () => ({
    getEnhancingParams: () => YOURS,
    getAutoDetectedParams: () => YOURS,
    getProRatesParams: () => PRO,
    describeParamsSource: (params) =>
        params?.manualOverrides?.length ? `manual params: ${params.manualOverrides.join(', ')}` : null,
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { on: () => {}, getPrice: (hrid) => prices[hrid] || null },
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => prices[hrid]?.ask ?? 0,
    getItemPrices: (hrid, level) => (level === 0 ? (prices[hrid] ?? null) : null),
}));

vi.mock('../../utils/tea-parser.js', () => ({
    parseArtisanBonus: () => 0,
    getDrinkConcentration: () => 0,
}));

let calculateEnhancementPath;
let buildEnhancementTooltipHTML;
let installEnhancementSourceToggle;
let uninstallEnhancementSourceToggle;
let rerenderOpenEnhancementSections;
let enhancementParamsFor;
let PRO_RATES_SETTING;

beforeAll(async () => {
    globalThis.math = mathjs;
    ({
        calculateEnhancementPath,
        buildEnhancementTooltipHTML,
        installEnhancementSourceToggle,
        uninstallEnhancementSourceToggle,
        rerenderOpenEnhancementSections,
    } = await import('./tooltip-enhancement.js'));
    ({ enhancementParamsFor, PRO_RATES_SETTING } = await import('./enhancement-params-source.js'));
});

/** Draw the enhancement section for an item into a stand-in tooltip, from whatever source is on */
function openTooltip(level = 3) {
    const params = enhancementParamsFor('tooltip', ITEM);
    const data = calculateEnhancementPath(ITEM, level, params);
    document.body.innerHTML = `<div class="MuiTooltip-popper">${buildEnhancementTooltipHTML(data)}</div>`;
}

/** The expected-attempts figure the open section is quoting */
function quotedAttempts() {
    return document.body.textContent.match(/Expected Attempts: ([\d.,KMB]+)/)?.[1] ?? null;
}

/** The label on the open section's source chip */
function chipLabel() {
    return document.querySelector('.toolasha-enh-source-chip')?.textContent?.trim() ?? null;
}

beforeEach(() => {
    settings.store = {};
    document.body.innerHTML = '';
    installEnhancementSourceToggle();
});

afterEach(() => {
    uninstallEnhancementSourceToggle();
    document.body.innerHTML = '';
});

describe('the chip on the section header', () => {
    test('says the numbers are the player’s own by default', () => {
        openTooltip();

        expect(chipLabel()).toContain('Yours');
        expect(document.body.textContent).toContain('ENHANCEMENT PATH');
    });

    test('says Pro, and is highlighted, once pro rates are on', () => {
        settings.store[PRO_RATES_SETTING] = true;
        openTooltip();

        expect(chipLabel()).toContain('Pro');
        expect(document.querySelector('.toolasha-enh-source-chip').getAttribute('style')).toContain('#ffb020');
    });

    test('carries what a redraw needs, so the open section can be rebuilt in place', () => {
        openTooltip(4);
        const section = document.querySelector('[data-toolasha-enh-section]');

        expect(section.getAttribute('data-toolasha-enh-section')).toBe('path');
        expect(section.getAttribute('data-toolasha-enh-item')).toBe(ITEM);
        expect(section.getAttribute('data-toolasha-enh-level')).toBe('4');
    });
});

describe('clicking the chip', () => {
    test('switches the computation to the other kit, not just the label', () => {
        openTooltip();
        const before = quotedAttempts();
        expect(before).toBeTruthy();

        document.querySelector('.toolasha-enh-source-chip').click();

        expect(chipLabel()).toContain('Pro');
        expect(quotedAttempts()).toBeTruthy();
        // A pro's success rate is far higher, so the same +3 takes visibly fewer attempts
        expect(quotedAttempts()).not.toBe(before);
    });

    test('persists the choice, so the next tooltip opens on the same kit', () => {
        openTooltip();
        document.querySelector('.toolasha-enh-source-chip').click();

        expect(settings.store[PRO_RATES_SETTING]).toBe(true);

        openTooltip();
        expect(chipLabel()).toContain('Pro');
    });

    test('clicking again returns to the player’s own numbers', () => {
        openTooltip();
        const yours = quotedAttempts();

        document.querySelector('.toolasha-enh-source-chip').click();
        document.querySelector('.toolasha-enh-source-chip').click();

        expect(chipLabel()).toContain('Yours');
        expect(quotedAttempts()).toBe(yours);
    });
});

describe('the P key', () => {
    const pressP = (target = document.body) =>
        target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'p', bubbles: true }));

    test('flips the source while a section is on screen', () => {
        // The one interaction a hover tooltip allows: it vanishes if the pointer leaves the item
        openTooltip();
        const before = quotedAttempts();

        pressP();

        expect(chipLabel()).toContain('Pro');
        expect(quotedAttempts()).not.toBe(before);
    });

    test('does nothing while typing into a field', () => {
        openTooltip();
        const input = document.createElement('input');
        document.body.appendChild(input);

        pressP(input);

        expect(chipLabel()).toContain('Yours');
        expect(settings.store[PRO_RATES_SETTING]).toBeFalsy();
    });

    test('does nothing when no prediction is open to re-source', () => {
        pressP();

        expect(settings.store[PRO_RATES_SETTING]).toBeFalsy();
    });

    test('is ignored when it is part of a browser shortcut', () => {
        openTooltip();
        document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));

        expect(chipLabel()).toContain('Yours');
    });
});

describe('redrawing open sections', () => {
    test('leaves nothing labelled with a source that did not produce it', () => {
        openTooltip();
        settings.store[PRO_RATES_SETTING] = true;

        rerenderOpenEnhancementSections();

        expect(chipLabel()).toContain('Pro');
        expect(document.querySelectorAll('[data-toolasha-enh-section]').length).toBe(1);
    });

    test('after the listeners are removed the chip is inert', () => {
        openTooltip();
        uninstallEnhancementSourceToggle();

        document.querySelector('.toolasha-enh-source-chip').click();

        expect(chipLabel()).toContain('Yours');
        expect(settings.store[PRO_RATES_SETTING]).toBeFalsy();
    });
});
