/** @vitest-environment happy-dom */
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
const harness = vi.hoisted(() => ({
    enabled: true,
    char: '1',
    listeners: {},
    ws: {},
    entries: [],
    loadoutBuilder: vi.fn(),
    worker: vi.fn(),
    initializedPanel: null,
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => harness.enabled } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        characterData: { character: { name: 'Current' } },
        guildBuildingLevelMap: {},
        getCurrentCharacterId: () => harness.char,
        getInitClientData: () => ({ guildTrialDetailMap: {} }),
        on: (key, cb) => {
            harness.listeners[key] = cb;
        },
        off: (key) => {
            delete harness.listeners[key];
        },
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
        onReady: (_key, cb) => {
            cb();
            return () => {};
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (key, cb) => {
            harness.ws[key] = cb;
        },
        off: (key) => {
            delete harness.ws[key];
        },
    },
}));
vi.mock('../../utils/command-registry.js', () => ({ registerCommand: vi.fn(), unregisterCommand: vi.fn() }));
vi.mock('../../utils/view-loadout.js', () => ({
    getLoadouts: () => harness.entries,
    VIEW_LOADOUT_CONTEXT: { GuildTrial: 'guild_trial' },
}));
vi.mock('../../utils/simple-panel.js', () => ({
    createPanel: ({ draw }) => {
        const shell = document.createElement('section');
        shell.id = 'toolasha-guild-trial-sim';
        document.body.appendChild(shell);
        const panel = {
            render: () => {
                shell.replaceChildren();
                draw(shell);
            },
            toggle: () => panel.render(),
            destroy: () => shell.remove(),
        };
        harness.initializedPanel = panel;
        return panel;
    },
    panelCard: (parent, text) => {
        const el = document.createElement('div');
        el.textContent = text;
        parent.appendChild(el);
        return el;
    },
    panelNote: (text) => {
        const el = document.createElement('p');
        el.textContent = text;
        return el;
    },
    panelLine: (label, text) => {
        const el = document.createElement('div');
        el.textContent = `${label}: ${text}`;
        return el;
    },
}));
vi.mock('./combat-sim-adapter.js', () => ({
    buildPlayerDTO: () => build(),
    buildPlayerDTOFromLoadout: (...args) => harness.loadoutBuilder(...args),
    parseShykaiImport: () => null,
    getCommunityBuffs: () => ({}),
    buildGameDataPayload: () => ({ combatMonsterDetailMap: {} }),
}));
vi.mock('./combat-sim-runner.js', () => ({
    buildExtraBuffs: () => [],
    runWorkerChunk: (...args) => harness.worker(...args),
}));
import { GuildTrialSim } from './guild-trial-sim.js';
import { GUILD_SKILLING_TICKS } from '../guild/guild-trial-messages.fixture.js';

function build() {
    return {
        staminaLevel: 100,
        intelligenceLevel: 100,
        attackLevel: 100,
        defenseLevel: 100,
        meleeLevel: 100,
        rangedLevel: 100,
        magicLevel: 100,
        equipment: {},
        houseRooms: {},
        food: [],
        drinks: [],
        abilities: [],
    };
}
let feature;
beforeEach(() => {
    document.body.replaceChildren();
    harness.enabled = true;
    harness.char = '1';
    harness.entries = [];
    harness.listeners = {};
    harness.ws = {};
    harness.worker.mockReset();
    harness.loadoutBuilder.mockReset();
    feature = new GuildTrialSim();
    feature.initialize();
});
afterEach(() => {
    feature.disable();
    document.body.replaceChildren();
    vi.restoreAllMocks();
});
const text = () => document.body.textContent;
const press = (label) =>
    Array.from(document.querySelectorAll('button'))
        .find((b) => b.textContent === label)
        .click();

