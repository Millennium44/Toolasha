/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ registrations: [], mutationWatchers: [] }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: vi.fn(),
        off: vi.fn(),
        getInitClientData: vi.fn(() => ({
            itemDetailMap: { '/items/gator_vest': { itemLevel: 1 } },
        })),
    },
}));

const settings = vi.hoisted(() => ({ autoProtect: false }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: vi.fn((key) => key === 'enhanceSim_autoProtectFrom' && settings.autoProtect),
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
vi.mock('../../utils/dom-observer-helpers.js', () => ({
    createMutationWatcher: vi.fn((target, callback) => {
        const watcher = { target, callback, unwatch: vi.fn() };
        state.mutationWatchers.push(watcher);
        return watcher.unwatch;
    }),
}));
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
const { getProtectionItemFromUI } = await import('./enhancement-display.js');
const { getEnhancingParams } = await import('../../utils/enhancement-config.js');
const { calculateEnhancementPath } = await import('../enhancement/tooltip-enhancement.js');
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
        state.mutationWatchers = [];
        settings.autoProtect = false;
        vi.clearAllMocks();
        initActionPanelObserver();
    });

    afterEach(() => {
        vi.useRealTimers();
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

    test('the panel watcher notices the protection slot when it alone renders late', async () => {
        const panel = buildEnhancingPanel();
        await enhancingCallback()(panel);
        const panelWatcher = state.mutationWatchers.find(({ target }) => target === panel);

        const protectionContainer = document.createElement('div');
        protectionContainer.className = 'SkillActionDetail_protectionItemInputContainer__abc123';
        panel.appendChild(protectionContainer);
        panelWatcher.callback([{ type: 'childList', addedNodes: [protectionContainer] }]);

        expect(createMutationWatcher.mock.calls.filter(([target]) => target === protectionContainer)).toHaveLength(1);
    });

    test('re-enabling on a reused panel reattaches the panel and protection watchers', async () => {
        const panel = buildEnhancingPanel();
        const protectionContainer = document.createElement('div');
        protectionContainer.className = 'SkillActionDetail_protectionItemInputContainer__abc123';
        panel.appendChild(protectionContainer);

        await enhancingCallback()(panel);
        disablePanelObserver();
        state.registrations = [];
        initActionPanelObserver();
        await enhancingCallback()(panel);

        expect(createMutationWatcher.mock.calls.filter(([target]) => target === panel)).toHaveLength(2);
        expect(createMutationWatcher.mock.calls.filter(([target]) => target === protectionContainer)).toHaveLength(2);
    });

    test('moves the protection watcher when React replaces the slot in a reused panel', async () => {
        const panel = buildEnhancingPanel();
        const firstContainer = document.createElement('div');
        firstContainer.className = 'SkillActionDetail_protectionItemInputContainer__first';
        panel.appendChild(firstContainer);
        const callback = enhancingCallback();
        await callback(panel);
        const firstWatcher = state.mutationWatchers.find(({ target }) => target === firstContainer);

        const replacement = document.createElement('div');
        replacement.className = 'SkillActionDetail_protectionItemInputContainer__replacement';
        firstContainer.replaceWith(replacement);
        await callback(panel);

        expect(firstWatcher.unwatch).toHaveBeenCalledTimes(1);
        expect(createMutationWatcher.mock.calls.filter(([target]) => target === replacement)).toHaveLength(1);
    });

    test('a protection-slot change uses the item currently selected in a reused panel', async () => {
        vi.useFakeTimers();
        settings.autoProtect = true;
        getProtectionItemFromUI.mockReturnValue('/items/mirror_of_protection');
        getEnhancingParams.mockReturnValue({});
        calculateEnhancementPath.mockReturnValue({ optimalStrategy: { protectFrom: 5 } });
        const panel = buildEnhancingPanel();
        const protectionContainer = document.createElement('div');
        protectionContainer.className = 'SkillActionDetail_protectionItemInputContainer__abc123';
        panel.appendChild(protectionContainer);
        const targetLabel = document.createElement('label');
        targetLabel.textContent = 'Target Level';
        const targetWrapper = document.createElement('div');
        const targetInput = document.createElement('input');
        targetInput.type = 'number';
        targetInput.value = '10';
        targetWrapper.append(targetLabel, targetInput);
        const protectLabel = document.createElement('label');
        protectLabel.textContent = 'Protect From Level';
        const protectWrapper = document.createElement('div');
        const protectInput = document.createElement('input');
        protectInput.type = 'number';
        protectWrapper.append(protectLabel, protectInput);
        panel.append(targetWrapper, protectWrapper);

        await enhancingCallback()(panel);
        panel.dataset.mwiItemHrid = '/items/griffin_tunic';
        const slotWatcher = state.mutationWatchers.find(({ target }) => target === protectionContainer);
        slotWatcher.callback([]);
        await vi.advanceTimersByTimeAsync(300);

        expect(calculateEnhancementPath).toHaveBeenLastCalledWith('/items/griffin_tunic', 10, {});
        vi.useRealTimers();
    });

    test('disable cancels a pending protection-slot retry', async () => {
        vi.useFakeTimers();
        settings.autoProtect = true;
        const panel = buildEnhancingPanel();
        const protectionContainer = document.createElement('div');
        protectionContainer.className = 'SkillActionDetail_protectionItemInputContainer__abc123';
        panel.appendChild(protectionContainer);

        await enhancingCallback()(panel);
        getProtectionItemFromUI.mockClear();
        state.mutationWatchers.find(({ target }) => target === protectionContainer).callback([]);
        disablePanelObserver();
        await vi.advanceTimersByTimeAsync(300);

        expect(getProtectionItemFromUI).not.toHaveBeenCalled();
        vi.useRealTimers();
    });
});
