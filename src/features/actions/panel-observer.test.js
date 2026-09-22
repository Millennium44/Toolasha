/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ registrations: [] }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: vi.fn(),
        off: vi.fn(),
        getInitClientData: vi.fn(() => ({
            itemDetailMap: { '/items/gator_vest': { itemLevel: 1 } },
        })),
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: vi.fn(() => false),
        getSettingValue: vi.fn((_key, fallback) => fallback),
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: vi.fn((_name, classNames, callback) => {
            state.registrations.push({ classNames, callback });
            return vi.fn();
        }),
        onReady: vi.fn(() => vi.fn()),
    },
}));

vi.mock('./enhancement-display.js', () => ({
    displayEnhancementStats: vi.fn(),
    getProtectionItemFromUI: vi.fn(),
}));
vi.mock('./profit-display.js', () => ({
    displayGatheringProfit: vi.fn(),
    displayProductionProfit: vi.fn(),
}));
vi.mock('../../utils/dom.js', () => ({ getOriginalText: vi.fn() }));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: vi.fn(() => vi.fn()) }));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: vi.fn(() => ({ clearAll: vi.fn(), registerTimeout: vi.fn() })),
}));
vi.mock('./action-filter.js', () => ({ default: { initialize: vi.fn(), cleanup: vi.fn(), registerPanel: vi.fn() } }));
vi.mock('../../utils/game-lookups.js', () => ({
    getActionHridFromName: vi.fn(),
    getItemHridFromName: vi.fn(() => '/items/gator_vest'),
}));
vi.mock('../../utils/action-panel-helper.js', () => ({ onActionTile: vi.fn(() => vi.fn()) }));
vi.mock('../../utils/enhancement-config.js', () => ({ getEnhancingParams: vi.fn() }));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({ calculateEnhancementPath: vi.fn() }));

const { createMutationWatcher } = await import('../../utils/dom-observer-helpers.js');
const { initActionPanelObserver, disablePanelObserver } = await import('./panel-observer.js');

function buildEnhancingPanel() {
    const panel = document.createElement('div');
    panel.className = 'SkillActionDetail_enhancingComponent__17bOx';

    const output = document.createElement('div');
    output.className = 'SkillActionDetail_enhancingOutput__VPHbY';
    output.appendChild(document.createElement('img'));

    const name = document.createElement('div');
    name.className = 'Item_name__2C42x';
    name.textContent = 'Gator Vest';
    output.appendChild(name);
    panel.appendChild(output);
    return panel;
}

function enhancingCallback() {
    return state.registrations.find(({ classNames }) => classNames === 'SkillActionDetail_enhancingComponent__17bOx')
        .callback;
}

describe('late-rendered enhancement protection slot', () => {
    beforeEach(() => {
        state.registrations = [];
        vi.clearAllMocks();
        initActionPanelObserver();
    });

    afterEach(() => {
        disablePanelObserver();
        document.body.innerHTML = '';
    });

    test('does not mark observer setup complete before the protection slot exists', async () => {
        const panel = buildEnhancingPanel();

        await enhancingCallback()(panel);

        expect(panel.dataset.mwiProtectObserverAdded).toBeUndefined();
    });

    test('retries on a later panel pass and attaches once the real slot renders', async () => {
        const panel = buildEnhancingPanel();
        const callback = enhancingCallback();
        await callback(panel);

        const protectionContainer = document.createElement('div');
        protectionContainer.className = 'SkillActionDetail_protectionItemInputContainer__abc123';
        panel.appendChild(protectionContainer);
        await callback(panel);

        expect(panel.dataset.mwiProtectObserverAdded).toBe('true');
        expect(createMutationWatcher.mock.calls.filter(([target]) => target === protectionContainer)).toHaveLength(1);
    });
});
