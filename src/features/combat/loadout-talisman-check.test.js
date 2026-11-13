/**
 * @vitest-environment happy-dom
 *
 * The Loadouts panel marker: drawn for the selected loadout, cleared when the cause goes away.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { BELT_ITEMS } from '../../__fixtures__/talisman-bonuses.js';

const game = vi.hoisted(() => ({
    server: true,
    setting: true,
    loaded: true,
    owned: [],
    loadouts: {},
    handlers: {},
    ws: {},
}));

vi.mock('../../utils/game-server.js', () => ({ isTestServer: () => game.server }));
vi.mock('../../utils/bundle-bridge.js', () => ({
    webSocketHook: () => null,
    marketUndercutAlerts: () => null,
    guildMemberSkills: () => null,
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (e, h) => (game.ws[e] ||= []).push(h),
        off: (e, h) => (game.ws[e] = (game.ws[e] || []).filter((x) => x !== h)),
    },
}));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => game.setting, onSettingChange: () => () => {} },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {}, onReady: () => () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return { characterLoadoutMap: game.loadouts };
        },
        getInitClientData: () => ({ itemDetailMap: BELT_ITEMS }),
        hasTalismansLoaded: () => game.loaded,
        getCharacterTalismans: () => game.owned,
        on: (e, h) => (game.handlers[e] ||= []).push(h),
        off: (e, h) => (game.handlers[e] = (game.handlers[e] || []).filter((x) => x !== h)),
    },
}));

const mod = await import('./loadout-talisman-check.js');
const { annotate, MARKER_CLASS } = mod;

const BELT_LOC = '/item_locations/belt';
const comb = { id: 11, talismanTypeHrid: '/talisman_types/combat', slotIndex: 1, modifiers: [] };
const skill = { id: 21, talismanTypeHrid: '/talisman_types/skilling', slotIndex: 0, modifiers: [] };

function panel(name) {
    document.body.innerHTML = `<div class="LoadoutsPanel_selectedLoadout__x"><div class="LoadoutsPanel_metadata__y">Name<svg></svg>${name}<button>Edit</button></div></div>`;
}
const marker = () => document.querySelector(`.${MARKER_CLASS}`);
const make = (over) => ({
    name: 'Boss',
    actionTypeHrid: '/action_types/combat',
    wearableMap: { [BELT_LOC]: `/items/large_talisman_belt::${BELT_LOC}::0` },
    talismanIdMap: { 1: 11, 2: 0, 3: 0 },
    ...over,
});

describe('loadout talisman marker', () => {
    beforeEach(() => {
        Object.assign(game, { server: true, setting: true, loaded: true, owned: [comb, skill], ws: {}, handlers: {} });
        game.loadouts = { 1: make() };
        panel('Boss');
    });
    afterEach(() => {
        mod.default.cleanup();
        document.body.innerHTML = '';
    });

    test('no talismans and all fine: nothing drawn', () => {
        game.loadouts = { 1: make({ talismanIdMap: { 1: 0, 2: 0, 3: 0 } }) };
        annotate();
        expect(marker()).toBeNull();
        game.loadouts = { 1: make() };
        annotate();
        expect(marker()).toBeNull();
    });

    test('each warning draws a marker with its reason; several are joined', () => {
        game.loadouts = { 1: make({ talismanIdMap: { 1: 99 } }) };
        annotate();
        expect(marker().title).toContain('no longer exists');
        game.loadouts = { 1: make({ talismanIdMap: { 1: 21 } }) };
        annotate();
        expect(marker().title).toContain('skilling talisman');
        game.loadouts = {
            1: make({
                wearableMap: { [BELT_LOC]: `/items/small_talisman_belt::${BELT_LOC}::0` },
                talismanIdMap: { 1: 99, 2: 21 },
            }),
        };
        annotate();
        expect(marker().title.split('\n')).toHaveLength(3);
        expect(document.querySelectorAll(`.${MARKER_CLASS}`)).toHaveLength(1);
    });

    test('a talisman deleted while the panel is open, then restored: marker follows', async () => {
        mod.default.initialize();
        annotate();
        expect(marker()).toBeNull();
        game.owned = [skill];
        for (const h of game.handlers.talismans_updated) h();
        await new Promise((r) => setTimeout(r, 300));
        expect(marker().title).toContain('no longer exists');
        game.owned = [comb, skill];
        for (const h of game.handlers.talismans_updated) h();
        await new Promise((r) => setTimeout(r, 300));
        expect(marker()).toBeNull();
    });

    test('belt changed (loadouts_updated) moves the marker', async () => {
        game.loadouts = { 1: make({ talismanIdMap: { 1: 11, 2: 21 } }) };
        game.owned = [comb, { ...skill, talismanTypeHrid: '/talisman_types/combat' }];
        mod.default.initialize();
        annotate();
        expect(marker()).toBeNull();
        game.loadouts = {
            1: make({
                wearableMap: { [BELT_LOC]: `/items/small_talisman_belt::${BELT_LOC}::0` },
                talismanIdMap: { 1: 11, 2: 21 },
            }),
        };
        for (const h of game.ws.loadouts_updated) h();
        await new Promise((r) => setTimeout(r, 300));
        expect(marker().title).toContain('1 slot');
    });

    test('namesakes: only an agreed warning shows', () => {
        game.loadouts = { 1: make({ talismanIdMap: { 1: 99 } }), 2: make() };
        annotate();
        expect(marker()).toBeNull();
    });

    test('talisman list not delivered: nothing', () => {
        game.loadouts = { 1: make({ talismanIdMap: { 1: 99 } }) };
        game.loaded = false;
        annotate();
        expect(marker()).toBeNull();
    });

    test('live server: nothing drawn and nothing wired', () => {
        game.server = false;
        game.loadouts = { 1: make({ talismanIdMap: { 1: 99 } }) };
        mod.default.initialize();
        annotate();
        expect(marker()).toBeNull();
        expect(game.handlers.talismans_updated || []).toHaveLength(0);
    });

    test('setting off clears an existing marker', () => {
        game.loadouts = { 1: make({ talismanIdMap: { 1: 99 } }) };
        annotate();
        expect(marker()).not.toBeNull();
        game.setting = false;
        annotate();
        expect(marker()).toBeNull();
    });

    test('cleanup removes the marker and every listener', () => {
        game.loadouts = { 1: make({ talismanIdMap: { 1: 99 } }) };
        mod.default.initialize();
        annotate();
        mod.default.cleanup();
        expect(marker()).toBeNull();
        expect(game.handlers.talismans_updated).toHaveLength(0);
        expect(game.ws.loadouts_updated).toHaveLength(0);
    });
});
