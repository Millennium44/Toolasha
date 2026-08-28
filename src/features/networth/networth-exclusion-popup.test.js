/**
 * @vitest-environment happy-dom
 *
 * The popup lets a player build up an exclusion list one chip at a time, but
 * until now it never said what all of them added up to — the only place that
 * total showed was the collapsed "Excluded" row back on the main panel, which
 * this popup sits on top of and hides. This tests that the total currently
 * being omitted from net worth is visible while configuring, and stays silent
 * when there is nothing to add up.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { COLOR_ACCENT: '#22c55e', Z_FLOATING_PANEL: 1100 },
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getInitClientData: () => null } }));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => null } }));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: vi.fn(),
    unregisterFloatingPanel: vi.fn(),
    bringPanelToFront: vi.fn(),
}));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: { getAllSnapshots: () => [] } }));
vi.mock('../../utils/bundle-bridge.js', () => ({ loadoutSnapshot: () => null }));

const state = vi.hoisted(() => ({ exclusions: [{ type: 'item', value: '/items/coin' }] }));
vi.mock('./networth-exclusions.js', () => ({
    getExclusions: () => state.exclusions,
    isExcluded: (type, value) => state.exclusions.some((e) => e.type === type && e.value === value),
    addExclusion: vi.fn(async () => {}),
    removeExclusion: vi.fn(async () => {}),
    clearExclusions: vi.fn(async () => {}),
}));

const { default: networthExclusionPopup } = await import('./networth-exclusion-popup.js');

/** A networthData shaped enough for the popup to render without throwing. */
function networthData(excludedTotal) {
    return {
        currentAssets: {
            equipped: { value: 0, breakdown: [] },
            inventory: { value: 0, breakdown: [], byCategory: {} },
            listings: { value: 0, breakdown: [] },
        },
        fixedAssets: {
            houses: { totalCost: 0, breakdown: [] },
            abilities: { totalCost: 0, breakdown: [] },
            abilityBooks: { totalCost: 0, breakdown: [] },
            guildShrines: { totalCost: 0, breakdown: [] },
        },
        excluded: { total: excludedTotal, items: [] },
    };
}

beforeEach(() => {
    document.body.innerHTML = '';
    networthExclusionPopup.close();
    state.exclusions = [{ type: 'item', value: '/items/coin' }];
});

describe('exclusion total readout', () => {
    test('shows what the current exclusions add up to omitting', () => {
        networthExclusionPopup.open(networthData(1_250_000), () => {});

        const totalLine = document.getElementById('mwi-nex-total');
        expect(totalLine).toBeTruthy();
        expect(totalLine.textContent).toContain('1.25M');
        expect(totalLine.textContent).toContain('Currently omitting');
    });

    test('says nothing when there are no exclusions configured', () => {
        state.exclusions = [];
        networthExclusionPopup.open(networthData(0), () => {});

        expect(document.getElementById('mwi-nex-total')).toBeNull();
    });

    test('refreshing after an exclusion is cleared drops the total line too', () => {
        networthExclusionPopup.open(networthData(1_250_000), () => {});
        expect(document.getElementById('mwi-nex-total')).toBeTruthy();

        state.exclusions = [];
        networthExclusionPopup.refresh(networthData(0));

        expect(document.getElementById('mwi-nex-total')).toBeNull();
    });
});
