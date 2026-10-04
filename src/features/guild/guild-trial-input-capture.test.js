/** @vitest-environment happy-dom */
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({
    owner: '1',
    guild: '10',
    recorderOwner: '1',
    recorderGuild: 'Guild 10',
    adoption: null,
    scopeVersion: 1,
    week: '2026-09-28T00:00:00Z',
    members: [],
    tracker: null,
    entries: [],
    handlers: new Map(),
    fetch: vi.fn(),
    openProfile: vi.fn(),
    profileRead: vi.fn(),
    loadoutListeners: new Set(),
    keepInputs: false,
    stored: new Map(),
    save: vi.fn(),
}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => key === 'guildTrialKeepInputs' && game.keepInputs,
        setSetting: (key, value) => {
            if (key === 'guildTrialKeepInputs') game.keepInputs = value;
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.owner,
        getInitClientData: () => ({}),
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: (...args) => game.profileRead(...args),
        setJSON: (...args) => game.save(...args),
        update: (...args) => game.save(...args),
    },
}));
vi.mock('../../utils/panel-geometry.js', () => ({
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    reopenIfLeftOpen: async () => {},
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    clampPanelToViewport: () => {},
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            if (!game.handlers.has(type)) game.handlers.set(type, new Set());
            game.handlers.get(type).add(handler);
        },
        off: (type, handler) => game.handlers.get(type)?.delete(handler),
    },
}));
vi.mock('./guild-xp-tracker.js', () => ({
    guildXPTracker: {
        getMemberList: () => game.tracker?.getMemberList() ?? game.members,
        getMemberMeta: (id) => game.tracker?.getMemberMeta(id) ?? null,
        getCurrentWeekStartAt: () => game.tracker?.getCurrentWeekStartAt() ?? game.week,
        getOwnGuildID: () => game.tracker?.getOwnGuildID() ?? game.guild,
        getOwnGuildSnapshotID: () => (game.tracker ? game.tracker.getOwnGuildSnapshotID?.() : game.guild),
        getOwnGuildName: () => game.tracker?.getOwnGuildName() ?? `Guild ${game.guild}`,
    },
}));
vi.mock('./guild-trial-recorder.js', () => ({
    default: {
        get characterId() {
            return game.recorderOwner;
        },
        get guildName() {
            return game.recorderGuild;
        },
        get pendingGuildAdoption() {
            return game.adoption;
        },
        get exportScopeVersion() {
            return game.scopeVersion;
        },
    },
}));
vi.mock('../../utils/profile-command.js', () => ({
    VALID_PLAYER_NAME_RE: /^[A-Za-z0-9_]+$/,
    openPlayerProfile: (...args) => game.openProfile(...args),
}));
vi.mock('../../utils/view-loadout.js', () => ({
    VIEW_LOADOUT_CONTEXT: { GuildTrial: 'guild_trial' },
    getLoadouts: () => game.entries,
    fetchLoadout: (...args) => game.fetch(...args),
    onLoadoutCaptured: (listener) => {
        game.loadoutListeners.add(listener);
        return () => game.loadoutListeners.delete(listener);
    },
}));

import {
    trialInputRoster,
    trialInputCoverage,
    trialInputCapturePanel,
    openTrialInputCapture,
    closeTrialInputCapture,
    buildTrialInputExport,
} from './guild-trial-input-capture.js';
import { startTrialSimulationCapture, stopTrialSimulationCapture } from './guild-trial-simulation-inputs.js';

