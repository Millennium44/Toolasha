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
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => (key in game.settings ? game.settings[key] : fallback),
        getSettingValue: (key, fallback) => (key in game.settingValues ? game.settingValues[key] : fallback),
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (id, className, callback) => {
            game.observers[className] = callback;
            return () => delete game.observers[className];
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
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => (key in game.store ? game.store[key] : fallback),
        set: async (key, value) => {
            game.store[key] = value;
            return true;
        },
    },
}));
// Token payouts are valued through the credit exchange, which prices items —
// mocked here so the real marketplace client is never pulled into this file
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (itemHrid, { mode } = {}) => game.prices[itemHrid]?.[mode] ?? 0,
}));
vi.mock('./guild-xp-tracker.js', () => ({
    guildXPTracker: {
        getOwnGuildName: () => game.guildName,
        getCurrentWeekStartAt: () => game.currentWeek,
        getMemberList: () => game.members,
        getMemberMeta: (id) => game.members.find((member) => member.characterID === id) || null,
    },
}));

const { analyseTrial, participantCounts, renderTrialBlock, tokenPayoutLine, guildTrials } =
    await import('./guild-trials.js');
const trialsFeature = (await import('./guild-trials.js')).default;

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
        expect(analysis.tiersClearedSoFar).toBe(4);
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
        expect(analysis.tiersClearedSoFar).toBe(1);
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
        expect(analysis.pace.clears.map((clear) => clear.tier)).toEqual([5, 6]);
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

        expect(analysis.next).toMatchObject({ tier: 6, level: 150 });
        expect(analysis.next.total).toBeCloseTo(720_000, 3);
        expect(analysis.next.participantPenalty).toBeCloseTo(0.21, 12);
    });

    test('a card whose two bars have not moved is not guessed at', () => {
        const readings = [
            { current: 5, max: 10 },
            { current: 7, max: 20 },
        ];
        const analysis = analyseTrial(record({ samples: [{ t: now, readings }] }), { timeLeftMs: 60_000 });

        expect(analysis.rate).toBeNull();
        expect(analysis.remaining).toBeNull();
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

        expect(row.value).toContain('≈1.0M');
        expect(row.value).toContain('via credit exchange');
        expect(row.title).toContain('Half the base points.');
    });
});

describe('the panel, end to end', () => {
    /**
     * The In Progress tab, as markup.
     * @param {Array<Object>} cards - Cards to render
     * @returns {Element} The trials-content element
     */
    function buildTab(cards) {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';

        const status = document.createElement('div');
        status.className = 'GuildPanel_eventStatusRow__b';
        status.textContent = 'In progress — 42:15 remaining';
        root.appendChild(status);

        for (const card of cards) {
            const tile = document.createElement('div');
            tile.className = 'GuildPanel_tile__c';
            tile.innerHTML =
                `<div class="GuildPanel_tileName__d">${card.name}</div>` +
                `<div class="GuildPanel_tileSummary__e">Lv.${card.level}</div>` +
                `<div class="ProgressBar_text__f">${card.bar}</div>`;
            root.appendChild(tile);
        }

        document.body.appendChild(root);
        return root;
    }

    const fire = (root) => game.observers['GuildPanel_trialsContent'](root);
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

    test('a second reading five seconds later produces a rate', () => {
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]);
        fire(root);

        root.querySelector('[class*="ProgressBar_text"]').textContent = '568,000 / 618,000';
        vi.setSystemTime(now + 10_000);
        fire(root);

        expect(text()).toContain('Party DPS');
        expect(text()).not.toContain('measuring');
    });

    test('four tiers banked at tier 5 reach the payout block', () => {
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]);
        fire(root);

        // A combat trial on tier 5 has banked four: 400 + 200 × 3 = 1,000 base
        // points → 500 tokens for every eligible member, 750 for a participant
        expect(text()).toContain('Guild Points banked1.0K');
        expect(text()).toContain('Tokens, every eligible member500');
        expect(text()).toContain('Tokens, if you took part750');
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

        fire(buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]));

        expect(text()).toContain('Tokens, every eligible member500 (≈1.0M');
        expect(text()).toContain('via credit exchange');
    });

    test('with nothing to price the token payout against, the bare count is all that shows', () => {
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]));

        expect(text()).toContain('Tokens, every eligible member500');
        expect(text()).not.toContain('via credit exchange');
    });

    test('an unknown building bonus is captioned, not silently treated as zero', () => {
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]));

        expect(text()).toContain('Base figures');
        expect(text()).toContain('Builders Hall');
        expect(text()).toContain('Treasury');
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
});
