/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    FOLD_ATTR,
    FOLD_TOGGLE_ID,
    removeMarketFold,
    resetMarketFoldState,
    syncMarketFold,
} from './market-filter-fold.js';

const STYLE_ID = 'mwi-market-mobile-layout';
let phone = true;

beforeEach(() => {
    phone = true;
    vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: phone }));
    resetMarketFoldState();
});

afterEach(() => {
    removeMarketFold();
    document.body.textContent = '';
    vi.restoreAllMocks();
});

const toggle = () => document.getElementById(FOLD_TOGGLE_ID);

/** The game's filter container, plus whichever of Toolasha's two rows are asked for, as siblings */
function panel({ sort = true, filters = true, sortMode = 'profit', min = '1', slot = 'all' } = {}) {
    document.body.textContent = '';
    const parent = document.createElement('div');
    const container = document.createElement('div');
    container.className = 'MarketplacePanel_itemFilterContainer__a';
    container.innerHTML = '<input type="text" />';
    parent.append(container);
    if (sort) {
        const row = document.createElement('div');
        row.id = 'toolasha-market-sort';
        row.innerHTML = `<select id="toolasha-market-sort-mode">
            <option value="profit">Profit</option><option value="alchemyProfit">Alchemy profit</option></select>`;
        row.querySelector('select').value = sortMode;
        parent.append(row);
    }
    if (filters) {
        const row = document.createElement('div');
        row.id = 'toolasha-market-filters';
        row.innerHTML = `<select id="toolasha-level-min"><option value="1">1</option><option value="50">50</option></select>
            <select id="toolasha-level-max"><option value="1000">All</option><option value="10">10</option></select>
            <select id="toolasha-class-filter"><option value="all">All</option><option value="melee">Melee</option></select>
            <select id="toolasha-slot-filter"><option value="all">All</option><option value="head">Head</option></select>`;
        row.querySelector('#toolasha-level-min').value = min;
        row.querySelector('#toolasha-slot-filter').value = slot;
        parent.append(row);
    }
    document.body.append(parent);
    return { parent, container };
}

