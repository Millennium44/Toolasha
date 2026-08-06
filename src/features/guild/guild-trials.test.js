/** @vitest-environment happy-dom */

/**
 * The trial panel, over a faked game.
 *
 * Driven the way `guild-credit-value.test.js` is driven: build the markup the
 * game renders, let the feature's DOM observer callback fire, read the injected
 * block back out. The clock is driven rather than allowed to run, because a rate
 * needs two readings and waiting five real seconds for the second one turns a
 * millisecond test into a five-second one.
 *
 * What is worth asserting here, rather than in the math tests: that the panel
 * survives a card it does not understand, that it says "measuring" instead of
 * inventing a rate off one reading, and that an unknown building bonus reaches
 * the screen as a caption rather than as a silently-zero multiplier.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    settings: { guildTrialsInfo: true },
    settingValues: {},
    clientData: {},
    prices: {},
    buildingLevels: {},
    store: {},
    observers: {},
    wsHandlers: {},
    guildName: 'Milky Way',
    currentWeek: '2026-07-31T00:00:00Z',
    members: [],
    characterId: null,
    characterData: null,
    dmHandlers: {},
    trialNames: [],
    alerts: { status: [], payouts: [], reset: 0 },
    recorder: { recording: false, activity: [], lifecycle: [], downloads: [], startedBy: null, endedBy: null },
    scoreboardToggles: 0,
    breakdown: {},
    scoreboardContext: null,
    skilling: {},
    skillingEnded: {},
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => (key in game.settings ? game.settings[key] : fallback),
        getSettingValue: (key, fallback) => (key in game.settingValues ? game.settingValues[key] : fallback),
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        // The feature watches several class names now, because the trials tab's
        // own container class is unverified — so the mock has to accept a list
        onClass: (id, classNames, callback) => {
            const names = Array.isArray(classNames) ? classNames : [classNames];
            for (const name of names) game.observers[name] = callback;
            return () => {
                for (const name of names) delete game.observers[name];
            };
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
    default: {
        get guildBuildingLevelMap() {
            return game.buildingLevels;
        },
        getInitClientData: () => game.clientData,
        getCurrentCharacterId: () => game.characterId,
        get characterData() {
            return game.characterData;
        },
        on: (event, handler) => {
            (game.dmHandlers[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            game.dmHandlers[event] = (game.dmHandlers[event] || []).filter((entry) => entry !== handler);
        },
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => (key in game.store ? game.store[key] : fallback),
        set: async (key, value) => {
            game.store[key] = value;
            return true;
        },
        delete: async (key) => {
            delete game.store[key];
            return true;
        },
        getAllKeys: async () => Object.keys(game.store),
    },
}));
// Token payouts are valued through the credit exchange, which prices items —
// mocked here so the real marketplace client is never pulled into this file
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (itemHrid, { mode } = {}) => game.prices[itemHrid]?.[mode] ?? 0,
}));
// `encounterOf` is a pure name-matcher and the feature now routes the spectated
// pool through it, so the real one is kept rather than stubbed
vi.mock('./guild-trial-damage.js', async (importOriginal) => ({
    ...(await importOriginal()),
    default: {
        initialize: vi.fn(),
        cleanup: vi.fn(),
        reset: vi.fn(),
        setTrialNames: (names) => (game.trialNames = names),
        breakdown: () => ({ measured: false, reason: 'no trial fight seen yet', players: [], ...game.breakdown }),
    },
}));
vi.mock('./guild-trial-recorder.js', () => ({
    default: {
        initialize: vi.fn(),
        cleanup: vi.fn(),
        setGuildName: vi.fn(),
        forget: () => {
            game.recorder.recording = false;
            game.recorder.forgotten = true;
        },
        noteActivity: (kind) => game.recorder.activity.push(kind),
        noteLifecycle: (phase) => game.recorder.lifecycle.push(phase),
        start: (reason) => {
            game.recorder.recording = true;
            game.recorder.startedBy = reason;
        },
        stop: (reason) => {
            game.recorder.recording = false;
            game.recorder.endedBy = reason;
        },
        get recording() {
            return game.recorder.recording;
        },
    },
    buildTrialExport: async () => ({ exportedAt: 'now', bundle: true }),
    downloadTrialExport: (bundle) => game.recorder.downloads.push(bundle),
}));
vi.mock('../notifications/guild-trial-alerts.js', () => ({
    default: {
        noteTrialStatus: (status) => game.alerts.status.push(status),
        notePayout: (payout) => game.alerts.payouts.push(payout),
        reset: () => (game.alerts.reset += 1),
    },
}));
vi.mock('./guild-trial-skilling.js', () => ({
    default: {
        initialize: vi.fn(),
        cleanup: vi.fn(),
        forTrial: (name) => game.skilling[String(name).toLowerCase()] || null,
        endedFor: (name) => game.skillingEnded[String(name).toLowerCase()] || null,
        participating: (name, id) => {
            const ids = game.skilling[String(name).toLowerCase()]?.participantIds;
            return Array.isArray(ids) ? ids.includes(Number(id)) : null;
        },
        snapshot: () => ({ updates: game.skilling, ended: game.skillingEnded }),
    },
}));
vi.mock('./guild-trial-scoreboard.js', () => ({
    default: {
        toggle: () => (game.scoreboardToggles += 1),
        close: vi.fn(),
        noteForecast: vi.fn(),
        noteContext: (context) => (game.scoreboardContext = context),
    },
}));
vi.mock('./guild-xp-tracker.js', () => ({
    guildXPTracker: {
        getOwnGuildName: () => game.guildName,
        getCurrentWeekStartAt: () => game.currentWeek,
        getMemberList: () => game.members,
        getMemberMeta: (id) => game.members.find((member) => member.characterID === id) || null,
    },
}));

const {
    analyseTrial,
    guildTrials,
    ownParticipation,
    participantCounts,
    placeTrialBlock,
    renderTrialBlock,
    renderTrialPlayers,
    signedUpMembers,
    tokenPayoutLine,
    withScrollKept,
} = await import('./guild-trials.js');
const trialsFeature = (await import('./guild-trials.js')).default;

const { NOTICE_BOARD_NAME } = await import('./guild-notice-board.fixture.js');

const now = Date.parse('2026-08-04T12:00:00Z');

/**
 * A stored tile record.
 * @param {Object} overrides - Fields to override
 * @returns {Object} Record
 */
function record(overrides = {}) {
    return {
        name: 'Trial Chameleon',
        kind: 'combat',
        level: 140,
        tier: 5,
        // A trial that has banked something: the card's points are what say a
        // badge counts finished tiers rather than the one in progress
        pointsByTier: { 5: 1200 },
        samples: [],
        tiers: [],
        ...overrides,
    };
}

describe('analyseTrial', () => {
    test('a combat trial reads its DPS off the falling bar', () => {
        const analysis = analyseTrial(
            record({
                samples: [
                    { t: now, readings: [{ current: 618_000, max: 618_000 }] },
                    { t: now + 10_000, readings: [{ current: 518_000, max: 618_000 }] },
                ],
                tiers: [{ tier: 5, total: 618_000 }],
            }),
            { participants: 21, timeLeftMs: 30 * 60_000 }
        );

        expect(analysis.kind).toBe('combat');
        expect(analysis.rate).toBeCloseTo(10, 9); // 100,000 damage over 10s
        expect(analysis.remaining).toBe(518_000);
        expect(analysis.etaMs).toBeCloseTo(51_800, 6);
        // The badge counts what is banked; the tier being fought is one past it
        expect(analysis.tiersClearedSoFar).toBe(5);
    });

    test('a skilling trial reads its fill rate off the rising bar', () => {
        const analysis = analyseTrial(
            record({
                name: 'Trial Milking',
                kind: 'skilling',
                level: 110,
                tier: 2,
                samples: [
                    { t: now, readings: [{ current: 1_000_000, max: 4_000_000 }] },
                    { t: now + 20_000, readings: [{ current: 1_400_000, max: 4_000_000 }] },
                ],
            }),
            { timeLeftMs: 30 * 60_000 }
        );

        expect(analysis.rate).toBeCloseTo(20, 9); // 400,000 over 20s
        expect(analysis.remaining).toBe(2_600_000);
        expect(analysis.etaMs).toBeCloseTo(130_000, 6);
        expect(analysis.tiersClearedSoFar).toBe(2);
    });

    test('one sample is not a rate', () => {
        const analysis = analyseTrial(
            record({ samples: [{ t: now, readings: [{ current: 618_000, max: 618_000 }] }] }),
            { timeLeftMs: 60_000 }
        );

        expect(analysis.rate).toBeNull();
        expect(analysis.etaMs).toBeNull();
        expect(analysis.pace).toBeNull();
    });

    test('the pace projection climbs the fitted curve', () => {
        // Tier 4 cost 500,000 and tier 5 costs 600,000: ×1.2 a tier. The party
        // does 1,000 damage a millisecond with 100,000 left, so tier 5 takes
        // 100s, tier 6 (720,000) takes 720s, tier 7 (864,000) takes 864s.
        // In 900s only tiers 5 and 6 fit.
        const analysis = analyseTrial(
            record({
                samples: [
                    { t: now, readings: [{ current: 200_000, max: 600_000 }] },
                    { t: now + 100_000, readings: [{ current: 100_000, max: 600_000 }] },
                ],
                tiers: [
                    { tier: 4, total: 500_000 },
                    { tier: 5, total: 600_000 },
                ],
            }),
            { participants: 20, timeLeftMs: 900_000 }
        );

        expect(analysis.rate).toBeCloseTo(1, 9);
        expect(analysis.pace.clears.map((clear) => clear.tier)).toEqual([6]);
        expect(analysis.pace.tiersCleared).toBe(6); // four banked plus two projected
        expect(analysis.growthPerTier).toBeCloseTo(1.2, 9);
    });

    test('the next tier is previewed with the party penalty spelled out', () => {
        const analysis = analyseTrial(
            record({
                samples: [{ t: now, readings: [{ current: 600_000, max: 600_000 }] }],
                tiers: [
                    { tier: 4, total: 500_000 },
                    { tier: 5, total: 600_000 },
                ],
            }),
            { participants: 21, timeLeftMs: 900_000 }
        );

        expect(analysis.next).toMatchObject({ tier: 7, level: 160 });
        expect(analysis.next.total).toBeCloseTo(864_000, 3);
        expect(analysis.next.participantPenalty).toBeCloseTo(0.21, 12);
    });

    test('the first bar of a combat card is the boss, before anything has moved', () => {
        // This used to wait for one of the two bars to fall before deciding
        // which was which, and a combat card's pair is health then mana — the
        // second never falls for a reason the party controls, and across a tier
        // clear neither of them falls at all. So a live trial's card was left
        // permanently unclassified. Position is the confirmed fact here.
        const readings = [
            { current: 5, max: 10 },
            { current: 7, max: 20 },
        ];
        const analysis = analyseTrial(record({ samples: [{ t: now, readings }] }), { timeLeftMs: 60_000 });

        // One sample is still not a rate
        expect(analysis.rate).toBeNull();
        expect(analysis.remaining).toBe(5);
        expect(analysis.total).toBe(10);
    });

    test('an empty record analyses to nothing rather than throwing', () => {
        const analysis = analyseTrial({}, {});
        expect(analysis.rate).toBeNull();
        expect(analysis.tiersClearedSoFar).toBe(0);
        expect(analysis.samples).toBe(0);
    });
});

describe('participantCounts', () => {
    const tracker = (members, week = '2026-07-31T00:00:00Z') => ({
        getCurrentWeekStartAt: () => week,
        getMemberList: () => members,
        getMemberMeta: (id) => members.find((member) => member.characterID === id) || null,
    });

    test('counts sign-ups made for the current week, per trial', () => {
        const counts = participantCounts(
            tracker([
                {
                    characterID: '1',
                    signupWeekStartAt: '2026-07-31T00:00:00Z',
                    signedUpSkillingTrialHrid: '/guild_trials/milking',
                    signedUpCombatTrialHrid: '/guild_trials/chameleon',
                },
                {
                    characterID: '2',
                    signupWeekStartAt: '2026-07-31T00:00:00Z',
                    signedUpSkillingTrialHrid: '/guild_trials/milking',
                    signedUpCombatTrialHrid: '',
                },
            ])
        );

        expect(counts).toEqual({ '/guild_trials/milking': 2, '/guild_trials/chameleon': 1 });
    });

    test('a sign-up from last week does not inflate the current penalty', () => {
        const counts = participantCounts(
            tracker([
                {
                    characterID: '1',
                    signupWeekStartAt: '2026-07-24T00:00:00Z',
                    signedUpCombatTrialHrid: '/guild_trials/chameleon',
                },
            ])
        );

        expect(counts).toEqual({});
    });

    test('no tracker at all is no counts', () => {
        expect(participantCounts({})).toEqual({});
    });

    test('the same walk keeps the names, for the estimated split to cover', () => {
        const roster = tracker([
            {
                characterID: '1',
                name: 'Tib',
                signupWeekStartAt: '2026-07-31T00:00:00Z',
                signedUpCombatTrialHrid: '/guild_trials/chameleon',
            },
            {
                characterID: '2',
                name: 'Moo',
                signupWeekStartAt: '2026-07-31T00:00:00Z',
                signedUpSkillingTrialHrid: '/guild_trials/milking',
            },
            {
                characterID: '3',
                name: 'Stale',
                signupWeekStartAt: '2026-07-24T00:00:00Z',
                signedUpCombatTrialHrid: '/guild_trials/chameleon',
            },
        ]);

        expect(signedUpMembers('Trial Chameleon', roster)).toEqual(['Tib']);
        expect(signedUpMembers('Milking', roster)).toEqual(['Moo']);
        expect(signedUpMembers('Trial Chameleon', {})).toEqual([]);
    });
});

describe('renderTrialBlock', () => {
    test('says it is measuring before there is a second reading', () => {
        const html = renderTrialBlock(analyseTrial(record({ samples: [] })), 0);
        expect(html).toContain('measuring');
    });

    test('names the rate and the ETA once there is one', () => {
        const analysis = analyseTrial(
            record({
                samples: [
                    { t: now, readings: [{ current: 618_000, max: 618_000 }] },
                    { t: now + 10_000, readings: [{ current: 518_000, max: 618_000 }] },
                ],
            }),
            { timeLeftMs: 30 * 60_000 }
        );
        const html = renderTrialBlock(analysis, 21);

        expect(html).toContain('Party DPS');
        expect(html).toContain('Kill in');
        expect(html).toContain('Banked');
    });

    test('a skilling trial is captioned as a fill, not as damage', () => {
        const analysis = analyseTrial(
            record({
                kind: 'skilling',
                samples: [
                    { t: now, readings: [{ current: 0, max: 1000 }] },
                    { t: now + 1000, readings: [{ current: 100, max: 1000 }] },
                ],
            }),
            { timeLeftMs: 60_000 }
        );

        expect(renderTrialBlock(analysis, 3)).toContain('Fill rate');
    });
});

