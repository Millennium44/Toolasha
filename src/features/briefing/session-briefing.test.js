/**
 * @vitest-environment happy-dom
 *
 * The card itself: what it draws, what its lines do when clicked, and whether
 * closing it makes it stay closed.
 *
 * The arithmetic is `briefing-lines.test.js`'s problem. What only a DOM can
 * catch is the thing this feature is most exposed to: it reads eleven other
 * features' stores, so a renamed accessor anywhere would blank a section
 * silently. The dullest assertion here — the panel drew and reported no
 * failure — is the one that catches that.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

/** Everything the collector reads, swapped between tests */
const game = vi.hoisted(() => ({
    characterId: 'char-1',
    characterInfo: {},
    characterQuests: [],
    communityBuffs: [],
    listings: [],
    queue: null,
    snapshots: [],
    ownSnapshot: null,
    rerolls: { known: false, available: false, remaining: null },
    consumable: null,
    labyrinth: { ok: false },
    enhancementSession: null,
    undercutStates: new Map(),
    guildMeta: null,
    stored: new Map(),
    settingOn: true,
    opened: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => game.settingOn,
        Z_FLOATING_PANEL: 100,
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.characterId,
        getMarketListings: () => game.listings,
        getInitClientData: () => ({
            communityBuffTypeDetailMap: { '/community_buff_type/experience': { name: 'XP' } },
        }),
        get characterData() {
            return { characterInfo: game.characterInfo, communityBuffs: game.communityBuffs };
        },
        get characterQuests() {
            return game.characterQuests;
        },
        on: () => {},
        off: () => {},
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback = null) => (game.stored.has(key) ? game.stored.get(key) : fallback),
        set: async (key, value) => {
            game.stored.set(key, value);
        },
    },
}));

// Geometry lives in IndexedDB and is not what this file is about
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
    markPanelInteracted: () => {},
}));

vi.mock('../../utils/overlay-rows.js', () => ({ registerRow: () => {} }));

vi.mock('../queue-monitor/queue-time-row.js', () => ({ queueTimeLeft: () => game.queue }));

vi.mock('../queue-monitor/queue-snapshot.js', () => ({
    default: {
        getSnapshot: () => game.ownSnapshot,
        getOtherCharacterSnapshots: () => game.snapshots,
    },
}));

vi.mock('../tasks/task-reroll-options.js', () => ({ readFreeRerollOffer: () => game.rerolls }));

vi.mock('../notifications/combat-consumable-alerts.js', () => ({ soonestCombatConsumable: () => game.consumable }));

vi.mock('../notifications/labyrinth-entry-forecast.js', () => ({ forecastLabyrinthEntries: () => game.labyrinth }));

vi.mock('../notifications/market-undercut-alerts.js', () => ({
    default: {
        get listingStates() {
            return game.undercutStates;
        },
    },
}));

vi.mock('../enhancement/enhancement-tracker.js', () => ({
    default: { getCurrentSession: () => game.enhancementSession },
}));

vi.mock('../../utils/bundle-bridge.js', () => ({
    guildXpTracker: () =>
        game.guildMeta
            ? { getMemberMeta: () => game.guildMeta, getCurrentWeekStartAt: () => game.guildMeta.week || null }
            : null,
    consumablesPanel: () => ({ show: () => game.opened.push('consumables') }),
}));

vi.mock('../../utils/item-navigation.js', () => ({
    navigateToAction: (hrid) => {
        game.opened.push(`action:${hrid}`);
        return true;
    },
}));

const {
    briefingPanel,
    collectFacts,
    maybeShowBriefing,
    labyrinthFact,
    _resetBriefingState,
    OPENERS,
    default: feature,
} = await import('./session-briefing.js');

/** The panel's rendered text */
function text() {
    return briefingPanel.panel?.textContent || '';
}

/** The rendered line rows */
function lineRows() {
    return [...(briefingPanel.panel?.querySelectorAll('.toolasha-briefing-line') || [])];
}

/**
 * Put a nav button on the page so a line has something to click.
 * @param {string} ariaLabel - The icon's aria-label
 * @returns {HTMLElement} The button
 */
function addNav(ariaLabel) {
    const nav = document.createElement('div');
    nav.className = 'NavigationBar_nav__3uuUl';
    nav.innerHTML = `<svg aria-label="${ariaLabel}"></svg>`;
    nav.addEventListener('click', () => game.opened.push(ariaLabel));
    document.body.appendChild(nav);
    return nav;
}

