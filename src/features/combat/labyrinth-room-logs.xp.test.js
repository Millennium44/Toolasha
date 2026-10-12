/** @vitest-environment happy-dom */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (_k, d) => d, Z_FLOATING_PANEL: 1100 },
}));
const skills = vi.hoisted(() => ({ list: null }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (_k, _s, fallback = null) => fallback,
        getJSON: async () => null,
        setJSON: async () => {},
        tryGet: async () => ({ found: false, value: null }),
        set: async () => true,
        delete: async () => true,
        getAllKeys: async () => [],
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getSkills: () => skills.list,
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
    },
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));

const { labyrinthRoomLogs } = await import('./labyrinth-room-logs.js');

// The game's skill list ends with a roll-up entry whose experience is the sum of
// every other skill's. Shapes as the game emits them (hrid-keyed entries).
const skillList = (cheesesmithing) => [
    { skillHrid: '/skills/cheesesmithing', level: 39, experience: cheesesmithing },
    { skillHrid: '/skills/alchemy', level: 29, experience: 100_000 },
    { skillHrid: '/skills/total_level', level: 500, experience: cheesesmithing + 100_000 },
];

describe('room experience is credited once, not once per skill and once for the roll-up', () => {
    beforeEach(() => {
        skills.list = skillList(1_000_000);
        labyrinthRoomLogs.persist = () => {};
        labyrinthRoomLogs.renderIfOpen = () => {};
        labyrinthRoomLogs.pendingReport = null;
        labyrinthRoomLogs.xpBaseline = labyrinthRoomLogs.totalExperience();
        labyrinthRoomLogs.activeSession = { xp: 0 };
    });

    test('the total leaves out the total_level entry', () => {
        expect(labyrinthRoomLogs.totalExperience()).toBe(1_100_000);
    });

    test('a room that moves the skill counter by 4481.88 is logged at 4481.88', () => {
        skills.list = skillList(1_000_000 + 4481.88);
        labyrinthRoomLogs.absorbExperience();
        expect(labyrinthRoomLogs.activeSession.xp).toBeCloseTo(4481.88, 6);
    });
});
