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

        expect(module.tabScope('tab2:name:中文')).toBe('public');
        expect(module.tabScope('tab2:name:Help')).toBe('public');
        expect(module.tabScope('tab2:name:Guild')).toBe('guild');
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

describe('the move out of the character records', () => {
    test('four tabs migrating at once lose nothing and duplicate nothing', async () => {
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

        expect(stored(PUBLIC, GLOBAL).sort()).toEqual(['common', 'only 101', 'only 202', 'only 303', 'only 404']);
        expect(stored(guildKey('g1'), GUILD)).toEqual(['g1 common']);
        expect(stored(guildKey('g2'), GUILD)).toEqual(['g2 common']);
        ids.forEach((id) => {
            const own = shared.db[ownKey(id)];
            expect(Object.keys(own.tabs)).toEqual([PARTY]);
            expect(stored(ownKey(id), PARTY)).toEqual([`party of ${id}`]);
            expect(own.sharedMigrated).toBe(true);
        });
    });

    test('a migration cut short before the character record was rewritten runs again without doubling anything', async () => {
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

        expect(stored(PUBLIC, GLOBAL)).toEqual(['one', 'two']);
        expect(texts(snapshot[GLOBAL])).toEqual(['one', 'two']);
        expect(shared.db[ownKey('101')].tabs[GLOBAL]).toBeUndefined();

        // And once done, a third load moves nothing.
        shared.opened = [];
        const third = await openPage('101');
        await third.persistence.load();
        expect(shared.opened.filter((call) => call.startsWith('update'))).toEqual([]);
    });

    test('an older character record that shares no line with the shared one goes before it', async () => {
        shared.db[PUBLIC] = {
            v: 1,
            savedAt: 5000,
            tabs: { [GLOBAL]: [line('Zed', 'today', 30)] },
            live: {},
            at: { [GLOBAL]: 5000 },
        };
        shared.db[ownKey('101')] = legacyRecord({ [GLOBAL]: [line('Zed', 'last week', 1)] }, 1000);

        const ada = await openPage('101');
        await ada.persistence.load();

        expect(stored(PUBLIC, GLOBAL)).toEqual(['last week', 'today']);
    });

    test('a shared tab whose move failed stays in the character record', async () => {
        const legacy = legacyRecord({ [GLOBAL]: [line('Zed', 'not lost', 1)], [PARTY]: [line('Pat', 'p', 2)] });
        shared.db[ownKey('101')] = legacy;
        const ada = await openPage('101');
        const { default: storage } = await import('../../core/storage.js');
        const update = storage.update;
        storage.update = async () => null;
        try {
            await ada.persistence.load();
            await ada.persistence.flush();
        } finally {
            storage.update = update;
        }

        expect(stored(ownKey('101'), GLOBAL)).toEqual(['not lost']);
        expect(shared.db[ownKey('101')].sharedMigrated).toBe(false);
        expect(shared.db[PUBLIC]).toBeUndefined();
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
