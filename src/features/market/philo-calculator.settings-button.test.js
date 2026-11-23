/** @vitest-environment happy-dom
 *
 * The "Philo Gamba" button the calculator puts on the game's Settings panel must go when the
 * feature is switched off, and must not come back when the panel is opened afterward.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const hooks = vi.hoisted(() => ({ panelCallbacks: [] }));

vi.mock('../../api/marketplace.js', () => ({
    default: { getPrice: () => null, fetch: vi.fn(), on: () => () => {}, off: () => {}, getDataAge: () => 0 },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
        getInitClientData: () => ({ itemDetailMap: {}, actionDetailMap: {} }),
        getItemDetails: () => null,
        getSkills: () => [],
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
        getInventory: () => [],
    },
}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        isFeatureEnabled: () => false,
        getSettingValue: (key, fallback) => fallback,
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
        COLOR_WARNING: '#fa0',
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: { get: vi.fn(async (key, store, fallback) => fallback), set: vi.fn(async () => {}) },
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    settingsUI: () => ({ onSettingsPanelAppear: (callback) => hooks.panelCallbacks.push(callback) }),
    guildMemberSkills: () => null,
    marketUndercutAlerts: () => null,
}));

const { default: philoCalculator } = await import('./philo-calculator.js');

const BUTTON = '.mwi-philo-calc-button';

describe('Philo Gamba settings-panel button', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div class="SettingsPanel_root"></div>';
    });

    afterEach(() => {
        philoCalculator.disable();
        document.body.innerHTML = '';
    });

    test('is drawn on initialize() and removed by disable()', () => {
        philoCalculator.initialize();
        expect(document.querySelectorAll(BUTTON)).toHaveLength(1);

        philoCalculator.disable();
        expect(document.querySelector(BUTTON)).toBeNull();
    });

    test('a settings panel opened after disable() does not get it back', () => {
        philoCalculator.initialize();
        philoCalculator.disable();

        document.body.innerHTML = '<div class="SettingsPanel_root"></div>';
        hooks.panelCallbacks.forEach((callback) => callback());

        expect(document.querySelector(BUTTON)).toBeNull();
    });

    test('initialize() again draws it once, however many times the feature went off and on', () => {
        philoCalculator.initialize();
        philoCalculator.disable();
        philoCalculator.initialize();

        hooks.panelCallbacks.forEach((callback) => callback());
        expect(document.querySelectorAll(BUTTON)).toHaveLength(1);
        // The panel's callback list cannot drop an entry, so the hook is added once
        expect(hooks.panelCallbacks).toHaveLength(1);
    });
});