describe('tokenPayoutLine', () => {
    beforeEach(() => {
        game.clientData = {};
        game.prices = {};
        game.settingValues = {};
    });

    test('an unpriceable token payout is left as the bare count it always was', () => {
        const row = tokenPayoutLine(500, 'Half the base points.');

        expect(row.value).toBe('500');
        expect(row.title).toBe('Half the base points.');
    });

    test('a priceable one carries the gold value and says it is derived', () => {
        game.clientData = {
            itemDetailMap: {
                '/items/guild_token': {
                    guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 1, creditCount: 2 }],
                },
                '/items/bronze_bar': {
                    guildCreditConversions: [
                        { creditItemHrid: '/items/guild_credit_1', itemCount: 10, creditCount: 1 },
                    ],
                },
            },
        };
        game.prices = { '/items/bronze_bar': { ask: 100 } };

        const row = tokenPayoutLine(500, 'Half the base points.');

        // Both halves in full: 500 tokens, and the gold they convert to
        expect(row.value).toContain('500 (');
        expect(row.value).toContain('≈1,000,000g');
        expect(row.value).toContain('via credit exchange');
        expect(row.title).toContain('Half the base points.');
    });
});

describe('ownParticipation', () => {
    // Confirmed by the user: the In Progress tab only ever shows the trials this
    // character signed up for, so a card for anybody else's trial can never
    // receive a reading. Knowing which is which is what lets the block say that
    // instead of promising a measurement that cannot arrive.
    const tracker = (meta) => ({
        getMemberMeta: (id) => (String(id) === '30404' ? meta : null),
        getCurrentWeekStartAt: () => '2026-07-31T00:00:00Z',
    });

    test('signed up for this trial, this week', () => {
        const meta = {
            signedUpCombatTrialHrid: '/guild_trials/trial_chameleon',
            signedUpSkillingTrialHrid: '',
            signupWeekStartAt: '2026-07-31T00:00:00Z',
        };
        expect(ownParticipation('Trial Chameleon', { tracker: tracker(meta), characterId: 30404 })).toBe(true);
        expect(ownParticipation('Alchemy', { tracker: tracker(meta), characterId: 30404 })).toBe(false);
    });

    test('an id that arrived as a number and is asked for as a string is the same member', () => {
        const meta = {
            signedUpSkillingTrialHrid: '/guild_trials/alchemy',
            signupWeekStartAt: '2026-07-31T00:00:00Z',
        };
        expect(ownParticipation('Alchemy', { tracker: tracker(meta), characterId: '30404' })).toBe(true);
    });

    test('last week’s sign-up is not this week’s', () => {
        const meta = {
            signedUpSkillingTrialHrid: '/guild_trials/alchemy',
            signupWeekStartAt: '2026-07-24T00:00:00Z',
        };
        expect(ownParticipation('Alchemy', { tracker: tracker(meta), characterId: 30404 })).toBe(false);
    });

    test('signed up for nothing is not in it', () => {
        const meta = { signedUpSkillingTrialHrid: '', signedUpCombatTrialHrid: '' };
        expect(ownParticipation('Alchemy', { tracker: tracker(meta), characterId: 30404 })).toBe(false);
    });

    test('no sign-up sheet at all is unknown, not an accusation', () => {
        expect(ownParticipation('Alchemy', { tracker: tracker(null), characterId: 30404 })).toBeNull();
        expect(ownParticipation('Alchemy', { tracker: tracker({}), characterId: null })).toBeNull();
    });
});

describe('withScrollKept', () => {
    test('puts every scrolled ancestor back where it was', () => {
        document.body.innerHTML = '<div id="outer"><div id="inner"><div id="leaf"></div></div></div>';
        const outer = document.getElementById('outer');
        const inner = document.getElementById('inner');
        const leaf = document.getElementById('leaf');
        Object.defineProperty(outer, 'scrollTop', { value: 120, writable: true, configurable: true });
        Object.defineProperty(inner, 'scrollTop', { value: 40, writable: true, configurable: true });

        withScrollKept(leaf, () => {
            // What a browser does when the content it is scrolling changes height
            outer.scrollTop = 0;
            inner.scrollTop = 0;
        });

        expect(outer.scrollTop).toBe(120);
        expect(inner.scrollTop).toBe(40);
    });

    test('a page nobody has scrolled is left alone, and the return value passes through', () => {
        document.body.innerHTML = '<div id="leaf"></div>';
        const leaf = document.getElementById('leaf');

        expect(withScrollKept(leaf, () => 'done')).toBe('done');
    });

    test('a throwing change still restores the scroll', () => {
        document.body.innerHTML = '<div id="outer"><div id="leaf"></div></div>';
        const outer = document.getElementById('outer');
        const leaf = document.getElementById('leaf');
        Object.defineProperty(outer, 'scrollTop', { value: 80, writable: true, configurable: true });

        expect(() =>
            withScrollKept(leaf, () => {
                outer.scrollTop = 0;
                throw new Error('nope');
            })
        ).toThrow('nope');
        expect(outer.scrollTop).toBe(80);
    });
});

describe('placeTrialBlock', () => {
    // Devtools, from the tab the user actually has: our block measured 126 ×
    // 152.8 as a *Grid Item* — one cell of a four-column grid, not the full-width
    // row `grid-column: 1 / -1` was supposed to give it — while the "Combat
    // Trial" section label beside it is a 525.6-wide *Flex Item* of an outer box.
    // Two different layouts in one panel, which is why this measures rather than
    // assumes.
    /**
     * A container holding two cards.
     * @param {string} css - Inline style for the container
     * @returns {{root: Element, container: Element, card: Element}} The pieces
     */
    function layout(css) {
        document.body.innerHTML =
            `<div class="GuildPanel_guildPanel__r"><div id="grid" style="${css}">` +
            '<div id="card" class="GuildPanel_tile__a">Trial Chameleon</div>' +
            '<div class="GuildPanel_tile__b">Alchemy</div></div>' +
            '<div class="GuildPanel_sectionLabel__s">Combat Trial</div></div>';
        return {
            root: document.querySelector('[class*="GuildPanel_guildPanel"]'),
            container: document.getElementById('grid'),
            card: document.getElementById('card'),
        };
    }

    /** @returns {Element} A fresh block */
    const newBlock = () => {
        const block = document.createElement('div');
        block.className = 'mwi-trial-info';
        block.innerHTML = '<div>Banked 3 tiers</div>';
        return block;
    };

    test('a grid with a real column template is spanned, all of it', () => {
        const { root, card } = layout('display:grid; grid-template-columns:126px 126px 126px 126px');
        const block = newBlock();

        expect(placeTrialBlock(root, card, block, 'Trial Chameleon')).toBe('spanned');
        // `span N`, never `1 / -1`: the latter counts explicit tracks only
        expect(block.style.gridColumn).toBe('1 / span 4');
        expect(block.previousElementSibling).toBe(card);
    });

    test('a grid that declares no columns is left alone and the block goes after it', () => {
        // This is the reported case. `-1` resolves against the explicit grid, so
        // on a container with implicit columns `1 / -1` is a single cell — 126px
        // wide, exactly as devtools measured it.
        const { root, container, card } = layout('display:grid');
        const block = newBlock();

        expect(placeTrialBlock(root, card, block, 'Trial Chameleon')).toBe('after-container');
        expect(container.contains(block)).toBe(false);
        expect(block.previousElementSibling).toBe(container);
        // Away from its card, so it says which card it is
        expect(block.textContent).toContain('Trial Chameleon');
        // And before the next section's label, which it used to collide with
        expect(block.nextElementSibling.className).toContain('GuildPanel_sectionLabel');
    });

    test('a wrapping flex row gives it a line of its own', () => {
        const { root, card } = layout('display:flex; flex-wrap:wrap');
        const block = newBlock();

        expect(placeTrialBlock(root, card, block, 'Trial Chameleon')).toBe('after-card');
        expect(block.style.flexBasis).toBe('100%');
        expect(block.previousElementSibling).toBe(card);
    });

    test('a flex row that does not wrap would squash the cards, so it goes after', () => {
        const { root, container, card } = layout('display:flex');
        const block = newBlock();

        expect(placeTrialBlock(root, card, block, 'Trial Chameleon')).toBe('after-container');
        expect(container.contains(block)).toBe(false);
    });

    test('ordinary flow needs nothing but being a block', () => {
        const { root, card } = layout('');
        const block = newBlock();

        expect(placeTrialBlock(root, card, block)).toBe('after-card');
        expect(block.previousElementSibling).toBe(card);
        expect(block.style.gridColumn).toBe('');
    });

    test('a card inside a dialog is refused, not decorated', () => {
        // The boss's stat popup is headed with a trial name over a level, which
        // is what a card is recognised by — so placement is the last point at
        // which "this is not the guild panel" can still be said
        document.body.innerHTML =
            '<div id="root"><div class="Modal_modalContainer__m" role="dialog">' +
            '<div class="GuildPanel_tile__a" id="popup-card">Trial Chameleon Lv.110</div>' +
            '</div></div>';
        const block = newBlock();
        const card = document.getElementById('popup-card');

        expect(placeTrialBlock(document.getElementById('root'), card, block, 'Trial Chameleon')).toBe('refused');
        expect(card.contains(block)).toBe(false);
        expect(document.body.contains(block)).toBe(false);
    });

    test('a card with nothing around it keeps the block inside itself', () => {
        document.body.innerHTML = '<div id="lone" class="GuildPanel_tile__a">Alchemy</div>';
        const card = document.getElementById('lone');
        const block = newBlock();

        expect(placeTrialBlock(card, card, block)).toBe('after-card');
        expect(card.contains(block)).toBe(true);
    });
});

