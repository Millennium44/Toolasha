/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
const game = vi.hoisted(() => ({ details: {}, skills: null, events: new Map(), subscribers: new Set(), actions: {} }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => game.details[hrid],
        getSkills: () => game.skills,
        on: (event, callback) => {
            if (!game.events.has(event)) game.events.set(event, new Set());
            game.events.get(event).add(callback);
        },
        off: (event, callback) => game.events.get(event)?.delete(callback),
    },
}));
vi.mock('../../utils/action-panel-helper.js', () => ({
    PANEL_SELECTOR: '[data-action]',
    resolveDetailPanel: (panel) => ({ panel, actionDetails: game.actions[panel.dataset.action] }),
    onDetailPanel: (callback) => {
        game.subscribers.add(callback);
        return () => game.subscribers.delete(callback);
    },
}));
import {
    renderActionItemRequirements,
    initializeItemRequirementWarnings,
    cleanupItemRequirementWarnings,
} from './item-requirement-warnings.js';
import { itemRequirementHtml } from '../../utils/item-requirements.js';
const BOOTS = '/items/lab_boots_refined';
function emit(event) {
    for (const handler of game.events.get(event) || []) handler();
}
function panel() {
    const node = document.createElement('div');
    node.dataset.action = 'refine';
    node.innerHTML = '<div class="SkillActionDetail_outputItems__x">Outputs</div><input value="0">';
    document.body.appendChild(node);
    return node;
}
function render(node) {
    renderActionItemRequirements({ panel: node, actionDetails: game.actions[node.dataset.action] });
}
beforeEach(() => {
    game.details = {
        [BOOTS]: {
            name: 'Refined Boots',
            equipmentDetail: { levelRequirements: [{ skillHrid: '/skills/defense', level: 95 }] },
        },
    };
    game.skills = [{ skillHrid: '/skills/defense', level: 88 }];
    game.actions = {
        refine: {
            upgradeItemHrid: '/items/lab_boots',
            inputItems: [{ itemHrid: '/items/lab_boots' }],
            outputItems: [{ itemHrid: BOOTS }],
        },
        food: { outputItems: [{ itemHrid: '/items/tea' }] },
    };
});
afterEach(() => {
    cleanupItemRequirementWarnings();
    document.body.replaceChildren();
});
describe('equipment output warnings', () => {
    test('warns for the refined output, with no amount or profit setting required', () => {
        const node = panel();
        render(node);
        expect(node.textContent).toContain('Needs Defense 95 (you: 88)');
        expect(node.querySelector('[data-item-requirement-hrid]').dataset.itemRequirementHrid).toBe(BOOTS);
        expect(node.querySelector('.SkillActionDetail_outputItems__x').nextElementSibling.className).toBe(
            'mwi-action-item-requirements'
        );
    });
    test('refreshing identical DOM is mutation-free and repeated dispatch never duplicates warnings', async () => {
        const node = panel();
        render(node);
        const observer = new MutationObserver(() => {});
        observer.observe(node, { childList: true, subtree: true, attributes: true, characterData: true });
        render(node);
        render(node);
        expect(observer.takeRecords()).toHaveLength(0);
        observer.disconnect();
        expect(node.querySelectorAll('.mwi-action-item-requirements')).toHaveLength(1);
    });
    test('a reused panel removes stale equipment warnings on a food action, then restores them on return', () => {
        const node = panel();
        render(node);
        node.dataset.action = 'food';
        render(node);
        expect(node.querySelector('.mwi-action-item-requirements')).toBeNull();
        node.dataset.action = 'refine';
        render(node);
        expect(node.textContent).toContain('Needs Defense 95');
    });
    test('missing output containers or details leave no stale warning', () => {
        const node = panel();
        render(node);
        game.actions.refine = null;
        render(node);
        expect(node.querySelector('.mwi-action-item-requirements')).toBeNull();
        node.replaceChildren();
        render(node);
        expect(node.textContent).toBe('');
    });
    test('every distinct equipment output is checked, but consumables and duplicate outputs are skipped', () => {
        game.actions.refine.outputItems.push(
            { itemHrid: BOOTS },
            { itemHrid: '/items/tea' },
            { itemHrid: '/items/shield' }
        );
        game.details['/items/shield'] = {
            name: 'Shield',
            equipmentDetail: { levelRequirements: [{ skillHrid: '/skills/defense', level: 100 }] },
        };
        const node = panel();
        render(node);
        expect(node.querySelectorAll('[data-item-requirement-hrid]')).toHaveLength(2);
        expect(node.textContent).toContain('Refined Boots: Needs Defense 95');
        expect(node.textContent).toContain('Shield: Needs Defense 100');
    });
    test.each(['skills_updated', 'action_completed'])(
        '%s clears both output and existing advisor warnings after a level gain',
        (event) => {
            const node = panel();
            document.body.insertAdjacentHTML('beforeend', itemRequirementHtml(BOOTS, { forYou: true }));
            initializeItemRequirementWarnings();
            game.skills[0].level = 95;
            emit(event);
            expect(node.querySelector('.mwi-action-item-requirements').hidden).toBe(true);
            expect(
                [...document.querySelectorAll('[data-item-requirement-hrid]')].every(
                    (el) => el.hidden && !el.textContent
                )
            ).toBe(true);
        }
    );
    test('character reload clears old levels, then a late initialization fills the warning', () => {
        const node = panel();
        initializeItemRequirementWarnings();
        game.skills = null;
        emit('character_switched');
        expect(node.textContent).not.toContain('you: 88');
        game.skills = [{ skillHrid: '/skills/defense', level: 50 }];
        emit('character_initialized');
        expect(node.textContent).toContain('you: 50');
    });
    test('cleanup cancels subscriptions, removes output nodes, and re-enable rechecks existing panels once', () => {
        const node = panel();
        initializeItemRequirementWarnings();
        initializeItemRequirementWarnings();
        expect(game.subscribers.size).toBe(1);
        expect([...game.events.values()].every((handlers) => handlers.size === 1)).toBe(true);
        cleanupItemRequirementWarnings();
        expect(game.subscribers.size).toBe(0);
        expect([...game.events.values()].every((handlers) => handlers.size === 0)).toBe(true);
        expect(node.querySelector('.mwi-action-item-requirements')).toBeNull();
        game.skills[0].level = 90;
        initializeItemRequirementWarnings();
        expect(node.textContent).toContain('you: 90');
    });
});
