import { describe, test, expect } from 'vitest';

import { renderLabTriggerResultsHtml } from './lab-trigger-view.js';

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