describe('the panel, end to end', () => {
    /**
     * The In Progress tab, as markup.
     * @param {Array<Object>} cards - Cards to render
     * @returns {Element} The trials-content element
     */
    function buildTab(cards, statusText = 'In progress — 42:15 remaining') {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';

        const status = document.createElement('div');
        status.className = 'GuildPanel_eventStatusRow__b';
        status.textContent = statusText;
        root.appendChild(status);

        for (const card of cards) {
            const tile = document.createElement('div');
            tile.className = 'GuildPanel_tile__c';
            tile.innerHTML =
                `<div class="GuildPanel_tileName__d">${card.name}</div>` +
                `<div class="GuildPanel_tileSummary__e">Lv.${card.level}</div>` +
                // A card states points once it has banked a tier, and that is
                // what tells a badge counting finished tiers from one naming the
                // tier in progress
                (Number.isFinite(card.points) ? `<div class="Card_points__p">${card.points} pts</div>` : '') +
                // The card's own decoration, which outranks the header's kind
                (card.completed ? '<div class="GuildPanel_status__q">Completed</div>' : '') +
                `<div class="ProgressBar_text__f">${card.bar}</div>`;
            root.appendChild(tile);
        }

        document.body.appendChild(root);
        return root;
    }

    /**
     * A Trials-tab card, which is where points and tiers come from.
     * @param {string} name - Trial name
     * @param {number} level - Its level
     * @param {number} points - What the card states
     * @returns {Element} The tab
     */
    function buildTrialsTabFor(name, level, points) {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        const tile = document.createElement('div');
        tile.className = 'GuildPanel_tile__c';
        tile.innerHTML =
            `<div class="GuildPanel_tileName__d">${name}</div>` +
            `<div class="GuildPanel_tileSummary__e">Lv.${level}</div>` +
            `<div class="Card_points__g">${points} pts</div>`;
        root.appendChild(tile);
        document.body.appendChild(root);
        return root;
    }

    // The callback takes no element: it finds the root itself, so that a tab
    // whose container is called something else is still read
    const fire = () => game.observers['GuildPanel_']();
    const text = () => document.body.textContent;

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        game.settings = { guildTrialsInfo: true };
        game.settingValues = {};
        game.clientData = {};
        game.prices = {};
        game.buildingLevels = {};
        game.store = {};
        game.members = [];
        game.characterId = null;
        game.characterData = null;
        game.dmHandlers = {};
        game.trialNames = [];
        game.alerts = { status: [], payouts: [], reset: 0 };
        game.recorder = {
            recording: false,
            activity: [],
            lifecycle: [],
            downloads: [],
            startedBy: null,
            endedBy: null,
        };
        game.scoreboardToggles = 0;
        game.breakdown = {};
        game.scoreboardContext = null;
        game.skilling = {};
        game.skillingEnded = {};
        await trialsFeature.initialize();
    });

    afterEach(() => {
        trialsFeature.cleanup();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    test('draws a block on each card and a payout block above them', () => {
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]);
        fire(root);

        expect(document.querySelectorAll('.mwi-trial-info')).toHaveLength(2);
        expect(text()).toContain('Trial payout');
        expect(text()).toContain('measuring');
    });

    test('a tab whose container is called something else is still read', () => {
        // The reported bug, in one test. Everything hung off one unverified
        // class name, and if the game does not spell it `GuildPanel_trialsContent`
        // then the observer never fires, the interval never matches, no reading
        // is ever taken, and the panel block and the overlay tile are both dark
        // during a live trial — with nothing logged anywhere.
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]);
        root.className = 'GuildPanel_whateverTheyCallItNow__z';
        fire();

        expect(document.querySelectorAll('.mwi-trial-info').length).toBeGreaterThan(0);
        expect(text()).toContain('Trial payout');
    });

    test('a card with no progress bar is identity, not a reading', () => {
        // The Trials tab's cards carry the tier and the sign-ups and no bar at
        // all. They are worth recording and must not push a sample: a sample
        // with no readings in it puts a hole in the series a rate is fitted to.
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]);
        root.querySelector('[class*="ProgressBar_text"]').textContent = 'Sign up';
        fire();

        const record = guildTrials.record.tiles['combat::trial chameleon'];
        expect(record.tier).toBe(5);
        expect(record.samples).toHaveLength(0);
        expect(text()).toContain('Trial payout');
    });

    test('the payout block sits above the cards when there is no status row to hang it on', () => {
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]);
        root.querySelector('[class*="GuildPanel_eventStatusRow"]').remove();
        fire();

        const payout = [...document.querySelectorAll('.mwi-trial-info')].find((el) =>
            el.textContent.includes('Trial payout')
        );
        const card = document.querySelector('[class*="GuildPanel_tile__"]');
        expect(payout.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    test('a second reading five seconds later produces a rate', () => {
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]);
        fire(root);

        root.querySelector('[class*="ProgressBar_text"]').textContent = '568,000 / 618,000';
        vi.setSystemTime(now + 10_000);
        fire(root);

        expect(text()).toContain('Party DPS');
        expect(text()).not.toContain('measuring');
    });

    test('a combat card measures damage across a tier clear', () => {
        // The recorded trial: the boss bar does not fall between these two
        // readings, it jumps to a bigger boss. Nothing fell, so nothing was
        // classified, so the card showed no DPS for the whole hour.
        const root = buildTab([{ name: 'Trial Chameleon', level: 120, bar: '23,031 / 618,000' }]);
        const bar = root.querySelector('[class*="ProgressBar_text"]');
        fire(root);

        bar.textContent = '506,273 / 669,500';
        vi.setSystemTime(now + 414_667);
        fire(root);

        expect(text()).toContain('Party DPS');
        // A non-breaking space: the unit must never be left on its own line
        expect(text()).toContain('449\u00a0dmg/s');
        // The card's own level puts both readings at tier 3, so there is no
        // second tier to fit a growth curve to and the boundary cannot be shown
        // to be a single step — said outright rather than quietly under-counted
        expect(document.body.innerHTML).toContain('lower bound');
    });

    test('the mana bar beside it is not mistaken for anything', () => {
        const root = buildTab([{ name: 'Trial Chameleon', level: 120, bar: '600,000 / 618,000' }]);
        const bar = root.querySelector('[class*="ProgressBar_text"]');
        bar.textContent = '600,000 / 618,000';
        const mana = document.createElement('div');
        mana.className = 'ProgressBar_text__m';
        mana.textContent = '582,560 / 600,000';
        bar.parentElement.appendChild(mana);
        fire(root);

        bar.textContent = '500,000 / 618,000';
        mana.textContent = '644,395 / 600,000';
        vi.setSystemTime(now + 10_000);
        fire(root);

        // 100,000 off the boss in ten seconds, and not a number from the mana bar
        expect(text()).toContain('10.0K\u00a0dmg/s');
    });

    test('four tiers banked at tier 5 reach the payout block', () => {
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, points: 1200, bar: '618,000 / 618,000' }]);
        fire(root);

        // A card badged T5 has banked five: 400 + 200 × 4 = 1,200 base points
        // → 600 tokens for every eligible member, 900 for a participant
        expect(text()).toContain('Guild Points banked1,200');
        expect(text()).toContain('Tokens, every eligible member600');
        expect(text()).toContain('Tokens, if you took part900');
    });

    test('a token payout carries an approximate gold value when the exchange can be priced', () => {
        // 1 token → 2 credits, and a credit costs 10 bronze bars at 100 each,
        // so a token is worth 2,000 gold and 500 of them are worth 1M
        game.clientData = {
            itemDetailMap: {
                '/items/guild_token': {
                    name: 'Guild Token',
                    guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 1, creditCount: 2 }],
                },
                '/items/bronze_bar': {
                    name: 'Bronze Bar',
                    guildCreditConversions: [
                        { creditItemHrid: '/items/guild_credit_1', itemCount: 10, creditCount: 1 },
                    ],
                },
            },
        };
        game.prices = { '/items/bronze_bar': { ask: 100 } };

        fire(buildTab([{ name: 'Trial Chameleon', level: 140, points: 1200, bar: '618,000 / 618,000' }]));

        expect(text()).toContain('Tokens, every eligible member600 (≈1,200,000g');
        expect(text()).toContain('via credit exchange');
    });

    test('with nothing to price the token payout against, the bare count is all that shows', () => {
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, points: 1200, bar: '618,000 / 618,000' }]));

        expect(text()).toContain('Tokens, every eligible member600');
        expect(text()).not.toContain('via credit exchange');
    });

    test('an unknown building bonus is captioned, not silently treated as zero', () => {
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]));

        expect(text()).toContain('level seen');
        expect(text()).toContain('Builder’s Hall');
        expect(text()).toContain('Treasury');
        expect(text()).toContain('each level adds 2%');
    });

    test('a resolvable bonus drops the caption', () => {
        game.buildingLevels = { '/guild_buildings/builders_hall': 2, '/guild_buildings/treasury': 2 };
        game.clientData = {
            guildBuildingDetailMap: {
                '/guild_buildings/builders_hall': { bonusPerLevel: 0.05 },
                '/guild_buildings/treasury': { bonusPerLevel: 0.05 },
            },
        };
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]));

        expect(text()).not.toContain('Base figures');
    });

    test('redrawing does not stack blocks', () => {
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]);
        fire(root);
        fire(root);
        fire(root);

        expect(document.querySelectorAll('.mwi-trial-info')).toHaveLength(2);
    });

    test('a tab with no trial cards draws nothing', () => {
        document.body.innerHTML = '<div class="GuildPanel_trialsContent__a">No trials in progress</div>';
        fire(document.querySelector('[class*="GuildPanel_trialsContent"]'));

        expect(document.querySelectorAll('.mwi-trial-info')).toHaveLength(0);
    });

    test('a skilling card and a combat card are both handled on one tab', () => {
        fire(
            buildTab([
                { name: 'Trial Milking', level: 110, bar: '1,000 / 4,000' },
                { name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' },
            ])
        );

        expect(document.querySelectorAll('.mwi-trial-info')).toHaveLength(3);
    });

    test('cleanup removes everything it drew', () => {
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]));
        trialsFeature.cleanup();

        expect(document.querySelectorAll('.mwi-trial-info')).toHaveLength(0);
        expect(game.observers['GuildPanel_trialsContent']).toBeUndefined();
        expect(game.wsHandlers['guild_trial_signup_updated']).toBeUndefined();
    });

    test('the feature stays out of the way when it is switched off', async () => {
        trialsFeature.cleanup();
        game.settings = { guildTrialsInfo: false };
        await trialsFeature.initialize();

        expect(game.observers['GuildPanel_trialsContent']).toBeUndefined();
        expect(guildTrials.initialized).toBe(false);
    });

    test('an open tab is sampled every five seconds, not whenever the DOM churns', () => {
        // The reported recording: two samples in forty minutes of a live trial
        // with the tab open and the pool ticking every second. A rate cannot be
        // fitted to that, and the tile said "measuring…" for the whole event.
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        const bar = root.querySelector('[class*="ProgressBar_text"]');

        for (let step = 1; step <= 6; step += 1) {
            bar.textContent = `${18_850 + step * 100} / 65,280`;
            vi.setSystemTime(now + step * 5000);
            vi.advanceTimersByTime(5000);
        }

        const samples = guildTrials.record.tiles['skilling::alchemy'].samples;
        expect(samples).toHaveLength(6);
        expect(samples[5].readings[0].current).toBe(19_450);
    });

    test('the sampler is running before the record has finished loading', async () => {
        // The ordering that made the above possible: everything below the first
        // `await` only exists once every promise above it settles, and the
        // sampler was below all of them. A tick that beats the load writes into
        // a fresh record, and the load merges into it rather than replacing it.
        trialsFeature.cleanup();
        game.store = {};

        const pending = trialsFeature.initialize();
        buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        vi.advanceTimersByTime(5000);

        expect(guildTrials.record.tiles['skilling::alchemy'].samples).toHaveLength(1);
        await pending;
        expect(guildTrials.record.tiles['skilling::alchemy'].samples).toHaveLength(1);
    });

    test('a sampler that has stopped is started again by the next tab event', () => {
        buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        vi.advanceTimersByTime(5000);
        expect(guildTrials.record.tiles['skilling::alchemy'].samples).toHaveLength(1);

        // Whatever killed it — a cleanup racing a re-initialisation, a
        // throttled background tab — the panel being drawn is proof it should
        // be running
        clearInterval(guildTrials.samplerId);
        vi.setSystemTime(now + 60_000);
        fire();

        vi.setSystemTime(now + 65_000);
        vi.advanceTimersByTime(5000);
        expect(guildTrials.record.tiles['skilling::alchemy'].samples.length).toBeGreaterThan(2);
    });

    test('the controls sit on the payout block and drive the recorder', () => {
        // The console command is no longer the only way in. The button calls the
        // same builder, so the two cannot drift apart.
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]));

        const buttons = [...document.querySelectorAll('button')];
        const record = buttons.find((button) => button.textContent.includes('Record trial'));
        expect(record).toBeTruthy();

        record.click();
        expect(game.recorder.recording).toBe(true);
        expect(game.recorder.startedBy).toBe('button');

        // Redrawn, the same button is now the way to stop
        const stop = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Stop'));
        expect(stop).toBeTruthy();
        stop.click();
        expect(game.recorder.recording).toBe(false);
    });

    test('the export button downloads the same bundle the console helper returns', async () => {
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]));

        [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Export')).click();
        await vi.advanceTimersByTimeAsync(0);

        expect(game.recorder.downloads).toEqual([{ exportedAt: 'now', bundle: true }]);
    });

    test('the per-player button opens the panel', () => {
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]));
        [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Per-player')).click();

        expect(game.scoreboardToggles).toBe(1);
    });

    test('a live reading tells the recorder a trial is running', () => {
        fire(buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]));
        expect(game.recorder.activity).toContain('tab-reading');
    });

    test('the tab’s own footer stats are kept with the trial that produced them', () => {
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        const footer = document.createElement('div');
        footer.innerHTML = '<div>Work Time</div><div>3.14s</div><div>Success Rate</div><div>60.8%</div>';
        root.appendChild(footer);
        fire(root);

        expect(guildTrials.record.tiles['skilling::alchemy'].personal).toMatchObject({
            'Work Time': '3.14s',
            'Success Rate': '60.8%',
        });
    });

    test('an unchanged redraw does not touch the page', () => {
        // The reported "keeps scrolling to the top": the sampler redraws every
        // five seconds and the observer redraws on every React burst, and each
        // one used to tear the blocks out and put them back. A container whose
        // content changes height while you are partway down it gets scrolled
        // back to the top, every few seconds, forever.
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        // Two passes to settle: the second reading is what turns "measuring…"
        // into a rate, so the markup legitimately changes once
        fire(root);
        vi.setSystemTime(now + 5000);
        fire(root);

        const block = document.querySelector('.mwi-trial-info[data-mwi-block^="tile:"]');
        const payout = document.querySelector('.mwi-trial-info[data-mwi-block="payout"]');
        const firstChild = block.firstElementChild;
        const payoutChild = payout.firstElementChild;

        // Two more passes with nothing whatsoever changed
        fire(root);
        fire(root);

        // The very same elements, and the very same nodes inside them: an
        // assignment to `innerHTML` rebuilds the subtree even when the markup is
        // identical, and rebuilding is what moves the scroll
        expect(document.querySelector('.mwi-trial-info[data-mwi-block^="tile:"]')).toBe(block);
        expect(document.querySelector('.mwi-trial-info[data-mwi-block="payout"]')).toBe(payout);
        expect(block.firstElementChild).toBe(firstChild);
        expect(payout.firstElementChild).toBe(payoutChild);
    });

    test('a reading that has moved updates in place rather than being replaced', () => {
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        fire(root);
        const block = document.querySelector('.mwi-trial-info[data-mwi-block^="tile:"]');

        root.querySelector('[class*="ProgressBar_text"]').textContent = '28,850 / 65,280';
        vi.setSystemTime(now + 10_000);
        fire(root);

        // Same element — the reader's place in the page is not disturbed — with
        // new figures in it
        expect(document.querySelector('.mwi-trial-info[data-mwi-block^="tile:"]')).toBe(block);
        expect(block.textContent).toContain('Fill rate');
    });

    test('the scroll position survives a block being inserted', () => {
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        // A scrolling container around the cards, which is what the guild panel is
        root.style.cssText = 'height:80px; overflow-y:auto;';
        Object.defineProperty(root, 'scrollTop', { value: 40, writable: true, configurable: true });

        fire(root);

        expect(root.scrollTop).toBe(40);
    });

    test('a trial that leaves the tab takes its block with it', () => {
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        fire(root);
        expect(document.querySelectorAll('.mwi-trial-info[data-mwi-block^="tile:"]')).toHaveLength(1);

        // The player switches to a tab with a different trial on it
        const swapped = buildTab([{ name: 'Milking', level: 130, bar: '1,000 / 65,280' }]);
        fire(swapped);

        const keys = [...document.querySelectorAll('.mwi-trial-info[data-mwi-block^="tile:"]')].map(
            (block) => block.dataset.mwiBlock
        );
        expect(keys).toEqual(['tile:skilling::milking']);
    });

    test('the card block is a block of its own, never inside the card', () => {
        // Appended into the card it sat on top of the game's own footer —
        // "Completed", "1/28 signed up" — because a card places its last rows
        // against its bottom edge rather than after whatever it contains
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]);
        fire(root);

        const card = root.querySelector('[class*="GuildPanel_tile__"]');
        const block = [...document.querySelectorAll('.mwi-trial-info')].find((el) => el.textContent.includes('Banked'));

        expect(card.contains(block)).toBe(false);
        expect(block.previousElementSibling).toBe(card);
        expect(block.style.position).toBe('static');
    });

    test('a record the panel contradicts is archived, without anyone clearing anything', async () => {
        // The reported failure after the keying fix: the poisoned record was
        // already on disk under the *new* guild's own key, so nothing about
        // provenance could reach it. The page could — it was saying "Scheduled"
        // with every card at 0 pts while the block above claimed banked tiers.
        trialsFeature.cleanup();
        game.characterId = 111;
        game.guildName = 'New Guild';
        game.store = {};
        await trialsFeature.initialize();

        // A cycle's worth of readings, as an older build would have left them
        guildTrials.record = {
            weekStart: guildTrials.record.weekStart,
            tiles: {
                'skilling::milking': {
                    name: 'Milking',
                    kind: 'skilling',
                    tier: 6,
                    pointsByTier: { 6: 840 },
                    samples: [{ t: now - 60_000, readings: [{ current: 100, max: 200 }] }],
                    tiers: [],
                },
            },
        };

        // The panel the user actually has: scheduled, and every card at nothing
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">Scheduled Wed 04:00 PM 2h 24m</div>' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Milking</div>' +
            '<div class="GuildPanel_tileSummary__e">Lv.130</div><div>0 pts</div>' +
            '<div>1/22 signed up</div></div>';
        document.body.appendChild(root);
        fire();

        // The phantom cycle is gone from the record and from the screen — and
        // kept, because the figures were real when they were taken
        // The old cycle's tier and its 840 are gone; what is left is what this
        // cycle's card actually states, which is nothing yet
        expect(guildTrials.record.tiles['skilling::milking']?.pointsByTier?.[6]).toBeUndefined();
        expect(guildTrials.record.tiles['skilling::milking']?.samples).toEqual([]);
        expect(guildTrials.record.history).toHaveLength(1);
        expect(guildTrials.record.history[0].tiles['skilling::milking'].pointsByTier).toEqual({ 6: 840 });
        expect(text()).not.toContain('840');
        expect(text()).not.toContain('Banked5 tiers');
    });

    test('nothing is drawn on the guild Overview tab', () => {
        // Reported from the user's main guild: the payout block and a side block
        // sat over the Overview tab's notice board, on a page with no trial
        // cards at all
        document.body.innerHTML =
            '<div class="GuildPanel_guildPanel__r">' +
            '<div class="TabsComponent_tab__x TabsComponent_selected__y">Overview</div>' +
            '<div class="GuildPanel_notice__n">Welcome! We are milking at Level 90 if anyone wants to join.</div>' +
            '<div class="GuildPanel_dataBlock__d"><div>Exp to Next Level</div><div>4,120 / 20,000</div></div>' +
            '</div>';
        fire();

        expect(document.querySelectorAll('.mwi-trial-info')).toHaveLength(0);
        expect(text()).not.toContain('Trial payout');
    });

    test('blocks drawn on the trials tab do not survive the switch away from it', () => {
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        fire(root);
        expect(document.querySelectorAll('.mwi-trial-info').length).toBeGreaterThan(0);

        // The player clicks Overview. The root finder now answers with a
        // different element, so a block left under the old one would never be
        // looked at again — it would simply stay on screen
        document.body.innerHTML =
            '<div class="GuildPanel_guildPanel__r">' +
            '<div class="TabsComponent_tab__x TabsComponent_selected__y">Overview</div>' +
            '<div class="GuildPanel_dataBlock__d"><div>Exp to Next Level</div><div>4,120 / 20,000</div></div></div>';
        fire();

        expect(document.querySelectorAll('.mwi-trial-info')).toHaveLength(0);
    });

    test('a reading on a tab with no header of its own still arms the recorder', () => {
        // The live failure: the status header is on the Trials tab and the
        // readings are on the In Progress one, so requiring both meant
        // auto-record never armed and the user pressed Record by hand
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        root.querySelector('[class*="GuildPanel_eventStatusRow"]')?.remove();
        fire(root);

        expect(game.recorder.activity).toContain('tab-reading');
    });

    test('during the skilling hour a combat card waits rather than pretending to run', () => {
        // Reported: the Trial Chameleon card rendered "Rate: measuring…" and
        // "Banked: nothing yet — tier 1 in progress" during the skilling hour.
        // The header says which kind it is about.
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">Skilling Trial - In Progress Thu 04:00 PM</div>' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Foraging</div>' +
            '<div class="ProgressBar_text__f">876 / 40,800</div></div>' +
            '<div class="GuildPanel_tile__d"><div class="GuildPanel_tileName__d">Trial Chameleon</div>' +
            '<div class="GuildPanel_tileSummary__e">Lv.100</div></div>';
        document.body.appendChild(root);
        fire();

        const blocks = [...document.querySelectorAll('.mwi-trial-info[data-mwi-block^="tile:"]')];
        const chameleon = blocks.find((block) => block.dataset.mwiBlock.includes('chameleon'));
        const foraging = blocks.find((block) => block.dataset.mwiBlock.includes('foraging'));

        expect(chameleon.textContent).toContain('scheduled');
        expect(chameleon.textContent).not.toContain('measuring');
        expect(chameleon.textContent).not.toContain('nothing yet');
        // …while the kind that is running is live as ever
        expect(foraging.textContent).toContain('Rate');
    });

    test('a combat card that has not started claims no banked tier', () => {
        // Reported from the new build: both combat cards read "Banked: 1 tier"
        // during the skilling hour, on cards stating 0 pts. A card at its own
        // base level with nothing stated has banked nothing.
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">Skilling Trial - In Progress Thu 04:00 PM</div>' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Foraging</div>' +
            '<div class="ProgressBar_text__f">876 / 40,800</div></div>' +
            '<div class="GuildPanel_tile__d"><div class="GuildPanel_tileName__d">Trial Chameleon</div>' +
            '<div class="GuildPanel_tileSummary__e">Lv.100</div><div>0 pts</div></div>';
        document.body.appendChild(root);
        fire();

        const chameleon = [...document.querySelectorAll('.mwi-trial-info[data-mwi-block^="tile:"]')].find((block) =>
            block.dataset.mwiBlock.includes('chameleon')
        );

        expect(chameleon.textContent).not.toContain('Banked');
        expect(chameleon.textContent).not.toContain('measuring');
        expect(chameleon.textContent).toContain('scheduled');

        // …and it contributes nothing to the payout either
        expect(text()).toContain('Guild Points banked');
        expect(text()).not.toContain('Guild Points banked400');
    });

    test('the payout is the week’s, whichever tab is open', () => {
        // Reported: the Trials tab read "banked 2,714" while the In Progress tab
        // read "banked 472" at the same moment, because each summed the cards it
        // could see
        const trialsTab = buildTrialsTabFor('Alchemy', 170, 1080);
        fire(trialsTab);
        const fromTrialsTab = text().match(/Guild Points banked([\d,]+)/)?.[1];
        expect(fromTrialsTab).toBeTruthy();

        // Now the In Progress tab, which shows only the running pool
        document.body.innerHTML = '';
        const live = document.createElement('div');
        live.className = 'GuildPanel_trialsContent__a';
        live.innerHTML =
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Alchemy</div>' +
            '<div class="ProgressBar_text__f">18,850 / 65,280</div></div>';
        document.body.appendChild(live);
        vi.setSystemTime(now + 5000);
        fire();

        expect(text().match(/Guild Points banked([\d,]+)/)?.[1]).toBe(fromTrialsTab);
    });

    test('the live pool files under the tier being fought, not the badge', () => {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">Skilling Trial - In Progress Thu 04:00 PM</div>' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Foraging</div>' +
            '<div class="GuildPanel_tileSummary__e">Lv.110</div><div>354 pts</div>' +
            '<div class="ProgressBar_text__f">24,382 / 48,960</div></div>';
        document.body.appendChild(root);
        fire();

        const tile = guildTrials.record.tiles['skilling::foraging'];
        // Lv.110 badges T2, so 48,960 is T3's pool
        expect(tile.tier).toBe(2);
        expect(tile.tiers).toEqual([{ tier: 3, total: 48_960 }]);
    });

    test('the first pool of a live trial is filed under tier one', () => {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">Skilling Trial - In Progress Thu 04:00 PM</div>' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Foraging</div>' +
            '<div class="ProgressBar_text__f">876 / 40,800</div></div>';
        document.body.appendChild(root);
        fire();

        const tile = guildTrials.record.tiles['skilling::foraging'];
        // No badge yet, so the reading is the first tier's
        expect(tile.tiers).toEqual([{ tier: 1, total: 40_800 }]);
    });

    test('a panel that says the cycle is over vetoes it', () => {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">Skilling Trial - Completed Thu 09:00 AM</div>' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Alchemy</div>' +
            '<div class="ProgressBar_text__f">18,850 / 65,280</div></div>';
        document.body.appendChild(root);
        fire();

        expect(game.recorder.activity).not.toContain('tab-reading');
    });

    test('a reading on a running trial does start one', () => {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">In Progress — 42:15 remaining</div>' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Alchemy</div>' +
            '<div class="ProgressBar_text__f">18,850 / 65,280</div></div>';
        document.body.appendChild(root);
        fire();

        expect(game.recorder.activity).toContain('tab-reading');
        expect(game.recorder.lifecycle).toContain('live');
    });

    test('the legacy shared bucket is purged at startup', async () => {
        trialsFeature.cleanup();
        game.store = { guildTrials_default: { weekStart: 1, tiles: { a: {} } } };
        await trialsFeature.initialize();
        await vi.advanceTimersByTimeAsync(0);

        // One bucket for every character in the tab is what poisoned a guild's
        // record in the first place
        expect(game.store.guildTrials_default).toBeUndefined();
    });

    test('a live trial whose cards are still at zero is not mistaken for a stale record', () => {
        // The guard on the guard: a running trial routinely shows 0 pts before
        // the first tier clears, so "0 pts" alone must not throw anything away
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        fire(root);
        expect(guildTrials.record.tiles['skilling::alchemy']).toBeTruthy();

        vi.setSystemTime(now + 5000);
        fire(root);

        expect(guildTrials.record.tiles['skilling::alchemy'].samples.length).toBeGreaterThan(1);
        expect(guildTrials.record.history || []).toHaveLength(0);
    });

    test('a finished cycle stops projecting a future', () => {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">Completed Thu 09:00 AM</div>' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Alchemy</div>' +
            '<div class="GuildPanel_tileSummary__e">Lv.170</div>' +
            '<div class="ProgressBar_text__f">18,850 / 65,280</div></div>';
        document.body.appendChild(root);

        fire();
        root.querySelector('[class*="ProgressBar_text"]').textContent = '28,850 / 65,280';
        vi.setSystemTime(now + 10_000);
        fire();

        // The rate is still shown — it happened — but nothing is projected from it
        expect(text()).toContain('Final fill rate');
        expect(text()).not.toContain('Tier clears in');
        expect(text()).not.toContain('On pace for');
    });

    test('the lifecycle is passed to the alerts', () => {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">Scheduled Wed 04:00 PM 2h 24m</div>' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Milking</div>' +
            '<div class="GuildPanel_tileSummary__e">Lv.130</div><div>0 pts</div></div>';
        document.body.appendChild(root);
        fire();

        expect(game.alerts.status.at(-1)).toMatchObject({
            phase: 'scheduled',
            startsInMs: 2 * 3600_000 + 24 * 60_000,
        });
    });

    test('switching character in the same tab leaves nothing of the old one behind', async () => {
        // Live-tested and reported: a fresh character in a different guild was
        // shown the previous guild's finished trial — "Guild Points banked
        // 2,880" beside a header reading 0, and a warning that judged the old
        // record's 840 pts against the new guild's Builder's Hall level.
        trialsFeature.cleanup();
        game.characterId = 111;
        game.guildName = 'Old Guild';
        game.store = {};
        await trialsFeature.initialize();

        fire(buildTab([{ name: 'Alchemy', level: 170, bar: '18,850 / 65,280' }]));
        expect(guildTrials.record.tiles['skilling::alchemy']).toBeTruthy();
        expect(game.trialNames).toBeDefined();

        // The switch message arrives before the arriving character's own data,
        // so every source of a guild name still answers with the old one
        game.characterId = 111;
        game.dmHandlers.character_switching.forEach((handler) => handler({ oldId: 111, newId: 222 }));
        await vi.advanceTimersByTimeAsync(0);

        // Nothing of the old character's survives, on screen or in hand
        expect(document.querySelectorAll('.mwi-trial-info')).toHaveLength(0);
        expect(guildTrials.guildName).toBeNull();
        expect(guildTrials.record?.tiles?.['skilling::alchemy']).toBeUndefined();
        expect(game.trialNames).toEqual([]);
        expect(game.recorder.forgotten).toBe(true);

        // And the old guild's name is not adopted while the ids still disagree
        expect(guildTrials._resolveGuildName()).toBeNull();

        // Once the arriving character's data lands, it is their own guild
        game.characterId = 222;
        game.guildName = 'New Guild';
        expect(guildTrials._resolveGuildName()).toBe('New Guild');
    });

    test('the fresh character draws its own empty state, not the last one’s', async () => {
        trialsFeature.cleanup();
        game.characterId = 111;
        game.guildName = null;
        game.store = {};
        await trialsFeature.initialize();

        // Character A banks a trial
        buildTrialsTabFor('Alchemy', 170, 1080);
        fire();
        expect(text()).toContain('Guild Points banked');

        game.dmHandlers.character_switching.forEach((handler) => handler({ oldId: 111, newId: 222 }));
        game.characterId = 222;
        await vi.advanceTimersByTimeAsync(0);

        // Character B's guild has run nothing: its cards state nothing, and the
        // panel must say nothing rather than the previous guild's total
        buildTrialsTabFor('Milking', 130, 0);
        fire();

        expect(text()).not.toContain('1,080');
        expect(guildTrials.record.tiles['skilling::alchemy']).toBeUndefined();
    });

    test('the guild name is taken off a guild message when the XP tracker never saw one', async () => {
        // Reported: every session filed its samples under `guildTrials_default`
        // because the tracker answered null all the way through — it can be
        // switched off, and it only ever learns the name from traffic it may not
        // have received.
        trialsFeature.cleanup();
        game.guildName = null;
        game.store = {};
        await trialsFeature.initialize();

        buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        game.wsHandlers.guild_updated({ guild: { name: 'Milky Way', experience: 10 } });
        await vi.advanceTimersByTimeAsync(0);

        expect(guildTrials.guildName).toBe('Milky Way');
        expect(Object.keys(game.store)).toContain('guildTrials_Milky Way');
        game.guildName = 'Milky Way';
    });

    test('a watched fight feeds the pool to a card the game draws no bar on', async () => {
        // The Trials tab's combat card carries a level and no bar at all, so
        // every projection said "measuring…" for the whole hour. The spectator
        // stream states the same pool to the unit, and the tier with it
        game.breakdown = { pool: { current: 454_807, max: 618_000, tier: 2, at: now, encounter: 'chameleon' } };
        const root = buildTab([{ name: 'Trial Chameleon', level: 110, points: 400, bar: '' }]);
        root.querySelector('[class*="ProgressBar_text"]').remove();
        fire(root);

        game.breakdown = {
            pool: { current: 453_402, max: 618_000, tier: 2, at: now + 10_000, encounter: 'chameleon' },
        };
        vi.setSystemTime(now + 10_000);
        fire(root);

        const record = guildTrials.record.tiles['combat::trial chameleon'];
        expect(record.samples.length).toBeGreaterThan(1);
        // The tier is the stream's own, not the badge plus one
        expect(record.tiers.some((entry) => entry.tier === 2 && entry.total === 618_000)).toBe(true);
        expect(text()).toContain('Party DPS');
    });

    test('a stale pool stops standing in, rather than reading as a rate of zero', async () => {
        game.breakdown = {
            pool: { current: 454_807, max: 618_000, tier: 2, at: now - 60_000, encounter: 'chameleon' },
        };
        const root = buildTab([{ name: 'Trial Chameleon', level: 110, points: 400, bar: '' }]);
        root.querySelector('[class*="ProgressBar_text"]').remove();
        fire(root);

        const record = guildTrials.record.tiles['combat::trial chameleon'];
        expect(record.samples).toHaveLength(0);
    });

    test('a card the game is drawing a bar on keeps its own numbers', async () => {
        // Two sources must never disagree on screen
        game.breakdown = { pool: { current: 1, max: 618_000, tier: 2, at: now, encounter: 'chameleon' } };
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]);
        fire(root);

        const record = guildTrials.record.tiles['combat::trial chameleon'];
        expect(record.samples[0].readings[0]).toMatchObject({ current: 618_000 });
    });

    test('with two combat trials the watched pool goes to one card, not both', async () => {
        // Reported: a week with two combat trials, both cards barless, and the
        // Chameleon fight's pool was injected into the Hedgehog card too — so
        // the guild report read "Trial Hedgehog — cleared 0 tiers … 490,871 of
        // 721,000 HP left" about a fight nobody had with a hedgehog
        game.breakdown = { pool: { current: 490_871, max: 721_000, tier: 3, at: now, encounter: 'chameleon' } };
        const root = buildTab([
            { name: 'Trial Chameleon', level: 120, points: 944, bar: '' },
            { name: 'Trial Hedgehog', level: 100, points: 0, bar: '' },
        ]);
        root.querySelectorAll('[class*="ProgressBar_text"]').forEach((el) => el.remove());
        fire(root);

        const chameleon = guildTrials.record.tiles['combat::trial chameleon'];
        const hedgehog = guildTrials.record.tiles['combat::trial hedgehog'];

        expect(chameleon.samples.length).toBeGreaterThan(0);
        expect(chameleon.tiers.some((entry) => entry.tier === 3 && entry.total === 721_000)).toBe(true);
        // And the trial nobody watched stays empty rather than inheriting it
        expect(hedgehog.samples).toHaveLength(0);
        expect(hedgehog.tiers).toEqual([]);
    });

    test('an unidentified fight attaches to no card at all', async () => {
        // Better "no data" on both than the right number on the wrong trial
        game.breakdown = { pool: { current: 490_871, max: 721_000, tier: 3, at: now, encounter: null } };
        const root = buildTab([
            { name: 'Trial Chameleon', level: 120, points: 944, bar: '' },
            { name: 'Trial Hedgehog', level: 100, points: 0, bar: '' },
        ]);
        root.querySelectorAll('[class*="ProgressBar_text"]').forEach((el) => el.remove());
        fire(root);

        expect(guildTrials.record.tiles['combat::trial chameleon'].samples).toHaveLength(0);
        expect(guildTrials.record.tiles['combat::trial hedgehog'].samples).toHaveLength(0);
    });

    test('the guild report is about the trial that was watched', async () => {
        game.breakdown = {
            source: 'spectated',
            pool: { current: 490_871, max: 721_000, tier: 3, at: now, encounter: 'chameleon' },
        };
        const root = buildTab([
            // Chameleon has banked two tiers; Hedgehog has banked nothing and
            // sorts later, so it used to win the context by being last
            { name: 'Trial Chameleon', level: 110, points: 708, bar: '' },
            { name: 'Trial Hedgehog', level: 100, points: 0, bar: '' },
        ]);
        root.querySelectorAll('[class*="ProgressBar_text"]').forEach((el) => el.remove());
        fire(root);

        expect(game.scoreboardContext?.trialName).toBe('Trial Chameleon');
        expect(game.scoreboardContext?.tiersCleared).toBe(2);
    });

    /**
     * The In Progress tab: a bar, and the footer of stats beneath it.
     * @param {boolean} [live] - Whether the card still carries a bar
     * @returns {Element} The tab
     */
    function buildInProgress(live = true) {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">Skilling Trial - In Progress 42:15 remaining</div>' +
            '<div class="GuildPanel_tile__c">' +
            '<div class="GuildPanel_tileName__d">Foraging</div>' +
            // Between tiers the bar is gone and the card is a name and its points
            (live
                ? '<div class="ProgressBar_text__f">20,500 / 57,120</div>'
                : '<div class="Card_points__p">590 pts</div>') +
            '</div>' +
            '<div class="GuildPanel_footer__g">' +
            '<div>Work Power</div><div>146</div>' +
            '<div>Success Rate</div><div>49.6%</div>' +
            // The per-minute session log the game draws beside them
            '<div>59m</div><div>5s</div>' +
            '<div>1m</div><div>3s</div>' +
            '<div>Time</div><div>1s</div>' +
            '</div>';
        document.body.appendChild(root);
        return root;
    }

    /** Seed the record as the Trials tab would have left it */
    function seedForaging(extra = {}) {
        guildTrials.record.tiles['skilling::foraging'] = {
            name: 'Foraging',
            kind: 'skilling',
            level: 130,
            tier: 4,
            points: 590,
            pointsByTier: { 1: 236, 2: 354, 3: 472, 4: 590 },
            samples: [],
            tiers: [],
            ...extra,
        };
    }

    test('a stats read during a tier lands under that tier', async () => {
        // Reported from two exports: `personal` had 61 entries and
        // `personalByTier` was empty for the whole trial, so the success-decline
        // model — which is built from exactly this — had nothing to fit
        const root = buildInProgress();
        seedForaging();
        fire(root);

        const tile = guildTrials.record.tiles['skilling::foraging'];
        // Four banked, so the readings are the fifth tier's
        expect(tile.personalByTier['5']).toMatchObject({ 'Success Rate': '49.6%' });
        expect(tile.personal['Success Rate']).toBe('49.6%');
    });

    test('a stats read on a card with no bar still lands under the banked tier', async () => {
        // The join used to ride on the *reading's* tier, which is null the
        // moment a card stops being live — so a footer read between tiers, or
        // after the hour, went nowhere
        const root = buildInProgress(false);
        seedForaging();
        fire(root);

        const tile = guildTrials.record.tiles['skilling::foraging'];
        expect(tile.personalByTier['4']).toMatchObject({ 'Success Rate': '49.6%' });
    });

    test('the per-minute time list is not a stat sheet', async () => {
        // The exact junk from the export: "59m": "5s" … "1m": "3s", "Time": "1s"
        const root = buildInProgress();
        seedForaging();
        fire(root);

        const tile = guildTrials.record.tiles['skilling::foraging'];
        expect(Object.keys(tile.personal)).toEqual(['Work Power', 'Success Rate']);
        expect(tile.personal['59m']).toBeUndefined();
        expect(tile.personal['1m']).toBeUndefined();
        expect(tile.personal.Time).toBeUndefined();
    });

    test('a completed card that banked nothing says so as a result', async () => {
        // The Hedgehog party wiped before clearing tier one, so its card read
        // Completed with no points and no badge — and the block said "nothing
        // yet — tier 1 in progress" under a trial that was over
        const root = buildTab(
            [{ name: 'Trial Hedgehog', level: 100, points: 0, bar: '721,000 / 721,000', completed: true }],
            'Combat Trial - Completed'
        );
        fire(root);

        expect(text()).toContain('0 tiers — fell before tier 1');
        expect(text()).not.toContain('in progress');
        expect(text()).not.toContain('tier not seen yet');
    });

    test('a guild notice board makes no tile, no stats and no recording', async () => {
        // The whole failure, end to end. On a live 106-member guild the notice
        // became a tile: two Discord channel ids in it read as a progress bar,
        // the Overview tab's guild statistics were attached to it as the
        // player's own action stats, and it was live enough to start the
        // recorder — that session reads `startedBy: "tab-reading"`
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        const tile = document.createElement('div');
        tile.className = 'GuildPanel_tile__c';
        tile.innerHTML =
            `<div class="GuildPanel_tileName__d">${NOTICE_BOARD_NAME.replace(/</g, '')}</div>` +
            '<div class="ProgressBar_text__f">' +
            'https://discord.com/channels/1234500000000000001/1525000000000000321</div>' +
            '<div>Guild Level</div><div>127</div>' +
            '<div>Guild Members</div><div>106</div>';
        root.appendChild(tile);
        document.body.appendChild(root);
        fire(root);

        expect(Object.keys(guildTrials.record.tiles)).toEqual([]);
        expect(game.recorder.activity).toEqual([]);
        expect(game.recorder.recording).toBe(false);
        // And no block was drawn over somebody's notice board
        expect(document.querySelectorAll('.mwi-trial-info')).toHaveLength(0);
    });

    test('the socket fills a skilling card the DOM has nothing on', async () => {
        // `guild_skilling_updated` states the pool, the tier and the player's own
        // action figures — every one of which was otherwise scraped off a tab
        // that has to be open, and each of which has had its own bug
        game.skilling.crafting = {
            trial: { kind: 'skilling', key: 'crafting', name: 'Crafting' },
            tier: 10,
            reading: { current: 21_608, max: 88_920 },
            personal: { 'Success Rate': '8.0%', 'Work Power': '161' },
            participantIds: [910007],
            at: now,
        };
        const root = buildTab([{ name: 'Crafting', level: 190, points: 1100, bar: '' }]);
        root.querySelectorAll('[class*="ProgressBar_text"]').forEach((el) => el.remove());
        fire(root);

        const tile = guildTrials.record.tiles['skilling::crafting'];
        expect(tile.samples).toHaveLength(1);
        expect(tile.samples[0].readings[0]).toEqual({ current: 21_608, max: 88_920 });
        // The tier is the payload's own, not a badge plus an assumption
        expect(tile.tiers).toContainEqual({ tier: 10, total: 88_920 });
        expect(tile.personalByTier['10']).toMatchObject({ 'Success Rate': '8.0%' });
    });

    test('a card the game is drawing a bar on keeps its own numbers', async () => {
        game.skilling.crafting = {
            trial: { kind: 'skilling', key: 'crafting', name: 'Crafting' },
            tier: 10,
            reading: { current: 1, max: 88_920 },
            personal: {},
            participantIds: [],
            at: now,
        };
        const root = buildTab([{ name: 'Crafting', level: 190, points: 1100, bar: '21,608 / 88,920' }]);
        fire(root);

        expect(guildTrials.record.tiles['skilling::crafting'].samples[0].readings[0].current).toBe(21_608);
    });

    test('the end message stamps the card completed at the tier it banked', async () => {
        // `end_guild_skilling` states tier 9 while tier 10 is in progress — the
        // game's own confirmation that a stated tier counts what is finished
        game.skillingEnded.crafting = { tier: 9, at: now };
        const root = buildTab([{ name: 'Crafting', level: 190, points: 1100, bar: '' }]);
        root.querySelectorAll('[class*="ProgressBar_text"]').forEach((el) => el.remove());
        fire(root);

        const tile = guildTrials.record.tiles['skilling::crafting'];
        expect(tile.completed).toBe(true);
        expect(tile.tier).toBe(9);
    });

    test('the game declaring a trial over ends the recording, certainly', async () => {
        // The only lifecycle signal this feature has ever had that is certain.
        // Everything else is a phase inferred from a header that may name the
        // other kind, or from a badge that may not have been redrawn
        game.skillingEnded.crafting = { tier: 9, at: now };
        const root = buildTab([{ name: 'Crafting', level: 190, points: 1100, bar: '21,608 / 88,920' }]);
        fire(root);

        expect(game.recorder.lifecycle).toContain('completed');
    });

    test('one kind ending is not the hour ending', async () => {
        // A guild runs the two kinds one after the other, so the skilling half
        // finishing while a combat trial is still live is not the end of anything
        game.skillingEnded.crafting = { tier: 9, at: now };
        const root = buildTab([
            { name: 'Crafting', level: 190, points: 1100, bar: '21,608 / 88,920' },
            { name: 'Trial Badger', level: 100, points: 400, bar: '429,000 / 429,000' },
        ]);
        fire(root);

        expect(game.recorder.lifecycle).not.toContain('completed');
    });

    test('a card wearing a Completed badge shows results, whatever the header says', async () => {
        // Reported: the header read "Combat Trial - In Progress" while the
        // skilling cards below it were decorated "Completed" — and the Foraging
        // block went on drawing a fill rate, a pace and a tier-clears-in for an
        // hour that had ended. The card's own badge is the per-card signal.
        const live = 'Combat Trial - In Progress — 42:15 remaining';
        const root = buildTab(
            [{ name: 'Trial Foraging', level: 130, points: 590, bar: '30,000 / 57,120', completed: true }],
            live
        );
        fire(root);

        // A second reading, so there is a rate to report as final
        root.querySelector('[class*="ProgressBar_text"]').textContent = '30,500 / 57,120';
        vi.setSystemTime(now + 10_000);
        fire(root);

        // The payout block is one of these too, so take the card's own
        const block = [...document.querySelectorAll('.mwi-trial-info')].find(
            (el) => !el.textContent.includes('Trial payout')
        );
        expect(block).toBeTruthy();
        const body = block.textContent;

        // Results, not a forecast and not a waiting room
        expect(body).toContain('Final fill rate');
        expect(body).toContain('Banked');
        expect(body).not.toContain('On pace for');
        expect(body).not.toContain('Tier clears in');
        expect(body).not.toContain('scheduled');
    });
});

