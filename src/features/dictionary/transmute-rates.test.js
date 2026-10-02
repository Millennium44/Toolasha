/** @vitest-environment happy-dom */
/**
 * Transmute Rates — the rate pill drawn on each "Transmuted From" row of the Item Dictionary.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({ clientData: null, onClass: null }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        onSettingChange: () => {},
        COLOR_TRANSMUTE: '#0f0',
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (_name, _class, cb) => {
            state.onClass = cb;
            return () => {};
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => state.clientData },
}));

const { default: transmuteRates } = await import('./transmute-rates.js');
const { getTimerRegistryCensus } = await import('../../utils/timer-registry.js');

/**
 * @param {Object} itemDetailMap
 * @returns {Object} init_client_data stand-in
 */
function clientData(itemDetailMap) {
    return { itemDetailMap };
}

const SOURCE = {
    name: 'Cheese',
    alchemyDetail: { transmuteSuccessRate: 0.5, transmuteDropTable: [{ itemHrid: '/items/milk', dropRate: 0.2 }] },
};

/**
 * @param {string} targetName - Dictionary title
 * @param {string} sourceName - Source row name
 * @returns {HTMLElement} the section
 */
function dictionary(targetName, sourceName) {
    document.body.innerHTML = `<h1 class="ItemDictionary_title__x">${targetName}</h1>
        <div class="ItemDictionary_transmutedFrom__y"><div class="ItemDictionary_item__z"><div class="Item_name__n">${sourceName}</div></div></div>`;
    return document.querySelector('[class*="ItemDictionary_transmutedFrom"]');
}

beforeEach(() => {
    vi.useFakeTimers();
    transmuteRates.initialize();
});

afterEach(() => {
    transmuteRates.disable();
    vi.useRealTimers();
});

describe('injectRates', () => {
    test('draws the total probability on a matching source row', () => {
        state.clientData = clientData({
            '/items/milk': { name: 'Milk' },
            '/items/cheese': SOURCE,
        });
        transmuteRates.injectRates(dictionary('Milk', 'Cheese'));
        expect(document.querySelector('.mwi-transmute-rate').textContent).toContain('10.0%');
    });

    test('reads the current game data rather than a name table built from an older one', () => {
        state.clientData = clientData({ '/items/milk': { name: 'Milk' }, '/items/cheese': SOURCE });
        transmuteRates.injectRates(dictionary('Milk', 'Cheese'));

        // A later init_client_data introduces an item the first one did not have
        state.clientData = clientData({
            '/items/milk': { name: 'Milk' },
            '/items/cheese': SOURCE,
            '/items/yak_cheese': { ...SOURCE, name: 'Yak Cheese' },
        });
        transmuteRates.injectRates(dictionary('Milk', 'Yak Cheese'));
        expect(document.querySelector('.mwi-transmute-rate')).not.toBeNull();
    });
});

describe('timers', () => {
    test('rows arriving in a burst do not accumulate timer registrations', () => {
        state.clientData = clientData({ '/items/milk': { name: 'Milk' }, '/items/cheese': SOURCE });
        const section = dictionary('Milk', 'Cheese');
        const before = getTimerRegistryCensus().timeouts;
        for (let i = 0; i < 20; i++) state.onClass(section.firstElementChild);
        vi.advanceTimersByTime(100);
        expect(getTimerRegistryCensus().timeouts).toBe(before);
    });
});
