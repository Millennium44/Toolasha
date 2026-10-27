/** @vitest-environment happy-dom
 *
 * Panel readers that must not depend on the client's language or on which attribute carries a
 * sprite id: the Protection slot's item (an icon may carry only `xlink:href`) and the Repeat
 * field's "∞" (found by its container, not by the English word "Repeat").
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => false,
        getSettingValue: (key, fallback) => fallback,
        toggleSetting: () => {},
        COLOR_XP_RATE: '#ffdd88',
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ itemDetailMap: {} }),
        getItemDetails: () => null,
        getActionDetails: () => null,
        getCurrentActions: () => [],
        getPersonalBuffFlatBoost: () => 0,
    },
}));
vi.mock('../../utils/enhancement-config.js', () => ({ getEnhancingParams: () => ({}) }));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => null, on: () => {} } }));
vi.mock('../../utils/profit-helpers.js', () => ({ resolveItemPrice: () => ({ price: 0 }) }));
vi.mock('../../utils/enhancement-input-pricing.js', () => ({
    priceMaterial: () => ({ price: null, unpriced: true }),
    priceGuarded: () => ({ price: null, unpriced: true }),
    priceMirror: () => ({ price: null, unpriced: true }),
    priceBase: () => ({ price: null, unpriced: true }),
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

import { getProtectionItemFromUI, isRepeatUnlimitedFromUI } from './enhancement-display.js';

beforeEach(() => {
    document.body.innerHTML = '';
});

const SVG = 'http://www.w3.org/2000/svg';
const XLINK = 'http://www.w3.org/1999/xlink';

/** A Protection slot whose icon names its sprite on `attr` ('href' or 'xlink:href') only */
function panelWithProtectionIcon(attr, fragment = 'mirror_of_protection') {
    const panel = document.createElement('div');
    const slot = document.createElement('div');
    slot.className = 'SkillActionDetail_protectionItemInputContainer__x';
    const svg = document.createElementNS(SVG, 'svg');
    const use = document.createElementNS(SVG, 'use');
    const value = `/static/media/items_sprite.abc123.svg#${fragment}`;
    if (attr === 'xlink:href') use.setAttributeNS(XLINK, 'xlink:href', value);
    else use.setAttribute('href', value);
    svg.appendChild(use);
    slot.appendChild(svg);
    panel.appendChild(slot);
    document.body.appendChild(panel);
    return panel;
}

describe('getProtectionItemFromUI', () => {
    test('reads an icon that names its sprite on href', () => {
        expect(getProtectionItemFromUI(panelWithProtectionIcon('href'))).toBe('/items/mirror_of_protection');
    });

    test('reads an icon that carries only xlink:href', () => {
        expect(getProtectionItemFromUI(panelWithProtectionIcon('xlink:href', 'cheese_sword'))).toBe(
            '/items/cheese_sword'
        );
    });

    test('an empty slot reads as no protection item', () => {
        const panel = document.createElement('div');
        panel.innerHTML = '<div class="SkillActionDetail_protectionItemInputContainer__x"></div>';
        document.body.appendChild(panel);
        expect(getProtectionItemFromUI(panel)).toBeNull();
    });
});

describe('isRepeatUnlimitedFromUI', () => {
    function repeatPanel(label, value) {
        const panel = document.createElement('div');
        panel.innerHTML =
            `<div class="SkillActionDetail_maxActionCountInput__x"><span>${label}</span>` +
            `<input type="text" value="${value}"></div>`;
        document.body.appendChild(panel);
        return panel;
    }

    test('reads the infinity sign in the English client', () => {
        expect(isRepeatUnlimitedFromUI(repeatPanel('Repeat', '∞'))).toBe(true);
        expect(isRepeatUnlimitedFromUI(repeatPanel('Repeat', '5'))).toBe(false);
    });

    test('reads it in a client whose label is not "Repeat"', () => {
        expect(isRepeatUnlimitedFromUI(repeatPanel('重复', '∞'))).toBe(true);
        expect(isRepeatUnlimitedFromUI(repeatPanel('重复', '5'))).toBe(false);
    });
});