/**
 * The two tabs as the live client actually draws them.
 *
 * Transcribed from screenshots of a running trial, which is the only reason this
 * file knows any of it. The shapes matter more than the exact strings: the
 * Trials tab has cards with no progress bar and the In Progress tab has a bar
 * with no level, so anything that requires both on one card records nothing on
 * either tab — which is what shipped, twice.
 */
describe('the two trial tabs, as the game draws them', () => {
    /**
     * The Trials tab: the setup cards, their sign-ups, and a countdown.
     * @returns {Element} The guild panel
     */
    function buildTrialsTab() {
        document.body.innerHTML = '';
        const panel = document.createElement('div');
        panel.className = 'GuildPanel_guildPanel__root';
        panel.innerHTML = `
            <div class="GuildPanel_header__h">Skilling Trial - In Progress Thu 09:00 AM</div>
            <div class="GuildPanel_setTime__s">Set Time</div>
            <div class="GuildPanel_tile__a">
                <div class="GuildPanel_tileName__n">Milking</div>
                <div class="GuildPanel_tileSummary__s">Lv.130<span class="mwi-trial-tier">T4</span></div>
                <div class="GuildPanel_points__p">600 pts</div>
                <div class="GuildPanel_signups__u">1/28 signed up</div>
                <div class="GuildPanel_clock__c">20m 53s</div>
            </div>
            <div class="GuildPanel_tile__b">
                <div class="GuildPanel_tileName__n">Foraging</div>
                <div class="GuildPanel_points__p">0 pts</div>
                <div class="GuildPanel_signups__u">0/28 signed up</div>
            </div>
            <div class="GuildPanel_tile__c">
                <div class="GuildPanel_tileName__n">Alchemy</div>
                <div class="GuildPanel_tileSummary__s">Lv.150<span class="mwi-trial-tier">T6</span></div>
                <div class="GuildPanel_points__p">840 pts</div>
                <div class="GuildPanel_signups__u">2/28 signed up</div>
                <div class="GuildPanel_clock__c">20m 53s</div>
            </div>
            <div class="GuildPanel_tile__d">
                <div class="GuildPanel_tileName__n">Trial Chameleon</div>
                <div class="GuildPanel_points__p">0 pts</div>
                <div class="GuildPanel_signups__u">Signed Up 3/56</div>
            </div>`;
        document.body.appendChild(panel);
        return panel;
    }

    /**
     * The In Progress tab: one card with the pool reading, and the footer.
     * @param {string} [reading] - What the bar says
     * @returns {Element} The guild panel
     */
    function buildInProgressTab(reading = '18,850 / 65,280') {
        document.body.innerHTML = '';
        const panel = document.createElement('div');
        panel.className = 'GuildPanel_guildPanel__root';
        panel.innerHTML = `
            <div class="GuildPanel_card__a">
                <div class="GuildPanel_cardName__n">Alchemy</div>
                <div class="ProgressBar_text__t">${reading}</div>
            </div>
            <div class="GuildPanel_member__m"><div>MillenniumTest</div><div>Working</div></div>
            <div class="GuildPanel_footer__f">
                <div>Work Power 229</div>
                <div>Work Time 3.14s</div>
                <div>Success Rate 60.8%</div>
                <div>Time: 20m 37s</div>
            </div>`;
        document.body.appendChild(panel);
        return panel;
    }

    const fire = () => game.observers['GuildPanel_']();

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        game.settings = { guildTrialsInfo: true };
        game.settingValues = {};
        game.clientData = {};
        game.prices = {};
        game.buildingLevels = {};
        game.store = {};
        game.members = [];
        game.characterId = null;
        game.characterData = null;
        game.dmHandlers = {};
        game.trialNames = [];
        game.alerts = { status: [], payouts: [], reset: 0 };
        game.recorder = {
            recording: false,
            activity: [],
            lifecycle: [],
            downloads: [],
            startedBy: null,
            endedBy: null,
        };
        game.scoreboardToggles = 0;
        guildTrials.record = null;
        guildTrials.guildName = null;
        await trialsFeature.initialize();
    });

    afterEach(() => {
        trialsFeature.cleanup();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    test('the Trials tab gives the tier, the points and the sign-ups, and no samples', () => {
        buildTrialsTab();
        fire();

        const milking = guildTrials.record.tiles['skilling::milking'];
        expect(milking).toMatchObject({ level: 130, tier: 4, points: 600 });
        expect(milking.signups).toEqual({ signed: 1, total: 28 });
        // Nothing on this tab moves, so nothing here is a reading
        expect(milking.samples).toHaveLength(0);
    });

    test('the tier survives this script having written a badge into the level line', () => {
        // `guild-credit-value.js` appends `T4` inside the very element holding
        // "Lv.130", and a leaf-element text walk drops any element that has
        // acquired a child — so the level vanished from every card the moment
        // this script annotated it
        buildTrialsTab();
        fire();

        expect(guildTrials.record.tiles['skilling::alchemy'].tier).toBe(6);
    });

    test('a sign-up ratio is never sampled as a progress bar', () => {
        // "1/28 signed up" and "Signed Up 3/56" have exactly the shape of a
        // reading, and a pool that fills and empties as members join would be
        // measured as a rate
        buildTrialsTab();
        fire();

        for (const tile of Object.values(guildTrials.record.tiles)) {
            expect(tile.samples).toHaveLength(0);
        }
    });

    test('a combat card written "Signed Up 3/56" is read the other way round too', () => {
        buildTrialsTab();
        fire();

        expect(guildTrials.record.tiles['combat::trial chameleon'].signups).toEqual({ signed: 3, total: 56 });
    });

    test('the In Progress tab gives the reading, from a card with no level on it', () => {
        buildInProgressTab();
        fire();

        const alchemy = guildTrials.record.tiles['skilling::alchemy'];
        expect(alchemy.samples).toHaveLength(1);
        expect(alchemy.samples[0].readings).toEqual([{ current: 18_850, max: 65_280 }]);
    });

    test('neither the members nor the footer is mistaken for a trial', () => {
        buildInProgressTab();
        fire();

        expect(Object.keys(guildTrials.record.tiles)).toEqual(['skilling::alchemy']);
    });

    test('the two tabs join into one trial: tier from Trials, rate from In Progress', () => {
        // The whole point. Neither tab is sufficient and the name is the join.
        buildTrialsTab();
        fire();

        buildInProgressTab('18,850 / 65,280');
        fire();

        vi.setSystemTime(now + 60_000);
        buildInProgressTab('28,850 / 65,280');
        fire();

        const alchemy = guildTrials.record.tiles['skilling::alchemy'];
        expect(alchemy.tier).toBe(6);
        expect(alchemy.samples).toHaveLength(2);

        const analysis = analyseTrial(alchemy, { timeLeftMs: 20 * 60_000 });
        expect(analysis.rate).toBeCloseTo(10_000 / 60_000, 9);
        // The badge counts what is banked, so a T6 card has six behind it
        expect(analysis.tiersClearedSoFar).toBe(6);
        expect(analysis.tier).toBe(7);
    });

    test('the countdown is read off either tab, and the footer stats are not clocks', () => {
        // "Work Time 3.14s" is a decimal, "Success Rate 60.8%" is a percentage,
        // and "Thu 09:00 AM" is a time of day that reads as nine minutes
        buildInProgressTab();
        fire();
        expect(guildTrials._timeLeftMs(document.querySelector('[class*="GuildPanel"]'))).toBe(20 * 60_000 + 37_000);

        buildTrialsTab();
        expect(guildTrials._timeLeftMs(document.querySelector('[class*="GuildPanel"]'))).toBe(20 * 60_000 + 53_000);
    });

    test('the pace block appears once a rate and a clock are both in hand', () => {
        buildTrialsTab();
        fire();
        buildInProgressTab('18,850 / 65,280');
        fire();
        vi.setSystemTime(now + 60_000);
        buildInProgressTab('28,850 / 65,280');
        fire();

        expect(document.body.textContent).toContain('On pace for');
        expect(document.body.textContent).not.toContain('no clock visible');
    });

    test('a tier observation needs both tabs, and is recorded from both', () => {
        // The total comes off the In Progress bar and the tier off the Trials
        // card. Requiring one card to carry both means the growth curve is never
        // fitted and "Next tier work" never appears.
        buildTrialsTab();
        fire();
        buildInProgressTab();
        fire();

        expect(guildTrials.record.tiles['skilling::alchemy'].tiers).toContainEqual({ tier: 6, total: 65_280 });
    });

    test('the sign-up count off the card is what the panel counts as participants', () => {
        buildTrialsTab();
        fire();
        buildInProgressTab();
        fire();

        // Two members signed up for Alchemy on the Trials tab, and no socket
        // sign-up traffic has been seen at all — the old count would be zero
        expect(participantCounts()).toEqual({});
        expect(guildTrials.record.tiles['skilling::alchemy'].signups.signed).toBe(2);
        expect(document.body.textContent).toContain('Trial payout');
    });
});

