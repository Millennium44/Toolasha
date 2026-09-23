/** @vitest-environment happy-dom */
/**
 * The machinery the three alchemy history viewers share underneath their
 * "Totals by Input Item" tables: grouping filtered sessions by input item,
 * pooling groups the game data says are the same bet, and the table chrome.
 *
 * Nothing here knows what a transmute or a decompose is — that is the point.
 * The columns stay with the viewer that understands them; only the parts that
 * would otherwise have been copy-pasted three times live here.
 */

import { describe, test, expect } from 'vitest';
import {
    HISTORY_TYPE_SCALE,
    breakEvenBound,
    createTotalsCell,
    groupSessionsByInputItem,
    poolEquivalentGroups,
    renderTotalsSection,
    totalsRowStyle,
} from './history-totals-table.js';

const NAMES = { '/items/a': 'Zinc', '/items/b': 'Apple', '/items/c': 'Mango' };
const nameOf = (hrid) => NAMES[hrid] ?? hrid;

/**
 * The simplest possible group shape: one counter, so the test is about the
 * grouping and not about anyone's economics.
 */
function simpleHandlers() {
    return {
        getDetail: (session) => ({ value: session.value }),
        getSortName: nameOf,
        createGroup: (hrid) => ({ inputItemHrid: hrid, sessionCount: 0, total: 0 }),
        accumulate: (group, _session, detail) => {
            group.sessionCount++;
            group.total += detail.value;
        },
    };
}

describe('groupSessionsByInputItem', () => {
    test('folds sessions of the same input item into one group', () => {
        const groups = groupSessionsByInputItem(
            [
                { id: '1', inputItemHrid: '/items/a', value: 10 },
                { id: '2', inputItemHrid: '/items/a', value: 5 },
                { id: '3', inputItemHrid: '/items/b', value: 7 },
            ],
            simpleHandlers()
        );

        expect(groups).toHaveLength(2);
        const zinc = groups.find((g) => g.inputItemHrid === '/items/a');
        expect(zinc.sessionCount).toBe(2);
        expect(zinc.total).toBe(15);
    });

    test('orders groups by display name, not by hrid or arrival', () => {
        const groups = groupSessionsByInputItem(
            [
                { id: '1', inputItemHrid: '/items/a', value: 1 },
                { id: '2', inputItemHrid: '/items/b', value: 1 },
                { id: '3', inputItemHrid: '/items/c', value: 1 },
            ],
            simpleHandlers()
        );

        expect(groups.map((g) => nameOf(g.inputItemHrid))).toEqual(['Apple', 'Mango', 'Zinc']);
    });

    test('runs finalize once per group, after every session is folded in', () => {
        const groups = groupSessionsByInputItem(
            [
                { id: '1', inputItemHrid: '/items/a', value: 10 },
                { id: '2', inputItemHrid: '/items/a', value: 30 },
            ],
            { ...simpleHandlers(), finalize: (group) => ({ ...group, mean: group.total / group.sessionCount }) }
        );

        expect(groups[0].mean).toBe(20);
    });

    test('no sessions produces no groups rather than an empty placeholder', () => {
        expect(groupSessionsByInputItem([], simpleHandlers())).toEqual([]);
    });
});

describe('poolEquivalentGroups', () => {
    const buildPooled = (members) => ({
        pooled: true,
        memberHrids: members.map((m) => m.inputItemHrid).sort((a, b) => nameOf(a).localeCompare(nameOf(b))),
        total: members.reduce((sum, m) => sum + m.total, 0),
    });

    test('pools groups that share a key and leaves the per-item groups untouched', () => {
        const totals = [
            { inputItemHrid: '/items/a', total: 1 },
            { inputItemHrid: '/items/b', total: 2 },
            { inputItemHrid: '/items/c', total: 4 },
        ];

        const pooled = poolEquivalentGroups(totals, {
            getKey: (hrid) => (hrid === '/items/c' ? 'other' : 'same'),
            buildPooled,
            getSortName: nameOf,
        });

        expect(pooled).toHaveLength(1);
        expect(pooled[0].total).toBe(3);
        // The per-item groups are the caller's array and must come back unchanged
        expect(totals).toHaveLength(3);
    });

    test('a set of one pools nothing — that is just the per-item row relabelled', () => {
        const pooled = poolEquivalentGroups([{ inputItemHrid: '/items/a', total: 1 }], {
            getKey: () => 'same',
            buildPooled,
            getSortName: nameOf,
        });

        expect(pooled).toEqual([]);
    });

    test('an item the key function cannot classify pools with nothing', () => {
        const pooled = poolEquivalentGroups(
            [
                { inputItemHrid: '/items/a', total: 1 },
                { inputItemHrid: '/items/b', total: 2 },
            ],
            { getKey: () => null, buildPooled, getSortName: nameOf }
        );

        expect(pooled).toEqual([]);
    });
});

