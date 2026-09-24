/**
 * @vitest-environment happy-dom
 *
 * The briefing section: what it says, where it goes, and when it goes there.
 *
 * The arithmetic is `briefing-lines.test.js`'s problem. What only a DOM can
 * catch is the thing this feature is most exposed to: it reads eleven other
 * features' stores and writes into a dialog it does not own, so a renamed
 * accessor anywhere would blank a block silently. The dullest assertion here —
 * the section drew and reported no failure — is the one that catches that.
 *
 * The other half is timing. The modal is a game DOM insertion and the facts
 * become readable on Toolasha's own arrival event; nothing orders those two, so
 * both orders are pinned here, along with the two silences (no modal at all, and
 * the setting switched off) that used to be a panel appearing anyway.
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
        getSettingValue: () => game.settingOn,
        Z_FLOATING_PANEL: 100,
    },
}));

// The shared modal watcher (utils/welcome-back-modal.js) goes through this, and
// the tests drive it by hand: a real MutationObserver would make the order of
// the two signals a race rather than something a test can state.
const observer = vi.hoisted(() => ({ handlers: [], unregistered: 0 }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, classes, callback) => {
            const entry = { name, classes, callback };
            observer.handlers.push(entry);
            return () => {
                observer.unregistered += 1;
                observer.handlers = observer.handlers.filter((held) => held !== entry);
            };
        },
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

// Geometry lives in IndexedDB and is not what this file is about. The briefing
// itself has no panel any more, but the notice-log panel it imports for one
// line's opener does, and that panel is built at module scope.
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

const rows = vi.hoisted(() => ({ registered: [] }));
vi.mock('../../utils/overlay-rows.js', () => ({
    registerRow: (row) => {
        rows.registered.push(row);
    },
}));

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

// The other tenant of the same modal. Its own row must keep working beside the
// briefing, which is the whole reason the detection lives in one shared place.
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: () => 100,
}));

const {
    collectFacts,
    renderBriefingSection,
    labyrinthFact,
    _resetBriefingState,
    OPENERS,
    SECTION_CLASS,
    default: feature,
} = await import('./session-briefing.js');

/** The modal the tests write into, once one has been opened */
let modal = null;

/**
 * Put a welcome modal on the page, exactly as the game's markup identifies it.
 * @returns {HTMLElement} The modal content element
 */
function openWelcomeModal() {
    const content = document.createElement('div');
    content.className = 'Modal_modalContent__1jDpH WelcomeBack_welcomeBack__2f8Yq';
    content.innerHTML = '<h2>Welcome Back!</h2><div>02:30:00</div>';
    document.body.appendChild(content);
    modal = content;
    return content;
}

/**
 * Tell every registered watcher that a node appeared.
 * @param {HTMLElement} [node] - What appeared; the open modal by default
 * @returns {void}
 */
function announce(node = modal) {
    for (const handler of [...observer.handlers]) handler.callback(node);
}

/** Open a modal and announce it in one gesture. */
function showWelcomeModal() {
    const content = openWelcomeModal();
    announce(content);
    return content;
}

/** The briefing section, if one was written */
function section() {
    return document.querySelector(`.${SECTION_CLASS}`);
}

/** The briefing section's rendered text */
function text() {
    return section()?.textContent || '';
}

/** The rendered line rows */
function lineRows() {
    return [...(section()?.querySelectorAll('.toolasha-briefing-line') || [])];
}

/** The keys of the rendered line rows */
function lineKeys() {
    return lineRows().map((row) => row.dataset.briefingKey);
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
    observer.handlers = [];
    observer.unregistered = 0;
    modal = null;
    _resetBriefingState();
});

