/** @vitest-environment happy-dom */

/**
 * Scroll chips in the action panel: which chips an action type gets, which
 * selection a click edits (the one the resolver reads), the master toggle, and
 * that the click listener goes away with the row.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({
    characterId: 'char1',
    simulateScrollEffects: true,
    snapshotName: null,
    saved: {},
    // The shapes the game ships: keyed by personal buff hrid, with the buff beside the action-type map
    personalBuffTypeDetailMap: {
        '/personal_buff_types/efficiency': {
            hrid: '/personal_buff_types/efficiency',
            usableInActionTypeMap: {
                '/action_types/brewing': true,
                '/action_types/cooking': true,
                '/action_types/foraging': true,
            },
            buff: { typeHrid: '/buff_types/efficiency', flatBoost: 0.14 },
        },
        '/personal_buff_types/gourmet': {
            hrid: '/personal_buff_types/gourmet',
            usableInActionTypeMap: { '/action_types/brewing': true, '/action_types/cooking': true },
            buff: { typeHrid: '/buff_types/gourmet', flatBoost: 0.1 },
        },
        '/personal_buff_types/gathering': {
            hrid: '/personal_buff_types/gathering',
            usableInActionTypeMap: { '/action_types/foraging': true },
            buff: { typeHrid: '/buff_types/gathering', flatBoost: 0.18 },
        },
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#0ff',
        getSetting: (key) => (key === 'simulateScrollEffects' ? game.simulateScrollEffects : false),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.characterId,
        getInitClientData: () => ({ personalBuffTypeDetailMap: game.personalBuffTypeDetailMap }),
        on: () => {},
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
    default: { getSnapshotInfoForSkill: () => (game.snapshotName ? { name: game.snapshotName } : null) },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({ guildMemberSkills: () => null, scrollSimulator: () => null }));

const scrollSimulator = (await import('../combat/scroll-simulator.js')).default;
const { buildScrollChips, getApplicableScrollBuffs } = await import('./scroll-chips.js');

const BREWING = '/action_types/brewing';
const FORAGING = '/action_types/foraging';

const chipNames = (row) => [...row.querySelectorAll('button[data-buff]')].map((b) => b.dataset.buff);
const chip = (row, buff) => row.querySelector(`button[data-buff="${buff}"]`);

describe('scroll chips', () => {
    beforeEach(async () => {
        game.characterId = 'char1';
        game.simulateScrollEffects = true;
        game.snapshotName = null;
        game.saved = {};
        scrollSimulator.scrollsByLoadout = {};
        scrollSimulator.initialized = false;
        scrollSimulator.switchHandler = null;
        scrollSimulator.owner = null;
        await scrollSimulator.initialize();
    });

    test('Gourmet is offered for brewing and cooking only', () => {
        expect(getApplicableScrollBuffs(BREWING)).toEqual(['/buff_types/efficiency', '/buff_types/gourmet']);
        expect(getApplicableScrollBuffs('/action_types/cooking')).toContain('/buff_types/gourmet');
        expect(getApplicableScrollBuffs(FORAGING)).toEqual(['/buff_types/efficiency', '/buff_types/gathering']);
        expect(getApplicableScrollBuffs('/action_types/woodcutting')).toEqual([]);
    });

    test('the row draws one chip per applicable scroll, reflecting the selection', async () => {
        await scrollSimulator.saveScrollsForLoadout(null, ['/buff_types/gourmet']);
        const { element } = buildScrollChips({ actionTypeHrid: BREWING, onChange: () => {} });

        expect(chipNames(element)).toEqual(['/buff_types/efficiency', '/buff_types/gourmet']);
        expect(chip(element, '/buff_types/gourmet').dataset.on).toBe('true');
        expect(chip(element, '/buff_types/efficiency').dataset.on).toBe('false');
    });

    test('nothing is drawn when the master toggle is off', () => {
        game.simulateScrollEffects = false;

        expect(buildScrollChips({ actionTypeHrid: BREWING, onChange: () => {} })).toBeNull();
    });

    test('with no loadout for the skill, a click edits the default and redraws', async () => {
        const onChange = vi.fn();
        const { element } = buildScrollChips({ actionTypeHrid: BREWING, onChange });
        expect(chip(element, '/buff_types/gourmet').title).toContain('Scroll of Gourmet (+10%)');
        expect(chip(element, '/buff_types/gourmet').title).toContain('default selection');

        chip(element, '/buff_types/gourmet').click();
        await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));

        expect(scrollSimulator.getScrollsForLoadout(null)).toEqual(new Set(['/buff_types/gourmet']));
        expect(scrollSimulator.getScrollSetForActionType(BREWING)).toEqual(new Set(['/buff_types/gourmet']));
        expect(game.saved.scroll_simulation_char1.__default__).toEqual(['/buff_types/gourmet']);
    });

    test('with a loadout that has its own selection, a click edits that loadout, not the default', async () => {
        await scrollSimulator.saveScrollsForLoadout(null, ['/buff_types/efficiency']);
        await scrollSimulator.saveScrollsForLoadout('Brew Set', ['/buff_types/gourmet']);
        game.snapshotName = 'Brew Set';
        const onChange = vi.fn();
        const { element } = buildScrollChips({ actionTypeHrid: BREWING, onChange });
        expect(chip(element, '/buff_types/efficiency').title).toContain('this loadout (Brew Set)');

        chip(element, '/buff_types/efficiency').click();
        await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));

        expect(scrollSimulator.getScrollsForLoadout('Brew Set')).toEqual(
            new Set(['/buff_types/gourmet', '/buff_types/efficiency'])
        );
        expect(scrollSimulator.getScrollsForLoadout(null)).toEqual(new Set(['/buff_types/efficiency']));
    });

    test('a loadout with no selection of its own falls through to the default, so the click edits the default', async () => {
        game.snapshotName = 'Unconfigured';
        const onChange = vi.fn();
        const { element } = buildScrollChips({ actionTypeHrid: BREWING, onChange });

        chip(element, '/buff_types/efficiency').click();
        await vi.waitFor(() => expect(onChange).toHaveBeenCalled());

        expect(scrollSimulator.getScrollsForLoadout(null)).toEqual(new Set(['/buff_types/efficiency']));
        expect(scrollSimulator.getScrollsForLoadout('Unconfigured')).toEqual(new Set());
    });

    test('a second click turns the scroll off again', async () => {
        await scrollSimulator.saveScrollsForLoadout(null, ['/buff_types/gourmet']);
        const onChange = vi.fn();
        const { element } = buildScrollChips({ actionTypeHrid: BREWING, onChange });

        chip(element, '/buff_types/gourmet').click();
        await vi.waitFor(() => expect(onChange).toHaveBeenCalled());

        expect(scrollSimulator.getScrollsForLoadout(null)).toEqual(new Set());
    });

    test('a save the simulator refuses does not redraw', async () => {
        const onChange = vi.fn();
        const { element } = buildScrollChips({ actionTypeHrid: BREWING, onChange });
        scrollSimulator.owner = 'someone-else';
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        chip(element, '/buff_types/gourmet').click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(onChange).not.toHaveBeenCalled();
    });

    test('a save tells every listener which selection changed', async () => {
        const heard = vi.fn();
        document.addEventListener('toolasha:scroll-selection-changed', heard);

        await scrollSimulator.saveScrollsForLoadout('Brew Set', ['/buff_types/gourmet']);
        document.removeEventListener('toolasha:scroll-selection-changed', heard);

        expect(heard).toHaveBeenCalledTimes(1);
        expect(heard.mock.calls[0][0].detail).toEqual({ key: 'Brew Set' });
    });

    test('a change made in a popup redraws a mounted panel, so its totals follow the new selection', async () => {
        const onChange = vi.fn();
        const { element, dispose } = buildScrollChips({ actionTypeHrid: BREWING, onChange });
        document.body.appendChild(element);

        await scrollSimulator.saveScrollsForLoadout(null, ['/buff_types/gourmet']);
        await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));

        dispose();
        element.remove();
    });

    test("a chip's own click redraws once, not again for its own save", async () => {
        const onChange = vi.fn();
        const { element, dispose } = buildScrollChips({ actionTypeHrid: BREWING, onChange });
        document.body.appendChild(element);

        chip(element, '/buff_types/gourmet').click();
        await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(onChange).toHaveBeenCalledTimes(1);
        dispose();
        element.remove();
    });

    test('rows never put their own listener on the document, so a closed panel is not kept alive', () => {
        const spy = vi.spyOn(document, 'addEventListener');
        const rows = Array.from({ length: 5 }, () => buildScrollChips({ actionTypeHrid: BREWING, onChange: () => {} }));

        // At most the one shared listener, however many panels have drawn a row
        const own = spy.mock.calls.filter(([type]) => type === 'toolasha:scroll-selection-changed');
        expect(own.length).toBeLessThanOrEqual(1);
        rows.forEach((r) => r.dispose());
        spy.mockRestore();
    });

    test('a disposed row no longer redraws on a selection change', async () => {
        const onChange = vi.fn();
        const { element, dispose } = buildScrollChips({ actionTypeHrid: BREWING, onChange });
        document.body.appendChild(element);
        dispose();

        await scrollSimulator.saveScrollsForLoadout(null, ['/buff_types/wisdom']);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(onChange).not.toHaveBeenCalled();
        element.remove();
    });

    test('dispose removes the click listener, and rows do not share one', () => {
        const rows = [1, 2, 3].map(() => buildScrollChips({ actionTypeHrid: BREWING, onChange: () => {} }));
        const spies = rows.map((r) => vi.spyOn(r.element, 'removeEventListener'));

        rows.forEach((r) => r.dispose());

        spies.forEach((spy) => expect(spy).toHaveBeenCalledWith('click', expect.any(Function)));
    });
});
