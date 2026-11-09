/**
 * zone-tier-memory: the tier the game's own Difficulty box shows for a combat zone, read from the
 * game's page localStorage and never written, plus the `taskCombatGoTier` mode.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const dm = vi.hoisted(() => ({ characterId: 'char-a' }));

vi.mock('../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => dm.characterId },
}));

import config from '../core/config.js';
import * as mem from './zone-tier-memory.js';

const GOBO = '/actions/combat/gobo_planet';
const FLY = '/actions/combat/fly';
const OTHER = '/actions/combat/swamp_planet';

let mode;
let setting;

beforeEach(() => {
    dm.characterId = 'char-a';
    mode = 'game';
    setting = vi
        .spyOn(config, 'getSettingValue')
        .mockImplementation((key, fallback) => (key === 'taskCombatGoTier' ? mode : fallback));
    const map = new Map([
        // The game's shape, read off the test server: { zoneHrid: tier } under the character id
        ['lastSelectedActionDifficultyMap_char-a', JSON.stringify({ [GOBO]: 4, [FLY]: 0 })],
        ['lastSelectedActionDifficultyMap_char-b', JSON.stringify({ [GOBO]: 1 })],
    ]);
    vi.stubGlobal('localStorage', { getItem: (key) => (map.has(key) ? map.get(key) : null) });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("the game's own Difficulty pick", () => {
    test('is the resolved tier, source selected', () => {
        expect(mem.resolveZoneTier(GOBO)).toEqual({ tier: 4, known: true, source: 'selected', pending: false });
        expect(mem.describeZoneTier(4, { source: 'selected', known: true })).toBe('T4 (the tier selected in the game)');
    });

    test('T0 picked in the game is a real pick, not a missing one', () => {
        expect(mem.resolveZoneTier(FLY)).toMatchObject({ tier: 0, source: 'selected', known: true });
    });

    test('is read for the current character only', () => {
        dm.characterId = 'char-b';
        expect(mem.gameSelectedTier(GOBO)).toBe(1);
        expect(mem.gameSelectedTier(FLY)).toBeNull();
    });

    test('a zone the game has no pick for is T0, source default, still known', () => {
        expect(mem.gameSelectedTier(OTHER)).toBeNull();
        expect(mem.resolveZoneTier(OTHER)).toEqual({ tier: 0, known: true, source: 'default', pending: false });
        expect(mem.describeZoneTier(0, { source: 'default' })).toBe("T0 (the game's default for this zone)");
    });

    test('no character or no zone is no pick', () => {
        dm.characterId = null;
        expect(mem.gameSelectedTier(GOBO)).toBeNull();
        dm.characterId = 'char-a';
        expect(mem.gameSelectedTier('')).toBeNull();
    });

    test('an unreadable map is no pick', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => {
                throw new Error('denied');
            },
        });
        expect(mem.gameSelectedTier(GOBO)).toBeNull();
        vi.stubGlobal('localStorage', { getItem: () => '{not json' });
        expect(mem.gameSelectedTier(GOBO)).toBeNull();
        expect(mem.resolveZoneTier(GOBO)).toMatchObject({ tier: 0, source: 'default' });
    });

    test('a negative or fractional tier is no pick', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => JSON.stringify({ [GOBO]: -1, [FLY]: 1.5 }),
        });
        expect(mem.gameSelectedTier(GOBO)).toBeNull();
        expect(mem.gameSelectedTier(FLY)).toBeNull();
    });
});

describe('goTierMode', () => {
    test('best only for the exact value, game for everything else', () => {
        mode = 'best';
        expect(mem.goTierMode()).toBe('best');
        mode = 'game';
        expect(mem.goTierMode()).toBe('game');
        mode = 'lastRun';
        expect(mem.goTierMode()).toBe('game');
        mode = undefined;
        expect(mem.goTierMode()).toBe('game');
    });

    test('a throwing config is the game mode', () => {
        setting.mockImplementation(() => {
            throw new Error('boom');
        });
        expect(mem.goTierMode()).toBe('game');
    });
});

describe('describeZoneTier', () => {
    test('words for each source', () => {
        expect(mem.describeZoneTier(2, { source: 'best' })).toBe('T2 (best Score of the tiers simulated)');
        expect(mem.describeZoneTier(3, { source: 'selected' })).toBe('T3 (the tier selected in the game)');
        expect(mem.describeZoneTier(0, { source: 'default' })).toBe("T0 (the game's default for this zone)");
    });
});
