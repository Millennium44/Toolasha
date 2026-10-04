/** @vitest-environment happy-dom */
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({
    owner: '1',
    guild: '10',
    week: '2026-09-28T00:00:00Z',
    members: [],
    entries: [],
    handlers: new Map(),
    fetch: vi.fn(),
    openProfile: vi.fn(),
    profileRead: vi.fn(),
    loadoutListeners: new Set(),
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
        setJSON: async () => {},
    },
}));
vi.mock('../../utils/panel-geometry.js', () => ({
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    reopenIfLeftOpen: async () => {},
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
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
        getMemberList: () => game.members,
        getMemberMeta: () => null,
        getCurrentWeekStartAt: () => game.week,
        getOwnGuildID: () => game.guild,
        getOwnGuildName: () => `Guild ${game.guild}`,
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
import { stopTrialSimulationCapture } from './guild-trial-simulation-inputs.js';

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
    game.week = '2026-09-28T00:00:00Z';
    game.members = [member(2, 'Alice', { signedUpSkillingTrialHrid: '/guild_skilling/alchemy' })];
    game.entries = [];
    game.handlers.clear();
    game.loadoutListeners.clear();
    game.fetch.mockReset();
    game.openProfile.mockReset().mockReturnValue(true);
    game.profileRead.mockReset().mockResolvedValue([]);
});
afterEach(() => {
    closeTrialInputCapture();
    stopTrialSimulationCapture();
    document.body.replaceChildren();
    vi.useRealTimers();
});

describe('trial input capture helper', () => {
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
        game.members = [member(2, 'Alice')];
        await expect(buildTrialInputExport()).rejects.toThrow('changed');
    });
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
