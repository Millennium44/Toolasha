/**
 * @vitest-environment happy-dom
 *
 * Task Reroll Protection — the config popup fits a phone-width screen.
 *
 * It was a bare `width: 400px` (404px with the border) centered by
 * translate(-50%), which put the left edge off-screen on a phone (-22px at
 * 360px wide), where nothing scrolls to it. happy-dom does no layout, so this
 * pins the declaration; the fit was measured in Firefox, Chromium and WebKit at
 * 360 and 390px wide, and 1280px unchanged.
 */

import { test, expect, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char1',
        getInitClientData: () => ({ actionDetailMap: {}, itemDetailMap: {} }),
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {}, onReady: () => () => {} },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('./task-card-state.js', () => ({
    isCardInConfirmState: () => false,
    armConfirmSettleWatch: () => {},
    onConfirmFlowSettled: () => () => {},
}));
vi.mock('./task-reroll-options.js', () => ({ findRerollOptions: () => [] }));
vi.mock('./task-card-quest.js', () => ({ questForTaskCard: () => null }));
vi.mock('../../utils/character-key.js', () => ({
    characterKey: (base) => `${base}_char`,
    readScopedFrom: async (_base, _map, _store, fallback) => fallback,
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async () => [],
        getMany: async (keys) => new Map(keys.map((key) => [key, null])),
        setJSON: async () => {},
        set: async () => {},
    },
}));

const { default: taskRerollProtection } = await import('./task-reroll-protection.js');

test('the config popup is never wider than the viewport less a gutter', () => {
    taskRerollProtection.openConfigPopup();

    const popup = document.getElementById('mwi-task-protection-popup');
    expect(popup.style.width).toBe('400px');
    expect(popup.style.maxWidth).toBe('calc(100vw - 20px)');
    popup.remove();
});
