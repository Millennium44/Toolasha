/** @vitest-environment happy-dom */

/**
 * The action bar's profit line gains a calibration badge from the stored
 * ledger. Everything the line does not need — the game, the calculators, the
 * observers — is mocked; what is asserted is that the forecast a player sees
 * carries the track record the ledger holds for it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    charId: 'char1',
    ledger: [],
    settings: { actionBar_showProfit: true },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = null) => (key in world.settings ? world.settings[key] : fallback),
        getSettingValue: (key, fallback) => fallback,
        SCRIPT_COLOR_MAIN: '#fff',
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => world.charId,
        getActionDetails: (hrid) =>
            hrid === '/actions/milking/cow'
                ? { hrid, type: '/action_types/milking', name: 'Milk Cows', outputItems: [] }
                : null,
        on: () => {},
        off: () => {},
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key) => (key === `calibration_${world.charId}` ? world.ledger : []),
        set: async () => true,
    },
}));

vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {}, register: () => () => {} } }));
vi.mock('../../core/tooltip-observer.js', () => ({ default: { register: () => () => {} } }));
vi.mock('../../api/marketplace.js', () => ({
    default: { getItemPrice: () => null, on: () => () => {}, off: () => {} },
}));

vi.mock('./gathering-profit.js', () => ({
    calculateGatheringProfit: async () => ({
        profitPerHour: 120_000,
        actionsPerHour: 100,
        efficiencyMultiplier: 1,
        pricingMode: 'hybrid',
    }),
}));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculateProfit: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: {} }));
vi.mock('../../utils/liquidity-cap.js', () => ({
    capProfitData: async (data) => data,
    liquidityMarkerHtml: () => '',
}));

const { default: actionTimeDisplay } = await import('./action-time-display.js');
const { loadCalibrationBadges, invalidateCalibrationBadges } = await import('../../utils/calibration-badge.js');

/**
 * Forty finished milking runs that each paid 88% of the forecast.
 * @returns {Array<Object>}
 */
function hotLedger() {
    return Array.from({ length: 40 }, (_, i) => ({
        id: `run${i}`,
        actionHrid: '/actions/milking/cow',
        actionType: 'milking',
        t: 1_700_000_000_000 + i * 3_600_000,
        predicted: 100_000,
        actual: 88_000,
    }));
}

beforeEach(() => {
    world.charId = 'char1';
    world.ledger = [];
    world.settings = { actionBar_showProfit: true };
    invalidateCalibrationBadges();
    actionTimeDisplay.profitElement = document.createElement('div');
    document.body.appendChild(actionTimeDisplay.profitElement);
});

afterEach(() => {
    actionTimeDisplay.profitElement = null;
    document.body.innerHTML = '';
});

describe('action bar profit line', () => {
    it('gains the forecast’s track record once the ledger is read', async () => {
        world.ledger = hotLedger();
        await loadCalibrationBadges();

        await actionTimeDisplay.updateActionBarProfit({ actionHrid: '/actions/milking/cow' }, 0);

        const line = actionTimeDisplay.profitElement;
        expect(line.textContent).toContain('+120.0K/hr');
        const badge = line.querySelector('.mwi-calibration-badge');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('−12% over 40 runs');
        expect(badge.dataset.tone).toBe('amber');
        expect(badge.title).toContain('run hot');
    });

    it('shows the bare forecast when nothing is measured, or the badges are off', async () => {
        await loadCalibrationBadges();
        await actionTimeDisplay.updateActionBarProfit({ actionHrid: '/actions/milking/cow' }, 0);
        expect(actionTimeDisplay.profitElement.textContent).toContain('+120.0K/hr');
        expect(actionTimeDisplay.profitElement.querySelector('.mwi-calibration-badge')).toBeNull();

        world.ledger = hotLedger();
        invalidateCalibrationBadges();
        await loadCalibrationBadges();
        world.settings.insights_calibrationBadges = false;
        await actionTimeDisplay.updateActionBarProfit({ actionHrid: '/actions/milking/cow' }, 0);
        expect(actionTimeDisplay.profitElement.querySelector('.mwi-calibration-badge')).toBeNull();
    });
});
