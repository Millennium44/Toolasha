/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const world = vi.hoisted(() => ({ characterId: 'alice', disk: new Map(), gate: null, writeGate: null }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => world.characterId,
        getInitClientData: () => ({
            actionDetailMap: {
                '/actions/milking/cow': { name: 'Cow', type: '/action_types/milking' },
                '/actions/brewing/coffee': { name: 'Coffee', type: '/action_types/brewing' },
            },
            combatMonsterDetailMap: {},
        }),
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
        onReady: (_name, callback) => {
            callback();
            return () => {};
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('./task-card-state.js', () => ({
    isCardInConfirmState: () => false,
    armConfirmSettleWatch: () => {},
    onConfirmFlowSettled: () => () => {},
}));
vi.mock('./task-reroll-options.js', () => ({ findRerollOptions: () => [] }));
vi.mock('./task-card-quest.js', () => ({ questForTaskCard: (card) => card.quest }));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => {
        if (world.gate?.stage !== 'adoption') return null;
        const gate = world.gate;
        world.gate = null;
        gate.entered();
        await gate.promise;
        return 'alice';
    },
    requestAdoptionConsent: () => {},
}));
// Keep the real scoped-key and scoped-value behavior, adding only a deferred
// completion to exercise each boundary of the initializer deterministically.
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
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key, _store, fallback) => {
            const value = structuredClone(world.disk.get(key) ?? fallback);
            if (world.gate?.stage === 'batch') {
                const gate = world.gate;
                world.gate = null;
                gate.entered();
                await gate.promise;
            }
            return value;
        },
        getMany: async (keys) => new Map(keys.map((key) => [key, structuredClone(world.disk.get(key) ?? null)])),
        set: vi.fn(async (key, value) => {
            world.disk.set(key, structuredClone(value));
            return true;
        }),
        setJSON: vi.fn(async (key, value) => {
            const captured = structuredClone(value);
            if (world.writeGate) await world.writeGate;
            world.disk.set(key, captured);
            return true;
        }),
    },
}));
import feature from './task-reroll-protection.js';
import storage from '../../core/storage.js';

const protection = feature.protection;
// HRIDs from task-reroll-walk.test.js and task-auto-reroll.test.js fixtures.
const MILKING = '/actions/milking/cow';
const KEEPER = '/actions/brewing/coffee';
const THIRD = '/monsters/goblin';
function seed(character, { hrids, enabled, coin, cowbell }) {
    world.disk.set(`taskProtectedHrids_${character}`, hrids);
    world.disk.set(`taskCapProtection_${character}`, enabled);
    world.disk.set(`taskCapCoinThreshold_${character}`, coin);
    world.disk.set(`taskCapCowbellThreshold_${character}`, cowbell);
}
function hold(stage) {
    let release;
    let entered;
    const ready = new Promise((resolve) => (entered = resolve));
    const promise = new Promise((resolve) => (release = resolve));
    world.gate = { stage, promise, entered };
    return { ready, release };
}
function expectCurrent({ hrids, enabled, coin, cowbell }) {
    expect(protection.getProtectedHrids()).toEqual(new Set(hrids));
    expect(protection.capProtectionEnabled).toBe(enabled);
    expect(protection.coinThreshold).toBe(coin);
    expect(protection.cowbellThreshold).toBe(cowbell);
    expect(protection.isTaskProtected({ quest: { actionHrid: KEEPER } })).toBe(hrids.includes(KEEPER));
}
const oldState = { hrids: [MILKING], enabled: false, coin: 320000, cowbell: 32 };
const newState = { hrids: [KEEPER], enabled: true, coin: 40000, cowbell: 4 };
beforeEach(() => {
    feature.disable();
    world.characterId = 'alice';
    world.disk = new Map();
    world.gate = null;
    world.writeGate = null;
    storage.setJSON.mockClear();
    storage.set.mockClear();
    document.body.innerHTML = '';
});
afterEach(() => feature.disable());

