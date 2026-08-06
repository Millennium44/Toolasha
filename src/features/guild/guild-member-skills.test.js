/** @vitest-environment happy-dom */

/**
 * Collecting guild members' skill levels, one profile at a time.
 *
 * The payload shape here is the one the codebase already reads elsewhere —
 * `combat-sim-export.js` builds a whole simulated player out of a
 * `profile_shared`, skill levels included — so these fixtures are transcribed
 * rather than invented.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ store: {}, members: [], wsHandlers: {}, loadouts: [] }));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => (key in game.store ? game.store[key] : fallback),
        set: async (key, value) => {
            game.store[key] = value;
            return true;
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            game.wsHandlers[type] = handler;
        },
        off: (type) => delete game.wsHandlers[type],
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 30404 },
}));
vi.mock('./guild-xp-tracker.js', () => ({
    guildXPTracker: { getMemberList: () => game.members },
}));
vi.mock('./guild-loadout-capture.js', () => ({
    default: { seen: () => game.loadouts },
}));

const {
    extractProfileSkills,
    findBattleUnits,
    guildMemberSkills,
    memberSkillsStorageKey,
    nextMemberToLog,
    REQUEST_TIMEOUT_MS,
    STALE_AFTER_MS,
    UNIT_FRESH_MS,
} = await import('./guild-member-skills.js');

const now = Date.parse('2026-08-05T15:00:00Z');

/**
 * A `profile_shared` message.
 * @param {string} name - Whose profile
 * @param {Object} levels - skillHrid → level
 * @returns {Object} The message
 */
function profile(name, levels = { '/skills/alchemy': 90, '/skills/milking': 75 }) {
    return {
        profile: {
            sharableCharacter: { id: `${name}-id`, name },
            characterSkills: Object.entries(levels).map(([skillHrid, level]) => ({
                skillHrid,
                level,
                characterID: `${name}-id`,
            })),
        },
    };
}

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    game.store = {};
    game.members = [{ name: 'Ada' }, { name: 'Bo' }, { name: 'Cy' }];
    game.wsHandlers = {};
    game.loadouts = [];
    guildMemberSkills.unitRequests = {};
    guildMemberSkills.forget();
    guildMemberSkills.initialized = false;
    await guildMemberSkills.initialize('Milky Way');
});

