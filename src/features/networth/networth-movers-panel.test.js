/** @vitest-environment happy-dom */
import { describe, test, expect, afterEach, vi } from 'vitest';

const moversMock = vi.hoisted(() => ({ detailFor: vi.fn() }));

vi.mock('./networth-movers.js', () => ({ default: moversMock }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => ({ '/items/sword': { name: 'Sword' }, '/items/log': { name: 'Log' } })[hrid],
    },
}));
vi.mock('../../utils/overlay-format.js', () => ({
    itemIcon: (hrid) => {
        const node = document.createElement('span');
        node.dataset.icon = hrid;
        return node;
    },
}));

const { openMoversPanel, renderMoversResult, rowLabel, MOVERS_PANEL_ID } = await import('./networth-movers-panel.js');

const rest = {
    delta: 0,
    otherItems: 0,
    otherItemsDelta: 0,
    fixedDelta: 0,
    house: 0,
    abilities: 0,
    shrines: 0,
    excluded: 0,
    remainder: 0,
};
const pricing = {
    changed: false,
    before: { pm: 'ask', vs: 'orderBook', ic: null },
    after: { pm: 'ask', vs: 'orderBook', ic: null },
};
const change = (extra) => ({
    kind: 'h',
    hrid: '/items/sword',
    level: 0,
    delta: 100,
    countBefore: 1,
    countAfter: 1,
    unitBefore: 100,
    unitAfter: 200,
    unpricedBefore: false,
    unpricedAfter: false,
    partialBefore: false,
    partialAfter: false,
    cause: 'price',
    ...extra,
});

afterEach(() => {
    document.body.innerHTML = '';
    moversMock.detailFor.mockReset();
});

describe('renderMoversResult', () => {
    test.each([
        ['no-map', 'No item detail for this reading'],
        ['no-previous', 'first reading with item detail'],
        ['unreadable', 'could not be read'],
        ['stale', 'character changed'],
    ])('%s says what it is', (state, text) => {
        expect(renderMoversResult({ state }).textContent).toContain(text);
    });

    test('unchanged says nothing changed and lists no rows', () => {
        const node = renderMoversResult({ state: 'unchanged', since: 1000, totalDelta: 0, top: [], rest, pricing });
        expect(node.textContent).toContain('Nothing changed');
        expect(node.querySelectorAll('[data-hrid]')).toHaveLength(0);
    });

    test('rows carry icon, enhanced name, the change, the reason, and a rest row that closes the sum', () => {
        const node = renderMoversResult({
            state: 'changed',
            since: 1000,
            totalDelta: 400,
            top: [
                change({ hrid: '/items/sword', level: 12, delta: 300, cause: 'both', countBefore: 1, countAfter: 2 }),
                change({ hrid: '/items/log', kind: 's', delta: 50, cause: 'gained', countBefore: null, countAfter: 7 }),
            ],
            rest: { ...rest, delta: 50, otherItems: 2, otherItemsDelta: 30, house: 20 },
            pricing,
            truncated: false,
        });
        const text = node.textContent;
        expect(text).toContain('Sword +12');
        expect(text).toContain('Sell listing: Log');
        expect(text).toContain('Quantity: 1 to 2');
        expect(text).toContain('Price: 100 to 200 each');
        expect(text).toContain('New: 7 held, none before');
        expect(text).toContain('2 other items');
        expect(text).toContain('houses');
        expect(node.querySelector('[data-icon="/items/sword"]')).toBeTruthy();
        expect(node.querySelector('[data-rest="true"]')).toBeTruthy();
    });

    test('an unpriced row says it is not a real 0, a partial one says floor', () => {
        const node = renderMoversResult({
            state: 'changed',
            since: 1000,
            totalDelta: 50,
            top: [change({ cause: 'unpriced', unpricedBefore: true, partialAfter: true })],
            rest,
            pricing,
        });
        expect(node.textContent).toContain('Not valued in the earlier reading');
        expect(node.textContent).toContain('so it counted as 0 there. Holdings did not change.');
        expect(node.textContent).toContain('partial bill');
    });

    test('a pricing mode change between readings is said plainly', () => {
        const node = renderMoversResult({
            state: 'changed',
            since: 1000,
            totalDelta: -10,
            top: [change({ delta: -10 })],
            rest,
            pricing: {
                changed: true,
                before: { pm: 'ask', vs: 'orderBook', ic: null },
                after: { pm: 'bid', vs: 'orderBook', ic: 'vendor' },
            },
        });
        expect(node.textContent).toContain('Pricing differed between these readings (ask to bid, Iron Cow vendor');
    });

    test('rowLabel falls back to the hrid for an item the game data lacks', () => {
        expect(rowLabel({ kind: 'h', hrid: '/items/mystery', level: 0 })).toBe('mystery');
    });
});

describe('openMoversPanel', () => {
    test('opens, fills from the maps, and close removes the panel and the listener once', async () => {
        moversMock.detailFor.mockResolvedValue({ state: 'no-map' });
        const onClose = vi.fn();
        const handle = openMoversPanel({ snapshot: { t: 1000, total: 5 }, at: { x: 10, y: 10 }, onClose });
        expect(document.getElementById(MOVERS_PANEL_ID)).toBeTruthy();
        await handle.done;
        expect(handle.element.textContent).toContain('No item detail');
        handle.close();
        handle.close();
        expect(document.getElementById(MOVERS_PANEL_ID)).toBeNull();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('a panel closed before the read finishes is not redrawn', async () => {
        let resolve;
        moversMock.detailFor.mockReturnValue(new Promise((r) => (resolve = r)));
        const handle = openMoversPanel({ snapshot: { t: 1, total: 5 }, at: { x: 0, y: 0 } });
        handle.close();
        resolve({ state: 'no-map' });
        await handle.done;
        expect(document.getElementById(MOVERS_PANEL_ID)).toBeNull();
    });

    test('an outside press closes it', async () => {
        moversMock.detailFor.mockResolvedValue({ state: 'no-map' });
        const handle = openMoversPanel({ snapshot: { t: 1, total: 5 }, at: { x: 0, y: 0 } });
        await handle.done;
        await new Promise((r) => setTimeout(r, 5));
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(document.getElementById(MOVERS_PANEL_ID)).toBeNull();
    });
});
