/** @vitest-environment happy-dom */

/**
 * The scroll chips on the action panel: one row per panel, wherever the profit section is (or is
 * not), for the action types whose figures take part in the simulation.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({
    simulateScrollEffects: true,
    scrollPlanner: false,
    saved: {},
    // Per panel element: the action type the panel names now
    typeOf: new WeakMap(),
    detailSubscribers: [],
    unsubscribed: 0,
    personalBuffTypeDetailMap: {
        '/personal_buff_types/efficiency': {
            usableInActionTypeMap: {
                '/action_types/tailoring': true,
                '/action_types/brewing': true,
                '/action_types/alchemy': true,
            },
            buff: { typeHrid: '/buff_types/efficiency', flatBoost: 0.14 },
        },
        '/personal_buff_types/gourmet': {
            usableInActionTypeMap: { '/action_types/brewing': true },
            buff: { typeHrid: '/buff_types/gourmet', flatBoost: 0.1 },
        },
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#0ff',
        getSetting: (key) => (key in game ? game[key] : false),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char1',
        getInitClientData: () => ({ personalBuffTypeDetailMap: game.personalBuffTypeDetailMap }),
        characterItems: [],
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key, store, fallback) => game.saved[key] ?? fallback,
        setJSON: async (key, value) => {
            game.saved[key] = value;
        },
    },
}));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { getSnapshotInfoForSkill: () => null },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    marketUndercutAlerts: () => null,
    guildMemberSkills: () => null,
    scrollSimulator: () => null,
    scrollPlannerInstance: () => null,
}));
vi.mock('../../utils/action-panel-helper.js', () => ({
    onDetailPanel: (callback) => {
        game.detailSubscribers.push(callback);
        return () => {
            game.unsubscribed += 1;
            game.detailSubscribers = game.detailSubscribers.filter((c) => c !== callback);
        };
    },
    resolveDetailPanel: (panel) => {
        const type = game.typeOf.get(panel);
        return { panel, actionDetails: type ? { type } : null };
    },
}));

const scrollSimulator = (await import('../combat/scroll-simulator.js')).default;
const { default: feature } = await import('./scroll-chips-panel.js');

const TAILORING = '/action_types/tailoring';
const BREWING = '/action_types/brewing';
const ALCHEMY = '/action_types/alchemy';
const COMBAT = '/action_types/combat';
const WOODCUTTING = '/action_types/woodcutting';

/**
 * A panel shaped like the game's: the quantity field three levels inside its container, which
 * Toolasha's sections follow.
 */
