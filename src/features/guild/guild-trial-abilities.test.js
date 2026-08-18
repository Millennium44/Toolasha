/**
 * The trial-abilities session: what resets it, what does not, and what the
 * aura arithmetic is allowed to claim from a partial capture.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

/** What storage answers with, and the last thing written to it */
const disk = vi.hoisted(() => ({ value: null, saved: null }));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async () => disk.value,
        set: async (key, value) => {
            disk.saved = value;
        },
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => ({ abilityDetailMap: {} }) },
}));

const {
    GuildTrialAbilities,
    SESSION_MAX_AGE_MS,
    TRIAL_START_GRACE_MS,
    playerKey,
    normalizeRoster,
    captureFor,
    expectedAuraHrids,
    aggregateAuras,
    auraCoverage,
} = await import('./guild-trial-abilities.js');

const NOW = 1_800_000_000_000;

/** An aura in the shape `isAuraAbility` detects — never a hardcoded list */
const aura = (name) => ({
    name,
    isSpecialAbility: true,
    abilityEffects: [{ effectType: '/ability_effect_types/buff', targetType: 'allAllies', buffs: [{}] }],
});

/** A plain attack, and a self-only special, neither of which is an aura */
const attack = (name) => ({ name, isSpecialAbility: false, abilityEffects: [] });
const selfBuff = (name) => ({
    name,
    isSpecialAbility: true,
    abilityEffects: [{ effectType: '/ability_effect_types/buff', targetType: 'self', buffs: [{}] }],
});

const GAME = {
    '/abilities/fierce_aura': aura('Fierce Aura'),
    '/abilities/aqua_aura': aura('Aqua Aura'),
    '/abilities/sweep': attack('Sweep'),
    '/abilities/vampirism': selfBuff('Vampirism'),
};

/** An authoritative loadout snapshot, in the `extractLoadout` shape */
function snap(name, characterId, abilities, over = {}) {
    return {
        name,
        characterId,
        abilities,
        abilitiesAuthoritative: true,
        source: 'battle_unit_fetched',
        at: NOW,
        ...over,
    };
}

/** A session with a roster, ready to capture into */
function session(roster = ['Alice', 'Bob']) {
    const s = new GuildTrialAbilities();
    s.guildName = 'Cats';
    s.setRoster(roster);
    return s;
}

describe('playerKey and roster plumbing', () => {
    test('characterId is the key; name only when there is no id', () => {
        expect(playerKey({ characterId: 7, name: 'Alice' })).toBe('id:7');
        expect(playerKey({ characterId: null, name: ' Alice ' })).toBe('name:alice');
    });

    test('normalizeRoster accepts names and objects and deduplicates', () => {
        expect(normalizeRoster(['Alice', { characterId: 2, name: 'Bob' }, 'Alice', '', null])).toEqual([
            { characterId: null, name: 'Alice' },
            { characterId: 2, name: 'Bob' },
        ]);
    });

    test('captureFor matches by id, by name key, and by name against id-keyed entries', () => {
        const players = {
            'id:1': { characterId: 1, name: 'Alice' },
            'name:bob': { characterId: null, name: 'Bob' },
        };
        expect(captureFor(players, { characterId: 1, name: 'Renamed' })).toBe(players['id:1']);
        expect(captureFor(players, { characterId: null, name: 'BOB' })).toBe(players['name:bob']);
        expect(captureFor(players, { characterId: null, name: 'alice' })).toBe(players['id:1']);
        expect(captureFor(players, { characterId: null, name: 'Cara' })).toBeNull();
    });
});