describe.each(['switch', 'same-character reconnect'])('%s during protection startup', (change) => {
    test.each(['batch', 'taskCapProtection', 'taskCapCoinThreshold', 'taskCapCowbellThreshold'])(
        'late %s completion cannot overwrite the newer list or cap settings',
        async (stage) => {
            seed('alice', oldState);
            const gate = hold(stage);
            const oldInit = feature.initialize();
            await gate.ready;
            feature.disable();
            if (change === 'switch') world.characterId = 'bob';
            seed(world.characterId, newState);
            await feature.initialize();
            expectCurrent(newState);
            gate.release();
            await oldInit;
            expectCurrent(newState);

            // A later UI edit must not turn a stale in-memory list into a
            // persistent replacement of the arriving character's preferences.
            await protection.addProtected(THIRD);
            expect(world.disk.get(`taskProtectedHrids_${world.characterId}`)).toEqual([KEEPER, THIRD]);
            if (change === 'switch') expect(world.disk.get('taskProtectedHrids_alice')).toEqual([MILKING]);
        }
    );
});

test('uninterrupted startup still loads scoped protections and thresholds', async () => {
    seed('alice', newState);
    await feature.initialize();
    expectCurrent(newState);
    expect(protection._isRerollAtCap({ kind: 'coin', cost: 40000 })).toBe(true);
    expect(protection._isRerollAtCap({ kind: 'cowbell', cost: 3 })).toBe(false);
});

test('empty settings retain the existing defaults', async () => {
    await feature.initialize();
    expectCurrent({ hrids: [], enabled: false, coin: 320000, cowbell: 32 });
});

test('a later edit persists the arriving list, not the late old-character list', async () => {
    seed('alice', oldState);
    const gate = hold('batch');
    const oldInit = feature.initialize();
    await gate.ready;
    feature.disable();
    world.characterId = 'bob';
    seed('bob', newState);
    await feature.initialize();
    gate.release();
    await oldInit;
    await protection.addProtected(THIRD);
    expect(world.disk.get('taskProtectedHrids_bob')).toEqual([KEEPER, THIRD]);
});

// These exercise a real asynchronous branch of readScopedFrom, not the
// boundary wrapper: the adoption target lookup can still be pending at switch.
test.each(['taskCapProtection', 'taskCapCoinThreshold', 'taskCapCowbellThreshold'])(
    'late real adoption lookup for %s cannot publish over the arriving settings',
    async (base) => {
        seed('alice', oldState);
        world.disk.set(base, world.disk.get(`${base}_alice`));
        world.disk.delete(`${base}_alice`);
        const gate = hold('adoption');
        const oldInit = feature.initialize();
        await gate.ready;
        feature.disable();
        world.characterId = 'bob';
        seed('bob', newState);
        await feature.initialize();
        gate.release();
        await oldInit;
        expectCurrent(newState);
        expect(world.disk.has(base)).toBe(true);
    }
);

test.each(['taskCapProtection', 'taskCapCoinThreshold', 'taskCapCowbellThreshold'])(
    'current list edits made while %s is pending are retained',
    async (stage) => {
        seed('alice', oldState);
        const gate = hold(stage);
        const pending = feature.initialize();
        await gate.ready;
        await protection.addProtected(KEEPER);
        gate.release();
        await pending;
        await protection.addProtected(THIRD);
        expect(world.disk.get('taskProtectedHrids_alice')).toEqual([MILKING, KEEPER, THIRD]);
    }
);

test('teardown closes both popup layers and rejects old controls during the next load', async () => {
    seed('alice', newState);
    await feature.initialize();
    protection.openConfigPopup();
    const popup = document.getElementById('mwi-task-protection-popup');
    const backdrop = popup.nextElementSibling;
    const row = popup.querySelector('[data-hrid]');
    const coin = popup.querySelector('#mwi-cap-coin');
    const toggle = coin.parentElement;
    feature.disable();
    expect(popup.isConnected).toBe(false);
    expect(backdrop.isConnected).toBe(false);
    world.characterId = 'bob';
    seed('bob', oldState);
    const gate = hold('batch');
    const pending = feature.initialize();
    await gate.ready;
    expect(protection.isInitialized).toBe(false);
    expect(protection.isTaskProtected({ quest: { actionHrid: KEEPER } })).toBe(false);
    protection.openConfigPopup();
    expect(document.getElementById('mwi-task-protection-popup')).toBeNull();
    row.click();
    coin.value = '10000';
    coin.dispatchEvent(new Event('change'));
    toggle.click();
    await protection.addProtected(THIRD);
    expect(storage.setJSON).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
    gate.release();
    await pending;
    expectCurrent(oldState);
    expect(world.disk.get('taskProtectedHrids_bob')).toEqual([MILKING]);
    // Even after the new session is ready, a detached old control stays retired.
    row.click();
    toggle.click();
    expect(storage.setJSON).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
});