beforeEach(() => {
    Object.assign(game, {
        characterId: 'char-1',
        characterInfo: {},
        characterQuests: [],
        communityBuffs: [],
        listings: [],
        queue: null,
        snapshots: [],
        ownSnapshot: null,
        rerolls: { known: false, available: false, remaining: null },
        consumable: null,
        labyrinth: { ok: false },
        enhancementSession: null,
        undercutStates: new Map(),
        guildMeta: null,
        settingOn: true,
        opened: [],
    });
    game.stored.clear();
    _resetBriefingState();
});

afterEach(() => {
    briefingPanel.hide({ remember: false });
    _resetBriefingState();
    document.body.replaceChildren();
});

describe('collectFacts', () => {
    test('reads every source without throwing when the game is empty', () => {
        const facts = collectFacts(1_000);
        expect(facts.queue).toBeNull();
        expect(facts.tasksReady).toBe(0);
        // `undercut` is null, not zero: the watcher has compared nothing yet,
        // and "no listings are undercut" would be a reassurance nobody checked
        expect(facts.listings).toEqual({ filled: 0, undercut: null });
        expect(facts.idle).toEqual([]);
    });

    test('projects when this character queue emptied, from its own snapshot', () => {
        game.ownSnapshot = { timestamp: 1_000, totalQueueSeconds: 60, hasInfiniteAction: false };
        game.queue = { queued: 0, seconds: 0 };
        expect(collectFacts(100_000).queue.emptySince).toBe(61_000);
    });

    test('a queue that has not run out yet has no emptied-at', () => {
        game.ownSnapshot = { timestamp: 1_000, totalQueueSeconds: 600, hasInfiniteAction: false };
        game.queue = { queued: 1, seconds: 100 };
        expect(collectFacts(2_000).queue.emptySince).toBeNull();
    });

    test('community buffs are named from the game and dated from their expiry', () => {
        game.communityBuffs = [
            { hrid: '/community_buff_type/experience', expireTime: '2024-01-01T00:00:00Z' },
            { hrid: '/community_buff_type/gathering', expireTime: '2024-01-01T00:00:00Z', isDone: true },
        ];
        const buffs = collectFacts().buffs;
        expect(buffs).toHaveLength(1);
        expect(buffs[0].name).toBe('XP');
    });

    test('beaten listings are counted off the undercut watcher rather than recomputed', () => {
        game.undercutStates = new Map([
            [1, { armed: false }],
            [2, { armed: true }],
            [3, { armed: false }],
        ]);
        expect(collectFacts().listings.undercut).toBe(2);
    });

    test('a signup from a previous week is not a signup', () => {
        game.guildMeta = { week: '2024-W10', signupWeekStartAt: '2024-W09', signedUpCombatTrialHrid: '/trial/x' };
        expect(collectFacts().guild).toEqual({ signedUp: false, trialName: null });
    });

    test('this week signup reports the trial', () => {
        game.guildMeta = { week: '2024-W10', signupWeekStartAt: '2024-W10', signedUpCombatTrialHrid: '/trial/eyes' };
        expect(collectFacts().guild).toEqual({ signedUp: true, trialName: 'eyes' });
    });

    test('no guild bundle means nothing is claimed about the trial', () => {
        expect(collectFacts().guild).toBeNull();
    });
});

describe('labyrinthFact', () => {
    test('the line is given the entry COUNT, not the forecast’s "is one due" flag', () => {
        // The forecast's own `available` is a boolean. Passed straight through,
        // the line printed "true available" — and `true > 0`, so it printed it
        // whenever a cooldown had elapsed rather than when entries were banked.
        const forecast = { ok: true, entries: 3, isFull: false, available: true, msUntilNext: -5 };
        expect(labyrinthFact(forecast)).toEqual({ ok: true, available: 3, isFull: false });
    });

    test('a forecast that could not be made says nothing', () => {
        expect(labyrinthFact({ ok: false, reason: 'incomplete labyrinth info' })).toBeNull();
        expect(labyrinthFact(null)).toBeNull();
    });
});