describe('renderTotalsSection', () => {
    const columns = [{ label: 'Input Item' }, { label: 'Net', title: 'What is left over' }];

    function buildRow(text) {
        const row = document.createElement('tr');
        row.appendChild(createTotalsCell(text));
        return row;
    }

    test('draws heading, header cells with their tooltips, rows and legend', () => {
        const container = document.createElement('div');

        renderTotalsSection(container, {
            heading: 'Totals by Input Item',
            columns,
            rows: [buildRow('Apple'), buildRow('Mango')],
            legendParts: ['* input unpriced — total is incomplete'],
        });

        expect(container.textContent).toContain('Totals by Input Item');
        const headers = Array.from(container.querySelectorAll('thead th'));
        expect(headers.map((th) => th.textContent)).toEqual(['Input Item', 'Net']);
        expect(headers[1].title).toBe('What is left over');
        expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
        expect(container.textContent).toContain('input unpriced');
    });

    test('no rows draws nothing at all — an empty table is worse than no table', () => {
        const container = document.createElement('div');
        container.textContent = 'stale';

        renderTotalsSection(container, { heading: 'Totals', columns, rows: [] });

        expect(container.textContent).toBe('');
    });

    test('a missing container is survivable — a partial modal must not throw', () => {
        expect(() =>
            renderTotalsSection(null, { heading: 'Totals', columns, rows: [buildRow('Apple')] })
        ).not.toThrow();
    });

    test('table text and legend sit on the shared type scale', () => {
        const container = document.createElement('div');

        renderTotalsSection(container, {
            heading: 'Totals',
            columns,
            rows: [buildRow('Apple')],
            legendParts: ['* input unpriced'],
        });

        expect(container.querySelector('table').style.fontSize).toBe(HISTORY_TYPE_SCALE.body);
        expect(container.firstChild.style.fontSize).toBe(HISTORY_TYPE_SCALE.heading);
        expect(container.lastChild.style.fontSize).toBe(HISTORY_TYPE_SCALE.note);
    });
});

describe('totalsRowStyle', () => {
    test('stripes ordinary rows', () => {
        expect(totalsRowStyle(0)).toContain('#2a2a2a');
        expect(totalsRowStyle(1)).toContain('#252525');
    });

    test('a pooled row is tinted and ruled off from the rows it summarizes', () => {
        const style = totalsRowStyle(0, { pooled: true });
        expect(style).toContain('rgba(74,144,226,0.08)');
        expect(style).toContain('border-top: 1px dashed');
    });

    test('a flagged row wins over the pooled tint — the warning must not be lost', () => {
        expect(totalsRowStyle(0, { pooled: true, flagged: true })).toContain('rgba(251,191,36,0.08)');
    });
});

describe('breakEvenBound', () => {
    test('complete data carries no prefix', () => {
        expect(breakEvenBound({ revenueUnpriced: false, catalystUnpricedSessions: 0 })).toEqual({
            prefix: '',
            noBound: false,
            title: undefined,
        });
    });

    test('an unpriced output makes the figure a lower bound', () => {
        expect(breakEvenBound({ revenueUnpriced: true }).prefix).toBe('≥');
    });

    test('an unpriced or unrecorded catalyst makes it an upper bound', () => {
        expect(breakEvenBound({ catalystUnpricedSessions: 1 }).prefix).toBe('≤');
        expect(breakEvenBound({ catalystUnrecordedSessions: 2 }).prefix).toBe('≤');
    });

    test('both together leave no bound', () => {
        const bound = breakEvenBound({ revenueUnpriced: true, catalystUnrecordedSessions: 1 });
        expect(bound.noBound).toBe(true);
        expect(bound.title).toContain('no bound');
    });
});

describe('renderTotalsSection with no rows', () => {
    test('draws nothing without an empty text', () => {
        const container = document.createElement('div');
        expect(renderTotalsSection(container, { heading: 'T', columns: [], rows: [] })).toBeNull();
        expect(container.childNodes).toHaveLength(0);
    });

    test('keeps the heading, the controls and an empty line when given an empty text', () => {
        const container = document.createElement('div');
        const controls = document.createElement('label');
        controls.textContent = 'toggle';
        renderTotalsSection(container, { heading: 'T', columns: [], rows: [], controls, emptyText: 'nothing' });
        expect(container.textContent).toBe('Ttogglenothing');
        expect(container.querySelector('table')).toBeNull();
    });
});
