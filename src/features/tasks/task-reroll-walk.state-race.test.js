/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const world = vi.hoisted(() => ({ characterId: 'alice', disk: new Map(), gate: null }));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (_key, fallback) => fallback, onSettingChange: () => () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => world.characterId, getMooPassBuffs: () => [] },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => null,
    requestAdoptionConsent: () => {},
}));
vi.mock('../../utils/character-key.js', async (importOriginal) => {
    const real = await importOriginal();
    return {
        ...real,
        readScopedFrom: async (...args) => {
            const value = await real.readScopedFrom(...args);
            if (world.gate?.stage === args[0]) {
                const gate = world.gate;
                world.gate = null;
                gate.entered();
                await gate.promise;
            }
            return value;
        },
    };
});
vi.mock('./task-sorter.js', () => ({ default: { sortTasks: () => {} } }));
vi.mock('./task-profit-calculator.js', () => ({ getCowbellValue: () => 8000 }));
vi.mock('./task-card-state.js', () => ({ cardTaskKey: () => '' }));
vi.mock('./task-card-quest.js', () => ({ questForTaskCard: () => null }));
vi.mock('./task-reroll-options.js', () => ({ findRerollOptions: () => [] }));
// The walk also runs with the shield feature off; its own stored values then
// provide the protection, rather than a ready shield instance overriding them.
vi.mock('./task-reroll-protection.js', () => ({ default: { protection: { isInitialized: false } } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        getMany: async (keys) => {
            const snapshot = new Map(keys.map((key) => [key, structuredClone(world.disk.get(key) ?? null)]));
            if (world.gate?.stage === 'batch') {
                const gate = world.gate;
                world.gate = null;
                gate.entered();
                await gate.promise;
            }
            return snapshot;
        },
        parseJSON: (raw, _key, fallback = null) => raw ?? fallback,
    },
}));
import feature from './task-reroll-walk.js';
const walk = feature.walk;
const MILKING = '/actions/milking/cow';
const KEEPER = '/actions/brewing/coffee';
function seed(character, latest) {
    world.disk.set(`taskProtectedHrids_${character}`, latest ? [KEEPER] : [MILKING]);
    world.disk.set(`taskCapProtection_${character}`, latest);
    world.disk.set(`taskCapCoinThreshold_${character}`, latest ? 40000 : 320000);
    world.disk.set(`taskCapCowbellThreshold_${character}`, latest ? 4 : 32);
    world.disk.set('taskRerollWalkPanelPosition', latest ? { left: 40, top: 80 } : { left: 4, top: 8 });
}
function hold(stage) {
    let release;
    let entered;
    const ready = new Promise((resolve) => (entered = resolve));
    const promise = new Promise((resolve) => (release = resolve));
    world.gate = { stage, promise, entered };
    return { ready, release };
}
function expectLatestCaps() {
    expect(walk._liveCapBlock()).toEqual({ enabled: true, coin: 40000, cowbell: 4 });
    expect(walk._blockThresholds()).toEqual({ coinThreshold: 40000, cowbellThreshold: 4 });
}
beforeEach(() => {
    walk.cleanup();
    world.characterId = 'alice';
    world.disk = new Map();
    world.gate = null;
    document.body.innerHTML = '';
});
afterEach(() => walk.cleanup());

describe.each(['switch', 'same-character reconnect'])('%s during guided walk startup', (change) => {
    test.each(['batch', 'taskCapProtection', 'taskCapCoinThreshold', 'taskCapCowbellThreshold'])(
        'late %s completion cannot replace the current fallback protections',
        async (stage) => {
            seed('alice', false);
            const gate = hold(stage);
            const oldInit = feature.initialize();
            await gate.ready;
            walk.cleanup();
            if (change === 'switch') world.characterId = 'bob';
            seed(world.characterId, true);
            await feature.initialize();
            gate.release();
            await oldInit;
            expectLatestCaps();
            expect(walk._liveProtectedHrids()).toEqual(new Set([KEEPER]));
            expect(walk.panelPosition).toEqual({ left: 40, top: 80 });
        }
    );
});

test.each(['batch', 'taskCapProtection', 'taskCapCoinThreshold', 'taskCapCowbellThreshold'])(
    "a stopped start with pending %s cannot change a newer start's cap advice",
    async (stage) => {
        seed('alice', false);
        const gate = hold(stage);
        const oldStart = walk.start();
        await gate.ready;
        walk.stop();
        seed('alice', true);
        await walk.start();
        gate.release();
        await oldStart;
        expectLatestCaps();
        expect(walk.state).toBe('stopped');
        expect(walk.message).toBe('No tasks on the board.');
    }
);

test('ordinary startup still reads scoped values and the current panel position', async () => {
    seed('alice', true);
    await feature.initialize();
    expectLatestCaps();
    expect(walk._liveProtectedHrids()).toEqual(new Set([KEEPER]));
    expect(walk.panelPosition).toEqual({ left: 40, top: 80 });
});

test('empty settings still mean no configured cap block', async () => {
    await feature.initialize();
    expect(walk._liveCapBlock()).toEqual({ enabled: false, coin: 320000, cowbell: 32 });
    expect(walk._blockThresholds()).toEqual({ coinThreshold: Infinity, cowbellThreshold: Infinity });
    expect(walk._liveProtectedHrids()).toEqual(new Set());
});

test.each(['batch', 'taskCapProtection', 'taskCapCoinThreshold', 'taskCapCowbellThreshold'])(
    'stopping a pending %s read retains the last completed caps',
    async (stage) => {
        seed('alice', true);
        await feature.initialize();
        seed('alice', false);
        const gate = hold(stage);
        const pending = walk.start();
        await gate.ready;
        walk.stop();
        gate.release();
        await pending;
        expectLatestCaps();
        expect(walk.state).toBe('idle');
    }
);
