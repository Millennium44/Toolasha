/** @vitest-environment happy-dom
 *
 * The calculator's phone layout: one stylesheet, installed while a calculator is drawn, that gives
 * the block the panel's full width under the shared phone breakpoint and is gone when the
 * calculator is turned off. happy-dom does no layout, so what is asserted is the stylesheet and
 * its lifecycle, not pixels.
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// The panel prices every input through the shared enhancement input rule; here it reads the same
// mocked resolver (and, where a file has one, a craft-cost table) every other price in the file does
vi.mock('../../utils/enhancement-input-pricing.js', async () => {
    const { resolveItemPrice } = await import('../../utils/profit-helpers.js');
    const answer = (price) =>
        price > 0 ? { price, unpriced: false, estimated: false } : { price: null, unpriced: true, estimated: false };
    const via = (hrid) => answer(resolveItemPrice(hrid, { side: 'buy', enhancementLevel: 0 })?.price);
    return {
        priceMaterial: (hrid) => {
            if (hrid === '/items/coin') return answer(1);
            if (hrid?.startsWith('/items/trainee_')) return answer(250_000);
            const quoted = via(hrid);
            return quoted.unpriced ? answer({}[hrid]) : quoted;
        },
        priceGuarded: (hrid) => via(hrid),
        priceMirror: () => via('/items/philosophers_mirror'),
        priceBase: (hrid) => via(hrid),
    };
});
import * as mathjs from 'mathjs';

const state = vi.hoisted(() => ({
    settings: { enhanceSim: true, enhanceSim_autoDetect: false },
    prices: {
        '/items/cheese': 500,
        '/items/cheese_sword': 50_000,
        '/items/gouda_sword': 50_000,
        '/items/brie_sword': 50_000,
    },
    blessedTeaBonus: 0.01,
    teas: { blessed: false },
    items: {
        // Same item level, no `level` field — which is what enhanceable equipment
        // actually looks like — and a steep skill requirement beside it.
        '/items/cheese_sword': {
            hrid: '/items/cheese_sword',
            name: 'Cheese Sword',
            itemLevel: 10,
            enhancementCosts: [{ itemHrid: '/items/cheese', count: 2 }],
            equipmentDetail: { levelRequirements: [{ skillHrid: '/skills/attack', level: 70 }] },
        },
        // The same weapon with no requirement at all
        '/items/gouda_sword': {
            hrid: '/items/gouda_sword',
            name: 'Gouda Sword',
            itemLevel: 10,
            enhancementCosts: [{ itemHrid: '/items/cheese', count: 2 }],
            equipmentDetail: { levelRequirements: [] },
        },
        // Far above the enhancer's level, so the chain takes the deficit penalty
        '/items/brie_sword': {
            hrid: '/items/brie_sword',
            name: 'Brie Sword',
            itemLevel: 100,
            enhancementCosts: [{ itemHrid: '/items/cheese', count: 2 }],
            equipmentDetail: { levelRequirements: [] },
        },
        '/items/cheese': { hrid: '/items/cheese', name: 'Cheese', sellPrice: 100 },
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => Boolean(state.settings[key]),
        getSettingValue: (key, fallback) => state.settings[key] ?? fallback,
        toggleSetting: () => {},
        COLOR_XP_RATE: '#ffdd88',
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ itemDetailMap: state.items }),
        getItemDetails: (hrid) => state.items[hrid] || null,
        getActionDetails: () => ({ baseTimeCost: 12e9 }),
        getCurrentActions: () => [],
        getPersonalBuffFlatBoost: () => 0,
    },
}));
vi.mock('../../utils/enhancement-config.js', () => ({
    getEnhancingParams: () => ({
        enhancingLevel: 60,
        houseLevel: 0,
        toolBonus: 3,
        speedBonus: 0,
        experienceBonus: 20,
        rareFindBonus: 0,
        detectedTeaBonus: 0,
        guzzlingBonus: 1,
        blessedTeaBonus: state.blessedTeaBonus,
        teas: state.teas,
    }),
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { getPrice: (hrid) => ({ ask: state.prices[hrid] || -1, bid: -1 }), on: () => {} },
}));
vi.mock('../../utils/profit-helpers.js', () => ({
    calculatePriceAfterTax: (price) => price,
    resolveItemPrice: (hrid) => ({ price: state.prices[hrid] || 0, custom: false, missing: !state.prices[hrid] }),
}));
vi.mock('../../utils/tester-shop.js', () => ({
    testerShopEnabled: () => false,
    testerGearPrice: () => null,
    MIRROR_HRID: '/items/philosophers_mirror',
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    marketUndercutAlerts: () => null,
    marketDepthCap: () => null,
    guildMemberSkills: () => null,
    missingMaterialsButton: () => null,
}));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));

import { displayEnhancementStats } from './enhancement-display.js';
import { clearProtectSweepMemo } from '../../utils/enhancement-protect-sweep.js';

import { MARKET_MOBILE_QUERY } from '../market/market-mobile-layout.js';
import { ENHANCEMENT_MOBILE_STYLE_ID, releaseEnhancementMobileStyles } from './enhancement-mobile-layout.js';

const styles = () => document.querySelectorAll(`#${ENHANCEMENT_MOBILE_STYLE_ID}`);

beforeAll(() => {
    globalThis.math = mathjs;
});

beforeEach(() => {
    clearProtectSweepMemo();
    state.settings = { enhanceSim: true, enhanceSim_autoDetect: false };
    document.body.innerHTML = '';
    document.head.innerHTML = '';
});

async function draw() {
    const panel = document.createElement('div');
    panel.innerHTML =
        '<div><span>Target Level</span><input type="number" value="5"></div>' +
        '<div><span>Protect From Level</span><input type="number" value="0"></div>' +
        '<div class="protectionItemInputContainer"></div>';
    document.body.appendChild(panel);
    await displayEnhancementStats(panel, '/items/cheese_sword');
    return panel;
}

describe('the calculator on a phone', () => {
    test('drawing it installs one stylesheet, and redrawing does not add another', async () => {
        const panel = await draw();
        expect(panel.querySelector('#mwi-enhancement-stats')).toBeTruthy();
        await displayEnhancementStats(panel, '/items/cheese_sword');
        expect(styles()).toHaveLength(1);
    });

    test('the rules sit under the shared phone breakpoint and only touch a panel that holds the block', async () => {
        await draw();
        const css = styles()[0].textContent;
        expect(css).toContain(`@media ${MARKET_MOBILE_QUERY}`);
        expect(css).toContain(
            'SkillActionDetail_enhancingComponent"]:has(> #mwi-enhancement-stats) { flex-wrap: wrap; }'
        );
        expect(css).toContain('> #mwi-enhancement-stats { flex: 1 1 100%; min-width: 0; box-sizing: border-box; }');
        // Nothing outside the media block, so a wide screen is untouched
        expect(css.trim().startsWith('@media')).toBe(true);
        expect(css.trim().endsWith('}')).toBe(true);
    });

    test('turning the calculator off removes the stylesheet with the block', async () => {
        const panel = await draw();
        state.settings.enhanceSim = false;
        await displayEnhancementStats(panel, '/items/cheese_sword');
        expect(panel.querySelector('#mwi-enhancement-stats')).toBeNull();
        expect(styles()).toHaveLength(0);
    });

    test('releasing with nothing installed is harmless, and turning it back on reinstalls', async () => {
        releaseEnhancementMobileStyles();
        const panel = await draw();
        expect(styles()).toHaveLength(1);
        state.settings.enhanceSim = false;
        await displayEnhancementStats(panel, '/items/cheese_sword');
        state.settings.enhanceSim = true;
        await displayEnhancementStats(panel, '/items/cheese_sword');
        expect(styles()).toHaveLength(1);
    });
});

/** The panel as the game draws it on a phone: two columns, the drop table in the right one */
function gamePanel() {
    const panel = document.createElement('div');
    panel.className = 'SkillActionDetail_enhancingComponent__17bOx';
    panel.innerHTML =
        '<div class="SkillActionDetail_inputs__x"><span>Target Level</span><input type="number" value="5">' +
        '<span>Protect From Level</span><input type="number" value="0">' +
        '<div class="protectionItemInputContainer"></div></div>' +
        '<div class="SkillActionDetail_info__y"><div class="SkillActionDetail_essenceDrops__z">' +
        '<span>Essences</span><div class="SkillActionDetail_dropTable__3ViVp"></div></div></div>';
    document.body.appendChild(panel);
    return panel;
}

