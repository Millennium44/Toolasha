/**
 * Shared chat history records.
 *
 * Public channels are one record for the browser profile, Guild chat one record
 * per guild, and everything else stays in the character's own record. Several
 * game tabs — one per character — now write the same record, so these tests run
 * several copies of the persistence module ("pages") over one storage, the way
 * several tabs share one IndexedDB.
 *
 * The storage double keeps the one property the design rests on: `update` reads
 * and writes in one step that nothing else lands inside, and is opened when it
 * is called, as an IndexedDB readwrite transaction is.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const shared = vi.hoisted(() => ({
    /** The one database every page shares */
    db: {},
    /** Set by a page-close test: anything not yet opened is never written */
    closing: false,
    /** Every storage call, in the order it was opened */
    opened: [],
}));

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

vi.mock('../../core/storage.js', () => ({
    default: {
        tryGet: async (key) => {
            await tick();
            return key in shared.db ? { found: true, value: clone(shared.db[key]) } : { found: false, value: null };
        },
        set: async (key, value) => {
            const open = !shared.closing;
            shared.opened.push(`set ${key}`);
            const copy = clone(value);
            await tick();
            if (!open) return true;
            shared.db[key] = copy;
            return true;
        },
        // One transaction: opened now, its read and its write with nothing between.
        update: async (key, mutate) => {
            const open = !shared.closing;
            shared.opened.push(`update ${key}`);
            await tick();
            if (!open) return null;
            const found = key in shared.db;
            const next = mutate(found ? clone(shared.db[key]) : undefined, found);
            if (next === undefined) return { written: false, value: clone(shared.db[key]) };
            shared.db[key] = clone(next);
            return { written: true, value: clone(next) };
        },
        isQuotaExceeded: () => false,
        onBeforeTeardown: () => () => {},
    },
}));

vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: vi.fn() }));
vi.mock('../../utils/profile-command.js', () => ({
    openPlayerProfile: vi.fn(),
    VALID_PLAYER_NAME_RE: /^[A-Za-z0-9_]+$/,
}));

const BASE = 'toolasha_local_chatHistory';
const PUBLIC = `${BASE}_public`;
const guildKey = (id) => `${BASE}_guild_${id}`;
const ownKey = (characterId) => `${BASE}_${characterId}`;

const GLOBAL = 'tab2:ch:/chat_channel_types/global';
const TRADE = 'tab2:ch:/chat_channel_types/trade';
const GUILD = 'tab2:ch:/chat_channel_types/guild';
const PARTY = 'tab2:ch:/chat_channel_types/party';
const WHISPER = 'tab2:ch:/chat_channel_types/whisper';

/**
 * A chat line as the serializer stores it: the game's markup, the id the
 * extender stamps when it can correlate one.
 * @param {string} sender
 * @param {string} text
 * @param {number} second - Distinct per line, as the timestamp makes real lines
 * @param {string} [id]
 * @returns {string}
 */
function line(sender, text, second, id) {
    const stamp = `[10/1 12:00:${String(second).padStart(2, '0')} PM] `;
    return (
        `<div class="ChatMessage_chatMessage__xyz"${id ? ` data-mwi-msg-id="${id}"` : ''}>` +
        `<span>${stamp}</span>` +
        '<span class="ChatMessage_name__1UZ8t ChatMessage_clickable__3Nt2s">' +
        '<div class="CharacterName_characterName__2FqyZ">' +
        `<div class="CharacterName_name__1amXp"><span>${sender}</span></div></div></span>` +
        `<span>: ${text}</span></div>`
    );
}

/** The text of a stored list, for readable assertions. */
const texts = (list) => (list || []).map((html) => html.match(/<span>: (.*?)<\/span>/)?.[1]);

/** A stored record's tab, as text. */
const stored = (key, tab) => texts(shared.db[key]?.tabs?.[tab]);

/**
 * `init_character_data` as the data manager keeps it: the character, and its
 * own row in the guild roster.
 */
function characterData(characterId, guildId) {
    return {
        character: { id: characterId },
        guild: guildId ? { id: guildId, name: `Guild ${guildId}` } : null,
        guildCharacterMap: guildId ? { [characterId]: { characterID: characterId, guildID: guildId } } : {},
    };
}

/**
 * Open a game tab: a fresh copy of the module, logged in as one character.
 * @param {string} characterId
 * @param {string|null} guildId
 */
async function openPage(characterId, guildId = null) {
    const page = { characterId, characterData: characterData(characterId, guildId) };
    // Each page gets its own data manager and key helper, as each game tab has its own.
    vi.resetModules();
    vi.doMock('../../core/data-manager.js', () => ({
        default: {
            getCurrentCharacterId: () => page.characterId,
            get characterData() {
                return page.characterData;
            },
            getItemDetails: () => null,
        },
    }));
    vi.doMock('../../utils/character-key.js', () => ({
        characterKey: (base) => `${base}_${page.characterId || 'default'}`,
    }));
    const module = await import('./chat-history-persistence.js');
    page.module = module;
    page.persistence = module.default;
    page.persistence.enable(() => 150);
    return page;
}

/** A character's record as a build before shared records wrote it. */
function legacyRecord(tabs, savedAt = 1000) {
    return { v: 1, savedAt, tabs, live: {} };
}

beforeEach(() => {
    shared.db = {};
    shared.closing = false;
    shared.opened = [];
});

afterEach(() => {
    vi.useRealTimers();
});