describe('the card', () => {
    test('draws only the lines with something to say, and reports no failure', () => {
        game.queue = { queued: 0, seconds: 0 };
        game.labyrinth = { ok: true, entries: 3, isFull: false };

        briefingPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        expect(lineRows().map((row) => row.dataset.briefingKey)).toEqual(['queue', 'labyrinth']);
        expect(text()).toContain('Action queue');
        expect(text()).toContain('Labyrinth entries');
        expect(text()).not.toContain('Task board');
    });

    test('says so when nothing needs the player', () => {
        briefingPanel.show({ remember: false });
        expect(text()).toContain('Nothing needs you right now.');
        expect(lineRows()).toHaveLength(0);
    });

    test('every subject at once still draws', () => {
        const now = Date.now();
        game.queue = { queued: 2, seconds: 120 };
        game.characterInfo = {
            unreadTaskCount: 3,
            taskSlotCap: 5,
            taskCooldownHours: 1,
            lastTaskTimestamp: new Date(now).toISOString(),
        };
        game.rerolls = { known: true, available: true, remaining: 1 };
        game.communityBuffs = [
            { hrid: '/community_buff_type/experience', expireTime: new Date(now + 60_000).toISOString() },
        ];
        game.consumable = { name: 'Coffee', secondsLeft: 900 };
        game.undercutStates = new Map([[1, { armed: false }]]);
        game.enhancementSession = {
            itemName: 'Sword',
            currentLevel: 3,
            targetLevel: 7,
            protectionCount: 1,
            state: 'tracking',
            lastUpdateTime: Date.now(),
        };
        game.guildMeta = { week: 'w', signupWeekStartAt: 'w', signedUpSkillingTrialHrid: '/trial/looms' };
        game.labyrinth = { ok: true, entries: 2, isFull: false };
        game.snapshots = [
            { characterId: 'alt', characterName: 'Alt', timestamp: 1, totalQueueSeconds: 0, actions: [] },
        ];

        briefingPanel.show({ remember: false });

        expect(text()).not.toContain('could not be drawn');
        const keys = lineRows().map((row) => row.dataset.briefingKey);
        expect(keys).toContain('rerolls');
        expect(keys).toContain('buffs');
        expect(keys).toContain('consumable');
        expect(keys).toContain('listings');
        expect(keys).toContain('enhancement');
        expect(keys).toContain('guild');
        expect(keys).toContain('idle');
    });
});

describe('the links', () => {
    test('a line with somewhere to go navigates there when clicked', () => {
        addNav('navigationBar.labyrinth');
        game.labyrinth = { ok: true, entries: 3, isFull: false };

        briefingPanel.show({ remember: false });
        const row = lineRows().find((entry) => entry.dataset.briefingKey === 'labyrinth');
        expect(row.style.cursor).toBe('pointer');
        row.click();

        expect(game.opened).toContain('navigationBar.labyrinth');
    });

    test('a stopped enhancement run is not news — stale or non-tracking sessions stay off the card', () => {
        game.enhancementSession = {
            itemName: 'Sword',
            currentLevel: 3,
            targetLevel: 7,
            protectionCount: 1,
            state: 'tracking',
            lastUpdateTime: Date.now() - 2 * 60 * 60 * 1000,
        };
        briefingPanel.show({ remember: false });
        expect(lineRows().map((row) => row.dataset.briefingKey)).not.toContain('enhancement');
        briefingPanel.hide();

        game.enhancementSession = {
            itemName: 'Sword',
            currentLevel: 7,
            targetLevel: 7,
            protectionCount: 1,
            state: 'completed',
            lastUpdateTime: Date.now(),
        };
        briefingPanel.show({ remember: false });
        expect(lineRows().map((row) => row.dataset.briefingKey)).not.toContain('enhancement');
    });

    test('the enhancement line opens the enhancing action', () => {
        game.enhancementSession = {
            itemName: 'Sword',
            currentLevel: 1,
            targetLevel: 4,
            protectionCount: 0,
            state: 'tracking',
            lastUpdateTime: Date.now(),
        };
        briefingPanel.show({ remember: false });
        lineRows()
            .find((entry) => entry.dataset.briefingKey === 'enhancement')
            .click();
        expect(game.opened).toContain('action:/actions/enhancing/enhance');
    });

    test('the consumable line opens the consumables panel', () => {
        OPENERS.consumables();
        expect(game.opened).toContain('consumables');
    });

    test('a line with nowhere to go is not dressed as a link', () => {
        game.snapshots = [
            { characterId: 'alt', characterName: 'Alt', timestamp: 1, totalQueueSeconds: 0, actions: [] },
        ];
        briefingPanel.show({ remember: false });
        const row = lineRows().find((entry) => entry.dataset.briefingKey === 'idle');
        expect(row.style.cursor).toBe('');
    });

    test('a missing nav button is survived rather than thrown over', () => {
        game.labyrinth = { ok: true, entries: 3, isFull: false };
        briefingPanel.show({ remember: false });
        expect(() => lineRows()[0].click()).not.toThrow();
    });
});

