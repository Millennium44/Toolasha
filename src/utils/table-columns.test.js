/** @vitest-environment happy-dom */
/**
 * Tests for shared table column utilities
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { fNum, rankBadge, sortIcon, makeColumnSortable, addColumn } from './table-columns.js';

describe('fNum', () => {
    test('rounds and formats with thousands separators', () => {
        expect(fNum(1234.6)).toBe('1,235');
        expect(fNum(999)).toBe('999');
    });
});

describe('rankBadge', () => {
    test('returns a medal for the top 3 ranks', () => {
        expect(rankBadge(1)).toBe('&#x1F947;');
        expect(rankBadge(2)).toBe('&#x1F948;');
        expect(rankBadge(3)).toBe('&#x1F949;');
    });

    test('returns a numbered badge for rank 4 and beyond', () => {
        expect(rankBadge(4)).toContain('#4');
        expect(rankBadge(4)).not.toContain('&#x1F94');
    });
});

describe('sortIcon', () => {
    test('highlights the active direction', () => {
        expect(sortIcon('asc')).toContain('▲');
        expect(sortIcon('desc')).toContain('▼');
        expect(sortIcon('none')).toContain('△');
        expect(sortIcon('none')).toContain('▽');
    });
});

function buildTable(rows) {
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const th1 = document.createElement('th');
    th1.textContent = 'Name';
    const th2 = document.createElement('th');
    th2.textContent = 'Value';
    headRow.append(th1, th2);
    thead.appendChild(headRow);

    const tbody = document.createElement('tbody');
    for (const row of rows) {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td');
        td1.textContent = row.name;
        const td2 = document.createElement('td');
        td2.textContent = String(row.value);
        tr.append(td1, td2);
        tbody.appendChild(tr);
    }

    table.append(thead, tbody);
    document.body.appendChild(table);
    return { table, th2 };
}

describe('makeColumnSortable', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    test('sorts rows descending on first click using numeric cell content', () => {
        const { table, th2 } = buildTable([
            { name: 'a', value: 5 },
            { name: 'b', value: 20 },
            { name: 'c', value: 1 },
        ]);
        makeColumnSortable(th2, { sortId: 'value', valueGetter: (tr) => parseFloat(tr.children[1].textContent) });

        th2.click();

        const names = Array.from(table.querySelector('tbody').children).map((tr) => tr.children[0].textContent);
        expect(names).toEqual(['b', 'a', 'c']); // 20, 5, 1 descending
    });

    test('clicking the same column again reverses the sort direction', () => {
        const { table, th2 } = buildTable([
            { name: 'a', value: 5 },
            { name: 'b', value: 20 },
            { name: 'c', value: 1 },
        ]);
        makeColumnSortable(th2, { sortId: 'value', valueGetter: (tr) => parseFloat(tr.children[1].textContent) });

        th2.click(); // desc: b, a, c
        th2.click(); // asc: c, a, b

        const names = Array.from(table.querySelector('tbody').children).map((tr) => tr.children[0].textContent);
        expect(names).toEqual(['c', 'a', 'b']);
    });

    test('Infinity values always sort to the end regardless of direction', () => {
        const { table, th2 } = buildTable([
            { name: 'finite', value: 5 },
            { name: 'infinite', value: 'Infinity' },
        ]);
        makeColumnSortable(th2, {
            sortId: 'value',
            valueGetter: (tr) =>
                tr.children[1].textContent === 'Infinity' ? Infinity : parseFloat(tr.children[1].textContent),
        });

        th2.click();
        let names = Array.from(table.querySelector('tbody').children).map((tr) => tr.children[0].textContent);
        expect(names[names.length - 1]).toBe('infinite');

        th2.click();
        names = Array.from(table.querySelector('tbody').children).map((tr) => tr.children[0].textContent);
        expect(names[names.length - 1]).toBe('infinite');
    });

    test('does nothing when the header has no enclosing table', () => {
        const th = document.createElement('th');
        expect(() => makeColumnSortable(th, { sortId: 'x', valueGetter: () => 0 })).not.toThrow();
    });
});

describe('addColumn', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    test('inserts a header and formatted cells for each row', () => {
        const { table } = buildTable([
            { name: 'a', value: 5 },
            { name: 'b', value: 10 },
        ]);
        addColumn(table, 'mwi-col', {
            name: 'Profit',
            data: [1234, 5678],
        });

        const headerCells = table.querySelectorAll('thead th');
        expect(headerCells[headerCells.length - 1].textContent).toBe('Profit');

        const firstRowCells = table.querySelectorAll('tbody tr')[0].querySelectorAll('td');
        expect(firstRowCells[firstRowCells.length - 1].textContent).toBe('1,234');
    });

    test('does not insert the same column twice', () => {
        const { table } = buildTable([{ name: 'a', value: 5 }]);
        addColumn(table, 'mwi-col', { name: 'Profit', data: [100] });
        addColumn(table, 'mwi-col', { name: 'Profit', data: [200] });

        const matching = table.querySelectorAll('th.mwi-col[data-name="Profit"]');
        expect(matching).toHaveLength(1);
    });

    test('uses a custom format function when provided', () => {
        const { table } = buildTable([{ name: 'a', value: 5 }]);
        addColumn(table, 'mwi-col', {
            name: 'Custom',
            data: ['x'],
            format: (value) => `<b>${value}</b>`,
        });
        const cell = table.querySelector('tbody tr td:last-child');
        expect(cell.innerHTML).toBe('<b>x</b>');
    });

    test('renders empty string for null/undefined/NaN values', () => {
        const { table } = buildTable([
            { name: 'a', value: 5 },
            { name: 'b', value: 6 },
        ]);
        addColumn(table, 'mwi-col', { name: 'Sparse', data: [null, NaN] });
        const cells = table.querySelectorAll('tbody tr td:last-child');
        expect(cells[0].textContent).toBe('');
        expect(cells[1].textContent).toBe('');
    });
});