describe('which record a tab lives in', () => {
    test('every channel type the game has is classed, and the unsure ones stay with the character', async () => {
        const { module } = await openPage('101');
        const scope = (channel) => module.tabScope(`tab2:ch:/chat_channel_types/${channel}`);

        for (const channel of [
            'global',
            'general',
            'trade',
            'beginner',
            'recruit',
            'help',
            'ironcow',
            'chinese',
            'russian',
            'korean',
            'japanese',
            'portuguese',
            'spanish',
            'french',
            'german',
        ]) {
            expect(scope(channel)).toBe('public');
        }
        expect(scope('guild')).toBe('guild');
        for (const channel of ['party', 'whisper', 'local', 'mod', 'nonexistent']) {
            expect(scope(channel)).toBe('character');
        }

        // A tab named only by its text could be a whisper with a player of that name: never shared.
        for (const label of ['中文', 'Help', 'Guild', 'General', 'Trade', 'Global']) {
            expect(module.tabScope(`tab2:name:${label}`)).toBe('character');
        }
        // A whisper tab named after its partner, and anything else unrecognised.
        expect(module.tabScope('tab2:name:Alice')).toBe('character');
        expect(module.tabScope('tab2:name:Party')).toBe('character');
    });

    test('every key a shared record can have is one the sync and the backups already keep on the device', async () => {
        const { module } = await openPage('101');
        for (const key of [module.PUBLIC_RECORD_KEY, module.guildRecordKey('g1'), ownKey('101')]) {
            expect(key.startsWith('toolasha_local_')).toBe(true);
        }
    });
});