describe('zero is a claim, and usually the wrong one', () => {
    /**
     * A record from the In Progress tab alone: a reading, and no tier anywhere.
     * @returns {Object} A tile record
     */
    const inProgressOnly = () => ({
        name: 'Alchemy',
        kind: 'skilling',
        level: null,
        tier: null,
        samples: [
            { t: now, readings: [{ current: 18_850, max: 65_280 }] },
            { t: now + 10_000, readings: [{ current: 28_850, max: 65_280 }] },
        ],
        tiers: [],
    });

    test('a tier that was never on screen is unknown, not nought banked', () => {
        const analysis = analyseTrial(inProgressOnly(), { timeLeftMs: 20 * 60_000 });

        expect(analysis.tierKnown).toBe(false);
        expect(analysis.tiersClearedSoFar).toBe(0);

        const html = renderTrialBlock(analysis, 0, { measured: false, reason: 'nothing' });
        expect(html).toContain('tier not seen yet');
        expect(html).not.toContain('0 tiers');
    });

    test('the first tier in progress says so rather than reading as a failure', () => {
        // Pre-badge: a trial on its first tier has banked nothing, and the badge
        // that would say otherwise has not appeared yet
        const analysis = analyseTrial(
            {
                name: 'Alchemy',
                kind: 'skilling',
                tier: null,
                samples: [{ t: now, readings: [{ current: 10, max: 100 }] }],
                tiers: [],
            },
            { timeLeftMs: 60_000, phase: 'live' }
        );

        expect(analysis.tier).toBe(1);
        expect(renderTrialBlock(analysis, 0)).toContain('nothing yet');
    });

    test('a pace that cannot be projected says which of the four things is missing', () => {
        // No clock
        expect(renderTrialBlock(analyseTrial(inProgressOnly(), {}), 0)).toContain('no clock visible');

        // A clock, but no tier to walk the ladder from
        expect(renderTrialBlock(analyseTrial(inProgressOnly(), { timeLeftMs: 60_000 }), 0)).toContain(
            'tier not known yet'
        );

        // A clock and a tier, and one reading
        const oneSample = analyseTrial(
            { name: 'Alchemy', kind: 'skilling', tier: 3, samples: [{ t: now, readings: [{ current: 1, max: 10 }] }] },
            { timeLeftMs: 60_000 }
        );
        expect(renderTrialBlock(oneSample, 0)).toContain('measuring');
    });
});