afterEach(() => {
    guildMemberSkills.cleanup();
    guildMemberSkills.forget();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('extractProfileSkills', () => {
    test('a profile carries every skill level, which is what a skilling trial needs', () => {
        const capture = extractProfileSkills(profile('Ada'), now);

        expect(capture).toMatchObject({ name: 'Ada', characterId: 'Ada-id', at: now });
        expect(capture.skills).toEqual({ '/skills/alchemy': 90, '/skills/milking': 75 });
    });

    test('a payload with no skills on it is not a capture', () => {
        expect(extractProfileSkills({ profile: { sharableCharacter: { name: 'Ada' } } })).toBeNull();
        expect(extractProfileSkills({})).toBeNull();
        expect(extractProfileSkills(null)).toBeNull();
    });

    test('a profile with no name still counts, under its character id', () => {
        const capture = extractProfileSkills({
            profile: { characterSkills: [{ skillHrid: '/skills/milking', level: 40, characterID: 77 }] },
        });
        expect(capture).toMatchObject({ characterId: 77, name: '77' });
    });
});

describe('nextMemberToLog', () => {
    test('never-captured members come first, and the count says how far along it is', () => {
        const state = nextMemberToLog(game.members, { ada: { at: now } }, now);

        expect(state.next.name).toBe('Bo');
        expect(state).toMatchObject({ logged: 1, total: 3, stale: 0 });
    });

    test('a capture that has gone stale is offered again', () => {
        const captures = {
            ada: { at: now - STALE_AFTER_MS - 1 },
            bo: { at: now },
            cy: { at: now },
        };
        const state = nextMemberToLog(game.members, captures, now);

        // Everyone has been logged, so a stale one is the next worth opening
        expect(state.logged).toBe(3);
        expect(state.stale).toBe(1);
        expect(state.next.name).toBe('Ada');
    });

    test('a roster with everything fresh is done', () => {
        const captures = { ada: { at: now }, bo: { at: now }, cy: { at: now } };
        expect(nextMemberToLog(game.members, captures, now).next).toBeNull();
    });

    test('an empty roster is not a walk', () => {
        expect(nextMemberToLog([], {}, now)).toMatchObject({ next: null, logged: 0, total: 0 });
    });
});

describe('the cycler', () => {
    test('one click opens one profile, and the next click moves on', () => {
        document.body.innerHTML =
            '<div class="GuildPanel_members__m"><table><tr><td>Ada</td></tr><tr><td>Bo</td></tr></table></div>';
        const clicked = [];
        for (const cell of document.querySelectorAll('td')) {
            cell.addEventListener('click', () => clicked.push(cell.textContent));
        }

        expect(guildMemberSkills.openNext()).toMatchObject({ opened: 'Ada', how: 'row' });
        expect(guildMemberSkills.openNext()).toMatchObject({ opened: 'Bo', how: 'row' });
        expect(clicked).toEqual(['Ada', 'Bo']);
    });

    test('the reply is what marks somebody logged', async () => {
        expect(guildMemberSkills.progress().logged).toBe(0);

        game.wsHandlers.profile_shared(profile('Ada'));
        await vi.advanceTimersByTimeAsync(0);

        expect(guildMemberSkills.progress()).toMatchObject({ logged: 1, total: 3 });
        expect(guildMemberSkills.levelFor('Ada', '/skills/alchemy')).toBe(90);
        expect(game.store[memberSkillsStorageKey('Milky Way')].ada).toBeTruthy();
    });

    test('with no member row on screen the chat command is filled in, not sent', () => {
        document.body.innerHTML = '<div class="Chat_chatInputContainer__c"><input /></div>';
        const input = document.querySelector('input');
        let submitted = false;
        input.addEventListener('keydown', () => (submitted = true));

        expect(guildMemberSkills.openNext()).toMatchObject({ opened: 'Ada', how: 'chat' });
        expect(input.value).toBe('/profile Ada');
        // Filled and focused, and the player presses Enter
        expect(submitted).toBe(false);
    });

    test('a roster that has been walked says it is done rather than reopening', () => {
        for (const name of ['Ada', 'Bo', 'Cy']) game.wsHandlers.profile_shared(profile(name));

        expect(guildMemberSkills.openNext()).toMatchObject({ opened: null, how: 'done', logged: 3, total: 3 });
    });

    test('a click in flight moves on, but never marks anyone logged', () => {
        document.body.innerHTML = '<div class="Chat_chatInputContainer__c"><input /></div>';
        const first = guildMemberSkills.openNext();
        const second = guildMemberSkills.openNext();

        expect(first.opened).toBe('Ada');
        expect(second.opened).toBe('Bo');
        // Neither click captured anything, so nothing is logged
        expect(guildMemberSkills.progress().logged).toBe(0);
    });

    test('a request that never lands is offered again', () => {
        // The reported failure: chat was hidden, the fill went nowhere, and the
        // cycler skipped that member for the session — "every member logged" at
        // seven of eight
        document.body.innerHTML = '<div class="Chat_chatInputContainer__c"><input /></div>';
        expect(guildMemberSkills.openNext().opened).toBe('Ada');

        vi.setSystemTime(now + REQUEST_TIMEOUT_MS + 1000);

        expect(guildMemberSkills.progress().logged).toBe(0);
        expect(guildMemberSkills.openNext(now + REQUEST_TIMEOUT_MS + 1000).opened).toBe('Ada');
    });

    test('a roster with real captures reads its real count, whatever was clicked', () => {
        document.body.innerHTML = '<div class="Chat_chatInputContainer__c"><input /></div>';
        game.wsHandlers.profile_shared(profile('Ada'));
        game.wsHandlers.profile_shared(profile('Bo'));

        // Clicks that went nowhere for the third
        guildMemberSkills.openNext();
        guildMemberSkills.openNext();

        const state = guildMemberSkills.progress();
        expect(state.logged).toBe(2);
        expect(state.total).toBe(3);
    });

    test('hidden chat is said, not silently filled', () => {
        // No chat input in the DOM at all, which is what a hidden chat looks
        // like from here
        document.body.innerHTML = '';
        const result = guildMemberSkills.openNext();

        expect(result.how).toBe('no-chat');
        // And nothing was marked as asked for, so the same member is next
        expect(guildMemberSkills.progress().next.name).toBe('Ada');
    });
});

describe('redoing a check on demand', () => {
    test('a fresh capture is offered again after a redo', () => {
        game.wsHandlers.profile_shared(profile('Ada'));
        game.wsHandlers.profile_shared(profile('Bo'));
        game.wsHandlers.profile_shared(profile('Cy'));
        expect(guildMemberSkills.progress()).toMatchObject({ logged: 3, next: null });

        guildMemberSkills.redoAll(now);

        const state = guildMemberSkills.progress(now + 1000);
        expect(state.logged).toBe(0);
        expect(state.next.name).toBe('Ada');
    });

    test('the levels already held stand until a fresh profile replaces them', () => {
        game.wsHandlers.profile_shared(profile('Ada'));
        guildMemberSkills.redoAll(now);

        // Due again, but still the best answer available
        expect(guildMemberSkills.levelFor('Ada', '/skills/alchemy')).toBe(90);
    });

    test('a redo asks for nothing by itself', () => {
        document.body.innerHTML = '<div class="Chat_chatInputContainer__c"><input /></div>';
        game.wsHandlers.profile_shared(profile('Ada'));

        guildMemberSkills.redoAll(now);

        // Nothing requested until somebody clicks
        expect(guildMemberSkills.progress(now + 1000).pending).toBeNull();
    });

    test('one member can be asked for again on their own', () => {
        game.wsHandlers.profile_shared(profile('Ada'));
        game.wsHandlers.profile_shared(profile('Bo'));

        guildMemberSkills.redoMember('Ada', now);

        const state = guildMemberSkills.progress(now + 1000);
        expect(state.logged).toBe(1);
        expect(state.next.name).toBe('Ada');
    });

    test('a capture arriving after a redo counts again', () => {
        game.wsHandlers.profile_shared(profile('Ada'));
        guildMemberSkills.redoAll(now);

        vi.setSystemTime(now + 5000);
        game.wsHandlers.profile_shared(profile('Ada', { '/skills/alchemy': 95 }));

        expect(guildMemberSkills.progress(now + 5000).logged).toBe(1);
        expect(guildMemberSkills.levelFor('Ada', '/skills/alchemy')).toBe(95);
    });
});

describe('per guild, and forgotten with the character', () => {
    test('captures are stored under the guild they were taken in', async () => {
        game.wsHandlers.profile_shared(profile('Ada'));
        await vi.advanceTimersByTimeAsync(0);
        expect(game.store[memberSkillsStorageKey('Milky Way')]).toBeTruthy();

        await guildMemberSkills.setGuildName('Other Guild');

        // Another guild's roster is not this one's
        expect(guildMemberSkills.progress().logged).toBe(0);
        expect(guildMemberSkills.levelFor('Ada', '/skills/alchemy')).toBeNull();
    });

    test('forgetting clears what was held', () => {
        game.wsHandlers.profile_shared(profile('Ada'));
        expect(guildMemberSkills.all().ada).toBeTruthy();

        guildMemberSkills.forget();
        expect(guildMemberSkills.all()).toEqual({});
    });
});

describe('people in the battle come first', () => {
    /**
     * A spectated fight: unit boxes with a name line and a health reading.
     * @param {Array<[string, string]>} units - [name, hp] pairs
     */
    function fightView(units, { boss = 'Trial Chameleon' } = {}) {
        const view = document.createElement('div');
        const rows = boss ? [[boss, '454,807/618,000'], ...units] : units;
        for (const [name, hp] of rows) {
            const box = document.createElement('div');
            const nameEl = document.createElement('div');
            nameEl.textContent = name;
            const hpEl = document.createElement('div');
            hpEl.textContent = hp;
            box.append(nameEl, hpEl);
            view.appendChild(box);
        }
        document.body.appendChild(view);
        return view;
    }

    test('finds roster members by their unit boxes, and the boss never', () => {
        fightView([['Ada', '2,612/2,612']]);
        const units = findBattleUnits(game.members);
        expect(units.map((u) => u.name)).toEqual(['Ada']);
    });

    test('a panel with no boss in it offers nobody — those units are inert', () => {
        // The skilling instance draws members too (this is how Liqueur, off
        // foraging, came to be offered during a fight), but only the fight's
        // own subtree holds a "Trial …" boss
        fightView([['Ada', '1,436/1,923']], { boss: null });
        expect(findBattleUnits(game.members)).toEqual([]);
        expect(guildMemberSkills.nextBattleUnit(now)).toBeNull();
    });

    test('a dead unit is clicked like anyone else', () => {
        // Death hides nothing — a popup shows whatever the build holds, and a
        // unit without abilities simply has none
        fightView([['Ada', '0/1,923']]);
        expect(guildMemberSkills.nextBattleUnit(now)?.name).toBe('Ada');
    });

    test('openNext clicks the alive unit before walking the roster', () => {
        const view = fightView([['Bo', '2,612/2,612']]);
        let clicked = null;
        view.addEventListener('click', (event) => {
            clicked = event.target;
        });

        const result = guildMemberSkills.openNext(now);
        expect(result.how).toBe('unit');
        expect(result.opened).toBe('Bo');
        expect(clicked).toBeTruthy();

        // In flight: not offered again until the window passes
        expect(guildMemberSkills.nextBattleUnit(now)).toBeNull();
        expect(guildMemberSkills.nextBattleUnit(now + REQUEST_TIMEOUT_MS + 1)?.name).toBe('Bo');
    });

    test('a fresh sheet stands down; a stale one is offered again', () => {
        fightView([['Ada', '2,612/2,612']]);
        game.loadouts = [{ name: 'Ada', at: now - 60_000 }];
        expect(guildMemberSkills.nextBattleUnit(now)).toBeNull();

        game.loadouts = [{ name: 'Ada', at: now - UNIT_FRESH_MS - 1 }];
        expect(guildMemberSkills.nextBattleUnit(now)?.name).toBe('Ada');
    });

    test('redo makes a fresh sheet due again', () => {
        fightView([['Ada', '2,612/2,612']]);
        game.loadouts = [{ name: 'Ada', at: now - 60_000 }];
        guildMemberSkills.redoAll(now);
        expect(guildMemberSkills.nextBattleUnit(now)?.name).toBe('Ada');
    });

    test('no fight on screen falls back to the roster walk', () => {
        const result = guildMemberSkills.openNext(now);
        expect(result.how).not.toBe('unit');
        expect(result.opened).toBe('Ada');
    });
});