describe('phone fold for the market filter rows', () => {
    test('builds one small toggle inside the filter container, collapsed, and moves nothing', () => {
        const { parent, container } = panel();
        const before = Array.from(parent.children);
        syncMarketFold(container);
        expect(toggle().parentElement).toBe(container);
        expect(container.getAttribute(FOLD_ATTR)).toBe('closed');
        expect(toggle().textContent).toBe('Filters ▾');
        expect(toggle().getAttribute('aria-expanded')).toBe('false');
        expect(Array.from(parent.children)).toEqual(before);
        expect(parent.querySelector('#toolasha-market-sort').style.display).toBe('');
    });

    test('hiding is a rule inside the phone media query and needs the toggle to be present', () => {
        syncMarketFold(panel().container);
        const css = document.getElementById(STYLE_ID).textContent;
        const media = css.indexOf('@media (max-width: 768px)');
        const hide = css.indexOf(
            '[data-mwi-market-fold="closed"]:has(> #mwi-market-filters-toggle) ~ #toolasha-market-sort'
        );
        expect(hide).toBeGreaterThan(media);
        expect(css.slice(0, media)).toContain('#mwi-market-filters-toggle { display: none; }');
        expect(css.slice(0, media)).not.toContain('data-mwi-market-fold');
    });

    test('tapping opens and closes, and the state survives the panel being drawn again', () => {
        let { container } = panel();
        syncMarketFold(container);
        toggle().click();
        expect(container.getAttribute(FOLD_ATTR)).toBe('open');
        expect(toggle().textContent).toBe('Filters ▴');
        ({ container } = panel());
        syncMarketFold(container);
        expect(container.getAttribute(FOLD_ATTR)).toBe('open');
        toggle().click();
        expect(container.getAttribute(FOLD_ATTR)).toBe('closed');
    });

    test('a fresh page starts collapsed', () => {
        const { container } = panel();
        syncMarketFold(container);
        expect(container.getAttribute(FOLD_ATTR)).toBe('closed');
    });

    test.each([
        ['a sort mode other than the default', { sortMode: 'alchemyProfit' }],
        ['a minimum level', { min: '50' }],
        ['a slot', { slot: 'head' }],
    ])('%s shows a bullet on the collapsed button', (_name, options) => {
        const { container } = panel(options);
        syncMarketFold(container);
        expect(toggle().textContent).toBe('Filters • ▾');
        expect(toggle().hasAttribute('data-active')).toBe(true);
    });

    test('nothing off its default shows no bullet', () => {
        syncMarketFold(panel().container);
        expect(toggle().textContent).not.toContain('•');
    });

    test('changing a control updates the bullet, with or without the event bubbling', () => {
        const { container } = panel();
        syncMarketFold(container);
        const select = document.getElementById('toolasha-class-filter');
        select.value = 'melee';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        expect(toggle().textContent).toContain('•');
        select.value = 'all';
        select.dispatchEvent(new Event('change'));
        expect(toggle().textContent).not.toContain('•');
    });

    test('works with either row alone, in either injection order', () => {
        const { container, parent } = panel({ filters: false });
        syncMarketFold(container);
        expect(toggle()).not.toBeNull();
        const row = document.createElement('div');
        row.id = 'toolasha-market-filters';
        parent.insertBefore(row, container.nextSibling);
        syncMarketFold(container);
        expect(document.querySelectorAll(`#${FOLD_TOGGLE_ID}`)).toHaveLength(1);
        const alone = panel({ sort: false });
        syncMarketFold(alone.container);
        expect(document.querySelectorAll(`#${FOLD_TOGGLE_ID}`)).toHaveLength(1);
    });

    test('a toggle the game dropped is rebuilt and a replaced container leaves no stray toggle', () => {
        const { container } = panel();
        syncMarketFold(container);
        toggle().remove();
        syncMarketFold(container);
        expect(toggle().parentElement).toBe(container);
        const old = container;
        const next = panel().container;
        document.body.append(old);
        syncMarketFold(next);
        expect(document.querySelectorAll(`#${FOLD_TOGGLE_ID}`)).toHaveLength(1);
        expect(toggle().parentElement).toBe(next);
    });

    test('with neither row there is no toggle, attribute or style', () => {
        const { container } = panel({ sort: false, filters: false });
        syncMarketFold(container);
        expect(toggle()).toBeNull();
        expect(container.hasAttribute(FOLD_ATTR)).toBe(false);
        expect(document.getElementById(STYLE_ID)).toBeNull();
    });

    test('above the phone breakpoint nothing is built', () => {
        phone = false;
        const { container } = panel();
        syncMarketFold(container);
        expect(toggle()).toBeNull();
        expect(container.hasAttribute(FOLD_ATTR)).toBe(false);
    });

    test('without matchMedia nothing is built', () => {
        const saved = window.matchMedia;
        delete window.matchMedia;
        try {
            const { container } = panel();
            syncMarketFold(container);
            expect(toggle()).toBeNull();
        } finally {
            window.matchMedia = saved;
        }
    });

    test('removing the last row takes the toggle, attribute and rules away and leaves the rows alone', () => {
        const { container, parent } = panel({ sortMode: 'alchemyProfit' });
        syncMarketFold(container);
        const sort = parent.querySelector('#toolasha-market-sort');
        const rows = parent.querySelector('#toolasha-market-filters');
        sort.remove();
        syncMarketFold();
        expect(toggle()).not.toBeNull();
        rows.remove();
        syncMarketFold();
        expect(toggle()).toBeNull();
        expect(document.querySelector(`[${FOLD_ATTR}]`)).toBeNull();
        expect(document.getElementById(STYLE_ID)).toBeNull();
        expect(sort.style.display).toBe('');
    });

    test('after the fold is removed a change event repaints nothing', () => {
        const { container, parent } = panel();
        syncMarketFold(container);
        removeMarketFold();
        const select = document.getElementById('toolasha-class-filter');
        select.value = 'melee';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        expect(toggle()).toBeNull();
        expect(parent.querySelector('#toolasha-market-sort')).not.toBeNull();
        syncMarketFold(container);
        expect(toggle().textContent).toContain('•');
    });
});
