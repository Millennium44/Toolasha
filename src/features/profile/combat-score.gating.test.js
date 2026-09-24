/**
 * @vitest-environment happy-dom
 *
 * Regression coverage for the combatScore / abilitiesTriggers decoupling.
 *
 * Commit 11dbeea79 made `combatScore` ("Profile panel: Show gear score") hide
 * only the score display while the module kept running for
 * `abilitiesTriggers` ("Profile panel: Show abilities & triggers"). Since
 * 3.54.0 the registry gates the whole module on the `combatScore` setting
 * (see src/entrypoint.js), so with gear score off the abilities panel never
 * initialized at all. This file proves the module still runs — and the
 * abilities panel still renders — with combatScore off and abilitiesTriggers
 * on, and that the registry's customCheck matches that behavior.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const settings = vi.hoisted(() => ({ combatScore: true, abilitiesTriggers: true, characterCard: false }));

vi.mock('../../core/config.js', () => ({
    default: {
        onSettingChange: () => {},
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
    default: { set: async () => {}, getJSON: async () => null, setJSON: async () => {} },
}));

const wsHandlers = vi.hoisted(() => new Map());
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => wsHandlers.set(event, handler),
        off: (event) => wsHandlers.delete(event),
    },
}));
vi.mock('./score-calculator.js', () => ({
    calculateCombatScore: async () => ({
        total: 0,
        house: 0,
        ability: 0,
        equipment: 0,
        skillerTotal: 0,
        skillerEquipment: 0,
        breakdown: { houses: [], abilities: [], equipment: [] },
        skillerBreakdown: { equipment: [] },
    }),
}));
vi.mock('../combat/combat-sim-export-metz.js', () => ({
    constructMetzCharacterExport: () => ({}),
    applyLoadoutOverrideToMetzCharacter: () => ({}),
}));
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
    createTimerRegistry: () => ({ registerTimeout: () => {}, clearAll: () => {} }),
}));
vi.mock('../../utils/floating-panel.js', () => ({ makeDraggable: () => {} }));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveGeometry: () => {},
    restoreGeometry: async () => {},
}));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: { getAllSnapshots: () => [] } }));
vi.mock('../combat-sim/combat-sim-ui.js', () => ({ default: {} }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({ buildPlayerDTOFromProfile: () => ({}) }));
vi.mock('../../utils/enhancement-worker-manager.js', () => ({ terminateWorkerPool: () => {} }));

let combatScore;

beforeEach(async () => {
    vi.resetModules();
    wsHandlers.clear();
    settings.combatScore = true;
    settings.abilitiesTriggers = true;
    settings.characterCard = false;
    document.body.innerHTML = '';
    ({ default: combatScore } = await import('./combat-score.js'));
});

/**
 * Build a minimal profile_shared payload with one consumable trigger, which
 * is enough for `buildAbilitiesTriggersHTML` to produce non-empty output.
 * @returns {Object} profile_shared message data
 */
function profileSharedData() {
    return {
        profile: {
            sharableCharacter: { id: 42, name: 'Tester' },
            equippedAbilities: [],
            abilityCombatTriggersMap: {},
            consumableCombatTriggersMap: {
                '/items/coffee': [],
            },
        },
    };
}

/**
 * Insert the profile overview panel plus an items sprite `<use>` so
 * `getItemsSpriteUrl` resolves and `waitForProfilePanel` finds it immediately.
 * @returns {Element} the modal container the panel resolves to
 */
function mountProfilePanel() {
    const modal = document.createElement('div');
    const panel = document.createElement('div');
    panel.setAttribute('class', 'SharableProfile_overviewTab_x');
    modal.appendChild(panel);
    document.body.appendChild(modal);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '/sprites/items_sprite.svg#coffee');
    svg.appendChild(use);
    document.body.appendChild(svg);

    return modal;
}

describe('entrypoint.js registry gate for combatScore', () => {
    // Registry gating happens in src/entrypoint.js via feature.customCheck(),
    // and that file is too heavy (boots the whole content script) to import
    // in a unit test. Pin the source of the 'combatScore' registry entry
    // instead, so a regression back to a bare config.isFeatureEnabled('combatScore')
    // check — which is what silently disabled abilitiesTriggers before this
    // fix — fails this test rather than shipping unnoticed.
    test("the 'combatScore' entry's customCheck ORs combatScore and abilitiesTriggers", () => {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const entrypointSrc = readFileSync(path.join(here, '..', '..', 'entrypoint.js'), 'utf8');

        const keyIndex = entrypointSrc.indexOf("key: 'combatScore',");
        expect(keyIndex).toBeGreaterThan(-1);

        // The entry runs from its key to the next entry's key (or closing brace)
        const entryText = entrypointSrc.slice(keyIndex, keyIndex + 600);
        const customCheckMatch = entryText.match(/customCheck:\s*\(\)\s*=>\s*([^\n]+)/);
        expect(customCheckMatch).not.toBeNull();
        expect(customCheckMatch[1]).toContain("config.getSetting('combatScore')");
        expect(customCheckMatch[1]).toContain("config.getSetting('abilitiesTriggers')");
        expect(customCheckMatch[1]).toContain('||');
    });
});

describe('combatScore / abilitiesTriggers decoupling', () => {
    test('gear score off, abilities on: a profile_shared message still renders the abilities panel', async () => {
        settings.combatScore = false;
        settings.abilitiesTriggers = true;

        combatScore.initialize();
        mountProfilePanel();

        const handler = wsHandlers.get('profile_shared');
        expect(handler).toBeTypeOf('function');

        await handler(profileSharedData());
        // Let handleProfileShared's internal awaits (waitForProfilePanel,
        // handleProfileOpen) settle.
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(document.getElementById('mwi-abilities-triggers-panel')).not.toBeNull();

        // The score panel still renders (so abilities can be positioned under
        // it), but the score section itself stays hidden.
        const toggle = document.getElementById('mwi-score-toggle');
        expect(toggle).not.toBeNull();
        expect(toggle.getAttribute('style')).toContain('display: none');
    });

    test('abilities off, gear score on: only the score panel renders', async () => {
        settings.combatScore = true;
        settings.abilitiesTriggers = false;

        combatScore.initialize();
        mountProfilePanel();

        const handler = wsHandlers.get('profile_shared');
        await handler(profileSharedData());
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(document.getElementById('mwi-combat-score-panel')).not.toBeNull();
        expect(document.getElementById('mwi-abilities-triggers-panel')).toBeNull();
    });
});