describe('trial simulator controls and ownership', () => {
    test('draws both modes and catches missing dependencies in the panel', () => {
        feature.panel.render();
        expect(text()).toContain('Combat roster');
        expect(text()).not.toContain('could not be drawn');
        feature.kind = 'skilling';
        feature.panel.render();
        press('Add member');
        expect(text()).toContain('Skilling roster');
        expect(text()).toContain('Work power');
        expect(text()).not.toContain('could not be drawn');
    });
    test('does not start when disabled', () => {
        feature.disable();
        harness.enabled = false;
        feature.initialize();
        expect(feature.initialized).toBe(false);
        expect(harness.ws).toEqual({});
    });
    test('deduplicates the current build without changing equipment', () => {
        feature.addCurrentBuild();
        feature.addCurrentBuild();
        expect(feature.combatMembers).toHaveLength(1);
        expect(feature.makeScenario().members[0].dto.equipment).toEqual({});
    });
    test('imports only trial-context combat builds with known profile levels', async () => {
        harness.entries = [
            { context: 'party', kind: 'combat', hasLoadout: true },
            { context: 'guild_trial', kind: 'combat', hasLoadout: true, characterId: '2', name: 'Known' },
            { context: 'guild_trial', kind: 'combat', hasLoadout: true, characterId: '3', name: 'Unknown' },
        ];
        harness.loadoutBuilder
            .mockResolvedValueOnce({ dto: build(), levelsFrom: 'profile' })
            .mockResolvedValueOnce({ dto: build(), levelsFrom: null });
        await feature.addCapturedBuilds();
        expect(feature.combatMembers.map((m) => m.name)).toEqual(['Known']);
        expect(feature.notice).toContain('1 skipped');
    });
    test('a late profile read cannot leak into another character', async () => {
        harness.entries = [
            { context: 'guild_trial', kind: 'combat', hasLoadout: true, characterId: '2', name: 'Other' },
        ];
        let finish;
        harness.loadoutBuilder.mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            })
        );
        const adding = feature.addCapturedBuilds();
        harness.listeners.character_switched();
        finish({ dto: build(), levelsFrom: 'profile' });
        await adding;
        expect(feature.combatMembers).toEqual([]);
        expect(feature.loading).toBe(false);
    });
    test('keeps the actual per-member reading precision and observed pool', () => {
        feature.kind = 'skilling';
        harness.ws.guild_skilling_updated(GUILD_SKILLING_TICKS[0]);
        feature.addReading();
        expect(feature.settings.startTier).toBe(10);
        expect(feature.settings.baseWork).toBeCloseTo(40000);
        expect(feature.skillingMembers[0].actionSeconds).toBe(4.464);
        expect(feature.notice).toContain('17 participants');
    });
    test('imports a setup atomically and preserves its captured buffs on round-trip', () => {
        feature.addCurrentBuild();
        const scenario = feature.makeScenario();
        scenario.buildingBuffs = [{ typeHrid: '/buff_types/damage', flatBoost: 0, ratioBoost: 0.2 }];
        feature.importSetup(JSON.stringify({ toolashaGuildTrialSimulation: 1, scenario }));
        expect(feature.makeScenario().buildingBuffs[0].ratioBoost).toBe(0.2);
        const before = structuredClone(feature.combatMembers);
        feature.importSetup('{bad');
        expect(feature.combatMembers).toEqual(before);
        expect(feature.error).toContain('Import failed');
    });
    test('aborts only its own request and ignores a late result after character switch', async () => {
        feature.addCurrentBuild();
        let finish;
        let signal;
        harness.worker.mockImplementation((_message, _progress, options) => {
            signal = options.signal;
            return new Promise((resolve) => {
                finish = resolve;
            });
        });
        const running = feature.run();
        expect(signal.aborted).toBe(false);
        feature.contextOverrides = { buildingBuffs: [{ typeHrid: '/buff_types/damage', ratioBoost: 0.2 }] };
        harness.listeners.character_switched();
        expect(signal.aborted).toBe(true);
        finish({ kind: 'combat' });
        await running;
        expect(feature.result).toBeNull();
        expect(feature.combatMembers).toEqual([]);
        expect(feature.contextOverrides).toBeNull();
    });
    test('removes old result claims immediately when an input changes', () => {
        feature.panel.render();
        const old = document.createElement('div');
        old.dataset.trialSimResults = 'true';
        document.getElementById('toolasha-guild-trial-sim').appendChild(old);
        feature.result = { kind: 'combat' };
        feature.changed();
        expect(old.isConnected).toBe(false);
        expect(feature.result).toBeNull();
    });
});