describe('several game tabs on one profile', () => {
    test('two characters writing Global at once keep both sets of lines', async () => {
        const ada = await openPage('101');
        const bob = await openPage('202');
        await Promise.all([ada.persistence.load(), bob.persistence.load()]);

        // Both see the broadcast lines; each also saw some the other did not.
        ada.persistence.record(GLOBAL, line('Zed', 'first', 1));
        ada.persistence.record(GLOBAL, line('Zed', 'seen by ada only', 2));
        bob.persistence.record(GLOBAL, line('Zed', 'first', 1));
        bob.persistence.record(GLOBAL, line('Zed', 'seen by bob only', 3));

        await Promise.all([ada.persistence.flush(), bob.persistence.flush()]);

        // Which of the two unshared lines lands first is the order the writes landed in.
        expect(stored(PUBLIC, GLOBAL)[0]).toBe('first');
        expect(stored(PUBLIC, GLOBAL).slice(1).sort()).toEqual(['seen by ada only', 'seen by bob only']);
    });

    test('a write whose session loaded before another tab wrote still merges that tab’s lines', async () => {
        const ada = await openPage('101');
        const bob = await openPage('202');
        // Both loaded an empty record.
        await Promise.all([ada.persistence.load(), bob.persistence.load()]);

        bob.persistence.record(GLOBAL, line('Zed', 'bob wrote first', 1));
        await bob.persistence.flush();
        // Ada's working record predates Bob's write; writing it whole would erase him.
        ada.persistence.record(GLOBAL, line('Zed', 'ada wrote second', 2));
        await ada.persistence.flush();

        expect(stored(PUBLIC, GLOBAL)).toEqual(['bob wrote first', 'ada wrote second']);
        // And Ada's working record now holds Bob's line, for her next restore.
        expect(texts(ada.persistence.messagesFor(GLOBAL))).toEqual(['bob wrote first', 'ada wrote second']);
    });

    test('flushes interleaved across their awaits both survive', async () => {
        const pages = [];
        for (const id of ['101', '202', '303', '404']) pages.push(await openPage(id));
        expect(new Set(pages.map((page) => page.persistence)).size).toBe(4);
        await Promise.all(pages.map((page) => page.persistence.load()));

        pages.forEach((page, i) => page.persistence.record(GLOBAL, line('Zed', `from tab ${i}`, i)));
        // Issued in one turn: every one opens before any has read.
        await Promise.all(pages.map((page) => page.persistence.flush()));

        expect(stored(PUBLIC, GLOBAL).sort()).toEqual(['from tab 0', 'from tab 1', 'from tab 2', 'from tab 3']);
    });

    test('guild chat is shared by guild id, and never across guilds', async () => {
        const ada = await openPage('101', 'g1');
        const bob = await openPage('202', 'g1');
        const cy = await openPage('303', 'g2');
        await Promise.all([ada, bob, cy].map((page) => page.persistence.load()));

        ada.persistence.record(GUILD, line('Ada', 'g1 from ada', 1));
        bob.persistence.record(GUILD, line('Bob', 'g1 from bob', 2));
        cy.persistence.record(GUILD, line('Cy', 'g2 from cy', 3));
        await Promise.all([ada, bob, cy].map((page) => page.persistence.flush()));

        expect(stored(guildKey('g1'), GUILD)).toEqual(['g1 from ada', 'g1 from bob']);
        expect(stored(guildKey('g2'), GUILD)).toEqual(['g2 from cy']);
        for (const id of ['101', '202', '303']) expect(shared.db[ownKey(id)].tabs[GUILD]).toBeUndefined();

        // A later tab for a g1 character reads g1's lines, and Cy's never.
        const dee = await openPage('404', 'g1');
        const snapshot = await dee.persistence.load();
        expect(texts(snapshot[GUILD])).toEqual(['g1 from ada', 'g1 from bob']);
    });

    test('a character with no known guild keeps its guild tab in its own record', async () => {
        const ada = await openPage('101', null);
        await ada.persistence.load();
        ada.persistence.record(GUILD, line('Ada', 'no guild id yet', 1));
        await ada.persistence.flush();

        expect(stored(ownKey('101'), GUILD)).toEqual(['no guild id yet']);
        expect(Object.keys(shared.db).filter((key) => key.includes('_guild_'))).toEqual([]);
    });

    test('party and whispers stay with the character', async () => {
        const ada = await openPage('101', 'g1');
        const bob = await openPage('202', 'g1');
        await Promise.all([ada.persistence.load(), bob.persistence.load()]);

        ada.persistence.record(PARTY, line('Ada', 'ada party', 1));
        ada.persistence.record(WHISPER, line('Eve', 'ada whisper', 2));
        bob.persistence.record(PARTY, line('Bob', 'bob party', 3));
        await Promise.all([ada.persistence.flush(), bob.persistence.flush()]);

        expect(stored(ownKey('101'), PARTY)).toEqual(['ada party']);
        expect(stored(ownKey('101'), WHISPER)).toEqual(['ada whisper']);
        expect(stored(ownKey('202'), PARTY)).toEqual(['bob party']);
        expect(stored(ownKey('202'), WHISPER)).toEqual([]);
        expect(JSON.stringify(shared.db[PUBLIC] || {})).not.toContain('whisper');
        expect(JSON.stringify(shared.db[guildKey('g1')] || {})).not.toContain('party');
    });

    test('the cap applies per shared tab, with the larger live count of the tabs showing it', async () => {
        const ada = await openPage('101');
        const bob = await openPage('202');
        ada.persistence.enable(() => 5);
        bob.persistence.enable(() => 5);
        await Promise.all([ada.persistence.load(), bob.persistence.load()]);

        for (let i = 0; i < 20; i += 1) {
            ada.persistence.record(GLOBAL, line('Zed', `g${i}`, i));
            bob.persistence.record(GLOBAL, line('Zed', `g${i}`, i));
        }
        ada.persistence.record(TRADE, line('Tom', 'one trade line', 30));
        ada.persistence.setLiveCount(GLOBAL, 2);
        bob.persistence.setLiveCount(GLOBAL, 4);
        await ada.persistence.flush();
        await bob.persistence.flush();

        // Five older lines plus the four the busier tab shows live: the oldest go.
        expect(stored(PUBLIC, GLOBAL)).toEqual(['g11', 'g12', 'g13', 'g14', 'g15', 'g16', 'g17', 'g18', 'g19']);
        expect(shared.db[PUBLIC].live[GLOBAL]).toBe(4);
        expect(stored(PUBLIC, TRADE)).toEqual(['one trade line']);
    });

    test('a tab showing fewer live lines keeps the shared record’s allowance in its working record', async () => {
        const ada = await openPage('101');
        ada.persistence.enable(() => 5);
        await ada.persistence.load();
        for (let i = 0; i < 9; i += 1) ada.persistence.record(GLOBAL, line('Zed', `g${i}`, i));
        ada.persistence.setLiveCount(GLOBAL, 4);
        await ada.persistence.flush();
        expect(stored(PUBLIC, GLOBAL)).toHaveLength(9);

        const bob = await openPage('202');
        bob.persistence.enable(() => 5);
        await bob.persistence.load();
        bob.persistence.setLiveCount(GLOBAL, 1);
        bob.persistence.record(GLOBAL, line('Zed', 'g9', 9));

        // Bob's own figure alone would cap at 5 + 1; the record allows 5 + 4.
        expect(texts(bob.persistence.messagesFor(GLOBAL))).toEqual(Array.from({ length: 9 }, (_, i) => `g${i + 1}`));
        await bob.persistence.flush();
        expect(stored(PUBLIC, GLOBAL)).toEqual(Array.from({ length: 9 }, (_, i) => `g${i + 1}`));
    });

    test('the allowance a tab reads for a shared tab is the one its cap uses', async () => {
        const ada = await openPage('101');
        await ada.persistence.load();
        ada.persistence.record(GLOBAL, line('Zed', 'g0', 0));
        ada.persistence.setLiveCount(GLOBAL, 6);
        await ada.persistence.flush();

        const bob = await openPage('202');
        await bob.persistence.load();
        expect(bob.persistence.liveCountFor(GLOBAL)).toBe(6);
        // A smaller own report does not lower it; a larger one (a switch batch's raise) does raise it.
        bob.persistence.setLiveCount(GLOBAL, 2);
        expect(bob.persistence.liveCountFor(GLOBAL)).toBe(6);
        bob.persistence.setLiveCount(GLOBAL, 9);
        expect(bob.persistence.liveCountFor(GLOBAL)).toBe(9);
        // A per-character tab is untouched by any of it.
        expect(bob.persistence.liveCountFor(PARTY)).toBeNull();
    });

    test('a deletion seen in one tab purges the shared record, and another tab cannot put it back', async () => {
        const ada = await openPage('101');
        const bob = await openPage('202');
        await Promise.all([ada.persistence.load(), bob.persistence.load()]);
        for (const page of [ada, bob]) {
            page.persistence.record(TRADE, line('Tom', 'keep me', 1, 'm1'));
            page.persistence.record(TRADE, line('Tom', 'delete me', 2, 'm2'));
        }
        await Promise.all([ada.persistence.flush(), bob.persistence.flush()]);
        expect(stored(PUBLIC, TRADE)).toEqual(['keep me', 'delete me']);

        await ada.persistence.purgeMessageById(TRADE, 'm2');
        await ada.persistence.flush();
        expect(stored(PUBLIC, TRADE)).toEqual(['keep me']);
        expect(shared.db[PUBLIC].deleted).toEqual(['m2']);

        // Bob never saw the deletion and still holds the line; his next write merges, it does not resurrect.
        bob.persistence.record(TRADE, line('Tom', 'later', 3, 'm3'));
        await bob.persistence.flush();
        expect(stored(PUBLIC, TRADE)).toEqual(['keep me', 'later']);
        expect(texts(bob.persistence.messagesFor(TRADE))).toEqual(['keep me', 'later']);
    });

    test('a deletion reaches the shared record even when this tab never held the line', async () => {
        const ada = await openPage('101');
        const bob = await openPage('202');
        await Promise.all([ada.persistence.load(), bob.persistence.load()]);
        bob.persistence.record(TRADE, line('Tom', 'only bob saw this', 1, 'm9'));
        await bob.persistence.flush();

        await ada.persistence.purgeMessageById(TRADE, 'm9');
        await ada.persistence.flush();

        expect(stored(PUBLIC, TRADE)).toEqual([]);
    });

    test('an undelete takes the tombstone back out, so the line can be recorded again', async () => {
        const ada = await openPage('101');
        await ada.persistence.load();
        ada.persistence.record(TRADE, line('Tom', 'back again', 1, 'm4'));
        await ada.persistence.purgeMessageById(TRADE, 'm4');
        await ada.persistence.flush();
        expect(shared.db[PUBLIC].deleted).toEqual(['m4']);

        ada.persistence.forgetDeletion(TRADE, 'm4');
        ada.persistence.record(TRADE, line('Tom', 'back again', 1, 'm4'));
        await ada.persistence.flush();

        expect(shared.db[PUBLIC].deleted).toEqual([]);
        expect(stored(PUBLIC, TRADE)).toEqual(['back again']);
    });

    test('an undelete that arrives before any tab has loaded still takes the tombstone out', async () => {
        const ada = await openPage('101');
        await ada.persistence.load();
        ada.persistence.record(TRADE, line('Tom', 'back again', 1, 'm4'));
        await ada.persistence.purgeMessageById(TRADE, 'm4');
        await ada.persistence.flush();
        expect(shared.db[PUBLIC].deleted).toEqual(['m4']);

        // A fresh game tab: the moderator's undelete reaches it before any chat container has read the records.
        const bob = await openPage('202');
        expect(bob.persistence.tabs).toBeNull();
        await bob.persistence.forgetDeletion(TRADE, 'm4');
        await bob.persistence.flush();

        expect(shared.db[PUBLIC].deleted).toEqual([]);
        bob.persistence.record(TRADE, line('Tom', 'back again', 1, 'm4'));
        await bob.persistence.flush();
        expect(stored(PUBLIC, TRADE)).toEqual(['back again']);
    });

    /**
     * Run `fn` with the clock at `ms`: the time a moderation event arrives is
     * what orders it against another game tab's.
     */
    async function at(ms, fn) {
        const now = vi.spyOn(Date, 'now').mockReturnValue(ms);
        try {
            return await fn();
        } finally {
            now.mockRestore();
        }
    }

    test('an old undelete from a tab that missed a newer deletion does not resurrect the line', async () => {
        const ada = await openPage('101');
        const bob = await openPage('202');
        await Promise.all([ada.persistence.load(), bob.persistence.load()]);

        // Bob saw a moderator's undelete at t=1000 and has not written since.
        await at(1000, () => bob.persistence.forgetDeletion(TRADE, 'm5'));
        // Ada saw the line deleted again at t=2000, and wrote it.
        ada.persistence.record(TRADE, line('Tom', 'deleted twice', 1, 'm5'));
        await at(2000, () => ada.persistence.purgeMessageById(TRADE, 'm5'));
        await ada.persistence.flush();
        expect(shared.db[PUBLIC].deleted).toEqual(['m5']);

        // Bob still holds the line and his stale undelete; his write must not bring either back.
        bob.persistence.record(TRADE, line('Tom', 'deleted twice', 1, 'm5'));
        await bob.persistence.flush();

        expect(shared.db[PUBLIC].deleted).toEqual(['m5']);
        expect(stored(PUBLIC, TRADE)).toEqual([]);
        expect(texts(bob.persistence.messagesFor(TRADE))).toEqual([]);
    });

    test('an old deletion from a tab that missed a newer undelete does not undo it', async () => {
        const ada = await openPage('101');
        const bob = await openPage('202');
        await Promise.all([ada.persistence.load(), bob.persistence.load()]);

        await at(1000, () => ada.persistence.purgeMessageById(TRADE, 'm6'));
        await ada.persistence.flush();
        // Bob saw the same deletion a moment later, and never saw the undelete.
        await at(1001, () => bob.persistence.purgeMessageById(TRADE, 'm6'));
        await at(3000, () => ada.persistence.forgetDeletion(TRADE, 'm6'));
        await ada.persistence.flush();
        expect(shared.db[PUBLIC].deleted).toEqual([]);

        await bob.persistence.flush();
        expect(shared.db[PUBLIC].deleted).toEqual([]);

        // So the line can be recorded again.
        ada.persistence.record(TRADE, line('Tom', 'undeleted for good', 1, 'm6'));
        await ada.persistence.flush();
        expect(stored(PUBLIC, TRADE)).toEqual(['undeleted for good']);
    });

    test('a decision a write landed is not sent again; one that failed to land is', async () => {
        const ada = await openPage('101');
        await ada.persistence.load();
        await ada.persistence.purgeMessageById(TRADE, 'm7');

        const { default: storage } = await import('../../core/storage.js');
        const update = storage.update;
        const sent = [];
        storage.update = async (key) => {
            sent.push(key);
            return null;
        };
        try {
            await ada.persistence.flush();
        } finally {
            storage.update = update;
        }
        expect(sent).toEqual([PUBLIC]);
        expect(shared.db[PUBLIC]).toBeUndefined();

        await ada.persistence.flush();
        expect(shared.db[PUBLIC].deleted).toEqual(['m7']);
        expect(ada.persistence.decisions.size).toBe(0);

        // Nothing left to say: a later flush of an unrelated line carries no decision.
        shared.db[PUBLIC].deleted = [];
        shared.db[PUBLIC].decidedAt = {};
        ada.persistence.record(TRADE, line('Tom', 'later', 2, 'm8'));
        await ada.persistence.flush();
        expect(shared.db[PUBLIC].deleted).toEqual([]);
    });

    test('a deletion and its undelete in the same millisecond keep their order', async () => {
        const ada = await openPage('101');
        await ada.persistence.load();
        await at(5000, async () => {
            await ada.persistence.purgeMessageById(TRADE, 'm9');
            ada.persistence.forgetDeletion(TRADE, 'm9');
        });
        await ada.persistence.flush();
        expect(shared.db[PUBLIC].deleted).toEqual([]);
    });

    test('the page-close flush opens every write before its first await', async () => {
        const ada = await openPage('101', 'g1');
        await ada.persistence.load();
        ada.persistence.record(GLOBAL, line('Zed', 'said just before close', 1));
        ada.persistence.record(GUILD, line('Ada', 'guild line before close', 2));
        ada.persistence.record(PARTY, line('Ada', 'party line before close', 3));

        // `storage.onBeforeTeardown` gives a listener nothing after its first await.
        const flushing = ada.persistence.flushPending();
        shared.closing = true;
        await flushing;

        expect(stored(PUBLIC, GLOBAL)).toEqual(['said just before close']);
        expect(stored(guildKey('g1'), GUILD)).toEqual(['guild line before close']);
        expect(stored(ownKey('101'), PARTY)).toEqual(['party line before close']);
    });

    test('before its first read has landed, a closing page still lands its shared lines', async () => {
        const ada = await openPage('101');
        // Recorded with no read made yet: the character's own record needs one
        // first and is lost with the page, as before; a shared one is a merge.
        ada.persistence.record(GLOBAL, line('Zed', 'unloaded but shared', 1));
        const flushing = ada.persistence.flushPending();
        shared.closing = true;
        await flushing;

        expect(stored(PUBLIC, GLOBAL)).toEqual(['unloaded but shared']);
    });
});

