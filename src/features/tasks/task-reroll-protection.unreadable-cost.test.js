/** @vitest-environment happy-dom */
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => 'alice' } }));
vi.mock('../../core/dom-observer.js', () => ({ default: {} }));
vi.mock('../../core/websocket.js', () => ({ default: {} }));
vi.mock('./task-card-state.js', () => ({
    isCardInConfirmState: () => false,
    armConfirmSettleWatch: () => {},
    onConfirmFlowSettled: () => () => {},
}));
vi.mock('./task-reroll-options.js', () => ({ findRerollOptions: () => [] }));
vi.mock('./task-card-quest.js', () => ({ questForTaskCard: () => null }));
import feature from './task-reroll-protection.js';

const protection = feature.protection;

beforeEach(() => {
    protection.coinThreshold = 80000;
    protection.cowbellThreshold = 8;
});

test('a price the button does not state is read off the quest ladder', () => {
    // 3 coin rerolls spent: the next is 80K, at an 80K cap
    expect(protection._isRerollAtCap({ kind: 'coin', cost: null }, { coinRerollCount: 3 })).toBe(true);
    expect(protection._isRerollAtCap({ kind: 'coin', cost: null }, { coinRerollCount: 2 })).toBe(false);
    expect(protection._isRerollAtCap({ kind: 'cowbell', cost: null }, { cowbellRerollCount: 3 })).toBe(true);
    expect(protection._isRerollAtCap({ kind: 'cowbell', cost: null }, { cowbellRerollCount: 2 })).toBe(false);
});

test('a price that can be read nowhere counts as at cap, never as free', () => {
    expect(protection._isRerollAtCap({ kind: 'coin', cost: null }, null)).toBe(true);
    expect(protection._isRerollAtCap({ kind: 'cowbell', cost: undefined })).toBe(true);
});

test('a stated price is judged as before', () => {
    expect(protection._isRerollAtCap({ kind: 'coin', cost: 40000 }, null)).toBe(false);
    expect(protection._isRerollAtCap({ kind: 'cowbell', cost: 8 }, null)).toBe(true);
});