describe('session reset rules', () => {
    test('a capture past the 65-minute window starts a new session', () => {
        const s = session();
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        expect(s.session.startedAt).toBe(NOW);

        s.recordCapture(snap('Bob', 2, []), { at: NOW + SESSION_MAX_AGE_MS + 1 });
        expect(s.session.startedAt).toBe(NOW + SESSION_MAX_AGE_MS + 1);
        expect(Object.keys(s.session.players)).toEqual(['id:2']);
    });

    test('a tier change does NOT reset — mixed tiers accumulate on one session', () => {
        const s = session();
        s.setTier(4);
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        s.setTier(5);
        s.recordCapture(snap('Bob', 2, []), { at: NOW + 60_000 });

        expect(s.session.startedAt).toBe(NOW);
        expect(Object.keys(s.session.players)).toHaveLength(2);
        expect(s.session.captureTier).toBe(4);
        expect(s.session.capturedTiers).toEqual([4, 5]);
    });

    test('manual recapture throws the captures away', () => {
        const s = session();
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        s.recapture(NOW + 1000);
        expect(s.session.players).toEqual({});
        expect(s.session.startedAt).toBe(NOW + 1000);
    });

    test('an explicit trial start resets, but not within the grace window', () => {
        const s = session();
        s.recordCapture(snap('Alice', 1, []), { at: NOW });

        s.noteTrialStart(NOW + TRIAL_START_GRACE_MS - 1);
        expect(Object.keys(s.session.players)).toHaveLength(1);

        s.noteTrialStart(NOW + TRIAL_START_GRACE_MS + 1);
        expect(s.session.players).toEqual({});
    });

    test('a wrong-guild name drops the session; the same guild keeps it', () => {
        const s = session();
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        s.session.guildName = 'Cats';

        s.setGuildName('Cats');
        expect(s.session).not.toBeNull();

        s.setGuildName('Dogs');
        expect(s.session).toBeNull();
    });
});