const NOW = 1_800_000_000_000;
const member = (id, name, extra = {}) => ({
    characterID: id,
    name,
    signupWeekStartAt: game.week,
    signedUpCombatTrialHrid: '/guild_combat/badger',
    ...extra,
});
const loadout = (id, kind = 'combat', extra = {}) => ({
    characterId: String(id),
    ownerCharacterId: '1',
    name: 'Alice',
    context: 'guild_trial',
    kind,
    capturedAt: NOW,
    hasLoadout: true,
    loadout: {
        wearableItemMap: {},
        equippedAbilities: [],
        combatConsumables: [],
        abilityCombatTriggersMap: {},
        consumableCombatTriggersMap: {},
    },
    ...extra,
});
function sendProfile(id, name = 'Alice') {
    const message = {
        profile: {
            sharableCharacter: { id, name },
            characterSkills: [{ characterID: id, skillHrid: '/skills/attack', level: 100 }],
            characterGuildBuffs: [{ guildBuffHrid: '/guild_buffs/scholar', level: 4 }],
        },
    };
    for (const handler of game.handlers.get('profile_shared') || []) handler(message);
}
const body = () => document.getElementById('toolasha-trialInputCapture-panel');
const text = () => body()?.textContent || '';
function press(label) {
    const control = [...body().querySelectorAll('button')].find((el) => el.textContent.startsWith(label));
    expect(control, label).toBeTruthy();
    control.click();
}
async function settle() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    game.owner = '1';
    game.guild = '10';
    game.recorderOwner = '1';
    game.recorderGuild = 'Guild 10';
    game.adoption = null;
    game.scopeVersion = 1;
    game.week = '2026-09-28T00:00:00Z';
    game.members = [member(2, 'Alice', { signedUpSkillingTrialHrid: '/guild_skilling/alchemy' })];
    game.tracker = null;
    game.entries = [];
    game.handlers.clear();
    game.loadoutListeners.clear();
    game.fetch.mockReset();
    game.openProfile.mockReset().mockReturnValue(true);
    game.keepInputs = false;
    game.stored.clear();
    game.save.mockReset().mockImplementation(async (key, mutate) => {
        const value = mutate(structuredClone(game.stored.get(key)));
        game.stored.set(key, structuredClone(value));
        return { written: true, value };
    });
    game.profileRead
        .mockReset()
        .mockImplementation(async (key, _store, fallback) => structuredClone(game.stored.get(key) ?? fallback));
});
afterEach(() => {
    closeTrialInputCapture();
    stopTrialSimulationCapture();
    document.body.replaceChildren();
    vi.useRealTimers();
});