/** A controllable matchMedia: `set(width)` flips it and fires `change` on its listeners */
function stubMedia(initiallyPhone) {
    const listeners = new Set();
    const state = { phone: initiallyPhone };
    vi.stubGlobal('matchMedia', (q) => ({
        get matches() {
            return q === MARKET_MOBILE_QUERY && state.phone;
        },
        addEventListener: (type, fn) => type === 'change' && listeners.add(fn),
        removeEventListener: (type, fn) => type === 'change' && listeners.delete(fn),
    }));
    return {
        listeners,
        set(phone) {
            state.phone = phone;
            [...listeners].forEach((fn) => fn({ matches: phone }));
        },
    };
}

describe('where the calculator sits', () => {
    afterEach(() => {
        releaseEnhancementMobileStyles();
        vi.unstubAllGlobals();
    });

    test('on a phone it is the last child of the panel, not inside the right column', async () => {
        stubMedia(true);
        const panel = gamePanel();
        await displayEnhancementStats(panel, '/items/cheese_sword');
        const stats = panel.querySelector('#mwi-enhancement-stats');
        expect(stats.parentNode).toBe(panel);
        expect(panel.lastElementChild).toBe(stats);
    });

    test('on a wide screen it stays right after the drop table, as before', async () => {
        stubMedia(false);
        const panel = gamePanel();
        await displayEnhancementStats(panel, '/items/cheese_sword');
        const stats = panel.querySelector('#mwi-enhancement-stats');
        expect(stats.previousElementSibling.className).toContain('SkillActionDetail_dropTable');
        expect(stats.parentNode.className).toContain('essenceDrops');
    });

    test('crossing the breakpoint moves the existing node, both ways, without redrawing it', async () => {
        const media = stubMedia(false);
        const panel = gamePanel();
        await displayEnhancementStats(panel, '/items/cheese_sword');
        const stats = panel.querySelector('#mwi-enhancement-stats');

        media.set(true);
        expect(panel.querySelector('#mwi-enhancement-stats')).toBe(stats);
        expect(stats.parentNode).toBe(panel);

        media.set(false);
        expect(panel.querySelector('#mwi-enhancement-stats')).toBe(stats);
        expect(stats.previousElementSibling.className).toContain('SkillActionDetail_dropTable');
    });

    test('redrawing at one width keeps one node in the right place and one listener', async () => {
        const media = stubMedia(true);
        const panel = gamePanel();
        await displayEnhancementStats(panel, '/items/cheese_sword');
        await displayEnhancementStats(panel, '/items/cheese_sword');
        expect(panel.querySelectorAll('#mwi-enhancement-stats')).toHaveLength(1);
        expect(panel.lastElementChild.id).toBe('mwi-enhancement-stats');
        expect(media.listeners.size).toBe(1);
    });

    test('releasing removes the breakpoint listener, so a later resize moves nothing', async () => {
        const media = stubMedia(false);
        const panel = gamePanel();
        await displayEnhancementStats(panel, '/items/cheese_sword');
        const stats = panel.querySelector('#mwi-enhancement-stats');
        releaseEnhancementMobileStyles();
        expect(media.listeners.size).toBe(0);
        media.set(true);
        expect(stats.parentNode).not.toBe(panel);
    });
});