afterEach(() => {
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

describe('the section', () => {
    test('draws only the lines with something to say, and reports no failure', () => {
        game.queue = { queued: 0, seconds: 0 };
        game.labyrinth = { ok: true, entries: 3, isFull: false };

        renderBriefingSection(openWelcomeModal());

        expect(text()).not.toContain('could not be drawn');
        expect(lineKeys()).toEqual(['queue', 'labyrinth']);
        expect(text()).toContain('Action queue');
        expect(text()).toContain('Labyrinth entries');
        expect(text()).not.toContain('Task board');
    });

    test('the section goes inside the modal, at the bottom of it', () => {
        game.queue = { queued: 0, seconds: 0 };
        const content = openWelcomeModal();

        renderBriefingSection(content);

        expect(section().parentElement).toBe(content);
        expect(content.lastElementChild).toBe(section());
    });

    test('nothing to say is said by saying nothing — no section, no "all clear"', () => {
        renderBriefingSection(openWelcomeModal());

        expect(section()).toBeNull();
        expect(document.body.textContent).not.toContain('Nothing needs you');
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

        renderBriefingSection(openWelcomeModal());

        expect(text()).not.toContain('could not be drawn');
        const keys = lineKeys();
        expect(keys).toContain('rerolls');
        expect(keys).toContain('buffs');
        expect(keys).toContain('consumable');
        expect(keys).toContain('listings');
        expect(keys).toContain('enhancement');
        expect(keys).toContain('guild');
        expect(keys).toContain('idle');
    });

    test('a dialog that is not the welcome modal is left completely alone', () => {
        game.queue = { queued: 0, seconds: 0 };
        const other = document.createElement('div');
        other.className = 'Modal_modalContent__1jDpH';
        other.innerHTML = '<h2>Settings</h2>';
        document.body.appendChild(other);

        announce(other);

        expect(section()).toBeNull();
        expect(other.textContent).toBe('Settings');
    });
});

describe('the links', () => {
    test('a line with somewhere to go navigates there when clicked', () => {
        addNav('navigationBar.labyrinth');
        game.labyrinth = { ok: true, entries: 3, isFull: false };

        renderBriefingSection(openWelcomeModal());
        const row = lineRows().find((entry) => entry.dataset.briefingKey === 'labyrinth');
        expect(row.style.cursor).toBe('pointer');
        row.click();

        expect(game.opened).toContain('navigationBar.labyrinth');
    });

    test('a stopped enhancement run is not news — stale or non-tracking sessions stay off the section', () => {
        game.enhancementSession = {
            itemName: 'Sword',
            currentLevel: 3,
            targetLevel: 7,
            protectionCount: 1,
            state: 'tracking',
            lastUpdateTime: Date.now() - 2 * 60 * 60 * 1000,
        };
        renderBriefingSection(openWelcomeModal());
        expect(lineKeys()).not.toContain('enhancement');

        document.body.replaceChildren();
        game.enhancementSession = {
            itemName: 'Sword',
            currentLevel: 7,
            targetLevel: 7,
            protectionCount: 1,
            state: 'completed',
            lastUpdateTime: Date.now(),
        };
        renderBriefingSection(openWelcomeModal());
        expect(lineKeys()).not.toContain('enhancement');
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
        renderBriefingSection(openWelcomeModal());
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
        renderBriefingSection(openWelcomeModal());
        const row = lineRows().find((entry) => entry.dataset.briefingKey === 'idle');
        expect(row.style.cursor).toBe('');
    });

    test('a missing nav button is survived rather than thrown over', () => {
        game.labyrinth = { ok: true, entries: 3, isFull: false };
        renderBriefingSection(openWelcomeModal());
        expect(() => lineRows()[0].click()).not.toThrow();
    });
});

/**
 * Two unrelated signals, either order.
 *
 * The modal is inserted by the game and the facts are gathered by
 * `initialize()`, which feature-registry runs on `character_switched`. Nothing
 * orders those two, so the feature has to be right in both orders — and in the
 * two cases where one of them never comes at all.
 */
describe('the modal and the facts, in either order', () => {
    test('a modal that appears first is filled in when the facts arrive', async () => {
        game.queue = { queued: 0, seconds: 0 };

        const init = feature.initialize();
        // The game draws its dialog while the stored listing baseline is still
        // being read: nothing may be written yet, because the facts behind it
        // are not all readable
        showWelcomeModal();
        expect(section()).toBeNull();

        await init;

        expect(section()).not.toBeNull();
        expect(text()).toContain('Action queue');
        expect(text()).not.toContain('could not be drawn');
    });

    test('the section goes above the dialog’s Close button, not under it', async () => {
        // Under Close is under the button the player is already reaching for
        game.queue = { queued: 0, seconds: 0 };
        const container = document.createElement('div');
        container.className = 'OfflineProgressModal_modalContainer__x';
        container.innerHTML =
            '<div class="OfflineProgressModal_modalContent__x">' +
            '<h2>Welcome Back!</h2><div class="body">stuff</div>' +
            '<div class="closeRow"><button>Close</button></div>' +
            '</div>';
        document.body.appendChild(container);

        await feature.initialize();

        const drawn = section();
        const closeRow = container.querySelector('.closeRow');
        expect(drawn).not.toBeNull();
        // Document order: the section comes first
        expect(drawn.compareDocumentPosition(closeRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    test('a dialog with no Close button still gets the section, at the end', async () => {
        game.queue = { queued: 0, seconds: 0 };
        const container = document.createElement('div');
        container.className = 'OfflineProgressModal_modalContent__x';
        container.innerHTML = '<h2>Welcome Back!</h2>';
        document.body.appendChild(container);

        await feature.initialize();

        expect(section()).not.toBeNull();
        expect(container.lastElementChild.className).toContain(SECTION_CLASS);
    });

    test('the section lands in the box the player can see, not the full-screen container', async () => {
        // The live shape, 2026-09-17: the game's dialog is a viewport-sized
        // container holding a backdrop and the visible box. Appending to the
        // container put the section at y=1099 in a 1091px viewport — rendered,
        // reachable by a test, and invisible to the player.
        game.queue = { queued: 0, seconds: 0 };
        const container = document.createElement('div');
        container.className = 'OfflineProgressModal_modalContainer__x';
        container.innerHTML =
            '<div class="OfflineProgressModal_background__x"></div>' +
            '<div class="OfflineProgressModal_modal__x">' +
            '<div class="OfflineProgressModal_modalContent__x"><h2>Welcome Back!</h2></div>' +
            '</div>';
        document.body.appendChild(container);

        await feature.initialize();

        const drawn = section();
        expect(drawn).not.toBeNull();
        expect(drawn.closest('[class*="modalContent"]')).not.toBeNull();
        expect(drawn.parentElement.className).toContain('modalContent');
    });

    test('a dialog already open before this feature starts is found, not waited for', async () => {
        // The live failure, 2026-09-17: the game draws its Welcome Back dialog
        // as the player arrives, which is BEFORE character_switched brings this
        // feature up. A MutationObserver only reports insertions, so nothing
        // ever announced that modal and the briefing was silently never drawn.
        // Opening it without announcing is exactly that situation.
        game.queue = { queued: 0, seconds: 0 };
        openWelcomeModal();

        await feature.initialize();

        expect(section()).not.toBeNull();
        expect(text()).toContain('Action queue');
        expect(text()).not.toContain('could not be drawn');
    });

    test('an unannounced dialog that is closed again is not written into', async () => {
        game.queue = { queued: 0, seconds: 0 };
        const content = openWelcomeModal();
        content.remove();

        await feature.initialize();

        expect(section()).toBeNull();
    });

    test('facts that were ready first are drawn the moment a modal appears', async () => {
        game.queue = { queued: 0, seconds: 0 };

        await feature.initialize();
        expect(section()).toBeNull();

        showWelcomeModal();

        expect(section()).not.toBeNull();
        expect(text()).toContain('Action queue');
    });

    test('no modal means nothing is rendered anywhere', async () => {
        game.queue = { queued: 0, seconds: 0 };

        await feature.initialize();

        expect(section()).toBeNull();
        expect(document.body.textContent).toBe('');
    });

    test('a modal closed before the facts land is not written into', async () => {
        game.queue = { queued: 0, seconds: 0 };

        const init = feature.initialize();
        const content = showWelcomeModal();
        content.remove();

        await init;

        expect(section()).toBeNull();
    });

    test('the section is appended once however often the watcher fires', async () => {
        game.queue = { queued: 0, seconds: 0 };
        await feature.initialize();

        showWelcomeModal();
        announce();
        announce();
        // And a node from inside the modal, which is what the game's own bursts
        // actually deliver
        announce(modal.querySelector('h2'));

        expect(document.querySelectorAll(`.${SECTION_CLASS}`)).toHaveLength(1);
    });

    test('the setting off means nothing is watched for and nothing is written', async () => {
        game.settingOn = false;
        game.queue = { queued: 0, seconds: 0 };

        await feature.initialize();
        showWelcomeModal();

        expect(observer.handlers).toHaveLength(0);
        expect(section()).toBeNull();
    });

    test('a character switch unhooks the watcher and takes the section with it', async () => {
        game.queue = { queued: 0, seconds: 0 };
        await feature.initialize();
        showWelcomeModal();
        expect(section()).not.toBeNull();

        feature.cleanup();

        expect(observer.handlers).toHaveLength(0);
        expect(observer.unregistered).toBe(1);
        expect(section()).toBeNull();
    });

    test('a modal left open across a character switch is not reused for the arriving character', async () => {
        // The switch pipeline is in-page — character_switching/character_switched,
        // never a reload — and cleanup() only strips this feature's own section,
        // not the game's dialog. A player who switches while the dialog is still
        // open leaves that exact node sitting there, still matching every marker
        // isWelcomeBackModal checks.
        game.queue = { queued: 0, seconds: 0 };
        await feature.initialize();
        const leftover = showWelcomeModal();
        expect(section()).not.toBeNull();

        feature.cleanup();
        expect(document.body.contains(leftover)).toBe(true);
        expect(leftover.querySelector(`.${SECTION_CLASS}`)).toBeNull();

        // A different character arrives. Nothing re-inserts the dialog — the
        // game never redrew it — so there is no fresh mutation for the watcher
        // to catch; only the "already open" look-back could find it.
        game.characterId = 'char-2';
        game.queue = { queued: 5, seconds: 500 };
        await feature.initialize();

        expect(section()).toBeNull();
        expect(leftover.querySelector(`.${SECTION_CLASS}`)).toBeNull();
    });
});

/**
 * Telling a refresh from a return.
 *
 * The gate lives in `initialize()`, which is the arrival hook feature-registry
 * calls on both boot and a character switch, and the only place that can tell
 * "the page for this character was alive a moment ago" from "it was not". The
 * game's own reason for opening its dialog is a different question — what the
 * account produced while the socket was shut — so it does not answer this one.
 */
describe('quick refresh vs a return', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('a quick refresh writes nothing, even with something to say', async () => {
        game.stored.set('sessionBriefingLastAlive_char-1', Date.now() - 20_000);
        game.queue = { queued: 0, seconds: 0 };

        await feature.initialize();
        showWelcomeModal();

        expect(section()).toBeNull();
    });

    test('a real absence still draws the briefing, exactly as before', async () => {
        game.stored.set('sessionBriefingLastAlive_char-1', Date.now() - 10 * 60_000);
        game.queue = { queued: 0, seconds: 0 };

        await feature.initialize();
        showWelcomeModal();

        expect(section()).not.toBeNull();
    });

    test('a first-ever load has no stamp to compare against, and draws as before', async () => {
        game.queue = { queued: 0, seconds: 0 };

        await feature.initialize();
        showWelcomeModal();

        expect(section()).not.toBeNull();
    });

    test('a character switch is not a refresh of the character switched to', async () => {
        // char-1's page was alive seconds ago, but char-2 is who is arriving
        game.stored.set('sessionBriefingLastAlive_char-1', Date.now() - 5_000);
        game.characterId = 'char-2';
        game.queue = { queued: 0, seconds: 0 };

        await feature.initialize();
        showWelcomeModal();

        expect(section()).not.toBeNull();
    });

    test('an arrival stamps this character as alive, for the next arrival to compare against', async () => {
        const now = Date.now();
        await feature.initialize();

        expect(game.stored.get('sessionBriefingLastAlive_char-1')).toBe(now);
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

/**
 * The "since you were away" block.
 *
 * A DOM test rather than another arithmetic one, because what `away-diff.js`
 * cannot check for itself is the wiring: that the diff is computed at the one
 * moment the arriving character's facts are readable, that it is reason enough
 * to write a section even when the live briefing has nothing to say, and that
 * showing it is what marks it read.
 */
describe('the away block', () => {
    const HOUR = 3_600_000;

    /** Store a snapshot for the current character, taken `hoursAgo` hours ago. */
    function storeSnapshot(facts, hoursAgo = 3) {
        game.stored.set(`briefingSnapshot_${game.characterId}`, {
            characterId: game.characterId,
            characterName: 'Char',
            at: Date.now() - hoursAgo * HOUR,
            facts,
        });
    }

    test('a deadline that lapsed while you were away is stated against the instant it named', async () => {
        // An hour of ale three hours ago, and the live game agrees there is a
        // keg to talk about
        storeSnapshot({ consumable: { name: 'Ale', secondsLeft: 3600 } });
        game.consumable = { name: 'Ale', secondsLeft: 0 };

        await feature.initialize();
        showWelcomeModal();

        expect(text()).toContain('Since you were away');
        expect(text()).toMatch(/Ale ran dry at /);
        expect(text()).not.toContain('could not be drawn');
    });

    test('the away block is reason enough to write a section on its own', async () => {
        // Nothing live needs this character at all — the only news is the past
        storeSnapshot({ tasksReady: 1 });
        game.characterInfo = { unreadTaskCount: 0 };

        await feature.initialize();
        showWelcomeModal();

        expect(section()).not.toBeNull();
        expect(text()).toContain('1 task claimed');
    });

    test('no snapshot is silence — it never says nothing happened', async () => {
        game.characterInfo = { unreadTaskCount: 2 };
        await feature.initialize();
        showWelcomeModal();

        expect(text()).toContain('2 waiting');
        expect(text()).not.toContain('Since you were away');
    });

    test('showing the block is reading it — the same snapshot never produces it twice', async () => {
        storeSnapshot({ tasksReady: 1 });
        game.characterInfo = { unreadTaskCount: 4 };

        await feature.initialize();
        showWelcomeModal();
        expect(text()).toContain('Since you were away');

        // The mark is the snapshot's own instant, so a later arrival comparing
        // against the same snapshot is silent about the past
        expect(game.stored.get(`briefingAwayDiffSeen_${game.characterId}`)).toBe(
            game.stored.get(`briefingSnapshot_${game.characterId}`).at
        );

        feature.cleanup();
        document.body.replaceChildren();
        // A genuine later return rather than a refresh seconds after this one,
        // which the quick-refresh gate would (rightly) suppress
        game.stored.delete('sessionBriefingLastAlive_char-1');
        await feature.initialize();
        showWelcomeModal();

        expect(text()).not.toContain('Since you were away');
        expect(text()).toContain('4 waiting');
    });

    test('a modal that never opens leaves the diff unread for the next arrival', async () => {
        storeSnapshot({ tasksReady: 1 });
        game.characterInfo = { unreadTaskCount: 4 };

        await feature.initialize();

        expect(game.stored.has(`briefingAwayDiffSeen_${game.characterId}`)).toBe(false);
    });

    test('a skipped quick refresh does not disturb the baseline the next real absence reports from', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

        // A real switch three hours ago left this snapshot, and nobody has read
        // the resulting "since you were away" block yet
        storeSnapshot({ tasksReady: 1 }, 3);
        game.characterInfo = { unreadTaskCount: 4 };
        // This arrival is only a page refresh, seconds after the last one
        game.stored.set('sessionBriefingLastAlive_char-1', Date.now() - 20_000);

        const snapshotAt = game.stored.get(`briefingSnapshot_${game.characterId}`).at;

        await feature.initialize();
        showWelcomeModal();

        // Nothing drawn...
        expect(section()).toBeNull();
        // ...and nothing was marked read, and the snapshot itself is untouched —
        // a genuine absence right after this still measures from the same instant
        expect(game.stored.has(`briefingAwayDiffSeen_${game.characterId}`)).toBe(false);
        expect(game.stored.get(`briefingSnapshot_${game.characterId}`).at).toBe(snapshotAt);

        vi.useRealTimers();
    });
});

describe('the overlay tile', () => {
    test('counts the same lines, and has no panel to offer', () => {
        const row = rows.registered.find((entry) => entry.key === 'sessionBriefing');
        expect(row).toBeTruthy();
        // No `onOpen`: there is no briefing panel any more, and the command
        // palette lists a row only when it has somewhere to send you
        expect(row.onOpen).toBeUndefined();

        game.queue = { queued: 0, seconds: 0 };
        const container = document.createElement('div');
        row.render(container);
        expect(container.textContent).toBe('1 needs you');
    });
});