describe('the side block’s shape', () => {
    // Reported from a screenshot: the two-column rows wrapped badly on a narrow
    // card — "Rate | no data — only trials you join can be measured" became a
    // tall ragged column, and "Next tier | needs a second tier to fit the curve"
    // broke mid-phrase. A caption is a sentence, not a value.
    test('a sentence gets the full width, under its label', () => {
        const analysis = analyseTrial(record({ tier: 6, samples: [] }), {});
        const html = renderTrialBlock(analysis, 3, { measured: false, reason: 'none' }, { participating: false });

        // Not squeezed into a right-hand column
        expect(html).not.toMatch(/justify-content:space-between[^>]*>\s*<span[^>]*>Rate<\/span>\s*<span[^>]*>no data/);
        expect(html).toContain('no data — only trials you join can be measured');
    });

    test('a real figure stays a two-column row', () => {
        const analysis = analyseTrial(
            record({
                kind: 'skilling',
                samples: [
                    { t: now, readings: [{ current: 1000, max: 65_280 }] },
                    { t: now + 10_000, readings: [{ current: 2060, max: 65_280 }] },
                ],
            }),
            {}
        );
        const html = renderTrialBlock(analysis, 3, { measured: false, reason: 'none' });

        expect(html).toMatch(/justify-content:space-between/);
        expect(html).toContain('Fill rate');
        expect(html).toContain('\u00a0work/s');
    });
});

describe('the first tier of a running trial', () => {
    // Live evidence: a trial visibly on its first tier (0 pts everywhere, first
    // pool 876/40,800) reported "tier not known yet", "On pace for: tier not
    // known yet" and "Expected: not projectable" for the whole hour. Every
    // trial starts at tier 1; the In Progress tab simply never says so.
    const running = (extra = {}) => ({
        name: 'Foraging',
        kind: 'skilling',
        samples: [
            { t: now, readings: [{ current: 876, max: 40_800 }] },
            { t: now + 10_000, readings: [{ current: 1756, max: 40_800 }] },
        ],
        tiers: [],
        ...extra,
    });

    test('a live trial with nothing banked is on tier one', () => {
        const analysis = analyseTrial(running(), { phase: 'live', timeLeftMs: 40 * 60_000 });

        expect(analysis.tier).toBe(1);
        expect(analysis.tierKnown).toBe(true);
        expect(analysis.tierSource).toBe('first-tier-rule');
        expect(analysis.tiersClearedSoFar).toBe(0);
    });

    test('and a pace can be walked from the start of it', () => {
        const analysis = analyseTrial(running({ tiers: [{ tier: 1, total: 40_800 }] }), {
            phase: 'live',
            timeLeftMs: 40 * 60_000,
        });

        expect(analysis.pace).not.toBeNull();
        const html = renderTrialBlock(analysis, 3, { measured: false, reason: 'none' }, { phase: 'live' });
        expect(html).not.toContain('tier not known yet');
        expect(html).not.toContain('tier not seen yet');
    });

    test('a card that already states points is not assumed to be on tier one', () => {
        // Joining midway: the trial has banked something and the tier badge is
        // the only thing that can say which one
        const analysis = analyseTrial(running({ pointsByTier: { 5: 840 } }), {
            phase: 'live',
            timeLeftMs: 40 * 60_000,
        });

        expect(analysis.tier).toBeNull();
        expect(analysis.tierKnown).toBe(false);
    });

    test('a scheduled or unknown phase assumes nothing', () => {
        expect(analyseTrial(running(), { phase: 'scheduled' }).tier).toBeNull();
        expect(analyseTrial(running(), {}).tier).toBeNull();
    });

    test('the card’s own tier always wins over the rule', () => {
        // A badge with points behind it counts banked tiers, so the one being
        // fought is the next
        const banked = analyseTrial(running({ tier: 6, pointsByTier: { 6: 700 } }), { phase: 'live' });
        expect(banked.tier).toBe(7);
        expect(banked.tiersClearedSoFar).toBe(6);

        // A badge with no points behind it is the tier in progress, banking nothing
        const started = analyseTrial(running({ tier: 6 }), { phase: 'live' });
        expect(started.tier).toBe(6);
        expect(started.tiersClearedSoFar).toBe(0);
        expect(banked.tierSource).toBe('card');
    });
});

describe('a trial that banked nothing', () => {
    test('a stated zero outranks the completed badge', () => {
        // The wipe case: "Lv.100, 0 pts, Completed" is a party that fell before
        // clearing tier one, not a party that finished the tier it was fighting
        const analysis = analyseTrial(
            record({ kind: 'combat', tier: 1, level: 100, points: 0, pointsByTier: { 1: 0 }, completed: true }),
            {}
        );

        expect(analysis.tiersClearedSoFar).toBe(0);
        expect(analysis.tier).toBe(1);
        expect(analysis.points.basePoints).toBe(0);
    });

    test('a completed card whose points were never seen is unchanged', () => {
        // Absent is not zero, and a card read only on the In Progress tab has
        // never stated its points at all
        const analysis = analyseTrial(record({ kind: 'combat', tier: 3, completed: true, points: undefined }), {});
        expect(analysis.tiersClearedSoFar).toBe(3);
    });

    test('and it contributes nothing to the payout rather than a tier’s worth', () => {
        const wiped = analyseTrial(
            record({ kind: 'combat', tier: 1, level: 100, points: 0, pointsByTier: { 1: 0 }, completed: true }),
            {}
        );
        expect(wiped.points.basePoints).toBe(0);

        const banked = analyseTrial(
            record({ kind: 'combat', tier: 1, level: 100, points: 400, pointsByTier: { 1: 400 }, completed: true }),
            {}
        );
        expect(banked.points.basePoints).toBeGreaterThan(0);
    });
});