describe('legacy lines in the character records', () => {
    test('public and guild tabs stay with their character, are restored to it alone, and are never merged in', async () => {
        const ids = ['101', '202', '303', '404'];
        // Every character saw "common"; each saw one line of its own, and two of them were in g1.
        ids.forEach((id, i) => {
            shared.db[ownKey(id)] = legacyRecord(
                {
                    [GLOBAL]: [line('Zed', 'common', 1), line('Zed', `only ${id}`, 10 + i)],
                    [GUILD]: [line('Gil', i < 2 ? 'g1 common' : 'g2 common', 2)],
                    [PARTY]: [line('Pat', `party of ${id}`, 3)],
                },
                1000 + i
            );
        });

        const pages = [];
        for (const [i, id] of ids.entries()) pages.push(await openPage(id, i < 2 ? 'g1' : 'g2'));
        await Promise.all(pages.map((page) => page.persistence.load()));
        await Promise.all(pages.map((page) => page.persistence.flush()));

        // Nothing went into a shared record.
        expect(shared.db[PUBLIC]).toBeUndefined();
        expect(shared.db[guildKey('g1')]).toBeUndefined();
        expect(shared.db[guildKey('g2')]).toBeUndefined();
        ids.forEach((id, i) => {
            const own = shared.db[ownKey(id)];
            // Everything that was on disk is still there, as legacy.
            expect(Object.keys(own.tabs)).toEqual([PARTY]);
            expect(stored(ownKey(id), PARTY)).toEqual([`party of ${id}`]);
            expect(texts(own.legacy[GLOBAL])).toEqual(['common', `only ${id}`]);
            expect(texts(own.legacy[GUILD])).toEqual([i < 2 ? 'g1 common' : 'g2 common']);
            expect(own.sharedMigrated).toBeUndefined();
            expect(texts(pages[i].persistence.messagesFor(GLOBAL))).toEqual(['common', `only ${id}`]);
        });
    });

    test('a whisper mixed into a legacy Trade list is never shown to another character', async () => {
        // Builds before the uniqueness check filed a whisper from a player named Trade under the channel's key.
        shared.db[ownKey('101')] = legacyRecord({
            [TRADE]: [line('Tom', 'wts sword', 1), line('Trade', 'private whisper', 2)],
        });
        const ada = await openPage('101');
        await ada.persistence.load();
        await ada.persistence.flush();
        const bob = await openPage('202');
        await bob.persistence.load();
        bob.persistence.record(TRADE, line('Tom', 'wtb shield', 3));
        await bob.persistence.flush();

        expect(shared.db[PUBLIC]).toBeDefined();
        expect(stored(PUBLIC, TRADE)).toEqual(['wtb shield']);
        expect(texts(bob.persistence.messagesFor(TRADE))).toEqual(['wtb shield']);
        expect(texts(ada.persistence.messagesFor(TRADE))).toEqual(['wts sword', 'private whisper']);
    });

    test('a legacy guild tab stays with the character even when the guild record shares its lines', async () => {
        const both = [line('Gil', 'both 1', 5), line('Ann', 'both 2', 6), line('Gil', 'both 3', 7)];
        shared.db[guildKey('g1')] = {
            v: 1,
            savedAt: 5000,
            tabs: { [GUILD]: [...both, line('Gil', 'newer', 8)] },
            live: {},
            at: { [GUILD]: 5000 },
        };
        shared.db[ownKey('101')] = legacyRecord({ [GUILD]: [line('Gil', 'older', 4), ...both] }, 1000);

        const ada = await openPage('101', 'g1');
        await ada.persistence.load();
        await ada.persistence.flush();

        expect(stored(guildKey('g1'), GUILD)).toEqual(['both 1', 'both 2', 'both 3', 'newer']);
        expect(texts(shared.db[ownKey('101')].legacy[GUILD])).toEqual(['older', 'both 1', 'both 2', 'both 3']);
        expect(shared.db[ownKey('101')].tabs[GUILD]).toBeUndefined();
        // Shown once, in sent order.
        expect(texts(ada.persistence.messagesFor(GUILD))).toEqual(['older', 'both 1', 'both 2', 'both 3', 'newer']);
    });

    test('legacy lines are shown ahead of the shared lines, kept across sessions, and never follow a write', async () => {
        shared.db[ownKey('101')] = legacyRecord({
            [GUILD]: [line('Old', 'old guild secret', 1)],
            [PARTY]: [line('Pat', 'p', 2)],
        });
        const bob = await openPage('202', 'g2');
        await bob.persistence.load();
        bob.persistence.record(GUILD, line('Gil', 'g2 today', 30));
        await bob.persistence.flush();

        const ada = await openPage('101', 'g2');
        const snapshot = await ada.persistence.load();
        await ada.persistence.flush();

        expect(stored(guildKey('g2'), GUILD)).toEqual(['g2 today']);
        expect(texts(shared.db[ownKey('101')].legacy[GUILD])).toEqual(['old guild secret']);
        expect(shared.db[ownKey('101')].tabs[GUILD]).toBeUndefined();
        expect(texts(snapshot[GUILD])).toEqual(['old guild secret', 'g2 today']);
        expect(texts(ada.persistence.messagesFor(GUILD))).toEqual(['old guild secret', 'g2 today']);

        ada.persistence.record(GUILD, line('Gil', 'g2 later', 31));
        await ada.persistence.flush();
        expect(stored(guildKey('g2'), GUILD)).toEqual(['g2 today', 'g2 later']);

        const cy = await openPage('303', 'g2');
        await cy.persistence.load();
        expect(texts(cy.persistence.messagesFor(GUILD))).toEqual(['g2 today', 'g2 later']);

        const again = await openPage('101', 'g2');
        await again.persistence.load();
        expect(texts(again.persistence.messagesFor(GUILD))).toEqual(['old guild secret', 'g2 today', 'g2 later']);
    });

    test('a load that is repeated, or cut short before the record was rewritten, loses and doubles nothing', async () => {
        shared.db[ownKey('101')] = legacyRecord({
            [GLOBAL]: [line('Zed', 'one', 1), line('Zed', 'two', 2)],
            [PARTY]: [line('Pat', 'party', 3)],
        });

        const first = await openPage('101');
        await first.persistence.load();
        // The page closed before its first write: the character record still holds Global.
        expect(shared.db[ownKey('101')].tabs[GLOBAL]).toHaveLength(2);

        const second = await openPage('101');
        const snapshot = await second.persistence.load();
        await second.persistence.flush();

        expect(texts(snapshot[GLOBAL])).toEqual(['one', 'two']);
        expect(shared.db[PUBLIC]).toBeUndefined();
        expect(shared.db[ownKey('101')].tabs[GLOBAL]).toBeUndefined();
        expect(texts(shared.db[ownKey('101')].legacy[GLOBAL])).toEqual(['one', 'two']);

        // A third load, and a write, change nothing.
        const third = await openPage('101');
        await third.persistence.load();
        await third.persistence.flush();
        expect(texts(shared.db[ownKey('101')].legacy[GLOBAL])).toEqual(['one', 'two']);
        expect(stored(ownKey('101'), PARTY)).toEqual(['party']);
    });

    test('a record from the earlier Guild-only revision (guildLegacy) is read as legacy', async () => {
        shared.db[ownKey('101')] = { ...legacyRecord({}), guildLegacy: { [GUILD]: [line('Gil', 'held', 1)] } };
        const ada = await openPage('101', 'g1');
        await ada.persistence.load();
        await ada.persistence.flush();

        expect(texts(ada.persistence.messagesFor(GUILD))).toEqual(['held']);
        expect(texts(shared.db[ownKey('101')].legacy[GUILD])).toEqual(['held']);
    });

    test('a deletion reaches legacy lines, public and guild', async () => {
        shared.db[ownKey('101')] = legacyRecord({
            [GUILD]: [line('Gil', 'keep', 1, 'k1'), line('Gil', 'remove', 2, 'r1')],
            [TRADE]: [line('Tom', 'keep t', 3, 'k2'), line('Tom', 'remove t', 4, 'r2')],
        });
        const ada = await openPage('101', 'g1');
        await ada.persistence.load();

        await expect(ada.persistence.purgeMessageById(GUILD, 'r1')).resolves.toBe(true);
        await expect(ada.persistence.purgeMessageById(TRADE, 'r2')).resolves.toBe(true);
        await ada.persistence.flush();

        expect(texts(ada.persistence.messagesFor(GUILD))).toEqual(['keep']);
        expect(texts(shared.db[ownKey('101')].legacy[GUILD])).toEqual(['keep']);
        expect(texts(shared.db[ownKey('101')].legacy[TRADE])).toEqual(['keep t']);
    });

    test('a write before the first read has landed keeps the legacy lines', async () => {
        shared.db[ownKey('101')] = {
            ...legacyRecord({}),
            legacy: { [GUILD]: [line('Gil', 'held', 1)] },
            guildLegacy: { [GUILD]: [line('Gil', 'held too', 2)] },
        };
        const ada = await openPage('101', 'g1');
        ada.persistence.record(PARTY, line('Pat', 'party before the read', 2));
        await ada.persistence.flushPending();

        expect(texts(shared.db[ownKey('101')].legacy[GUILD])).toEqual(['held']);
        expect(texts(shared.db[ownKey('101')].guildLegacy[GUILD])).toEqual(['held too']);
        expect(stored(ownKey('101'), PARTY)).toEqual(['party before the read']);
    });

    test('legacy lines age out as the shared tab fills the per-tab cap', async () => {
        const old = Array.from({ length: 4 }, (_, i) => line('Zed', `old ${i}`, i + 1));
        shared.db[ownKey('101')] = legacyRecord({ [GLOBAL]: old });
        const ada = await openPage('101');
        ada.persistence.enable(() => 6);
        await ada.persistence.load();
        ada.persistence.setLiveCount(GLOBAL, 0);
        for (let i = 0; i < 3; i += 1) ada.persistence.record(GLOBAL, line('Zed', `new ${i}`, 20 + i));
        await ada.persistence.flush();
        // 3 new + 4 old = 7 > 6: the oldest legacy line goes.
        expect(texts(shared.db[ownKey('101')].legacy[GLOBAL])).toEqual(['old 1', 'old 2', 'old 3']);
        expect(texts(ada.persistence.messagesFor(GLOBAL))).toEqual([
            'old 1',
            'old 2',
            'old 3',
            'new 0',
            'new 1',
            'new 2',
        ]);

        // Once the shared tab holds the whole allowance, none are left.
        for (let i = 3; i < 6; i += 1) ada.persistence.record(GLOBAL, line('Zed', `new ${i}`, 20 + i));
        await ada.persistence.flush();
        expect(shared.db[ownKey('101')].legacy).toBeUndefined();
        expect(stored(PUBLIC, GLOBAL)).toEqual(['new 0', 'new 1', 'new 2', 'new 3', 'new 4', 'new 5']);
    });
});