test('an already-started save finishes for its owner without repainting after teardown', async () => {
    seed('alice', oldState);
    await feature.initialize();
    let release;
    world.writeGate = new Promise((resolve) => (release = resolve));
    const paint = vi.spyOn(protection, '_processAllCards');
    try {
        const saving = protection.addProtected(KEEPER);
        feature.disable();
        world.characterId = 'bob';
        release();
        await saving;
        expect(world.disk.get('taskProtectedHrids_alice')).toEqual([MILKING, KEEPER]);
        expect(world.disk.has('taskProtectedHrids_bob')).toBe(false);
        expect(paint).not.toHaveBeenCalled();
    } finally {
        paint.mockRestore();
    }
});

test('closing and reopening the popup removes the old backdrop too', async () => {
    seed('alice', oldState);
    await feature.initialize();
    protection.openConfigPopup();
    const popup = document.getElementById('mwi-task-protection-popup');
    const backdrop = popup.nextElementSibling;
    expect(backdrop.isConnected).toBe(true);
    protection.openConfigPopup();
    expect(document.getElementById('mwi-task-protection-popup')).toBeNull();
    expect(backdrop.isConnected).toBe(false);
    protection.openConfigPopup();
    expect(document.querySelectorAll('#mwi-task-protection-backdrop')).toHaveLength(1);
});

test('a retained popup row cannot replace the next character list while its read is pending', async () => {
    seed('alice', oldState);
    await feature.initialize();
    protection.openConfigPopup();
    const row = document.querySelector(`[data-hrid="${MILKING}"]`);
    feature.disable();
    world.characterId = 'bob';
    seed('bob', newState);
    const gate = hold('batch');
    const pending = feature.initialize();
    await gate.ready;
    row.click();
    await Promise.resolve();
    gate.release();
    await pending;
    expect(world.disk.get('taskProtectedHrids_bob')).toEqual([KEEPER]);
});

test('the shield button is removed and recreated on an already-open board', async () => {
    document.body.innerHTML = '<div><span class="TasksPanel_taskSlotCount">Tasks</span></div>';
    seed('alice', oldState);
    await feature.initialize();
    const oldButton = document.querySelector('.mwi-task-protection-btn');
    expect(oldButton).not.toBeNull();
    feature.disable();
    expect(oldButton.isConnected).toBe(false);
    world.characterId = 'bob';
    seed('bob', newState);
    await feature.initialize();
    oldButton.click();
    expect(document.getElementById('mwi-task-protection-popup')).toBeNull();
    const button = document.querySelector('.mwi-task-protection-btn');
    expect(button).not.toBeNull();
    expect(button).not.toBe(oldButton);
    button.click();
    expect(document.getElementById('mwi-task-protection-popup')).not.toBeNull();
});

test('an old completion cannot clear the newer startup flag', async () => {
    seed('alice', oldState);
    const first = hold('batch');
    const oldInit = feature.initialize();
    await first.ready;
    feature.disable();
    world.characterId = 'bob';
    seed('bob', newState);
    const second = hold('taskCapProtection');
    const newInit = feature.initialize();
    await second.ready;
    first.release();
    await oldInit;
    expect(protection.isInitializing).toBe(true);
    expect(protection.isInitialized).toBe(false);
    second.release();
    await newInit;
    expect(protection.isInitializing).toBe(false);
    expect(protection.isInitialized).toBe(true);
    expectCurrent(newState);
});

test('removing a loaded protection during cap resolution does not resurrect it', async () => {
    seed('alice', oldState);
    const gate = hold('taskCapCoinThreshold');
    const pending = feature.initialize();
    await gate.ready;
    await protection.removeProtected(MILKING);
    gate.release();
    await pending;
    await protection.addProtected(THIRD);
    expect(world.disk.get('taskProtectedHrids_alice')).toEqual([THIRD]);
});

test('current popup edits still update and save the loaded settings', async () => {
    seed('alice', newState);
    await feature.initialize();
    protection.openConfigPopup();
    const popup = document.getElementById('mwi-task-protection-popup');
    popup.querySelector(`[data-hrid="${KEEPER}"]`).click();
    await Promise.resolve();
    expect(world.disk.get('taskProtectedHrids_alice')).toEqual([]);
    const coin = popup.querySelector('#mwi-cap-coin');
    coin.value = '80000';
    coin.dispatchEvent(new Event('change'));
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(world.disk.get('taskCapCoinThreshold_alice')).toBe(80000);
    expect(protection.coinThreshold).toBe(80000);
});
