/** @vitest-environment happy-dom */
/**
 * Tests for the wider Enhancing panel. The class goes on the center column only
 * while the Enhancing panel is shown and the setting is on; fixture DOM mirrors
 * the partial class selectors the module reads.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: {},
    listeners: new Map(),
    classHandlers: new Map(),
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (id) => mocks.settings[id],
        onSettingChange: (id, cb) => mocks.listeners.set(id, cb),
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, _cls, cb) => {
            mocks.classHandlers.set(name, cb);
            return () => mocks.classHandlers.delete(name);
        },
    },
}));

const { default: feature, WIDE_CLASS } = await import('./wide-enhancing-panel.js');

const SHELL = (inner) => `
    <div class="GamePage_mainPanel__x">
        <div class="GamePage_middlePanel__y" id="center">${inner}</div>
        <div class="GamePage_chatPanel__z"></div>
    </div>`;
const ENHANCING = '<div class="SkillActionDetail_enhancingComponent__abc"></div>';
const ENHANCE_TABS = '<div><button role="tab">Enhance</button><button role="tab">Current Action</button></div>';
const FORAGING = '<div class="SkillActionDetail_regularComponent__abc"></div>';

const center = () => document.getElementById('center');
const flush = () => new Promise((r) => setTimeout(r, 150));

beforeEach(() => {
    mocks.settings = { enhancingPanel_wide: true };
    mocks.classHandlers.clear();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
});

afterEach(() => feature.disable());

describe('WideEnhancingPanel', () => {
    test('adds the class to the center column when the Enhancing panel is shown', () => {
        document.body.innerHTML = SHELL(ENHANCE_TABS + ENHANCING);
        feature.initialize();
        expect(center().classList.contains(WIDE_CLASS)).toBe(true);
        expect(document.getElementById('mwi-wide-enhancing-style')).not.toBeNull();
    });

    test('does nothing for another skill panel', () => {
        document.body.innerHTML = SHELL(FORAGING);
        feature.initialize();
        expect(document.querySelector(`.${WIDE_CLASS}`)).toBeNull();
    });

    test('does nothing when the setting is off', () => {
        mocks.settings.enhancingPanel_wide = false;
        document.body.innerHTML = SHELL(ENHANCE_TABS + ENHANCING);
        feature.initialize();
        expect(document.querySelector(`.${WIDE_CLASS}`)).toBeNull();
        expect(document.getElementById('mwi-wide-enhancing-style')).toBeNull();
    });

    test('applies when the panel mounts later', () => {
        document.body.innerHTML = SHELL(FORAGING);
        feature.initialize();
        center().innerHTML = ENHANCE_TABS + ENHANCING;
        mocks.classHandlers.get('WideEnhancingPanel')();
        expect(center().classList.contains(WIDE_CLASS)).toBe(true);
    });

    test('removes the class when the player leaves for another skill', async () => {
        document.body.innerHTML = SHELL(ENHANCE_TABS + ENHANCING);
        feature.initialize();
        center().innerHTML = FORAGING;
        await flush();
        expect(center().classList.contains(WIDE_CLASS)).toBe(false);
    });

    test('keeps the class on the Current Action tab when the component is unmounted', async () => {
        document.body.innerHTML = SHELL(ENHANCE_TABS + ENHANCING);
        feature.initialize();
        center().innerHTML = ENHANCE_TABS + '<div>Current action</div>';
        await flush();
        expect(center().classList.contains(WIDE_CLASS)).toBe(true);
    });

    test('turning the setting off removes the class and the style', () => {
        document.body.innerHTML = SHELL(ENHANCE_TABS + ENHANCING);
        feature.initialize();
        mocks.listeners.get('enhancingPanel_wide')(false);
        expect(document.querySelector(`.${WIDE_CLASS}`)).toBeNull();
        expect(document.getElementById('mwi-wide-enhancing-style')).toBeNull();
    });

    test('turning the setting on applies live', () => {
        mocks.settings.enhancingPanel_wide = false;
        document.body.innerHTML = SHELL(ENHANCE_TABS + ENHANCING);
        feature.initialize();
        mocks.settings.enhancingPanel_wide = true;
        mocks.listeners.get('enhancingPanel_wide')(true);
        expect(center().classList.contains(WIDE_CLASS)).toBe(true);
    });

    test('falls back to the main panel child when the middle panel class is absent', () => {
        document.body.innerHTML = `<div class="GamePage_mainPanel__x"><div id="center"><div>${ENHANCING}</div></div></div>`;
        feature.initialize();
        expect(center().classList.contains(WIDE_CLASS)).toBe(true);
    });
});