describe('one game tab switching characters in place', () => {
    /**
     * What the extender's `disable()` and the registry's re-initialise do to
     * this module on `character_switching` and `character_switched`.
     */
    async function switchTo(page, characterId, guildId) {
        const finalFlush = page.persistence.flushForTeardown();
        page.persistence.reset();
        page.characterId = characterId;
        page.characterData = characterData(characterId, guildId);
        page.persistence.enable(() => 150);
        const snapshot = await page.persistence.load();
        await finalFlush;
        return snapshot;
    }

    test('the departing character’s own tabs are written under its own key before the arriving one reads', async () => {
        const page = await openPage('101', 'g1');
        await page.persistence.load();
        page.persistence.record(PARTY, line('Ada', 'ada party', 1));
        page.persistence.record(WHISPER, line('Eve', 'ada whisper', 2));
        page.persistence.record(GLOBAL, line('Zed', 'global before the switch', 3));
        page.persistence.record(GUILD, line('Ada', 'g1 before the switch', 4));

        const snapshot = await switchTo(page, '202', 'g1');

        expect(stored(ownKey('101'), PARTY)).toEqual(['ada party']);
        expect(stored(ownKey('101'), WHISPER)).toEqual(['ada whisper']);
        // The writes were opened before the read of the arriving character's records.
        const firstRead = shared.opened.findIndex((call) => call.includes(ownKey('202')));
        expect(firstRead === -1 || firstRead > shared.opened.indexOf(`set ${ownKey('101')}`)).toBe(true);

        // Nothing of Ada's own carried over; the public and same-guild lines did.
        expect(snapshot[PARTY]).toBeUndefined();
        expect(snapshot[WHISPER]).toBeUndefined();
        expect(texts(snapshot[GLOBAL])).toEqual(['global before the switch']);
        expect(texts(snapshot[GUILD])).toEqual(['g1 before the switch']);
        expect(shared.db[ownKey('202')]?.tabs?.[PARTY]).toBeUndefined();
    });

    test('switching to a character in another guild reads that guild, and writes there', async () => {
        const page = await openPage('101', 'g1');
        await page.persistence.load();
        page.persistence.record(GUILD, line('Ada', 'g1 line', 1));

        const snapshot = await switchTo(page, '202', 'g2');
        expect(snapshot[GUILD]).toBeUndefined();

        page.persistence.record(GUILD, line('Bob', 'g2 line', 2));
        await page.persistence.flush();

        expect(stored(guildKey('g1'), GUILD)).toEqual(['g1 line']);
        expect(stored(guildKey('g2'), GUILD)).toEqual(['g2 line']);
    });

    test('lines the game re-renders after the switch fold into the shared record instead of doubling', async () => {
        const page = await openPage('101', 'g1');
        await page.persistence.load();
        const backlog = [line('Zed', 'a', 1), line('Zed', 'b', 2), line('Zed', 'c', 3)];
        for (const html of backlog) page.persistence.record(GLOBAL, html);

        await switchTo(page, '202', 'g1');
        // The arriving character's Global pane renders the same backlog.
        for (const html of backlog) page.persistence.record(GLOBAL, html);
        await page.persistence.flush();

        expect(stored(PUBLIC, GLOBAL)).toEqual(['a', 'b', 'c']);
    });

    test('a guild change mid-session writes the old guild’s lines to the old guild only', async () => {
        const page = await openPage('101', 'g1');
        await page.persistence.load();
        page.persistence.record(GUILD, line('Ada', 'said in g1', 1));

        page.persistence.noteGuildRoster({ 101: { characterID: '101', guildID: 'g2' } });
        page.persistence.record(GUILD, line('Ada', 'said in g2', 2));
        await page.persistence.flush();

        expect(stored(guildKey('g1'), GUILD)).toEqual(['said in g1']);
        expect(stored(guildKey('g2'), GUILD)).toEqual(['said in g2']);
    });

    test('a guild change whose write to the old guild fails keeps those lines and retries', async () => {
        const bob = await openPage('202', 'g1');
        await bob.persistence.load();
        bob.persistence.record(GUILD, line('Gil', 'to be deleted', 1, 'x1'));
        await bob.persistence.flush();

        const page = await openPage('101', 'g1');
        await page.persistence.load();
        page.persistence.record(GUILD, line('Ada', 'said in g1', 2));
        await page.persistence.purgeMessageById(GUILD, 'x1');

        const { default: storage } = await import('../../core/storage.js');
        const update = storage.update;
        storage.update = async (key, mutate) => (key === guildKey('g1') ? null : update(key, mutate));
        try {
            page.persistence.noteGuildRoster({ 101: { characterID: '101', guildID: 'g2' } });
            await page.persistence.flush();
        } finally {
            storage.update = update;
        }
        expect(stored(guildKey('g1'), GUILD)).toEqual(['to be deleted']);

        page.persistence.record(GUILD, line('Ada', 'said in g2', 3));
        await page.persistence.flush();

        expect(stored(guildKey('g1'), GUILD)).toEqual(['said in g1']);
        expect(shared.db[guildKey('g1')].deleted).toEqual(['x1']);
        expect(stored(guildKey('g2'), GUILD)).toEqual(['said in g2']);
        expect(page.persistence.heldGuildWrites.size).toBe(0);
    });

    test('joining a guild mid-session keeps a guildless character’s old guild lines as its own', async () => {
        shared.db[ownKey('101')] = legacyRecord({ [GUILD]: [line('Old', 'from a guild left long ago', 1)] });
        const page = await openPage('101', null);
        await page.persistence.load();
        expect(texts(page.persistence.messagesFor(GUILD))).toEqual(['from a guild left long ago']);

        page.persistence.noteGuildRoster({ 101: { characterID: '101', guildID: 'g2' } });
        page.persistence.record(GUILD, line('Gil', 'g2 now', 2));
        await page.persistence.flush();

        expect(stored(guildKey('g2'), GUILD)).toEqual(['g2 now']);
        expect(texts(shared.db[ownKey('101')].legacy[GUILD])).toEqual(['from a guild left long ago']);
        expect(texts(page.persistence.messagesFor(GUILD))).toEqual(['from a guild left long ago', 'g2 now']);
    });

    test('a roster row for another member says nothing about this character’s guild', async () => {
        const page = await openPage('101', 'g1');
        await page.persistence.load();
        page.persistence.noteGuildRoster({ 999: { characterID: '999', guildID: 'g7' } });
        page.persistence.record(GUILD, line('Ada', 'still g1', 1));
        await page.persistence.flush();

        expect(stored(guildKey('g1'), GUILD)).toEqual(['still g1']);
        expect(shared.db[guildKey('g7')]).toBeUndefined();
    });
});

