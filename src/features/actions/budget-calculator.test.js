/** @vitest-environment happy-dom */
/**
 * Regression coverage for the budget calculator's panel-position observer.
 *
 * `_attachToPanel` starts a MutationObserver per panel to keep the widget
 * pinned after the missing-mats button (which other features can recreate).
 * The observer used to be stashed in a WeakMap keyed by panel, on the theory
 * that GC would take care of tearing it down — but a live MutationObserver is
 * a strong reference the *other* direction (the panel keeps the observer
 * alive, not the reverse), so nothing was ever collected while the panel
 * stayed open, and disable() never actually disconnected anything. What this
 * pins: after disable(), a later mutation on a still-open panel must not
 * bring the widget back.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const world = vi.hoisted(() => ({
    settings: { actions_budgetCalculator: true },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => world.settings[key] ?? false,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => null },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { getPrice: () => null },
}));
vi.mock('../../utils/material-calculator.js', () => ({
    calculateMaterialRequirements: () => [],
}));
vi.mock('../../utils/react-input.js', () => ({
    setReactInputValue: () => {},
}));

const dispatcher = vi.hoisted(() => ({ callback: null }));
vi.mock('../../utils/action-panel-helper.js', () => ({
    onDetailPanel: (cb) => {
        dispatcher.callback = cb;
        return () => {
            dispatcher.callback = null;
        };
    },
    resolveDetailPanel: (panel) => ({
        panel,
        actionHrid: panel.dataset.actionHrid || null,
        actionDetails: panel.dataset.actionHrid
            ? { type: '/action_types/cooking', inputItems: [{ itemHrid: '/items/egg', count: 1 }] }
            : null,
    }),
}));

const { default: budgetCalculator } = await import('./budget-calculator.js');
const { resolveDetailPanel } = await import('../../utils/action-panel-helper.js');

/** A mounted production action panel with a missing-mats-button anchor. */
function mountPanel() {
    const panel = document.createElement('div');
    panel.dataset.actionHrid = '/actions/cooking/omelette';
    const anchor = document.createElement('div');
    anchor.id = 'mwi-missing-mats-button';
    panel.appendChild(anchor);
    document.body.appendChild(panel);
    return panel;
}

beforeEach(() => {
    document.body.innerHTML = '';
    dispatcher.callback = null;
});

afterEach(() => {
    budgetCalculator.disable();
    vi.restoreAllMocks();
});

describe('budget calculator panel observer teardown', () => {
    test('disable() disconnects the panel observer so it never reinserts the widget again', async () => {
        const disconnectSpy = vi.spyOn(MutationObserver.prototype, 'disconnect');

        budgetCalculator.initialize();
        const panel = mountPanel();
        dispatcher.callback(resolveDetailPanel(panel));

        expect(panel.querySelector('#mwi-budget-calculator')).not.toBeNull();

        budgetCalculator.disable();
        expect(disconnectSpy).toHaveBeenCalled();

        // The widget is gone immediately after disable()
        expect(panel.querySelector('#mwi-budget-calculator')).toBeNull();

        // A later mutation on the still-open panel (another feature recreating
        // the missing-mats button) must not resurrect the disabled widget —
        // that would mean the observer kept running past disable().
        panel.querySelector('#mwi-missing-mats-button')?.remove();
        const newAnchor = document.createElement('div');
        newAnchor.id = 'mwi-missing-mats-button';
        panel.appendChild(newAnchor);

        // MutationObserver callbacks flush as a microtask
        await Promise.resolve();
        await Promise.resolve();

        expect(panel.querySelector('#mwi-budget-calculator')).toBeNull();
    });
});