describe('trial input capture helper', () => {
    test('explicit save survives a session reset and opt-in restores this guild/week without requesting profiles', async () => {
        openTrialInputCapture();
        game.entries = [loadout(2, 'combat'), loadout(2, 'skilling')];
        sendProfile(2);
        press('Save captures');
        await settle();
        await settle();
        expect(game.stored.get('guild_trial_inputs_1')).toHaveLength(1);
        closeTrialInputCapture();
        stopTrialSimulationCapture();
        game.entries = [];
        game.keepInputs = true;
        openTrialInputCapture();
        await settle();
        expect(text()).toContain('2/2 loadouts');
        expect(text()).toContain('1/1 profiles');
        expect(text()).toContain('Restored this guild/week');
        expect(game.fetch).not.toHaveBeenCalled();
        expect(game.openProfile).not.toHaveBeenCalled();
    });
    test('autosaves response changes only after the keep setting is enabled', async () => {
        openTrialInputCapture();
        sendProfile(2);
        await vi.advanceTimersByTimeAsync(1000);
        expect(game.save).not.toHaveBeenCalled();
        game.keepInputs = true;
        sendProfile(2);
        await vi.advanceTimersByTimeAsync(1000);
        expect(game.stored.get('guild_trial_inputs_1')[0].simulationInputs.profiles).toHaveLength(1);
    });
    test('a late saved read cannot overwrite a fresh capture round', async () => {
        openTrialInputCapture();
        const saved = await buildTrialInputExport();
        closeTrialInputCapture();
        stopTrialSimulationCapture();
        let finish;
        game.profileRead.mockImplementation((key) =>
            key === 'guild_trial_inputs_1'
                ? new Promise((resolve) => {
                      finish = resolve;
                  })
                : Promise.resolve([])
        );
        game.keepInputs = true;
        openTrialInputCapture();
        press('Start fresh captures');
        finish([saved]);
        await settle();
        expect(text()).not.toContain('Restored this guild/week');
        expect(text()).toContain('Older captures stay');
    });
    test('includes combat and skilling signups, excluding old weeks and absent ids', () => {
        game.members.push(
            member(3, 'Bob', { signedUpCombatTrialHrid: '', signedUpSkillingTrialHrid: '/guild_skilling/crafting' }),
            member(4, 'Old', { signupWeekStartAt: 'old' }),
            member(null, 'NoId')
        );
        expect(trialInputRoster()).toEqual([
            {
                characterId: '2',
                name: 'Alice',
                trials: { combat: '/guild_combat/badger', skilling: '/guild_skilling/alchemy' },
            },
            { characterId: '3', name: 'Bob', trials: { skilling: '/guild_skilling/crafting' } },
        ]);
        game.week = null;
        expect(trialInputRoster()).toEqual([]);
    });
    test('coverage requires fresh correctly scoped kinds and a profile with levels', () => {
        const options = {
            owner: '1',
            since: NOW,
            loadouts: [
                loadout(2, 'combat', { context: 'party' }),
                loadout(2, 'combat', { ownerCharacterId: '9' }),
                loadout(2, 'combat', { capturedAt: NOW - 1 }),
                loadout(2, null),
                loadout(3),
            ],
            profiles: [{ characterID: 2, timestamp: NOW, profile: {} }],
        };
        expect(trialInputCoverage(trialInputRoster(), options)[0]).toMatchObject({
            captured: { combat: 'needed', skilling: 'needed' },
            profile: 'needed',
        });
        options.loadouts.push(loadout(2), loadout(2, 'skilling', { hasLoadout: false }));
        expect(trialInputCoverage(trialInputRoster(), options)[0].captured).toEqual({
            combat: 'captured',
            skilling: 'no_loadout',
        });
    });
    test('one press captures one kind, advancing through both loadouts and then the profile', async () => {
        game.fetch.mockImplementation(async (row, context, kind) => {
            const entry = loadout(row.characterId, kind);
            game.entries.push(entry);
            for (const handler of game.loadoutListeners) handler(entry);
            return { status: 'done', entry };
        });
        openTrialInputCapture();
        expect(game.fetch).not.toHaveBeenCalled();
        expect(text()).not.toContain('could not be drawn');
        press('Capture next: Alice · combat');
        await settle();
        expect(game.fetch).toHaveBeenCalledTimes(1);
        expect(game.fetch.mock.calls[0].slice(1)).toEqual(['guild_trial', 'combat']);
        expect(text()).toContain('Capture next: Alice · skilling');
        press('Capture next: Alice · skilling');
        await settle();
        expect(game.fetch).toHaveBeenCalledTimes(2);
        expect(text()).toContain('Capture next: Alice · profile');
        press('Capture next: Alice · profile');
        expect(game.openProfile).toHaveBeenCalledTimes(1);
        sendProfile(3, 'Bob');
        expect(text()).toContain('Waiting for Alice');
        sendProfile(2);
        expect(text()).toContain('2/2 loadouts · 1/1 profiles');
        expect(text()).toContain('No unskipped steps left');
        const exported = await buildTrialInputExport();
        expect(exported.simulationInputs.viewLoadouts).toHaveLength(2);
        expect(exported.simulationInputs.profiles[0].profile.characterSkills[0].level).toBe(100);
        expect(exported.coverage[0]).toMatchObject({
            captured: { combat: 'captured', skilling: 'captured' },
            profile: 'captured',
        });
    });
    test('uses numeric game member ids for both trial loadout requests', async () => {
        game.fetch.mockImplementation(async (row, context, kind) => {
            // The game's roster passes its numeric member id to View Loadout.
            if (typeof row.characterId !== 'number') return { status: 'no_reply', entry: null };
            const entry = loadout(row.characterId, kind);
            game.entries.push(entry);
            for (const handler of game.loadoutListeners) handler(entry);
            return { status: 'done', entry };
        });
        openTrialInputCapture();
        press('Capture next: Alice · combat');
        await settle();
        expect(text()).toContain('Combat loadout: Captured');
        press('Capture next: Alice · skilling');
        await settle();
        expect(text()).toContain('2/2 loadouts');
        expect(game.fetch.mock.calls.map(([row]) => row.characterId)).toEqual([2, 2]);
    });
    test('a restored panel completes profile capture without a false timeout', async () => {
        // The recorder starts passive capture; the panel shell restores via show(), not openTrialInputCapture().
        startTrialSimulationCapture();
        trialInputCapturePanel.show();
        body().querySelector('[aria-label="Alice: capture profile"]').click();
        expect(game.openProfile).toHaveBeenCalledTimes(1);
        sendProfile(2);
        trialInputCapturePanel.render();
        expect(text()).toContain('Profile: Captured');
        expect(text()).toContain('Profile captured. Close the game popup to continue.');
        await vi.advanceTimersByTimeAsync(8000);
        expect(text()).not.toContain('No profile reply');
        expect(game.openProfile).toHaveBeenCalledTimes(1);
    });
    test('trial filtering captures only that kind and shares one profile between both trials', () => {
        openTrialInputCapture();
        const select = body().querySelector('select');
        select.value = '/guild_skilling/alchemy';
        select.dispatchEvent(new Event('change'));
        expect(text()).toContain('Capture next: Alice · skilling');
        expect(text()).not.toContain('Combat loadout:');
        press('Skip for now');
        press('Capture next: Alice · profile');
        sendProfile(2);
        expect(text()).toContain('0/1 loadouts · 1/1 profiles');
        expect(text()).toContain('Skipped — still missing');
    });
    test('a failed request stays retryable and skipped inputs remain incomplete', async () => {
        game.fetch.mockResolvedValue({ status: 'no_reply' });
        openTrialInputCapture();
        press('Capture next');
        press('Capture next');
        await settle();
        expect(game.fetch).toHaveBeenCalledTimes(1);
        expect(text()).toContain('Retry or skip');
        press('Skip for now');
        expect(text()).toContain('Capture next: Alice · skilling');
        expect(text()).toContain('Skipped — still missing');
        expect((await buildTrialInputExport()).coverage[0].captured.combat).toBe('needed');
    });
    test('no-loadout replies stay missing while the helper advances to another input', async () => {
        const entry = loadout(2, 'combat', { hasLoadout: false });
        game.fetch.mockImplementation(async () => {
            game.entries.push(entry);
            return { status: 'done', entry };
        });
        openTrialInputCapture();
        press('Capture next');
        await settle();
        expect(text()).toContain('No trial loadout');
        expect(text()).toContain('Capture next: Alice · skilling');
        expect(text()).toContain('0/2 loadouts');
    });
    test('profile timeouts leave the step retryable and teardown removes the pending timer and listeners', () => {
        openTrialInputCapture();
        body().querySelector('[aria-label="Alice: capture profile"]').click();
        vi.advanceTimersByTime(8000);
        expect(text()).toContain('No profile reply for Alice');
        body().querySelector('[aria-label="Alice: capture profile"]').click();
        closeTrialInputCapture();
        expect(game.loadoutListeners.size).toBe(0);
        expect(game.handlers.get('profile_shared').size).toBe(1); // The export collector remains owned by the recorder.
        expect(vi.getTimerCount()).toBe(0);
    });
    test('a character/guild switch cannot complete an old pending request or reuse the prior round', async () => {
        let reply;
        game.fetch.mockReturnValue(
            new Promise((resolve) => {
                reply = resolve;
            })
        );
        openTrialInputCapture();
        press('Capture next');
        game.owner = '9';
        game.guild = '99';
        game.recorderOwner = '9';
        game.recorderGuild = 'Guild 99';
        vi.setSystemTime(NOW + 1);
        trialInputCapturePanel.render();
        reply({ status: 'done', entry: loadout(2) });
        await settle();
        expect(text()).toContain('0/2 loadouts');
        expect(text()).not.toContain('Waiting');
        expect(game.fetch).toHaveBeenCalledTimes(1);
    });
    test('export rejects a guild or week switch during profile-cache reading', async () => {
        openTrialInputCapture();
        game.profileRead.mockImplementation(async () => {
            game.guild = '99';
            return [];
        });
        await expect(buildTrialInputExport()).rejects.toThrow('changed');
        game.profileRead.mockImplementation(async () => {
            game.week = 'next-week';
            return [];
        });
        game.recorderGuild = 'Guild 99';
        game.members = [member(2, 'Alice')];
        await expect(buildTrialInputExport()).rejects.toThrow('changed');
    });
    test('stale tracker metadata cannot supply inputs while a new character or guild is being adopted', async () => {
        openTrialInputCapture();
        game.adoption = ++game.scopeVersion;
        trialInputCapturePanel.render();
        expect(body().querySelector('[aria-label="Alice: capture combat"]')).toBeNull();
        await expect(buildTrialInputExport()).rejects.toThrow('changed');
        expect(game.profileRead).not.toHaveBeenCalled();

        game.adoption = null;
        game.owner = '9';
        game.recorderOwner = '9';
        game.recorderGuild = null;
        trialInputCapturePanel.render();
        expect(body().querySelector('[aria-label="Alice: capture combat"]')).toBeNull();
        await expect(buildTrialInputExport()).rejects.toThrow('changed');
        expect(game.profileRead).not.toHaveBeenCalled();

        // The arriving scope is usable only after tracker metadata agrees with the recorder.
        game.guild = '99';
        game.recorderGuild = 'Guild 99';
        game.members = [member(3, 'Bob')];
        trialInputCapturePanel.render();
        expect(text()).toContain('Capture next: Bob');
        expect((await buildTrialInputExport()).coverage.map((row) => row.name)).toEqual(['Bob']);
    });
    test('an adoption that starts and finishes during the cache read still invalidates the export', async () => {
        openTrialInputCapture();
        game.profileRead.mockImplementation(async () => {
            game.adoption = ++game.scopeVersion;
            game.adoption = null;
            game.scopeVersion++;
            return [];
        });
        await expect(buildTrialInputExport()).rejects.toThrow('changed');
    });
    test('a pending member-history load excludes outgoing signups from standalone exports', async () => {
        const { guildXPTracker: tracker } = await vi.importActual('./guild-xp-tracker.js');
        const records = vi.spyOn(tracker, '_recordsHistory').mockReturnValue(false);
        await tracker._onCharacterInit({
            guild: { name: 'Guild 10', currentWeekStartAt: game.week },
            guildCharacterMap: { 2: { guildID: '10', ...member(2, 'Alice') } },
            guildSharableCharacterMap: { 2: { name: 'Alice' } },
        });
        records.mockReturnValue(true);
        let release;
        const held = new Promise((resolve) => {
            release = resolve;
        });
        const read = vi.spyOn(tracker, '_loadMap').mockImplementation(async (key) => {
            if (key === 'memberXP_99') await held;
            return {};
        });
        const persist = vi.spyOn(tracker, '_persist').mockImplementation(() => {});
        game.tracker = tracker;
        game.recorderGuild = 'Guild 99';
        const changing = tracker._onMembersUpdated({
            guildCharacterMap: { 3: { guildID: '99', ...member(3, 'Bob') } },
            guildSharableCharacterMap: { 3: { name: 'Bob' } },
        });
        try {
            await tracker._onGuildUpdated({ guild: { id: 99, name: 'Guild 99', currentWeekStartAt: game.week } });
            openTrialInputCapture();
            expect(tracker.getOwnGuildID()).toBe('99');
            trialInputCapturePanel.render();
            expect(text()).not.toContain('Alice');
            await expect(buildTrialInputExport()).rejects.toThrow('No current trial signups');
            expect(game.profileRead).not.toHaveBeenCalled();
            release();
            await changing;
            const bundle = await buildTrialInputExport();
            expect(bundle.guildName).toBe('Guild 99');
            expect(bundle.coverage.map((row) => row.name)).toEqual(['Bob']);
        } finally {
            release();
            await changing;
            read.mockRestore();
            records.mockRestore();
            persist.mockRestore();
            tracker.disable();
            game.tracker = null;
        }
    });
    test('a guild identity arriving before its members cannot export the previous roster', async () => {
        const { guildXPTracker: tracker } = await vi.importActual('./guild-xp-tracker.js');
        const records = vi.spyOn(tracker, '_recordsHistory').mockReturnValue(false);
        try {
            await tracker._onCharacterInit({
                guild: { id: 10, name: 'Guild 10', currentWeekStartAt: game.week },
                guildCharacterMap: { 2: { guildID: '10', ...member(2, 'Alice') } },
                guildSharableCharacterMap: { 2: { name: 'Alice' } },
            });
            game.tracker = tracker;
            game.recorderGuild = 'Guild 99';
            await tracker._onGuildUpdated({ guild: { id: 99, name: 'Guild 99', currentWeekStartAt: game.week } });
            openTrialInputCapture();
            expect(text()).not.toContain('Alice');
            await expect(buildTrialInputExport()).rejects.toThrow('changed');
            expect(game.profileRead).not.toHaveBeenCalled();
            await tracker._onMembersUpdated({
                guildCharacterMap: { 3: { guildID: '99', ...member(3, 'Bob') } },
                guildSharableCharacterMap: { 3: { name: 'Bob' } },
            });
            expect((await buildTrialInputExport()).coverage.map((row) => row.name)).toEqual(['Bob']);
        } finally {
            records.mockRestore();
            tracker.disable();
            game.tracker = null;
        }
    });
    test('completed member updates wait for a matching guild identity before exporting', async () => {
        const { guildXPTracker: tracker } = await vi.importActual('./guild-xp-tracker.js');
        const records = vi.spyOn(tracker, '_recordsHistory').mockReturnValue(false);
        try {
            await tracker._onCharacterInit({
                guild: { id: 10, name: 'Guild 10', currentWeekStartAt: game.week },
                guildCharacterMap: { 2: { guildID: '10', ...member(2, 'Alice') } },
                guildSharableCharacterMap: { 2: { name: 'Alice' } },
            });
            game.tracker = tracker;
            openTrialInputCapture();
            await tracker._onMembersUpdated({
                guildCharacterMap: { 3: { guildID: '99', ...member(3, 'Bob') } },
                guildSharableCharacterMap: { 3: { name: 'Bob' } },
            });
            trialInputCapturePanel.render();
            expect(text()).not.toContain('Bob');
            await expect(buildTrialInputExport()).rejects.toThrow('changed');
            expect(game.profileRead).not.toHaveBeenCalled();
            await tracker._onGuildUpdated({ guild: { id: 99, name: 'Guild 99', currentWeekStartAt: game.week } });
            game.recorderGuild = 'Guild 99';
            const bundle = await buildTrialInputExport();
            expect(bundle.guildName).toBe('Guild 99');
            expect(bundle.coverage.map((row) => row.name)).toEqual(['Bob']);
        } finally {
            records.mockRestore();
            tracker.disable();
            game.tracker = null;
        }
    });
    test.each(['guild', 'members'])(
        'a %s update invalidates outgoing inputs before waiting for initial history',
        async (kind) => {
            const { guildXPTracker: tracker } = await vi.importActual('./guild-xp-tracker.js');
            const records = vi.spyOn(tracker, '_recordsHistory').mockReturnValue(false);
            let release;
            const held = new Promise((resolve) => {
                release = resolve;
            });
            const guildMessage = { guild: { id: 99, name: 'Guild 99', currentWeekStartAt: game.week } };
            const memberMessage = {
                guildCharacterMap: { 3: { guildID: '99', ...member(3, 'Bob') } },
                guildSharableCharacterMap: { 3: { name: 'Bob' } },
            };
            let changing;
            try {
                await tracker._onCharacterInit({
                    guild: { id: 10, name: 'Guild 10', currentWeekStartAt: game.week },
                    guildCharacterMap: { 2: { guildID: '10', ...member(2, 'Alice') } },
                    guildSharableCharacterMap: { 2: { name: 'Alice' } },
                });
                game.tracker = tracker;
                openTrialInputCapture();
                tracker.ready = tracker._trackLoad(held);
                changing =
                    kind === 'guild' ? tracker._onGuildUpdated(guildMessage) : tracker._onMembersUpdated(memberMessage);
                trialInputCapturePanel.render();
                expect(text()).not.toContain('Alice');
                await expect(buildTrialInputExport()).rejects.toThrow(/changed|No current trial signups/);
                expect(game.profileRead).not.toHaveBeenCalled();
                release();
                await changing;
                if (kind === 'guild') await tracker._onMembersUpdated(memberMessage);
                else await tracker._onGuildUpdated(guildMessage);
                game.recorderGuild = 'Guild 99';
                expect((await buildTrialInputExport()).coverage.map((row) => row.name)).toEqual(['Bob']);
            } finally {
                release();
                await changing;
                await tracker.ready;
                records.mockRestore();
                tracker.disable();
                game.tracker = null;
            }
        }
    );
    test('fresh capture rounds do not count the previous snapshots', () => {
        openTrialInputCapture();
        game.entries = [loadout(2), loadout(2, 'skilling')];
        sendProfile(2);
        expect(text()).toContain('2/2 loadouts · 1/1 profiles');
        vi.setSystemTime(NOW + 1000);
        press('Start fresh captures');
        expect(text()).toContain('0/2 loadouts · 0/1 profiles');
    });
});
