import { describe, test, expect } from 'vitest';

import { labTriggerLoadoutsHtml, renderLabTriggerResultsHtml, summarizeLabTriggerRun } from './lab-trigger-view.js';

const FROM_ROW = {
    dependencyHrid: '/combat_trigger_dependencies/self',
    conditionHrid: '/combat_trigger_conditions/missing_hp',
    comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
};
const FRENZY = {
    dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
    conditionHrid: '/combat_trigger_conditions/frenzy',
    comparatorHrid: '/combat_trigger_comparators/is_active',
    value: 0,
};
const donut = (extra) => ({
    ...FROM_ROW,
    key: 'k',
    itemName: 'Donut',
    slotType: 'food',
    from: 300,
    to: 450,
    se: 0.05,
    ...extra,
});

const groupWith = ({ result, conditions }) => ({
    key: 'current',
    name: 'Current gear',
    fights: [],
    result: { changes: [], reliable: null, ...result },
    conditions,
});
const render = (group) => renderLabTriggerResultsHtml({ groups: [group], minGain: 0.02, simCount: 10 }, {});

describe('the best measured candidate when nothing is recommended', () => {
    test('threshold search: shows the best found, labeled not a recommendation', () => {
        const html = render(groupWith({ result: { bestMeasured: donut({ deltaScore: 0.03 }) } }));
        expect(html).toContain('No change beat the current thresholds by a clear margin.');
        expect(html).toContain('Best found: Donut (food)');
        expect(html).toContain('300');
        expect(html).toContain('450');
        expect(html).toContain('+0.03 ± 0.05 attempts');
        expect(html).toContain('not a recommendation');
    });

    test('threshold search: still shows the best found when the all-together check rejected the changes', () => {
        const html = render(groupWith({ result: { reliable: false, bestMeasured: donut({ deltaScore: 0.03 }) } }));
        expect(html).toContain('No reliable improvement found.');
        expect(html).toContain('data-lab-trigger-best');
        expect(html).toContain('Best found: Donut (food)');
    });

    test('condition search: still shows each slot best when the all-together check rejected them', () => {
        const html = render(
            groupWith({
                result: { noTunables: true },
                conditions: {
                    changes: [],
                    reliable: false,
                    bestMeasured: [
                        {
                            key: 'drinks|0',
                            itemName: 'Coffee',
                            slotType: 'drinks',
                            fromRows: [],
                            toRows: [FRENZY],
                            deltaScore: 0.01,
                            se: 0.04,
                        },
                    ],
                },
            })
        );
        expect(html).toContain('none are recommended');
        expect(html).toContain('data-lab-condition-best="drinks|0"');
        expect(html).toContain('Best found: Coffee (drink)');
    });

    test('threshold search: says so when the current setting measured best', () => {
        const html = render(groupWith({ result: { bestMeasured: donut({ deltaScore: -0.04 }) } }));
        expect(html).toContain('Current setting measured best.');
        expect(html).not.toContain('Best found:');
    });

    test('condition search: shows each slot best and the current-best case', () => {
        const html = render(
            groupWith({
                result: { noTunables: true },
                conditions: {
                    changes: [],
                    bestMeasured: [
                        {
                            key: 'drinks|0',
                            itemName: 'Coffee',
                            slotType: 'drinks',
                            fromRows: [],
                            toRows: [FRENZY],
                            deltaScore: 0.01,
                            se: 0.04,
                        },
                        {
                            key: 'food|0',
                            itemName: 'Cake',
                            slotType: 'food',
                            fromRows: [],
                            toRows: [FRENZY],
                            deltaScore: -0.2,
                            se: 0.04,
                        },
                    ],
                },
            })
        );
        expect(html).toContain('No condition beat the current triggers by a clear margin');
        expect(html).toContain('Best found: Coffee (drink)');
        expect(html).toContain('+0.01 ± 0.04 attempts');
        expect(html).toContain('Cake (food): Current setting measured best.');
    });

    test('accepted changes render as before, with no best-found line', () => {
        const html = render(
            groupWith({
                result: {
                    reliable: true,
                    changes: [donut({ deltaScore: 0.5, se: 0.1 })],
                    bestMeasured: donut({ key: 'other', itemName: 'Cake', deltaScore: 0.1 }),
                },
            })
        );
        expect(html).toContain('data-lab-trigger-change="k"');
        expect(html).not.toContain('Best found');
        expect(html).not.toContain('data-lab-trigger-best');
    });
});

describe('labTriggerLoadoutsHtml', () => {
    const mage = { key: 'loadout:3', name: 'Mage', fights: [{ monsterName: 'Cyclops', roomLevel: 120 }] };
    const configure = {
        key: 'configure:/monsters/mimic:130',
        name: 'Configure fight',
        configure: true,
        fights: [{ monsterName: 'Mimic', roomLevel: 130 }],
    };

    test('a loadout gets a tick, unless it was unticked', () => {
        expect(labTriggerLoadoutsHtml([mage], new Set())).toMatch(/data-lab-trigger-group="loadout:3"[^>]* checked/);
        expect(labTriggerLoadoutsHtml([mage], new Set(['loadout:3']))).not.toMatch(/ checked/);
    });

    test('the Configure fight is a plain label with no tick', () => {
        const html = labTriggerLoadoutsHtml([configure], new Set(['configure:/monsters/mimic:130']));
        expect(html).not.toContain('<input');
        expect(html).toContain('data-lab-trigger-configure="configure:/monsters/mimic:130"');
        expect(html).toContain('Configure fight: Mimic');
    });

    test('an empty list says why when it is told, and otherwise the default', () => {
        expect(labTriggerLoadoutsHtml([], new Set(), 'No target is ticked')).toContain('No target is ticked');
        expect(labTriggerLoadoutsHtml([], new Set())).toContain('No labyrinth fights');
    });
});

describe('summarizeLabTriggerRun', () => {
    test('counts condition changes in a loadout with no threshold changes', () => {
        const run = { groups: [{ result: { changes: [] }, conditions: { changes: [{}, {}] } }] };
        expect(summarizeLabTriggerRun(run)).toBe('2 changes found');
        expect(
            summarizeLabTriggerRun({ groups: [{ result: { noTunables: true }, conditions: { changes: [{}] } }] })
        ).toBe('1 change found');
        expect(
            summarizeLabTriggerRun({ groups: [{ result: { noTunables: true }, conditions: { changes: [] } }] })
        ).toBe('No change beat the current thresholds');
    });
});
