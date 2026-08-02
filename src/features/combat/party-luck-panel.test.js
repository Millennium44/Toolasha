/**
 * @vitest-environment happy-dom
 *
 * The Party Luck panel, built rather than reasoned about.
 *
 * The arithmetic is tested in `party-luck.test.js`. What building it catches is
 * that every section draws against a real-shaped run, and that the states it
 * spends most of its life in — nothing measured yet, a player who has looted
 * nothing — say so rather than failing.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ players: [], actionDetail: null, monsters: {}, context: null }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: () => game.actionDetail,
        getInitClientData: () => ({ combatMonsterDetailMap: game.monsters }),
        getItemDetails: (hrid) => ({ '/items/a': { name: 'Apple' } })[hrid],
    },
}));
vi.mock('../../core/config.js', () => ({
    default: { Z_FLOATING_PANEL: 1100, getSetting: () => true, getSettingValue: () => 'full' },
}));
vi.mock('./combat-drop-luck.js', () => ({
    default: {
        get context() {
            return game.context;
        },
    },
}));
vi.mock('../combat-stats/combat-stats-data-collector.js', () => ({
    default: { getLatestData: () => ({ players: game.players }) },
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: (hrid) => ({ '/items/a': 100 })[hrid] ?? null }));
vi.mock('../../utils/panel-geometry.js', () => ({ restoreGeometry: () => {}, saveGeometry: () => {} }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));

const { partyLuckPanel } = await import('./party-luck-panel.js');
const { partyLuck } = await import('./party-luck.js');

beforeEach(() => {
    game.context = { actionHrid: '/actions/zone', difficultyTier: 2, battles: 100 };
    game.monsters = {
        '/monsters/grunt': { dropTable: [{ itemHrid: '/items/a', dropRate: 0.1, minCount: 1, maxCount: 1 }] },
    };
    game.actionDetail = {
        combatZoneInfo: {
            isDungeon: false,
            fightInfo: {
                randomSpawnInfo: {
                    spawns: [{ combatMonsterHrid: '/monsters/grunt', rate: 1, strength: 1 }],
                    maxSpawnCount: 1,
                    maxTotalStrength: 1,
                },
                bossSpawns: [],
            },
        },
    };
    game.players = [
        {
            name: 'Geared',
            isCurrentPlayer: true,
            loot: { a: { itemHrid: '/items/a', count: 10 } },
            combatStats: { combatDropRate: 1, combatRareFind: 0, combatDropQuantity: 0 },
        },
        {
            name: 'Bare',
            isCurrentPlayer: false,
            loot: {},
            combatStats: { combatDropRate: 0, combatRareFind: 0, combatDropQuantity: 0 },
        },
    ];
});

afterEach(() => partyLuckPanel.hide());

const text = () => partyLuckPanel.panel.textContent;
const FAILED = 'could not be drawn';

describe('the panel renders', () => {
    test('every section draws, and none of them fails', () => {
        partyLuckPanel.show();

        expect(text()).toContain('Session Statistics');
        expect(text()).toContain('Revenue');
        expect(text()).toContain('Geared');
        expect(text()).toContain('Bare');
        expect(text()).not.toContain(FAILED);
    });

    test('the session stats are the ones the model was built from', () => {
        // Every figure below depends on these, so a wrong zone or tier has to be
        // visible rather than assumed
        partyLuckPanel.show();

        expect(text()).toContain('Battles');
        expect(text()).toContain('100');
        expect(text()).toContain('Difficulty tier');
    });

    test('an item table names the drop, its haul and what it was owed', () => {
        partyLuckPanel.show();

        expect(text()).toContain('Apple');
        expect(text()).toContain('Owed');
    });

    test('an item that both dropped and was owed is one row, not two', () => {
        // The loot map is keyed by the game's slot key rather than by item hrid.
        // Matched on the raw key, every item that dropped appeared twice — once
        // with the haul and once at a permanent -100%.
        partyLuckPanel.show();

        const geared = partyLuck(game.context).players.find((player) => player.name === 'Geared');
        expect(geared.items.filter((item) => item.itemHrid === '/items/a')).toHaveLength(1);
    });

    test('a drop that was owed and never came is still a row', () => {
        // Those are the interesting ones — a run reads as unlucky because one
        // thing did not turn up, and a silence cannot say that
        const bare = partyLuck(game.context).players.find((player) => player.name === 'Bare');
        expect(bare.items).toHaveLength(1);
        expect(bare.items[0].count).toBe(0);
        expect(bare.items[0].expected).toBeGreaterThan(0);
    });

    test('the party total is there and marked as the party', () => {
        partyLuckPanel.show();
        expect(text()).toContain('TOTAL');
    });

    test('nothing measured yet says why rather than being blank', () => {
        // The zone and battle count are only on the wire during combat, which is
        // the state this panel opens in most of the time
        game.context = null;
        partyLuckPanel.show();

        expect(text()).toContain('No run measured yet');
        expect(text()).not.toContain(FAILED);
    });

    test('a zone the model cannot cover does not fail the panel', () => {
        game.actionDetail = { combatZoneInfo: { isDungeon: true } };
        partyLuckPanel.show();

        expect(text()).toContain('No run measured yet');
        expect(text()).not.toContain(FAILED);
    });
});
