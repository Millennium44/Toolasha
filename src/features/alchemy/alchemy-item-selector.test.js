/**
 * @vitest-environment happy-dom
 *
 * Which alchemy action the page is showing, on an English and a translated client.
 */

import { describe, test, expect, afterEach } from 'vitest';

import { activeAlchemyAction } from './alchemy-item-selector.js';

/**
 * @param {string[]} labels - Tab labels, in strip order
 * @param {number} selected - Index of the selected tab
 * @param {boolean} [inPanel=true] - Whether the strip sits in the panel's tab container
 */
function mountTabs(labels, selected, inPanel = true) {
    const tabs = labels
        .map((label, i) => `<button role="tab" aria-selected="${i === selected}">${label}</button>`)
        .join('');
    const strip = `<div role="tablist">${tabs}</div>`;
    document.body.innerHTML = inPanel ? `<div class="AlchemyPanel_tabsComponentContainer__x">${strip}</div>` : strip;
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('activeAlchemyAction', () => {
    test('reads an English strip by its labels', () => {
        mountTabs(['Coinify', 'Decompose', 'Transmute', 'Unrefine', 'Current Action'], 2, false);
        expect(activeAlchemyAction()).toBe('transmute');
    });

    test('a non-alchemy tab of an English strip is no action', () => {
        mountTabs(['Coinify', 'Decompose', 'Transmute', 'Unrefine', 'Current Action'], 4);
        expect(activeAlchemyAction()).toBe('');
    });

    test('a translated strip is read by the position of the selected tab', () => {
        const labels = ['点金', '分解', '转化', '精炼还原', '当前行动'];
        mountTabs(labels, 0);
        expect(activeAlchemyAction()).toBe('coinify');
        mountTabs(labels, 1);
        expect(activeAlchemyAction()).toBe('decompose');
        mountTabs(labels, 2);
        expect(activeAlchemyAction()).toBe('transmute');
        mountTabs(labels, 3);
        expect(activeAlchemyAction()).toBe('unrefine');
        mountTabs(labels, 4);
        expect(activeAlchemyAction()).toBe('');
    });

    test('with no alchemy strip on the page there is no action', () => {
        document.body.innerHTML = '<div role="tablist"><button role="tab" aria-selected="true">Other</button></div>';
        expect(activeAlchemyAction()).toBe('');
    });
});
