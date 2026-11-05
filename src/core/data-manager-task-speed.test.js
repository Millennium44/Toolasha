/**
 * getTaskSpeedBonus follows the game's `base + table[level] * bonus`, measured live on the test server.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('./websocket.js', () => ({
    default: { on: vi.fn(), off: vi.fn(), onSocketEvent: vi.fn(), offSocketEvent: vi.fn() },
}));
vi.mock('./storage.js', () => ({
    default: { get: vi.fn(), set: vi.fn(), getJSON: vi.fn(), setJSON: vi.fn(), flushAll: vi.fn() },
}));

const TABLE = [
    0, 1, 2.1, 3.3, 4.6, 6, 7.5, 9.1, 10.8, 12.6, 14.5, 16.7, 19.2, 22, 25.1, 28.5, 32.2, 36.2, 40.5, 45.1, 50,
];
const BADGES = {
    '/items/basic_task_badge': { base: 0.05, per: 0.005 },
    '/items/advanced_task_badge': { base: 0.1, per: 0.01 },
    '/items/expert_task_badge': { base: 0.15, per: 0.015 },
};
const itemDetailMap = Object.fromEntries(
    Object.entries(BADGES).map(([hrid, b]) => [
        hrid,
        {
            equipmentDetail: {
                type: '/equipment_types/trinket',
                noncombatStats: { taskSpeed: b.base },
                noncombatEnhancementBonuses: { taskSpeed: b.per },
            },
        },
    ])
);

async function bonus(hrid, level, table = TABLE) {
    const { default: dataManager } = await import('./data-manager.js');
    dataManager.initClientData = { itemDetailMap, enhancementLevelTotalBonusMultiplierTable: table };
    dataManager.characterEquipment = new Map(
        hrid ? [['/item_locations/trinket', { itemHrid: hrid, enhancementLevel: level }]] : []
    );
    return dataManager.getTaskSpeedBonus();
}

describe('getTaskSpeedBonus', () => {
    beforeEach(() => vi.resetModules());

    test('Expert badge +20 reads 90 as the game does', async () => {
        expect(await bonus('/items/expert_task_badge', 20)).toBeCloseTo(90, 9);
    });
    test('Expert badge +10 reads 36.75, +0 reads 15', async () => {
        expect(await bonus('/items/expert_task_badge', 10)).toBeCloseTo(36.75, 9);
        expect(await bonus('/items/expert_task_badge', 0)).toBeCloseTo(15, 9);
    });
    test.each([
        ['/items/basic_task_badge', 20, 30],
        ['/items/advanced_task_badge', 20, 60],
        ['/items/basic_task_badge', 10, 12.25],
        ['/items/advanced_task_badge', 10, 24.5],
    ])('%s +%i reads %f', async (hrid, level, expected) => {
        expect(await bonus(hrid, level)).toBeCloseTo(expected, 9);
    });
    test('a missing table falls back and gives the same figures', async () => {
        expect(await bonus('/items/expert_task_badge', 20, undefined)).toBeCloseTo(90, 9);
        expect(await bonus('/items/expert_task_badge', 10, undefined)).toBeCloseTo(36.75, 9);
    });
    test('no badge gives 0', async () => {
        expect(await bonus(null, 0)).toBe(0);
    });
});
