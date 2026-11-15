/**
 * @vitest-environment happy-dom
 *
 * The profile score panels resize by a corner grip. The real floating-panel helpers run here; only
 * the stored geometry is replaced by an in-memory record.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const geo = vi.hoisted(() => ({ record: {} }));

const stub = vi.hoisted(() => ({ currentCharacterId: 7 }));

vi.mock('../../core/config.js', () => ({
    default: {
        onSettingChange: () => {},
        getSetting: () => false,
        COLOR_TEXT_SECONDARY: '#999',
        COLOR_TEXT_PRIMARY: '#fff',
        COLOR_ACCENT: '#5b8def',
        Z_FLOATING_PANEL: 1100,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => stub.currentCharacterId, on: () => {}, off: () => {} },
}));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: async () => null, setJSON: async () => {} } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('./score-calculator.js', () => ({ calculateCombatScore: () => ({}) }));
vi.mock('../combat/combat-sim-export.js', () => ({ constructExportObject: () => ({}) }));
vi.mock('../combat/milkonomy-export.js', () => ({ constructMilkonomyExport: () => ({}) }));
vi.mock('./character-card-button.js', () => ({
    handleViewCardClick: () => {},
    handleViewCardFromSnapshot: () => {},
}));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({
        registerTimeout: () => {},
        scheduleTimeout: (fn, ms) => setTimeout(fn, ms),
        cancelTimeout: (id) => clearTimeout(id),
        clearAll: () => {},
    }),
}));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: { getAllSnapshots: () => [] } }));
vi.mock('../combat-sim/combat-sim-ui.js', () => ({ default: {} }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    seedSimPriceCache: (cache) => cache,
    buildPlayerDTOFromProfile: () => ({}),
}));
vi.mock('../../utils/enhancement-worker-manager.js', () => ({ terminateWorkerPool: () => {} }));

vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    clampGeometry: () => null,
    clampPanelToViewport: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
    allGeometry: async () => geo.record,
    clearSize: vi.fn(async (key) => {
        if (geo.record[key]) {
            delete geo.record[key].width;
            delete geo.record[key].height;
        }
    }),
    saveGeometry: vi.fn(async (key, value) => {
        geo.record[key] = { ...geo.record[key], ...value };
    }),
    restoreGeometry: vi.fn(async (panel, key) => {
        const saved = geo.record[key];
        if (saved?.width) panel.style.width = `${saved.width}px`;
        if (saved?.height) panel.style.height = `${saved.height}px`;
    }),
    markPanelInteracted: () => {},
}));

vi.mock('./build-score-row.js', () => ({ readOwnScore: () => null }));

const combatScore = (await import('./combat-score.js')).default;
const { saveGeometry, clearSize } = await import('../../utils/panel-geometry.js');

const scoreData = {
    total: 300,
    house: 50,
    ability: 100,
    equipment: 150,
    skillerTotal: 90,
    skillerEquipment: 90,
    equipmentHidden: false,
    hasEquipmentData: true,
    breakdown: { houses: [], abilities: [], equipment: [] },
    skillerBreakdown: { equipment: [] },
};
const profileData = { profile: { sharableCharacter: { id: 7, name: 'Someone' } } };

const scorePanel = () => document.querySelector('#mwi-combat-score-panel');
const abilitiesPanel = () => document.querySelector('#mwi-abilities-triggers-panel');
const gripsIn = (el) => el?.querySelectorAll('.toolasha-resize-grip') ?? [];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function openBoth() {
    const modal = document.createElement('div');
    combatScore.showScorePanel(profileData, scoreData, modal);
    combatScore.buildAbilitiesTriggersHTML = () => '<div>ability rows</div>';
    combatScore.showAbilitiesTriggersPanel(profileData, modal);
}

function dragGrip(panel, dx, dy) {
    panel.getBoundingClientRect = () => ({
        width: parseFloat(panel.style.width) || 250,
        height: parseFloat(panel.style.height) || 150,
        left: 0,
        top: 0,
    });
    gripsIn(panel)[0].dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    );
    document.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: dx, clientY: dy }));
    document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: dx, clientY: dy }));
}

beforeEach(() => {
    document.body.innerHTML = '';
    geo.record = {};
    combatScore.currentPanel = null;
    combatScore.currentAbilitiesPanel = null;
    vi.mocked(saveGeometry).mockClear();
    vi.mocked(clearSize).mockClear();
});

describe('score panel resize', () => {
    test('has one grip on the outer panel, outside the scrolling content', () => {
        openBoth();
        expect(gripsIn(scorePanel())).toHaveLength(1);
        expect(gripsIn(scorePanel())[0].parentElement).toBe(scorePanel());
        expect(scorePanel().querySelector('#mwi-score-scroll')).not.toBeNull();
        expect(gripsIn(abilitiesPanel())).toHaveLength(1);
    });

    test('the drag header stays outside the scroller', () => {
        openBoth();
        const header = scorePanel().querySelector('#mwi-score-header');
        expect(header.parentElement).toBe(scorePanel());
        expect(scorePanel().querySelector('#mwi-score-scroll').contains(header)).toBe(false);
    });

    test('the first drag lifts the width cap as it starts, and a tap saves nothing', () => {
        openBoth();
        gripsIn(scorePanel())[0].dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 0, clientY: 0 })
        );
        expect(scorePanel().style.maxWidth).toBe('none');
        document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 0, clientY: 0 }));
        expect(saveGeometry).not.toHaveBeenCalled();
    });

    test('a drag saves the size, lifts the width cap and makes the content scroll', () => {
        openBoth();
        expect(scorePanel().style.maxWidth).toBe('280px');
        dragGrip(scorePanel(), 150, 300);
        expect(saveGeometry).toHaveBeenCalledWith('profileCombatScore', { width: 400, height: 450 });
        expect(scorePanel().style.maxWidth).toBe('none');
        expect(scorePanel().querySelector('#mwi-score-scroll').style.overflowY).toBe('auto');
    });

    test('a saved size is applied and lifts the caps', async () => {
        geo.record.profileCombatScore = { width: 400, height: 450 };
        openBoth();
        await settle();
        expect(scorePanel().style.width).toBe('400px');
        expect(scorePanel().style.maxWidth).toBe('none');
    });

    test('double-clicking the grip resets the size and keeps the position', async () => {
        geo.record.profileCombatScore = { left: '10px', top: '20px', width: 400, height: 450 };
        openBoth();
        await settle();
        gripsIn(scorePanel())[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await settle();
        expect(scorePanel().style.width).toBe('');
        expect(scorePanel().style.maxWidth).toBe('280px');
        expect(geo.record.profileCombatScore).toEqual({ left: '10px', top: '20px' });
    });

    test('closing removes the grip and reopening does not stack another', () => {
        openBoth();
        const old = scorePanel();
        scorePanel().querySelector('#mwi-score-close-btn').click();
        expect(gripsIn(old)).toHaveLength(0);
        openBoth();
        expect(document.querySelectorAll('#mwi-combat-score-panel')).toHaveLength(1);
        expect(gripsIn(scorePanel())).toHaveLength(1);
    });
});

describe('abilities panel resize', () => {
    test('the 200px height is an opening size: a drag lifts it and saves', () => {
        openBoth();
        expect(abilitiesPanel().style.maxHeight).toBe('200px');
        dragGrip(abilitiesPanel(), 20, 400);
        expect(saveGeometry).toHaveBeenCalledWith('profileAbilities', { width: 300, height: 550 });
        expect(abilitiesPanel().style.maxHeight).toBe('none');
    });

    test('the expand button hands a dragged height back to the content', async () => {
        geo.record.profileAbilities = { width: 320, height: 500 };
        openBoth();
        await settle();
        expect(abilitiesPanel().style.height).toBe('500px');
        abilitiesPanel().querySelector('#mwi-abilities-expand-btn').click();
        expect(abilitiesPanel().style.height).toBe('');
        expect(abilitiesPanel().style.maxHeight).toBe('none');
        // Only this session's inline height is lifted: the saved size stays
        expect(geo.record.profileAbilities).toEqual({ width: 320, height: 500 });
        expect(clearSize).not.toHaveBeenCalled();
    });

    test('the first drag lifts the opening caps as it starts', () => {
        openBoth();
        gripsIn(abilitiesPanel())[0].dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 0, clientY: 0 })
        );
        expect(abilitiesPanel().style.maxHeight).toBe('none');
        expect(abilitiesPanel().style.maxWidth).toBe('none');
        document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 0, clientY: 0 }));
        expect(saveGeometry).not.toHaveBeenCalled();
    });

    test('double-click resets to the 200px cap', async () => {
        geo.record.profileAbilities = { width: 320, height: 500 };
        openBoth();
        await settle();
        gripsIn(abilitiesPanel())[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await settle();
        expect(abilitiesPanel().style.maxHeight).toBe('200px');
        expect(abilitiesPanel().style.height).toBe('');
        expect(geo.record.profileAbilities).toEqual({});
    });

    test('closing removes the grip', () => {
        openBoth();
        const old = abilitiesPanel();
        old.querySelector('#mwi-abilities-close-btn').click();
        expect(gripsIn(old)).toHaveLength(0);
    });
});
