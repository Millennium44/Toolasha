/** @vitest-environment happy-dom */
import { describe, test, expect, vi } from 'vitest';
import { buildSkillGroups, getSkillGroupState, toggleSkillGroup, renderSkillBar } from './task-skill-groups.js';

const gameData = {
    actionTypeDetailMap: {
        '/action_types/brewing': { name: 'Brewing', sortIndex: 8 },
        '/action_types/milking': { name: 'Milking', sortIndex: 1 },
    },
    actionDetailMap: {
        '/actions/brewing/brew_a': { type: '/action_types/brewing', name: 'A' },
        '/actions/brewing/brew_b': { type: '/action_types/brewing', name: 'B' },
        '/actions/milking/cow': { type: '/action_types/milking', name: 'Cow' },
        '/actions/combat/zone': { type: '/action_types/combat', name: 'Zone' },
        '/actions/labyrinth/x': { type: '/action_types/labyrinth', name: 'Lab' },
    },
};

describe('buildSkillGroups', () => {
    test('groups non-combat actions by type, in game skill order', () => {
        const groups = buildSkillGroups(gameData);
        expect(groups.map((g) => g.label)).toEqual(['Milking', 'Brewing']);
        expect(groups[1].hrids).toEqual(['/actions/brewing/brew_a', '/actions/brewing/brew_b']);
    });

    test('excludes combat and labyrinth', () => {
        const types = buildSkillGroups(gameData).map((g) => g.type);
        expect(types).not.toContain('/action_types/combat');
        expect(types).not.toContain('/action_types/labyrinth');
    });

    test('picks up an action type added by the game without code changes', () => {
        const data = {
            actionDetailMap: { '/actions/new/thing': { type: '/action_types/newskill' } },
        };
        expect(buildSkillGroups(data)).toEqual([
            { type: '/action_types/newskill', label: 'Newskill', hrids: ['/actions/new/thing'] },
        ]);
    });

    test('handles missing game data', () => {
        expect(buildSkillGroups(null)).toEqual([]);
    });
});

describe('toggleSkillGroup', () => {
    const group = { hrids: ['a', 'b', 'c'] };

    test('selects all when none are selected', () => {
        const set = new Set();
        expect(toggleSkillGroup(group, set)).toBe(true);
        expect([...set]).toEqual(['a', 'b', 'c']);
    });

    test('selects all when only some are selected, keeping unrelated entries', () => {
        const set = new Set(['a', 'other']);
        expect(getSkillGroupState(group, set)).toBe('some');
        toggleSkillGroup(group, set);
        expect(getSkillGroupState(group, set)).toBe('all');
        expect(set.has('other')).toBe(true);
    });

    test('deselects all when all are selected, keeping unrelated entries', () => {
        const set = new Set(['a', 'b', 'c', 'other']);
        expect(toggleSkillGroup(group, set)).toBe(false);
        expect([...set]).toEqual(['other']);
        expect(getSkillGroupState(group, set)).toBe('none');
    });
});

describe('renderSkillBar', () => {
    test('draws one chip per skill with counts and routes clicks to onToggle', () => {
        const groups = buildSkillGroups(gameData);
        const bar = document.createElement('div');
        const onToggle = vi.fn();
        renderSkillBar(bar, groups, new Set(), { accent: '#fff', tint: '#000', onToggle });
        const chips = bar.querySelectorAll('[data-skill]');
        expect(chips).toHaveLength(2);
        expect(chips[1].textContent).toBe('Brewing (2)');
        chips[1].click();
        expect(onToggle).toHaveBeenCalledWith(groups[1]);
    });
});