describe('showing and dismissing', () => {
    test('shows on arrival when there is something to say', () => {
        game.queue = { queued: 0, seconds: 0 };
        expect(maybeShowBriefing()).toBe(true);
        expect(briefingPanel.panel).toBeTruthy();
    });

    test('does not show when there is nothing to say', () => {
        expect(maybeShowBriefing()).toBe(false);
        expect(briefingPanel.panel).toBeNull();
    });

    test('does not show when the setting is off', () => {
        game.queue = { queued: 0, seconds: 0 };
        game.settingOn = false;
        expect(maybeShowBriefing()).toBe(false);
    });

    test('a dismissal is remembered for the rest of the session', () => {
        game.queue = { queued: 0, seconds: 0 };
        expect(maybeShowBriefing()).toBe(true);

        briefingPanel.hide();
        expect(briefingPanel.panel).toBeNull();

        expect(maybeShowBriefing()).toBe(false);
        expect(briefingPanel.panel).toBeNull();
    });

    test('the dismissal belongs to the character who made it', () => {
        game.queue = { queued: 0, seconds: 0 };
        maybeShowBriefing();
        briefingPanel.hide();

        game.characterId = 'char-2';
        expect(maybeShowBriefing()).toBe(true);
    });

    test('a character switch closes the card without counting as a dismissal', () => {
        game.queue = { queued: 0, seconds: 0 };
        maybeShowBriefing();

        feature.cleanup();
        expect(briefingPanel.panel).toBeNull();
        expect(maybeShowBriefing()).toBe(true);
    });

    test('a character switch clears the stale market-fill count before the new character has loaded its own', async () => {
        // char-1 filled a listing this session
        game.listings = [{ id: 1, status: '/market_listing_status/filled' }];
        await feature.initialize();
        expect(collectFacts().listings.filled).toBe(1);

        // character_switching fires: the overlay panel re-initializes and can
        // redraw the tile well before this feature's own initialize() (and
        // its loadListingDelta) runs again for the new character — cleanup()
        // is the only thing that runs synchronously at that moment
        feature.cleanup();

        expect(collectFacts().listings.filled).toBe(0);
    });
});

describe('what the market did while away', () => {
    test('a newly filled listing counts, one already filled last session does not', async () => {
        game.listings = [
            { id: 1, status: '/market_listing_status/filled' },
            { id: 2, status: '/market_listing_status/filled' },
        ];
        game.stored.set('sessionBriefingListings_char-1', {
            at: 1,
            listings: { 1: '/market_listing_status/filled', 2: '/market_listing_status/active' },
        });

        await feature.initialize();

        expect(collectFacts().listings.filled).toBe(1);
        // and this session becomes the next one's baseline
        expect(game.stored.get('sessionBriefingListings_char-1').listings).toEqual({
            1: '/market_listing_status/filled',
            2: '/market_listing_status/filled',
        });
    });

    test('with no baseline every filled listing is news', async () => {
        game.listings = [{ id: 7, status: '/market_listing_status/filled' }];
        await feature.initialize();
        expect(collectFacts().listings.filled).toBe(1);
    });

    test('no expiry is claimed, because none can be seen', async () => {
        // `mergeMarketListings` drops expired listings before this feature ever
        // sees them, so the briefing does not carry a counter that can only
        // ever print zero
        game.listings = [{ id: 7, status: '/market_listing_status/active', _toolashaStatus: 'expired' }];
        await feature.initialize();
        expect(collectFacts().listings.expired).toBeUndefined();
    });

    test('a baseline written by the object-shaped version is still readable', async () => {
        game.listings = [{ id: 7, status: '/market_listing_status/filled' }];
        game.stored.set('sessionBriefingListings_char-1', {
            at: 1,
            listings: { 7: { status: '/market_listing_status/filled', toolashaStatus: '' } },
        });

        await feature.initialize();

        expect(collectFacts().listings.filled).toBe(0);
    });

    test('a plain-string baseline is what gets written now', async () => {
        game.listings = [{ id: 7, status: '/market_listing_status/filled' }];
        await feature.initialize();

        expect(game.stored.get('sessionBriefingListings_char-1').listings).toEqual({
            7: '/market_listing_status/filled',
        });
    });
});
