/** @vitest-environment happy-dom */

/**
 * The Arbitrage and Craft & Enhance buttons find their skill page by the title's skill icon sprite first, so a
 * game running in Chinese (title text "锻造", sprite unchanged) still gets them. English text stays the fallback.
 */
import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (_k, f) => f, setSettingValue: () => {} },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            skillDetailMap: {
                '/skills/cheesesmithing': {},
                '/skills/crafting': {},
                '/skills/tailoring': {},
                '/skills/cooking': {},
                '/skills/brewing': {},
                '/skills/foraging': {},
            },
        }),
    },
}));
vi.mock('./craft-enhance.js', () => ({
    CRAFT_ENHANCE_SETTING: 'actions_craftEnhance',
    TARGET_LEVEL_SETTING: 't',
    OWNED_MODE_SETTING: 'o',
    clearCraftEnhanceCache: () => {},
    craftEnhanceAvailable: () => true,
    craftEnhanceStateKey: () => 'k',
    rankCraftEnhance: async () => [],
}));
vi.mock('./production-arbitrage.js', async () => {
    const actual = await vi.importActual('./production-arbitrage.js');
    return {
        PRODUCTION_SKILLS: actual.PRODUCTION_SKILLS,
        arrangeRows: actual.arrangeRows,
        rankProductionArbitrage: async () => [],
        clearProductionArbitrageCache: () => {},
    };
});

const { default: craftBoard, OPEN_BUTTON_CLASS: CRAFT_CLASS } = await import('./craft-enhance-board.js');
const { default: arbitrageBoard, OPEN_BUTTON_CLASS: ARB_CLASS } = await import('./production-arbitrage-board.js');

/** A skill page title: the skill's icon sprite plus a name in whatever language the client runs */
function title(sprite, name) {
    const el = document.createElement('div');
    el.className = 'GatheringProductionSkillPanel_title__x';
    el.innerHTML =
        (sprite ? `<svg><use href="/static/media/skills_sprite.abc123.svg#${sprite}"></use></svg>` : '') +
        `<div>${name}</div>`;
    document.body.appendChild(el);
    return el;
}

describe('skill page title buttons, by icon first', () => {
    test('Chinese title text with a matching skill icon still gets both buttons', () => {
        const t = title('cheesesmithing', '奶酪锻造');
        craftBoard.injectOpenButton(t);
        arbitrageBoard.injectOpenButton(t);
        expect(t.querySelector(`.${CRAFT_CLASS}`)).not.toBeNull();
        expect(t.querySelector(`.${ARB_CLASS}`)).not.toBeNull();
    });

    test('the icon decides over the text: a non-gear skill gets no Craft & Enhance button', () => {
        const t = title('cooking', '烹饪');
        craftBoard.injectOpenButton(t);
        arbitrageBoard.injectOpenButton(t);
        expect(t.querySelector(`.${CRAFT_CLASS}`)).toBeNull();
        expect(t.querySelector(`.${ARB_CLASS}`)).not.toBeNull();
    });

    test('a non-production skill icon gets neither button', () => {
        const t = title('foraging', '采集');
        craftBoard.injectOpenButton(t);
        arbitrageBoard.injectOpenButton(t);
        expect(t.querySelector(`.${CRAFT_CLASS}`)).toBeNull();
        expect(t.querySelector(`.${ARB_CLASS}`)).toBeNull();
    });

    test('English names without an icon still work (fallback)', () => {
        const t = title(null, 'Tailoring');
        craftBoard.injectOpenButton(t);
        arbitrageBoard.injectOpenButton(t);
        expect(t.querySelector(`.${CRAFT_CLASS}`)).not.toBeNull();
        expect(t.querySelector(`.${ARB_CLASS}`)).not.toBeNull();
        const other = title(null, 'Foraging');
        craftBoard.injectOpenButton(other);
        arbitrageBoard.injectOpenButton(other);
        expect(other.querySelector(`.${CRAFT_CLASS}, .${ARB_CLASS}`)).toBeNull();
    });
});