describe('mergeLists', () => {
    test('a line another tab trimmed goes back to the front, where the cap takes it again', async () => {
        const { module } = await openPage('101');
        const base = [line('Z', 'b', 2), line('Z', 'c', 3)];
        const incoming = [line('Z', 'a', 1), line('Z', 'b', 2), line('Z', 'd', 4)];
        // `d` is newer than its anchor `b`; where it falls against `c`, which only the base has, nothing says —
        // it goes before the next line both hold, and with none, last.
        expect(texts(module.mergeLists(base, incoming))).toEqual(['a', 'b', 'c', 'd']);
    });

    test('lines between two anchors stay between them', async () => {
        const { module } = await openPage('101');
        const base = [line('Z', 'a', 1), line('Z', 'c', 3)];
        const incoming = [line('Z', 'a', 1), line('Z', 'b', 2), line('Z', 'c', 3)];
        expect(texts(module.mergeLists(base, incoming))).toEqual(['a', 'b', 'c']);
    });

    test('the copy carrying the game’s id is the one kept', async () => {
        const { module } = await openPage('101');
        const merged = module.mergeLists([line('Z', 'a', 1, 'm1')], [line('Z', 'a', 1)]);
        expect(merged).toEqual([line('Z', 'a', 1, 'm1')]);
    });
});

