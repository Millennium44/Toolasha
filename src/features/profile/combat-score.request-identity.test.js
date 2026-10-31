/**
 * @vitest-environment happy-dom
 *
 * A slower earlier profile score must not replace a newer profile's panel.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const settings = vi.hoisted(() => ({ combatScore: true, abilitiesTriggers: false, characterCard: false }));
const settingListeners = vi.hoisted(() => new Map());

vi.mock('../../core/config.js', () => ({
    default: {
        onSettingChange: (key, callback) => settingListeners.set(key, callback),
        getSetting: (key) => settings[key],
        COLOR_TEXT_SECONDARY: '#999',
        COLOR_TEXT_PRIMARY: '#fff',
        COLOR_ACCENT: '#5b8def',
        COLOR_PROFIT: '#4ade80',
        Z_FLOATING_PANEL: 9999,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 7 },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async () => null,
        set: async () => {},
        getJSON: async () => null,
        setJSON: async () => {},
    },
}));

const wsHandlers = vi.hoisted(() => new Map());
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => wsHandlers.set(event, handler),
        off: (event) => wsHandlers.delete(event),
    },
}));
const scoreGate = vi.hoisted(() => ({ pending: [] }));
vi.mock('./score-calculator.js', () => ({
    calculateCombatScore: async (profileData) => {
        await new Promise((resolve) => {
            scoreGate.pending.push({ name: profileData.profile.sharableCharacter.name, resolve });
        });
        return {
            total: 0,
            house: 0,
            ability: 0,
            equipment: 0,
            skillerTotal: 0,
            skillerEquipment: 0,
            breakdown: { houses: [], abilities: [], equipment: [] },
            skillerBreakdown: { equipment: [] },
        };
    },
}));
vi.mock('../combat/combat-sim-export-metz.js', () => ({
    constructMetzCharacterExport: () => ({}),
    applyLoadoutOverrideToMetzCharacter: () => ({}),
}));
vi.mock('../combat/combat-sim-export.js', () => ({ constructExportObject: () => ({}) }));
vi.mock('../combat/milkonomy-export.js', () => ({ constructMilkonomyExport: () => ({}) }));
vi.mock('./character-card-button.js', () => ({
    handleViewCardClick: () => {},
    handleViewCardFromSnapshot: () => {},
}));
vi.mock('./build-score-panel.js', () => ({
    buildScorePanel: { render: () => {} },
    setScoreSource: () => {},
}));
vi.mock('./build-score-row.js', () => ({ readOwnScore: () => null }));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({
        registerTimeout: () => {},
        scheduleTimeout: (fn, ms) => setTimeout(fn, ms),
        cancelTimeout: (id) => clearTimeout(id),
        clearAll: () => {},
    }),
}));
vi.mock('../../utils/floating-panel.js', () => ({ makeDraggable: () => {} }));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveGeometry: () => {},
    restoreGeometry: async () => {},
}));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: { getAllSnapshots: () => [] } }));
vi.mock('../combat-sim/combat-sim-ui.js', () => ({ default: {} }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    seedSimPriceCache: (cache) => cache,
    buildPlayerDTOFromProfile: () => ({}),
}));
vi.mock('../../utils/enhancement-worker-manager.js', () => ({ terminateWorkerPool: () => {} }));

let combatScore;

beforeEach(async () => {
    vi.resetModules();
    wsHandlers.clear();
    settings.combatScore = true;
    settings.abilitiesTriggers = false;
    document.body.innerHTML = '';
    ({ default: combatScore } = await import('./combat-score.js'));
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function mountProfilePanel() {
    const modal = document.createElement('div');
    const panel = document.createElement('div');
    panel.setAttribute('class', 'SharableProfile_overviewTab_x');
    modal.appendChild(panel);
    document.body.appendChild(modal);
    return modal;
}

function profileFor(name, id) {
    return { profile: { sharableCharacter: { id, name }, equippedAbilities: [] } };
}

describe('combat score request identity', () => {
    test('a slower earlier profile result does not replace the newer profile panel', async () => {
        scoreGate.pending.length = 0;
        combatScore.initialize();
        mountProfilePanel();
        const handler = wsHandlers.get('profile_shared');

        const alice = handler(profileFor('Alice', 1));
        await flush();
        await flush();
        const bob = handler(profileFor('Bob', 2));
        await flush();
        await flush();
        expect(scoreGate.pending.map((p) => p.name)).toEqual(['Alice', 'Bob']);

        scoreGate.pending[1].resolve();
        await bob;
        await flush();
        const bobPanel = document.getElementById('mwi-combat-score-panel');
        expect(bobPanel).not.toBeNull();
        expect(bobPanel.textContent).toContain('Bob');

        scoreGate.pending[0].resolve();
        await alice;
        await flush();
        expect(document.getElementById('mwi-combat-score-panel')).toBe(bobPanel);
        expect(bobPanel.textContent).toContain('Bob');
        expect(bobPanel.textContent).not.toContain('Alice');
    });

    test('ordered completion still draws the latest profile', async () => {
        scoreGate.pending.length = 0;
        combatScore.initialize();
        mountProfilePanel();
        const handler = wsHandlers.get('profile_shared');
        const first = handler(profileFor('Alice', 1));
        await flush();
        await flush();
        scoreGate.pending[0].resolve();
        await first;
        await flush();
        expect(document.getElementById('mwi-combat-score-panel').textContent).toContain('Alice');
    });
});
