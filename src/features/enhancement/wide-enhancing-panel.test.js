/** @vitest-environment happy-dom */
/**
 * Tests for the wider Enhancing panel: one stylesheet, present only while the
 * setting is on, targeting the game's EnhancingPanel_enhancingAction box.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: {},
    listeners: new Map(),
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (id) => mocks.settings[id],
        onSettingChange: (id, cb) => mocks.listeners.set(id, cb),
    },
}));

const { default: feature, STYLE_ID } = await import('./wide-enhancing-panel.js');

const style = () => document.getElementById(STYLE_ID);

beforeEach(() => {
    mocks.settings = { enhancingPanel_wide: true };
    document.head.innerHTML = '';
});

afterEach(() => feature.disable());

describe('WideEnhancingPanel', () => {
    test('injects one stylesheet when the setting is on', () => {
        feature.initialize();
        feature.initialize();
        expect(document.querySelectorAll(`#${STYLE_ID}`)).toHaveLength(1);
    });

    test('the rule targets EnhancingPanel_enhancingAction and raises its max-width', () => {
        feature.initialize();
        expect(style().textContent).toContain('[class*="EnhancingPanel_enhancingAction"]');
        expect(style().textContent).toContain('max-width: min(1400px, 92vw) !important');
    });

    test('injects nothing when the setting is off', () => {
        mocks.settings.enhancingPanel_wide = false;
        feature.initialize();
        expect(style()).toBeNull();
    });

    test('turning the setting off removes the stylesheet', () => {
        feature.initialize();
        mocks.listeners.get('enhancingPanel_wide')(false);
        expect(style()).toBeNull();
    });

    test('turning the setting on adds it live', () => {
        mocks.settings.enhancingPanel_wide = false;
        feature.initialize();
        mocks.settings.enhancingPanel_wide = true;
        mocks.listeners.get('enhancingPanel_wide')(true);
        expect(style()).not.toBeNull();
    });
});
