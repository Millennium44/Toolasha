/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
const game = vi.hoisted(() => ({ details: {}, skills: null, names: {} }));
vi.mock('../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => game.details[hrid],
        getSkills: () => game.skills,
        getInitClientData: () => ({ skillDetailMap: game.names }),
    },
}));
import {
    unmetItemRequirements,
    itemRequirementText,
    itemRequirementHtml,
    upgradeRequirementHtml,
    refreshItemRequirementWarnings,
} from './item-requirements.js';
const BOOTS = '/items/lab_boots_refined';
beforeEach(() => {
    game.details = {
        [BOOTS]: {
            name: 'Refined Boots',
            equipmentDetail: {
                levelRequirements: [
                    { skillHrid: '/skills/defense', level: 95 },
                    { skillHrid: '/skills/stamina', level: 80 },
                ],
            },
        },
    };
    game.skills = [
        { skillHrid: '/skills/defense', level: 88 },
        { skillHrid: '/skills/stamina', level: 80 },
    ];
    game.names = {};
});
afterEach(() => {
    document.body.replaceChildren();
});
describe('local equipment requirements', () => {
    test('reports unmet requirements but accepts the exact boundary', () => {
        expect(itemRequirementText(BOOTS)).toBe('Needs Defense 95 (you: 88)');
        expect(unmetItemRequirements(BOOTS)).toEqual([
            { skillHrid: '/skills/defense', name: 'Defense', required: 95, current: 88 },
        ]);
        game.skills[0].level = 95;
        expect(itemRequirementText(BOOTS)).toBe('');
    });
    test('a known zero is a real level, not missing data', () => {
        game.skills = [{ skillHrid: '/skills/defense', level: 0 }];
        expect(itemRequirementText(BOOTS)).toBe('Needs Defense 95 (you: 0)');
    });

    test('reports every unmet skill once, using the strictest requirement', () => {
        game.details[BOOTS].equipmentDetail.levelRequirements.push(
            { skillHrid: '/skills/defense', level: 90 },
            { skillHrid: '/skills/defense', level: 100 }
        );
        game.skills[1].level = 79;
        expect(itemRequirementText(BOOTS)).toBe('Needs Defense 100 (you: 88); Needs Stamina 80 (you: 79)');
    });
    test.each([
        null,
        [],
        [{ skillHrid: '/skills/defense' }],
        [{ skillHrid: '/skills/defense', level: NaN }],
        [{ skillHrid: '/skills/defense', level: -1 }],
    ])('unknown skills do not invent a level: %j', (skills) => {
        game.skills = skills;
        expect(itemRequirementText(BOOTS)).toBe('');
    });
    test('malformed requirements, absent items and non-equipment produce no warnings', () => {
        game.details[BOOTS].equipmentDetail.levelRequirements = [
            null,
            {},
            { skillHrid: '/skills/defense', level: NaN },
            { skillHrid: '/skills/defense', level: 0 },
        ];
        expect(itemRequirementText(BOOTS)).toBe('');
        expect(itemRequirementHtml('/items/missing')).toBe('');
        game.details['/items/tea'] = { levelRequirements: [{ skillHrid: '/skills/defense', level: 100 }] };
        expect(itemRequirementHtml('/items/tea')).toBe('');
    });
    test('late local data populates a hidden slot, and level gains clear it without changing the item', () => {
        game.skills = null;
        document.body.innerHTML = itemRequirementHtml(BOOTS);
        const node = document.querySelector('span');
        expect(node.hidden).toBe(true);
        game.skills = [{ skillHrid: '/skills/defense', level: 88 }];
        refreshItemRequirementWarnings();
        expect(node.hidden).toBe(false);
        expect(node.textContent).toContain('you: 88');
        game.skills[0].level = 100;
        refreshItemRequirementWarnings();
        expect(node.hidden).toBe(true);
        expect(node.textContent).toBe('');
    });
    test('party rows and hypothetical levels explicitly describe only the local character', () => {
        const html = upgradeRequirementHtml({
            candidate: { upgradeHrid: BOOTS, upgradeLevel: 12, playerIndex: 1, isSelf: false },
            playerDTO: { defenseLevel: 150 },
        });
        expect(html).toContain('For you: Needs Defense 95 (you: 88)');
        expect(html).not.toContain('150');
    });
    test('multi-slot swaps name each equipment item and deduplicate a repeated primary item', () => {
        game.details['/items/shield'] = {
            name: 'Shield',
            equipmentDetail: { levelRequirements: [{ skillHrid: '/skills/defense', level: 100 }] },
        };
        const html = upgradeRequirementHtml({
            candidate: {
                upgradeHrid: BOOTS,
                addedSlots: {
                    '/equipment_types/feet': { hrid: BOOTS, enhancementLevel: 12 },
                    '/equipment_types/off_hand': { hrid: '/items/shield', enhancementLevel: 5 },
                    '/equipment_types/main_hand': { hrid: '/items/shield', enhancementLevel: 6 },
                },
            },
        });
        document.body.innerHTML = html;
        expect(document.querySelectorAll('[data-item-requirement-hrid]')).toHaveLength(2);
        expect(document.body.textContent).toContain('For you: Refined Boots: Needs Defense 95');
        expect(document.body.textContent).toContain('For you: Shield: Needs Defense 100');
    });
    test('escapes item and skill names instead of executing markup', () => {
        game.details[BOOTS].name = '<img src=x onerror=alert(1)>';
        game.names['/skills/defense'] = { name: '<Defense & "more">' };
        document.body.innerHTML = itemRequirementHtml(BOOTS, { showName: true });
        expect(document.querySelector('img')).toBeNull();
        expect(document.body.textContent).toContain('<Defense & "more"> 95');
    });
});
