/** @vitest-environment happy-dom */
/**
 * The marketplace tab row comes out in one fixed order whichever feature (or
 * other userscript) mounts first: other script, Market History, Ledger, Stale,
 * Overbid, Bulk Sell, History, pinned material tabs (in pin order), Return,
 * "x All".
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/data-manager.js', () => ({
    default: { getInventory: () => [], getItemDetails: () => ({}), on: () => {} },
}));

import { insertTabInOrder } from './marketplace-tabs.js';

let container;
let game1;
let game2;

function makeTab(label, attrs = {}) {
    const tab = document.createElement('button');
    tab.textContent = label;
    tab.setAttribute('role', 'tab');
    for (const [name, value] of Object.entries(attrs)) tab.setAttribute(name, value);
    return tab;
}

const material = (label) => makeTab(label, { 'data-mwi-custom-tab': 'true' });
const labels = () => [...container.children].map((el) => el.textContent);

beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    container.className = 'MuiTabs-flexContainer';
    container.setAttribute('role', 'tablist');
    game1 = makeTab('Market Listings', { 'aria-selected': 'true', class: 'Mui-selected' });
    game2 = makeTab('My Listings', { 'aria-selected': 'false', tabindex: '-1' });
    container.append(game1, game2);
    document.body.append(container);
});

const FULL = [
    'Market Listings',
    'My Listings',
    'Other Script',
    'Market History',
    'Ledger',
    'Stale',
    'Overbid',
    'Bulk Sell',
    'History',
    'Iron Ore',
    'Copper Ore',
    'Return',
    'x All',
];

function mountAll(order) {
    const tabs = {
        companion: [makeTab('Other Script'), 'companion'],
        mh: [makeTab('Market History'), 'market-history'],
        ledger: [makeTab('Ledger'), 'ledger'],
        stale: [makeTab('Stale'), 'stale'],
        overbid: [makeTab('Overbid'), 'overbid'],
        bulk: [makeTab('Bulk Sell'), 'bulk-sell'],
        history: [makeTab('History'), 'history'],
        iron: [material('Iron Ore'), 'material'],
        copper: [material('Copper Ore'), 'material'],
        ret: [makeTab('Return', { 'data-mwi-custom-tab': 'true' }), 'return'],
        all: [makeTab('x All', { 'data-mwi-custom-tab': 'true', 'data-mwi-clear-all-tab': 'true' }), 'close-all'],
    };
    for (const name of order) insertTabInOrder(container, tabs[name][0], tabs[name][1]);
}

describe('marketplace tab row order', () => {
    test('the in-order mount gives the full order', () => {
        mountAll(['companion', 'mh', 'ledger', 'stale', 'overbid', 'bulk', 'history', 'iron', 'copper', 'ret', 'all']);
        expect(labels()).toEqual(FULL);
    });

    test('the reverse mount gives the same order', () => {
        mountAll(['all', 'ret', 'copper', 'iron', 'history', 'bulk', 'overbid', 'stale', 'ledger', 'mh', 'companion']);
        // pin order is the arrival order, so the two materials arrive reversed
        expect(labels()).toEqual(
            FULL.map((l) => (l === 'Iron Ore' ? 'Copper Ore' : l === 'Copper Ore' ? 'Iron Ore' : l))
        );
    });

    test('another script first, then ours', () => {
        mountAll(['companion', 'ledger', 'mh', 'bulk', 'stale']);
        expect(labels()).toEqual([
            'Market Listings',
            'My Listings',
            'Other Script',
            'Market History',
            'Ledger',
            'Stale',
            'Bulk Sell',
        ]);
    });

    test('ours first, then another script lands in front of them', () => {
        mountAll(['mh', 'ledger', 'bulk', 'companion']);
        expect(labels().slice(2)).toEqual(['Other Script', 'Market History', 'Ledger', 'Bulk Sell']);
    });

    test('a keyed tab that landed after everything is settled to its slot by the next insert', () => {
        // Keyed 'companion' but sitting after everything: the next insert settles it first
        const late = makeTab('Other Script', { 'data-mwi-tab-key': 'companion' });
        mountAll(['mh', 'ledger']);
        container.append(late);
        mountAll(['stale']);
        expect(labels().slice(2)).toEqual(['Other Script', 'Market History', 'Ledger', 'Stale']);
    });

    test('pinned material tabs mounted before Market History stay in pin order and end up after it', () => {
        mountAll(['iron', 'copper', 'mh', 'ledger']);
        expect(labels().slice(2)).toEqual(['Market History', 'Ledger', 'Iron Ore', 'Copper Ore']);
    });

    test('Return and x All stay last after a later keyed insert', () => {
        mountAll(['iron', 'ret', 'all', 'stale', 'overbid', 'copper']);
        expect(labels().slice(2)).toEqual(['Stale', 'Overbid', 'Iron Ore', 'Copper Ore', 'Return', 'x All']);
    });

    test('Return comes before x All even when x All arrives first', () => {
        mountAll(['all', 'ret']);
        expect(labels().slice(2)).toEqual(['Return', 'x All']);
    });

    test('re-inserting an existing tab moves nothing', () => {
        mountAll(['companion', 'mh', 'ledger', 'iron', 'ret', 'all']);
        const before = [...container.children];
        const observer = new MutationObserver(() => {});
        observer.observe(container, { childList: true });
        for (const el of before.slice(2))
            insertTabInOrder(container, el, el.getAttribute('data-mwi-tab-key') || undefined);
        expect(observer.takeRecords()).toHaveLength(0);
        expect([...container.children]).toEqual(before);
    });

    test('duplicate keys keep their arrival order', () => {
        const a = material('A');
        const b = material('B');
        const c = material('C');
        insertTabInOrder(container, a, 'material');
        insertTabInOrder(container, b, 'material');
        insertTabInOrder(container, c, 'material');
        insertTabInOrder(container, makeTab('Ledger'), 'ledger');
        expect(labels().slice(2)).toEqual(['Ledger', 'A', 'B', 'C']);
    });

    test('re-inserting a pinned tab among its peers leaves it in its pin slot', () => {
        const a = material('A');
        const b = material('B');
        const c = material('C');
        for (const el of [a, b, c]) insertTabInOrder(container, el, 'material');
        const observer = new MutationObserver(() => {});
        observer.observe(container, { childList: true });
        insertTabInOrder(container, a, 'material');
        insertTabInOrder(container, b, 'material');
        expect(observer.takeRecords()).toHaveLength(0);
        expect(labels().slice(2)).toEqual(['A', 'B', 'C']);
    });

    test("the game's tabs never move and their selected state is untouched", () => {
        mountAll(['all', 'iron', 'mh', 'companion', 'ret', 'stale']);
        expect([...container.children].slice(0, 2)).toEqual([game1, game2]);
        expect(game1.className).toBe('Mui-selected');
        expect(game1.getAttribute('aria-selected')).toBe('true');
        expect(game2.getAttribute('aria-selected')).toBe('false');
        expect(game2.getAttribute('tabindex')).toBe('-1');
        expect(game1.hasAttribute('data-mwi-tab-key')).toBe(false);
        expect(game2.hasAttribute('data-mwi-tab-key')).toBe(false);
    });
});