describe('the badge counts what is banked', () => {
    // The live sequence that settled it: after the first clear the card read
    // "Lv.100, 236 pts, T1"; after the second, "Lv.110, 354 pts, T2" — while the
    // pool on the In Progress tab was visibly the third one. So the badge is
    // tiers finished and the tier being fought is one past it.
    test('a T2 badge means two banked and the third in progress', () => {
        const analysis = analyseTrial(record({ kind: 'skilling', tier: 2 }), { phase: 'live' });

        expect(analysis.tiersClearedSoFar).toBe(2);
        expect(analysis.tier).toBe(3);
    });

    test('a finished card is what it reached, with nothing in progress', () => {
        const analysis = analyseTrial(record({ kind: 'combat', tier: 3, completed: true }), { phase: 'completed' });

        expect(analysis.tiersClearedSoFar).toBe(3);
        expect(analysis.tier).toBe(3);
    });

    test('the block says two banked under a T2 badge, not one', () => {
        const analysis = analyseTrial(record({ kind: 'skilling', tier: 2 }), { phase: 'live' });
        const html = renderTrialBlock(analysis, 3, { measured: false, reason: 'none' }, { phase: 'live' });

        expect(html).toContain('2 tiers');
    });
});

describe('the narrow block beside a card', () => {
    // The reported screenshot, row for row: labels ellipsized to stubs — "C… |
    // 0 tiers → T1 (Lv.100)", "Expe… | not projectable", "Ban… | tier not seen
    // yet" — in the ~250px block that sits beside a 126px card. A label cut to
    // one letter is worse than a wrapped one.
    const rowsOf = (html) => html.split('</div>').filter((part) => part.includes('span'));

    test('no label is ever cut off', () => {
        const analysis = analyseTrial(
            record({
                kind: 'skilling',
                tier: null,
                samples: [
                    { t: now, readings: [{ current: 876, max: 40_800 }] },
                    { t: now + 10_000, readings: [{ current: 1756, max: 40_800 }] },
                ],
            }),
            { phase: 'live', timeLeftMs: 40 * 60_000 }
        );
        const html = renderTrialBlock(analysis, 3, { measured: false, reason: 'none' }, { phase: 'live' });

        // Nothing truncates, and nothing breaks inside a word: "Expecte / d"
        // with an orphan letter under it was the reported result of the last fix
        expect(html).not.toContain('text-overflow:ellipsis');
        expect(html).not.toContain('overflow-wrap:anywhere');
        expect(html).toContain('word-break:normal');
        for (const row of rowsOf(html)) expect(row).not.toMatch(/white-space:nowrap;">[^<]{1,4}…/);

        // And the labels are whole words
        expect(html).toContain('On pace for');
        expect(html).toContain('Banked');
    });

    test('a long value takes the full width with its label above it', () => {
        // "0 tiers → T1 (Lv.100)" has no business sharing a line with a label in
        // a block this narrow — it is the row the screenshot showed as "C… | 0
        // tiers → T1 (Lv.100)"
        const analysis = analyseTrial(
            record({
                kind: 'skilling',
                tier: 1,
                tiers: [
                    { tier: 1, total: 40_800 },
                    { tier: 2, total: 44_880 },
                ],
                samples: [
                    { t: now, readings: [{ current: 876, max: 40_800 }] },
                    { t: now + 10_000, readings: [{ current: 1756, max: 40_800 }] },
                ],
            }),
            { phase: 'live', timeLeftMs: 40 * 60_000 }
        );
        const html = renderTrialBlock(analysis, 3, { measured: false, reason: 'none' }, { phase: 'live' });

        const pace = html.split('</div>').find((part) => part.includes('→'));
        expect(pace).toBeTruthy();
        // Stacked: the value is its own full-width line, not a squeezed column
        expect(pace).not.toContain('justify-content:space-between');
        // With the whole label above it
        expect(html).toContain('>On pace for</div>');
    });

    test('a short figure still sits beside its label', () => {
        const analysis = analyseTrial(
            record({
                kind: 'skilling',
                samples: [
                    { t: now, readings: [{ current: 1000, max: 65_280 }] },
                    { t: now + 10_000, readings: [{ current: 1880, max: 65_280 }] },
                ],
            }),
            { phase: 'live' }
        );
        const html = renderTrialBlock(analysis, 3, { measured: false, reason: 'none' }, { phase: 'live' });

        const rate = html.split('</div>').find((part) => part.includes('Fill rate'));
        expect(rate).toContain('justify-content:space-between');
        expect(rate).toContain('\u00a0work/s');
    });
});

describe('one row set per phase', () => {
    /** Nothing attributed, which is the usual case for a trial nobody joined */
    const breakdown = { measured: false, reason: 'no trial fight seen yet', players: [] };

    // Reported from two screenshots. A scheduled card stacked three rows all
    // saying variations of "nothing yet"; a finished card offered to fit a
    // growth curve for a tier that will never be fought, and told a player who
    // was not in the trial that its rate was "not measured".
    const combat = (extra = {}) => analyseTrial(record({ kind: 'combat', tier: 4, completed: true, ...extra }), {});

    test('a scheduled card is one line, with the countdown', () => {
        const html = renderTrialBlock(analyseTrial(record({ tier: 6 }), {}), 3, breakdown, {
            phase: 'scheduled',
            startsInMs: 2 * 3600_000 + 24 * 60_000,
        });

        expect(html).toContain('scheduled');
        expect(html).toContain('2h');
        // And none of the three rows that used to sit under it
        expect(html).not.toContain('Banked');
        expect(html).not.toContain('Per player');
        expect(html).not.toContain('Next tier');
    });

    test('a scheduled card with no countdown still says only that', () => {
        const html = renderTrialBlock(analyseTrial(record({ tier: 6 }), {}), 3, breakdown, { phase: 'scheduled' });
        expect(html).toContain('scheduled');
        expect(html).not.toContain('Banked');
    });

    test('a completed card is results only', () => {
        const analysis = combat({
            samples: [
                { t: now, readings: [{ current: 618_000, max: 618_000 }] },
                { t: now + 10_000, readings: [{ current: 518_000, max: 618_000 }] },
            ],
        });
        const html = renderTrialBlock(analysis, 3, breakdown, { phase: 'completed' });

        expect(html).toContain('Final party DPS');
        expect(html).toContain('Banked');
        // Nothing about a future that is not coming
        expect(html).not.toContain('Next tier');
        expect(html).not.toContain('On pace for');
        expect(html).not.toContain('Kill in');
        expect(html).not.toContain('Per player');
    });

    test('a completed trial nobody joined shows the facts and no absences', () => {
        // "Final fill rate | not measured" beside "no trial fight seen here" is
        // two ways of saying the same nothing
        const html = renderTrialBlock(
            analyseTrial(record({ kind: 'combat', tier: 4, completed: true }), {}),
            3,
            breakdown,
            {
                phase: 'completed',
                participating: false,
            }
        );

        expect(html).not.toContain('not measured');
        expect(html).not.toContain('Per player');
        expect(html).not.toContain('only trials you join');
        // What is known is still shown
        expect(html).toContain('Banked');
        expect(html).toContain('4 tiers');
    });

    test('a live card keeps the full set', () => {
        const analysis = analyseTrial(
            record({
                kind: 'skilling',
                samples: [
                    { t: now, readings: [{ current: 1000, max: 65_280 }] },
                    { t: now + 10_000, readings: [{ current: 2060, max: 65_280 }] },
                ],
            }),
            { timeLeftMs: 20 * 60_000 }
        );
        const html = renderTrialBlock(analysis, 3, breakdown, { phase: 'live' });

        expect(html).toContain('Fill rate');
        expect(html).toContain('Banked');
        expect(html).toContain('On pace for');
    });

    test('a value never gives up its unit', () => {
        const analysis = analyseTrial(
            record({
                kind: 'combat',
                samples: [
                    { t: now, readings: [{ current: 618_000, max: 618_000 }] },
                    { t: now + 10_000, readings: [{ current: 518_000, max: 618_000 }] },
                ],
            }),
            {}
        );
        const html = renderTrialBlock(analysis, 3, breakdown, { phase: 'live' });

        // Non-breaking space between the number and its unit, and a value
        // column that does not wrap or shrink
        expect(html).toContain('\u00a0dmg/s');
        expect(html).toMatch(/white-space:nowrap; *flex:0 0 auto;/);
    });
});

describe('the arrow points at the count', () => {
    /** Nothing attributed */
    const breakdown = { measured: false, reason: 'no trial fight seen yet', players: [] };

    /**
     * A skilling trial four tiers deep, part way into a fifth.
     * @param {number} timeLeftMs - What is left of the hour
     * @returns {Object} The analysis
     */
    const atBoundary = (timeLeftMs) =>
        analyseTrial(
            record({
                name: 'Trial Foraging',
                kind: 'skilling',
                level: 130,
                // The badge counts what is banked: four, with the fifth running
                tier: 4,
                pointsByTier: { 4: 590 },
                tiers: [
                    { tier: 4, total: 53_040 },
                    { tier: 5, total: 57_120 },
                ],
                samples: [
                    { t: now, readings: [{ current: 20_000, max: 57_120 }] },
                    // 500 work in ten seconds — 50 a second
                    { t: now + 10_000, readings: [{ current: 20_500, max: 57_120 }] },
                ],
            }),
            { participants: 2, timeLeftMs, phase: 'live' }
        );

    test('a tier entered and not finished does not move the target', () => {
        // 36,620 work left at 50/s is twelve minutes, and there are five. So
        // four tiers are banked and four is where this ends — the panel used to
        // draw "4 tiers → T5" here, pointing at the tier being worked on
        const analysis = atBoundary(5 * 60_000);
        expect(analysis.tier).toBe(5);
        expect(analysis.tiersClearedSoFar).toBe(4);
        expect(analysis.pace.tiersCleared).toBe(4);

        const html = renderTrialBlock(analysis, 2, breakdown, { phase: 'live' });
        expect(html).toContain('4 tiers → T4 (Lv.130)');
        expect(html).not.toContain('→ T5');
    });

    test('once the fifth fits, both numbers move together', () => {
        const analysis = atBoundary(20 * 60_000);
        expect(analysis.pace.tiersCleared).toBe(5);

        const html = renderTrialBlock(analysis, 2, breakdown, { phase: 'live' });
        expect(html).toContain('5 tiers → T5 (Lv.140)');
        expect(html).not.toContain('→ T4');
    });
});

describe('the expected-tier row', () => {
    /** Nothing attributed */
    const breakdown = { measured: false, reason: 'no trial fight seen yet', players: [] };

    test('with no measured slowdown there is one prediction, not two', () => {
        // "On pace for 4 tiers → T4" beside "Expected ~T3" is two bare numbers
        // disagreeing; a reader cannot tell which to believe
        const html = renderTrialBlock(analyseTrial(record({ tier: 2 }), {}), 3, breakdown, {
            phase: 'live',
            forecast: { tier: 4, tiersCleared: 4, source: 'measured', limitedBy: 'time', coverage: null },
        });

        expect(html).toContain('On pace for');
        expect(html).toContain('4 tiers → T4');
        expect(html).not.toContain('Expected');
        expect(html).toContain('derived from the game');
    });

    test('a measured slowdown is what makes two rows worth having', () => {
        const html = renderTrialBlock(
            analyseTrial(
                record({
                    kind: 'skilling',
                    tier: 2,
                    tiers: [
                        { tier: 2, total: 44_880 },
                        { tier: 3, total: 48_960 },
                    ],
                    samples: [
                        { t: now, readings: [{ current: 1000, max: 44_880 }] },
                        { t: now + 10_000, readings: [{ current: 2000, max: 44_880 }] },
                    ],
                }),
                { timeLeftMs: 40 * 60_000, phase: 'live' }
            ),
            3,
            breakdown,
            {
                phase: 'live',
                forecast: {
                    tier: 4,
                    tiersCleared: 4,
                    source: 'measured',
                    limitedBy: 'time',
                    decline: { perTier: -0.08, rate: 0.576, atTier: 3, observations: 3 },
                },
            }
        );

        // Both, and each says what it assumes
        expect(html).toContain('On pace (flat)');
        expect(html).toContain('Expected (slowing)');
        expect(html).toContain('8.0 points a tier');
    });

    test('an estimated one says how many loadouts it rests on', () => {
        const html = renderTrialBlock(analyseTrial(record({ tier: 2 }), {}), 8, breakdown, {
            phase: 'live',
            forecast: {
                tier: 4,
                tiersCleared: 4,
                source: 'estimated',
                limitedBy: 'time',
                coverage: { known: 3, of: 8 },
            },
        });

        expect(html).toContain('4 tiers → T4');
        expect(html).toContain('3 of 8 members');
        expect(html).toContain('rough shape rather than a measurement');
    });

    test('a long fight is reported as enraged, not as impossible', () => {
        // Enrage is a stacking buff — one stack a minute to ten, +10% accuracy
        // and +10% damage each — so a fight past ten minutes is dangerous
        // rather than unwinnable. The projection keeps its tier and says what
        // it cannot model: the deaths.
        const html = renderTrialBlock(analyseTrial(record({ tier: 2 }), {}), 3, breakdown, {
            phase: 'live',
            forecast: {
                tier: 5,
                tiersCleared: 5,
                source: 'measured',
                limitedBy: 'time',
                enragedFrom: 4,
                coverage: null,
            },
        });

        expect(html).toContain('fully enraged');
        expect(html).toContain('→ T5');
        expect(html).toContain('+100% damage and +100% accuracy');
        expect(html).toContain('expect deaths to slow this');
        expect(html).not.toContain('wall');
    });

    test('a fight inside ten minutes says nothing about enrage', () => {
        const html = renderTrialBlock(analyseTrial(record({ tier: 2 }), {}), 3, breakdown, {
            phase: 'live',
            forecast: { tier: 4, tiersCleared: 4, source: 'measured', limitedBy: 'time', enragedFrom: null },
        });

        expect(html).not.toContain('enrage');
    });

    test('nothing to project says which kind of nothing', () => {
        const html = renderTrialBlock(analyseTrial(record({ tier: 2 }), {}), 3, breakdown, {
            phase: 'live',
            forecast: { tier: null, source: 'none', reason: 'no clock on the tab' },
        });

        expect(html).toContain('not projectable');
        expect(html).toContain('no clock on the tab');
    });

    test('a finished or scheduled card does not carry one at all', () => {
        const forecast = { tier: 6, source: 'measured', limitedBy: 'time' };
        expect(
            renderTrialBlock(analyseTrial(record({ tier: 2 }), {}), 3, breakdown, {
                phase: 'scheduled',
                forecast,
            })
        ).not.toContain('Expected');
        expect(
            renderTrialBlock(analyseTrial(record({ tier: 2, completed: true }), {}), 3, breakdown, {
                phase: 'completed',
                forecast,
            })
        ).not.toContain('Expected');
    });
});

describe('renderTrialPlayers', () => {
    const breakdown = {
        measured: true,
        fights: 3,
        players: [
            {
                name: 'Tib',
                damage: 750_000,
                dps: 5000,
                share: 75,
                hits: 120,
                crits: 12,
                misses: 5,
                accuracy: 0.96,
                critRate: 0.1,
                deaths: 0,
            },
            {
                name: 'Moo',
                damage: 250_000,
                dps: 1600,
                share: 25,
                hits: 60,
                crits: 0,
                misses: 40,
                accuracy: 0.6,
                critRate: 0,
                deaths: 2,
            },
        ],
    };

    test('a line per player, with the share and the deaths', () => {
        const html = renderTrialPlayers(breakdown).join('');

        expect(html).toContain('Tib');
        expect(html).toContain('75%');
        expect(html).toContain('Moo');
        expect(html).toContain('2✝');
        expect(html).toContain('3 fights');
    });

    test('nothing measured is an instruction, not an apology', () => {
        // "no trial fight seen here" reads as a fight that could have been seen
        // and was not, and was reported as a bug twice on that basis. The fight
        // is real and streams to whoever opens the In Progress fight view
        const html = renderTrialPlayers({ measured: false, reason: 'the monsters are not this week’s trial' }).join('');

        expect(html).toContain('Per player');
        expect(html).toContain('open the fight view');
        expect(html).toContain('fills from the trial');
        expect(html).not.toContain('no trial fight seen here');
    });

    test('a watched fight with nothing attributed yet says exactly that', () => {
        const html = renderTrialPlayers({
            measured: false,
            source: 'spectated',
            reason: 'watched',
            pool: { encounter: 'chameleon' },
        }).join('');

        expect(html).toContain('watched, nothing attributed yet');
        expect(html).toContain('fills in as hits land');
        // The support figures did arrive, and the line must not imply otherwise
        expect(html).toContain('Damage taken, healing and mana come through');
    });

    test('a watched fight nothing has identified asks for one click', () => {
        // No card may claim it until it is named — better "no data" on both
        // combat cards than the right number on the wrong trial
        const html = renderTrialPlayers({
            measured: false,
            source: 'spectated',
            reason: 'watched',
            pool: { encounter: null },
        }).join('');

        expect(html).toContain('click the boss to identify');
        expect(html).toContain('attach to none');
    });

    test('a measured split says it was watched', () => {
        const html = renderTrialPlayers({
            measured: true,
            source: 'spectated',
            fights: 2,
            players: [
                {
                    name: 'ICMeow',
                    damage: 1000,
                    dps: 100,
                    share: 100,
                    hits: 4,
                    crits: 1,
                    accuracy: 1,
                    critRate: 0.25,
                    deaths: 0,
                },
            ],
        }).join('');

        expect(html).toContain('2 fights · watched');
        expect(html).toContain('ICMeow');
    });

    test('a stale trial says it is the last one', () => {
        const html = renderTrialPlayers({ measured: false, stale: true, reason: 'old' }).join('');
        expect(html).toContain('last trial, not this one');
    });

    test('no breakdown at all draws nothing rather than throwing', () => {
        expect(renderTrialPlayers(null)).toEqual([]);
    });

    test('the two ways of measuring party DPS are checked against each other', () => {
        // The bar says one thing and the battle feed says another. They measure
        // the same quantity by different routes, so a large gap means one of
        // them is watching the wrong fight — worth a line rather than two
        // numbers on screen that quietly differ.
        const combat = analyseTrial(
            record({
                samples: [
                    { t: now, readings: [{ current: 618_000, max: 618_000 }] },
                    { t: now + 10_000, readings: [{ current: 518_000, max: 618_000 }] },
                ],
            }),
            {}
        );
        expect(combat.rate * 1000).toBeCloseTo(10_000, 6);

        const disagreeing = renderTrialBlock(combat, 0, { ...breakdown, partyDps: 1000 });
        expect(disagreeing).toContain('Split disagrees');

        const agreeing = renderTrialBlock(combat, 0, { ...breakdown, partyDps: 9500 });
        expect(agreeing).not.toContain('Split disagrees');

        // Nothing attributed is nothing to check against
        expect(renderTrialBlock(combat, 0, { measured: false, reason: 'none' })).not.toContain('Split disagrees');
    });

    test('a trial this character is not in says so, instead of measuring forever', () => {
        // Reported: cards for other people's trials sat on "measuring…" and
        // "tier not known yet" all week. No reading can ever arrive for them —
        // the In Progress tab shows only this character's own trials.
        const analysis = analyseTrial(record({ tier: 6, samples: [] }), {});
        const html = renderTrialBlock(analysis, 3, { measured: false, reason: 'none' }, { participating: false });

        expect(html).toContain('no data — only trials you join can be measured');
        expect(html).not.toContain('measuring…');
        expect(html).not.toContain('On pace for');
        // What the Trials tab does say about it is still shown
        expect(html).toContain('Banked');
    });

    test('not knowing whether they are in it keeps the older wording', () => {
        const analysis = analyseTrial(record({ tier: 6, samples: [] }), {});
        const unknown = renderTrialBlock(analysis, 3, { measured: false, reason: 'none' }, { participating: null });

        expect(unknown).toContain('measuring…');
        expect(unknown).not.toContain('only trials you join');
    });

    test('a trial they are in that has a reading is measured as ever', () => {
        const analysis = analyseTrial(
            record({
                samples: [
                    { t: now, readings: [{ current: 618_000, max: 618_000 }] },
                    { t: now + 10_000, readings: [{ current: 518_000, max: 618_000 }] },
                ],
            }),
            {}
        );
        const html = renderTrialBlock(analysis, 3, { measured: false, reason: 'none' }, { participating: true });

        expect(html).toContain('Party DPS');
        expect(html).not.toContain('only trials you join');
    });

    test('the completed card makes the banked count exact', () => {
        // The settled question. Trial Chameleon finished reading "Lv.120, 960
        // pts, T3", and 960 is the ladder's three-tier total at +20% — so on a
        // finished card the badge is the tiers earned, and "Banked 2 tiers"
        // beside it was one short.
        const finished = analyseTrial(
            record({ kind: 'combat', level: 120, tier: 3, completed: true, pointsByTier: { 3: 960 } }),
            { buildersHallBonus: 0.2 }
        );

        expect(finished.tiersClearedSoFar).toBe(3);
        expect(finished.points.guildPoints).toBe(960);
        expect(finished.points.basePoints).toBeCloseTo(800, 6);
        expect(renderTrialBlock(finished, 3, { measured: false, reason: 'none' })).toContain('3 tiers · finished');

        // Still an inference while the trial runs, and it does not claim the
        // tier the party is currently fighting
        const running = analyseTrial(record({ kind: 'combat', level: 120, tier: 3, completed: false }), {});
        expect(running.tiersClearedSoFar).toBe(3);
        expect(renderTrialBlock(running, 3, { measured: false, reason: 'none' })).not.toContain('· finished');
    });

    test('a combat block carries the split and a skilling one does not', () => {
        const combat = analyseTrial(record({ samples: [{ t: now, readings: [{ current: 1, max: 2 }] }] }), {});
        expect(renderTrialBlock(combat, 0, breakdown)).toContain('Per player');

        const skilling = analyseTrial(
            record({ kind: 'skilling', samples: [{ t: now, readings: [{ current: 1, max: 2 }] }] }),
            {}
        );
        expect(renderTrialBlock(skilling, 0, breakdown)).not.toContain('Per player');
    });
});

describe('the payout block, audited', () => {
    /**
     * The Trials tab, whose cards carry a tier, a points line and sign-ups and
     * no progress bar at all.
     * @param {...Object} cards - Each `{name, level, points, signups}`
     * @returns {Element} The tab
     */
    function buildTrialsTab(...cards) {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';

        for (const card of cards) {
            const tile = document.createElement('div');
            tile.className = 'GuildPanel_tile__c';
            tile.innerHTML =
                `<div class="GuildPanel_tileName__d">${card.name}</div>` +
                `<div class="GuildPanel_tileSummary__e">Lv.${card.level}</div>` +
                `<div class="Card_points__g">${card.points} pts</div>` +
                `<div class="Card_signups__h">${card.signups} signed up</div>` +
                (card.completed ? '<div class="Card_state__j">Completed</div>' : '') +
                '<div class="Card_clock__i">20m 53s</div>';
            root.appendChild(tile);
        }

        document.body.appendChild(root);
        return root;
    }

    const fire = () => game.observers['GuildPanel_']();
    const text = () => document.body.textContent;

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        game.settings = { guildTrialsInfo: true };
        game.settingValues = {};
        game.clientData = {};
        game.prices = {};
        game.buildingLevels = {};
        game.store = {};
        game.members = [];
        game.characterId = null;
        game.characterData = null;
        game.dmHandlers = {};
        game.trialNames = [];
        game.alerts = { status: [], payouts: [], reset: 0 };
        game.recorder = {
            recording: false,
            activity: [],
            lifecycle: [],
            downloads: [],
            startedBy: null,
            endedBy: null,
        };
        game.scoreboardToggles = 0;
        game.breakdown = {};
        game.scoreboardContext = null;
        game.skilling = {};
        game.skillingEnded = {};
        await trialsFeature.initialize();
    });

    afterEach(() => {
        trialsFeature.cleanup();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    test('an In Progress card alone says the banked figure is unknown, not zero', () => {
        // The reported screenshot: joined the alchemy trial midway, opened only
        // the In Progress tab, and every payout line read 0
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        const tile = document.createElement('div');
        tile.className = 'GuildPanel_tile__c';
        tile.innerHTML =
            '<div class="GuildPanel_tileName__d">Alchemy</div>' +
            '<div class="ProgressBar_text__f">18,850 / 65,280</div>';
        root.appendChild(tile);
        document.body.appendChild(root);

        fire();

        expect(text()).toContain('not known yet');
        // The remedy is in the tooltip, where a caption this long belongs
        expect(document.body.innerHTML).toContain('Open the Trials tab');
    });

    test('the cards’ own points are what the guild is paid', () => {
        // The day this was calibrated on. The guild's chat announced "2880
        // Guild Points earned" and the three cards read 840, 1,080 and 960 —
        // the sum, exactly. The panel used to report 2.4K, because it looked
        // each figure up under its own inference about how many tiers were
        // banked, missed by one tier on every trial, and fell through to the
        // ladder.
        game.buildingLevels = { '/guild_buildings/builders_hall': 10, '/guild_buildings/treasury': 5 };

        buildTrialsTab(
            { name: 'Alchemy', level: 170, points: 1080, signups: '3/56' },
            { name: 'Trial Chameleon', level: 120, points: 960, signups: '3/56' }
        );
        fire();

        expect(guildTrials.record.tiles['skilling::alchemy'].pointsByTier).toEqual({ 8: 1080 });
        expect(guildTrials.record.tiles['combat::trial chameleon'].pointsByTier).toEqual({ 3: 960 });

        // 1,080 + 960 = 2,040 Guild Points banked; base 1,700 at the Builder's
        // Hall's +20%, and half of that at the Treasury's +10% is 935 tokens
        expect(text()).toContain('Guild Points banked2,040');
        expect(text()).toContain('Tokens, every eligible member935');
        expect(text()).toContain('Tokens, if you took part1,403');
        expect(text()).not.toContain('needs checking');
    });

    test('a finished card banks the tier it names, and the block says so', () => {
        // End to end on the settled question: the completed Trial Chameleon
        // read "Lv.120, 960 pts, T3, Completed", and 960 is exactly the
        // ladder's three-tier total once the Builder's Hall +20% is off it
        game.buildingLevels = { '/guild_buildings/builders_hall': 10, '/guild_buildings/treasury': 5 };

        buildTrialsTab({
            name: 'Trial Chameleon',
            level: 120,
            points: 960,
            signups: '3/56',
            completed: true,
        });
        fire();

        expect(guildTrials.record.tiles['combat::trial chameleon'].completed).toBe(true);
        expect(text()).toContain('3 tiers · finished');
        expect(text()).toContain('Guild Points banked960');
        // 800 of base, half of it at the Treasury's +10%
        expect(text()).toContain('Tokens, every eligible member440');
    });

    test('a card the ladder cannot explain even after the bonus is reported', () => {
        // 1,337 at combat T5 is 1,114 of base against a +20% Builder's Hall,
        // and the ladder says 1,200 cumulative or 200 marginal. That is a real
        // disagreement — unlike every card of every week, which is what the
        // warning this replaces was firing on
        game.buildingLevels = { '/guild_buildings/builders_hall': 10, '/guild_buildings/treasury': 5 };
        buildTrialsTab({ name: 'Trial Chameleon', level: 140, points: 1337, signups: '3/56' });
        fire();

        expect(text()).toContain('neither the running total');
        expect(text()).toContain('needs checking');
    });

    test('a card banked across a Hall upgrade says so, rather than blaming the ladder', () => {
        // MilkMaxxing's own T10 Milking card. The guild levelled its Builder's
        // Hall 5 → 6 during the skilling hour, and points bank live: 500 of base
        // at +10% and 600 at +12% is 1,222 exactly. Today's +12% alone predicts
        // 1,232, so the card divides cleanly by neither bonus
        game.buildingLevels = { '/guild_buildings/builders_hall': 6, '/guild_buildings/treasury': 5 };
        buildTrialsTab({ name: 'Milking', level: 190, points: 1222, signups: '12/106' });
        fire();

        expect(text()).toContain('consistent with a Builder’s Hall upgrade during the trial');
        expect(text()).toContain('Points bank live');
        expect(text()).toContain('used exactly as stated');
        // And it is not the warning about a figure nothing can explain
        expect(text()).not.toContain('neither the running total');
        expect(text()).not.toContain('needs checking');
        // The card is what the guild is paid, unchanged
        expect(text()).toContain('Guild Points banked1,222');
        // …but the tokens are paid on *base*, and dividing 1,222 by today's
        // +12% recovers 1,091 where the tier actually banked 1,100. Half of
        // 1,100 at the Treasury's +10% is 605; the division would have said 600
        expect(text()).toContain('Tokens, every eligible member605');
        // And the banked row's tooltip says where the base came from
        expect(document.body.innerHTML).toContain('banked across a Builder’s Hall upgrade');
    });

    test('with no building level anywhere, the bonus is read back out of the cards', () => {
        // No Buildings tab has been opened and no guild traffic has carried a
        // level, but three cards state Guild Points for tiers whose base the
        // ladder knows — and 840/700, 1,080/900 and 960/800 are all 1.2, which
        // is the Builder's Hall at level 10 recovered from the cards themselves
        game.buildingLevels = {};
        buildTrialsTab(
            { name: 'Milking', level: 150, points: 840, signups: '3/56' },
            { name: 'Alchemy', level: 170, points: 1080, signups: '3/56' }
        );
        fire();

        expect(text()).toContain('Builder’s Hall read as level 10');
        expect(text()).toContain('+20%');
        // The Treasury has no such shortcut, and the block says so
        expect(text()).toContain('No Treasury level seen');
    });
});