describe('join key and roster changes', () => {
    test('a slot reorder cannot transplant abilities: characterId keys the capture', () => {
        const s = session();
        s.recordCapture(snap('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 70 }]), { at: NOW });
        // The roster reorders; Alice's row moves but her capture does not
        s.setRoster(['Bob', 'Alice']);
        const rows = s.participants();
        expect(rows[1].name).toBe('Alice');
        expect(rows[1].capture.abilities).toEqual([{ hrid: '/abilities/fierce_aura', level: 70 }]);
        expect(rows[0].capture).toBeNull();
    });

    test('a re-capture of the same characterId replaces in place', () => {
        const s = session();
        s.recordCapture(snap('Alice', 1, [{ hrid: '/abilities/sweep', level: 10 }]), { at: NOW });
        s.recordCapture(snap('Alice', 1, [{ hrid: '/abilities/aqua_aura', level: 20 }]), { at: NOW + 1000 });
        expect(Object.keys(s.session.players)).toEqual(['id:1']);
        expect(s.session.players['id:1'].abilities).toEqual([{ hrid: '/abilities/aqua_aura', level: 20 }]);
    });

    test('an id-carrying capture adopts an earlier id-less sighting of the same name', () => {
        const s = session();
        s.recordCapture(snap('Alice', null, [], { abilitiesAuthoritative: false, source: 'popup' }), { at: NOW });
        s.recordCapture(snap('Alice', 1, [{ hrid: '/abilities/sweep', level: 5 }]), { at: NOW + 1000 });
        expect(Object.keys(s.session.players)).toEqual(['id:1']);
    });

    test('a joining participant adds exactly one outstanding capture', () => {
        const s = session(['Alice', 'Bob']);
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        expect(s.state(GAME).outstanding.map((row) => row.name)).toEqual(['Bob']);

        s.setRoster(['Alice', 'Bob', 'Cara']);
        expect(s.state(GAME).outstanding.map((row) => row.name)).toEqual(['Bob', 'Cara']);
    });

    test('a departed player keeps the capture and is marked not-current', () => {
        const s = session(['Alice', 'Bob']);
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        s.setRoster(['Bob']);
        const view = s.state(GAME);
        expect(view.rosterCount).toBe(1);
        expect(view.capturedCount).toBe(0);
        expect(view.notCurrent.map((player) => player.name)).toEqual(['Alice']);
    });
});

describe('what counts as captured', () => {
    test('an authoritative empty kit is genuinely empty: captured, no auras', () => {
        const s = session(['Alice']);
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        const view = s.state(GAME);
        expect(view.capturedCount).toBe(1);
        expect(view.complete).toBe(true);
        expect(view.auras).toEqual({});
        expect(view.coverage['/abilities/fierce_aura']).toBe('missing');
    });

    test('a stat-only capture stays outstanding', () => {
        const s = session(['Alice']);
        s.recordCapture(snap('Alice', 1, [], { abilitiesAuthoritative: false, source: 'popup' }), { at: NOW });
        const view = s.state(GAME);
        expect(view.capturedCount).toBe(0);
        expect(view.complete).toBe(false);
        expect(view.outstanding).toHaveLength(1);
        expect(view.coverage['/abilities/fierce_aura']).toBe('unknown');
    });

    test('a stat-only sighting never erases an authoritative kit', () => {
        const s = session(['Alice']);
        s.recordCapture(snap('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 70 }]), { at: NOW });
        s.recordCapture(snap('Alice', 1, [], { abilitiesAuthoritative: false, source: 'popup' }), { at: NOW + 500 });
        const view = s.state(GAME);
        expect(view.capturedCount).toBe(1);
        expect(view.auras['/abilities/fierce_aura'].provider).toBe('Alice');
    });
});

describe('the finished trial survives a reload', () => {
    beforeEach(() => {
        disk.value = null;
        disk.saved = null;
    });

    /** A completed 2/2 session as an earlier page-load persisted it */
    const storedSession = (startedAt) => ({
        startedAt,
        guildName: 'Cats',
        captureTier: 4,
        capturedTiers: [4],
        completedAt: startedAt + 60_000,
        players: {
            'id:1': {
                characterId: 1,
                name: 'Alice',
                capturedAt: startedAt + 30_000,
                capturedTier: 4,
                source: 'battle_unit_fetched',
                abilitiesAuthoritative: true,
                abilities: [{ hrid: '/abilities/fierce_aura', level: 70 }],
            },
            'id:2': {
                characterId: 2,
                name: 'Bob',
                capturedAt: startedAt + 60_000,
                capturedTier: 4,
                source: 'battle_unit_fetched',
                abilitiesAuthoritative: true,
                abilities: [],
            },
        },
        roster: [
            { characterId: 1, name: 'Alice' },
            { characterId: 2, name: 'Bob' },
        ],
    });

    test('a session older than the trial hour is kept, roster and all', async () => {
        // Two hours on: the trial is over, and the completed 8/8 view is
        // exactly what the panel is asked for — until the next trial's first
        // capture starts a fresh session
        disk.value = storedSession(NOW - 2 * 60 * 60_000);

        const s = new GuildTrialAbilities();
        await s.initialize('Cats');

        expect(s.session?.startedAt).toBe(NOW - 2 * 60 * 60_000);
        expect(s.roster.map((member) => member.name)).toEqual(['Alice', 'Bob']);
        const view = s.state(GAME);
        expect(view.capturedCount).toBe(2);
        expect(view.complete).toBe(true);
        expect(view.auras['/abilities/fierce_aura'].provider).toBe('Alice');
    });

    test('a wrong-guild session is still not adopted', async () => {
        disk.value = storedSession(NOW - 10 * 60_000);

        const s = new GuildTrialAbilities();
        await s.initialize('Dogs');

        expect(s.session).toBeNull();
        expect(s.roster).toEqual([]);
    });

    test('the next trial’s first capture still starts a fresh session', async () => {
        disk.value = storedSession(NOW - 2 * 60 * 60_000);

        const s = new GuildTrialAbilities();
        await s.initialize('Cats');
        s.recordCapture(snap('Cara', 3, []), { at: NOW });

        expect(s.session.startedAt).toBe(NOW);
        expect(Object.keys(s.session.players)).toEqual(['id:3']);
    });

    test('the roster rides along with every persisted session', () => {
        const s = session(['Alice', 'Bob']);
        s.recordCapture(snap('Alice', 1, []), { at: NOW });

        expect(disk.saved?.roster?.map((member) => member.name)).toEqual(['Alice', 'Bob']);
    });
});

describe('aura aggregation', () => {
    const captured = (name, characterId, abilities) => ({
        name,
        characterId,
        abilities,
        abilitiesAuthoritative: true,
    });

    test('expected auras come off the ability data, not a list', () => {
        expect(expectedAuraHrids(GAME).sort()).toEqual(['/abilities/aqua_aura', '/abilities/fierce_aura']);
    });

    test('highest level wins the provider slot; lower copies are redundant, listed once', () => {
        const auras = aggregateAuras(
            [
                captured('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 60 }]),
                captured('Bob', 2, [{ hrid: '/abilities/fierce_aura', level: 78 }]),
                captured('Cara', 3, [{ hrid: '/abilities/fierce_aura', level: 40 }]),
            ],
            GAME
        );
        const fierce = auras['/abilities/fierce_aura'];
        expect(fierce.highestLevel).toBe(78);
        expect(fierce.provider).toBe('Bob');
        expect(fierce.duplicateCount).toBe(2);
        expect(fierce.providers.map((provider) => provider.name)).toEqual(['Bob', 'Alice', 'Cara']);
    });

    test('different aura hrids are never duplicates of each other', () => {
        const auras = aggregateAuras(
            [
                captured('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 60 }]),
                captured('Bob', 2, [{ hrid: '/abilities/aqua_aura', level: 50 }]),
            ],
            GAME
        );
        expect(auras['/abilities/fierce_aura'].duplicateCount).toBe(0);
        expect(auras['/abilities/aqua_aura'].duplicateCount).toBe(0);
    });

    test('one player equipping the same hrid twice counts once', () => {
        const auras = aggregateAuras(
            [
                captured('Alice', 1, [
                    { hrid: '/abilities/fierce_aura', level: 60 },
                    { hrid: '/abilities/fierce_aura', level: 60 },
                ]),
            ],
            GAME
        );
        expect(auras['/abilities/fierce_aura'].providers).toHaveLength(1);
        expect(auras['/abilities/fierce_aura'].duplicateCount).toBe(0);
    });

    test('non-auras and non-authoritative entries contribute nothing', () => {
        const auras = aggregateAuras(
            [
                captured('Alice', 1, [
                    { hrid: '/abilities/sweep', level: 99 },
                    { hrid: '/abilities/vampirism', level: 99 },
                ]),
                { name: 'Bob', characterId: 2, abilities: [{ hrid: '/abilities/fierce_aura', level: 70 }] },
            ],
            GAME
        );
        expect(auras).toEqual({});
    });

    test('missing only at full authoritative coverage; unknown before', () => {
        expect(auraCoverage({}, GAME, false)['/abilities/fierce_aura']).toBe('unknown');
        expect(auraCoverage({}, GAME, true)['/abilities/fierce_aura']).toBe('missing');
        const covered = { '/abilities/fierce_aura': { providers: [{ name: 'Alice' }] } };
        expect(auraCoverage(covered, GAME, false)['/abilities/fierce_aura']).toBe('covered');
    });
});

describe('exportSnapshot', () => {
    let s;
    beforeEach(() => {
        s = session(['Alice', 'Bob']);
        s.setTier(4);
    });

    test('a partial session exports unknownAuras, never missingAuras', () => {
        s.recordCapture(snap('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 70 }]), { at: NOW });
        const out = s.exportSnapshot(GAME);
        expect(out.complete).toBe(false);
        expect(out.completedAt).toBeNull();
        expect(out.missingAuras).toBeUndefined();
        expect(out.unknownAuras).toEqual(['/abilities/aqua_aura']);
        expect(out.auras['/abilities/fierce_aura'].provider).toBe('Alice');
    });

    test('a complete session names what is provably missing', () => {
        s.recordCapture(snap('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 70 }]), { at: NOW });
        s.setTier(5);
        s.recordCapture(snap('Bob', 2, [{ hrid: '/abilities/sweep', level: 50 }]), { at: NOW + 1000 });

        const out = s.exportSnapshot(GAME);
        expect(out.complete).toBe(true);
        expect(out.completedAt).toBe(NOW + 1000);
        expect(out.captureTier).toBe(4);
        expect(out.capturedTiers).toEqual([4, 5]);
        expect(out.missingAuras).toEqual(['/abilities/aqua_aura']);
        expect(out.unknownAuras).toEqual([]);
        expect(out.players['1']).toMatchObject({ name: 'Alice', capturedTier: 4, abilitiesAuthoritative: true });
        expect(out.players['2']).toMatchObject({ name: 'Bob', capturedTier: 5 });
    });

    test('a joiner after completion un-completes the export', () => {
        s.setRoster(['Alice']);
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        expect(s.exportSnapshot(GAME).complete).toBe(true);

        s.setRoster(['Alice', 'Cara']);
        const out = s.exportSnapshot(GAME);
        expect(out.complete).toBe(false);
        expect(out.completedAt).toBeNull();
        expect(out.missingAuras).toBeUndefined();
    });
});