function makePanel(type, { withInput = true } = {}) {
    const panel = document.createElement('div');
    panel.className = 'SkillActionDetail_skillActionDetail__x';
    game.typeOf.set(panel, type);
    panel.innerHTML =
        '<div class="SkillActionDetail_name__x">Some Action</div>' +
        '<div class="requirements">Requires</div>' +
        (withInput
            ? '<div class="inputContainer"><div class="wrap"><div class="SkillActionDetail_maxActionCountInput__x">' +
              '<input type="number"></div></div></div>'
            : '') +
        '<div class="SkillActionDetail_buttonsContainer__x"><button>Start</button></div>';
    document.body.appendChild(panel);
    return panel;
}
const inputContainer = (panel) => panel.querySelector('.inputContainer');
const rows = (panel) => [...panel.querySelectorAll('.mwi-scroll-chips')];
const section = (title) => {
    const el = document.createElement('div');
    el.className = 'mwi-collapsible-section';
    el.textContent = title;
    return el;
};
const quickInputs = () => {
    const el = document.createElement('div');
    el.innerHTML = '<button class="mwi-quick-input-btn">1</button>';
    return el;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

function boot() {
    feature.initialize();
}
function announce(panel) {
    game.detailSubscribers.forEach((callback) => callback({ panel }));
}

beforeEach(async () => {
    game.simulateScrollEffects = true;
    game.scrollPlanner = false;
    game.saved = {};
    game.detailSubscribers = [];
    game.unsubscribed = 0;
    scrollSimulator.scrollsByLoadout = {};
    scrollSimulator.initialized = false;
    scrollSimulator.switchHandler = null;
    scrollSimulator.owner = null;
    await scrollSimulator.initialize();
});

afterEach(() => {
    feature.cleanup();
    document.body.innerHTML = '';
});

describe('scroll chips panel: where and when', () => {
    test('a tailoring panel with no profit section at all (an untradable cape) still gets its chips', () => {
        const panel = makePanel(TAILORING);
        boot();
        announce(panel);

        expect(panel.querySelector('#mwi-production-profit')).toBeNull();
        expect(rows(panel)).toHaveLength(1);
        expect(rows(panel)[0].dataset.actionType).toBe(TAILORING);
    });

    test('a panel already on the page when the feature starts is picked up', () => {
        const panel = makePanel(TAILORING);
        boot();

        expect(rows(panel)).toHaveLength(1);
    });

    test('the row sits right after the quantity field, or after the Toolasha block that follows it', () => {
        const bare = makePanel(TAILORING);
        const full = makePanel(TAILORING);
        for (const el of [quickInputs(), section('speed'), section('level')]) {
            inputContainer(full).insertAdjacentElement('afterend', el);
            // Each one goes right after the field, as quick-input-buttons does: newest first
        }
        boot();

        expect(inputContainer(bare).nextElementSibling).toBe(rows(bare)[0]);
        // Newest first, so the quick-input block is the last of the three and the row follows it
        const row = full.querySelector('.mwi-scroll-chips');
        expect(row.previousElementSibling.querySelector('.mwi-quick-input-btn')).toBeTruthy();
        expect(row.nextElementSibling.className).toContain('SkillActionDetail_buttonsContainer');
        expect(full.querySelectorAll('.mwi-scroll-chips')).toHaveLength(1);
    });

    test('sections drawn after the row land above it: the row is moved to the end of the block', async () => {
        const panel = makePanel(TAILORING);
        boot();
        expect(inputContainer(panel).nextElementSibling).toBe(rows(panel)[0]);

        // quick-input-buttons arrives later and inserts after the quantity field
        inputContainer(panel).insertAdjacentElement('afterend', section('level'));
        inputContainer(panel).insertAdjacentElement('afterend', section('speed'));
        inputContainer(panel).insertAdjacentElement('afterend', quickInputs());

        await vi.waitFor(() => expect(rows(panel)[0].previousElementSibling.className).toBe('mwi-collapsible-section'));
        expect(rows(panel)).toHaveLength(1);
        expect(rows(panel)[0].nextElementSibling.className).toContain('SkillActionDetail_buttonsContainer');
    });

    test('a check that finds everything in place writes nothing', async () => {
        const panel = makePanel(TAILORING);
        boot();
        const row = rows(panel)[0];
        const writes = [];
        new MutationObserver((records) => writes.push(...records)).observe(panel, { childList: true, subtree: true });

        panel.querySelector('.requirements').textContent = 'Requires (changed)';
        await settle();

        // Only the text change itself: the row was neither rebuilt nor moved
        expect(rows(panel)[0]).toBe(row);
        expect(writes.filter((r) => !r.target.classList.contains('requirements'))).toHaveLength(0);
    });

    test('brewing offers more chips than tailoring: the row follows the action type', () => {
        const panel = makePanel(BREWING);
        boot();

        expect([...rows(panel)[0].querySelectorAll('button[data-buff]')].map((b) => b.dataset.buff)).toEqual([
            '/buff_types/efficiency',
            '/buff_types/gourmet',
        ]);
    });
});

describe('scroll chips panel: every ending', () => {
    test('alchemy and combat panels get none, though the buff table lists alchemy', () => {
        const alchemy = makePanel(ALCHEMY);
        const combat = makePanel(COMBAT);
        boot();

        expect(rows(alchemy)).toHaveLength(0);
        expect(rows(combat)).toHaveLength(0);
    });

    test('a supported type with no applicable scroll gets none', () => {
        const panel = makePanel(WOODCUTTING);
        boot();

        expect(rows(panel)).toHaveLength(0);
    });

    test('a panel with no quantity field yet gets its row when the field arrives', async () => {
        const panel = makePanel(TAILORING, { withInput: false });
        boot();
        expect(rows(panel)).toHaveLength(0);

        panel
            .querySelector('.requirements')
            .insertAdjacentHTML(
                'afterend',
                '<div class="inputContainer"><div class="wrap"><div class="SkillActionDetail_maxActionCountInput__x">' +
                    '<input type="number"></div></div></div>'
            );

        await vi.waitFor(() => expect(rows(panel)).toHaveLength(1));
    });

    test('an action that is not resolved yet gets its row once the game data is there', async () => {
        const panel = makePanel(undefined);
        boot();
        expect(rows(panel)).toHaveLength(0);

        game.typeOf.set(panel, TAILORING);
        panel.querySelector('.requirements').textContent = 'Requires (loaded)';

        await vi.waitFor(() => expect(rows(panel)).toHaveLength(1));
    });

    test('simulation off at start: no feature, no rows', () => {
        game.simulateScrollEffects = false;
        const panel = makePanel(TAILORING);
        boot();

        expect(feature.isRunning()).toBe(false);
        expect(game.detailSubscribers).toHaveLength(0);
        expect(rows(panel)).toHaveLength(0);
    });

    test('simulation switched off while a row is open removes it, and switching on again (a restart) draws it', async () => {
        const panel = makePanel(TAILORING);
        boot();
        expect(rows(panel)).toHaveLength(1);

        game.simulateScrollEffects = false;
        document.dispatchEvent(
            new CustomEvent('toolasha:scroll-selection-changed', { detail: { key: null, setting: true } })
        );
        await vi.waitFor(() => expect(rows(panel)).toHaveLength(0));

        feature.cleanup();
        game.simulateScrollEffects = true;
        boot();
        expect(rows(panel)).toHaveLength(1);
    });

    test('cleanup removes every row, unsubscribes, and stops watching', async () => {
        const panel = makePanel(TAILORING);
        boot();
        expect(rows(panel)).toHaveLength(1);

        feature.cleanup();

        expect(rows(panel)).toHaveLength(0);
        expect(game.unsubscribed).toBe(1);
        expect(feature.isRunning()).toBe(false);
        panel.querySelector('.requirements').textContent = 'changed';
        await settle();
        expect(rows(panel)).toHaveLength(0);
    });

    test('starting twice does not subscribe twice or draw two rows', () => {
        const panel = makePanel(TAILORING);
        boot();
        boot();

        expect(game.detailSubscribers).toHaveLength(1);
        expect(rows(panel)).toHaveLength(1);
        announce(panel);
        expect(rows(panel)).toHaveLength(1);
    });

    test('a stray row from an earlier life of the feature is replaced, not duplicated', () => {
        const panel = makePanel(TAILORING);
        const stray = document.createElement('div');
        stray.className = 'mwi-scroll-chips';
        panel.appendChild(stray);
        boot();

        expect(rows(panel)).toHaveLength(1);
        expect(rows(panel)[0]).not.toBe(stray);
    });
});

describe('scroll chips panel: action switches, remounts, other panels', () => {
    test('the game reusing the panel for another action type rebuilds the row for it', async () => {
        const panel = makePanel(TAILORING);
        boot();
        expect(rows(panel)[0].querySelectorAll('button[data-buff]')).toHaveLength(1);

        game.typeOf.set(panel, BREWING);
        panel.querySelector('.SkillActionDetail_name__x').textContent = 'Brewing Thing';

        await vi.waitFor(() => expect(rows(panel)[0]?.dataset.actionType).toBe(BREWING));
        expect(rows(panel)).toHaveLength(1);
        expect(rows(panel)[0].querySelectorAll('button[data-buff]')).toHaveLength(2);
    });

    test('reused for an action with no chips (alchemy), the row goes', async () => {
        const panel = makePanel(TAILORING);
        boot();

        game.typeOf.set(panel, ALCHEMY);
        panel.querySelector('.SkillActionDetail_name__x').textContent = 'Transmute';

        await vi.waitFor(() => expect(rows(panel)).toHaveLength(0));
    });

    test('the game swapping the contents of the panel wholesale brings the row back', async () => {
        const panel = makePanel(TAILORING);
        boot();

        // The row is wiped along with the contents it sat in
        panel.replaceChildren();
        panel.innerHTML =
            '<div class="SkillActionDetail_name__x">Same</div>' +
            '<div class="inputContainer"><div class="wrap"><div class="SkillActionDetail_maxActionCountInput__x">' +
            '<input type="number"></div></div></div>';

        await vi.waitFor(() => expect(rows(panel)).toHaveLength(1));
    });

    test('two panels each get their own row', () => {
        const a = makePanel(TAILORING);
        const b = makePanel(BREWING);
        boot();

        expect(rows(a)).toHaveLength(1);
        expect(rows(b)).toHaveLength(1);
        expect(rows(a)[0]).not.toBe(rows(b)[0]);
    });

    test('a panel the game removed is released on the next panel that appears', () => {
        const gone = makePanel(TAILORING);
        boot();
        const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
        gone.remove();

        announce(makePanel(BREWING));

        expect(disconnect).toHaveBeenCalled();
        disconnect.mockRestore();
    });
});

describe('scroll chips panel: pressing a chip', () => {
    test('saves the selection and redraws exactly one row; the figures read the same selection', async () => {
        const panel = makePanel(BREWING);
        boot();

        rows(panel)[0].querySelector('button[data-buff="/buff_types/gourmet"]').click();
        await vi.waitFor(() =>
            expect(rows(panel)[0]?.querySelector('button[data-buff="/buff_types/gourmet"]')?.dataset.on).toBe('true')
        );

        expect(rows(panel)).toHaveLength(1);
        expect(scrollSimulator.getScrollSetForActionType(BREWING)).toEqual(new Set(['/buff_types/gourmet']));
    });

    test('a selection saved elsewhere (the Loadouts popup) repaints the open row', async () => {
        const panel = makePanel(BREWING);
        boot();

        await scrollSimulator.saveScrollsForLoadout(null, ['/buff_types/efficiency']);

        await vi.waitFor(() =>
            expect(rows(panel)[0]?.querySelector('button[data-buff="/buff_types/efficiency"]')?.dataset.on).toBe('true')
        );
        expect(rows(panel)).toHaveLength(1);
    });

    test('with nothing selected every chip is off, so no figure differs from the setting being off', () => {
        const panel = makePanel(BREWING);
        boot();

        const states = [...rows(panel)[0].querySelectorAll('button[data-buff]')].map((b) => b.dataset.on);
        expect(states).toEqual(['false', 'false']);
        expect(scrollSimulator.getScrollSetForActionType(BREWING)).toEqual(new Set());
    });
});