describe('stored lines are kept in the order they were sent', () => {
    /** A line with a whole stamp of its own, as `[M/D h:mm:ss AM]`. */
    function sent(stamp, text, sender = 'Gil') {
        return line(sender, text, 0).replace(/\[10\/1 12:00:00 PM\] /, `[${stamp}] `);
    }

    /** Open a page whose client writes month first, at a fixed instant. */
    async function openAt(iso, characterId = '101', guildId = 'g1') {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(iso));
        const page = await openPage(characterId, guildId);
        (await import('../../utils/locale-date-order.js'))._resetDateFieldOrder(false);
        return page;
    }

    test('two sent-order lists that each hold lines the other lacks merge in sent order', async () => {
        const { module } = await openAt('2026-10-01T13:00:00');
        const a = sent('10/1 7:00:01 AM', 'a');
        const b = sent('10/1 7:00:02 AM', 'b');
        const c = sent('10/1 7:00:03 AM', 'c');
        const e = sent('10/1 7:00:05 AM', 'e');
        // Without the stamps, `b` lands before its anchor `e` but after `c`, which only the base holds.
        expect(texts(module.mergeLists([a, c, e], [b, e]))).toEqual(['a', 'b', 'c', 'e']);
    });

    test('a character record holding late copies of old lines stays legacy, and restores, in sent order', async () => {
        // The shape found live: older builds re-recorded a re-rendered backlog's old lines after today's.
        const legacy = [
            sent('10/1 7:42:44 AM', 'today 1'),
            sent('9/28 10:48:38 AM', 'sep 28 a'),
            sent('10/1 7:47:29 AM', 'today 2'),
            sent('9/28 4:00:14 PM', 'sep 28 b'),
            sent('9/30 2:15:43 AM', 'sep 30'),
            sent('10/1 5:58:28 AM', 'early 2'),
            sent('10/1 5:57:39 AM', 'early 1'),
        ];
        shared.db[guildKey('g1')] = {
            v: 1,
            savedAt: 5000,
            tabs: {
                [GUILD]: [
                    sent('9/30 2:15:43 AM', 'sep 30'),
                    sent('10/1 5:57:39 AM', 'early 1'),
                    sent('10/1 7:47:29 AM', 'today 2'),
                    sent('10/1 8:00:00 AM', 'today 3'),
                ],
            },
            live: {},
            at: { [GUILD]: 5000 },
        };
        shared.db[ownKey('101')] = legacyRecord({ [GUILD]: legacy }, 1000);

        const ada = await openAt('2026-10-01T13:00:00');
        const snapshot = await ada.persistence.load();
        await ada.persistence.flush();

        const order = ['sep 28 a', 'sep 28 b', 'sep 30', 'early 1', 'early 2', 'today 1', 'today 2', 'today 3'];
        // Only the shared lines are in the shared record; the character's own are merged in at restore.
        expect(stored(guildKey('g1'), GUILD)).toEqual(['sep 30', 'early 1', 'today 2', 'today 3']);
        expect(texts(snapshot[GUILD])).toEqual(order);
        expect(texts(ada.persistence.messagesFor(GUILD))).toEqual(order);
    });

    test('held guild lines out of order are shown in sent order ahead of the guild record', async () => {
        shared.db[ownKey('101')] = legacyRecord(
            { [GUILD]: [sent('10/1 7:42:44 AM', 'held new'), sent('9/28 10:48:38 AM', 'held old')] },
            1000
        );
        const ada = await openAt('2026-10-01T13:00:00', '101', 'g2');
        const snapshot = await ada.persistence.load();
        expect(texts(snapshot[GUILD])).toEqual(['held old', 'held new']);
    });

    test('a shared record already out of order reads back in order, and is written back in order', async () => {
        shared.db[guildKey('g1')] = {
            v: 1,
            savedAt: 5000,
            tabs: {
                [GUILD]: [
                    sent('10/1 7:42:44 AM', 'today'),
                    sent('9/28 10:48:38 AM', 'old'),
                    sent('10/1 9:00:00 AM', 'later'),
                ],
            },
            live: {},
            at: { [GUILD]: 5000 },
        };
        const ada = await openAt('2026-10-01T13:00:00');
        const snapshot = await ada.persistence.load();
        expect(texts(snapshot[GUILD])).toEqual(['old', 'today', 'later']);

        ada.persistence.record(GUILD, sent('10/1 9:30:00 AM', 'new'));
        await ada.persistence.flush();
        expect(stored(guildKey('g1'), GUILD)).toEqual(['old', 'today', 'later', 'new']);
    });

    test('lines sharing a stamp keep the order they were seen in', async () => {
        const { module } = await openAt('2026-10-01T13:00:00');
        const same = '10/1 7:00:00 AM';
        const base = [sent(same, 'second', 'B'), sent('9/30 1:00:00 AM', 'out of place'), sent(same, 'first', 'A')];
        expect(texts(module.mergeLists(base, []))).toEqual(['out of place', 'second', 'first']);
    });

    test('a line with no stamp stays just after the line before it', async () => {
        const { module } = await openAt('2026-10-01T13:00:00');
        const bare = line('Sys', 'no stamp', 0).replace(/\[10\/1 12:00:00 PM\] /, '');
        const list = [sent('10/1 7:00:00 AM', 'new'), bare, sent('9/30 1:00:00 AM', 'old')];
        expect(texts(module.mergeLists(list, []))).toEqual(['old', 'new', 'no stamp']);
    });

    test('December lines read in January sort before January’s', async () => {
        const { module } = await openAt('2027-01-02T10:00:00');
        const list = [sent('1/1 12:00:01 AM', 'new year'), sent('12/31 11:59:59 PM', 'old year')];
        expect(texts(module.mergeLists(list, []))).toEqual(['old year', 'new year']);
    });
});
