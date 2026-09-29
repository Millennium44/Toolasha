/**
 * Four skilling parties' tier clears, as a live client held them.
 *
 * Test server, 2026-09-29, guild SuperMoo, one trial ~34 minutes in with 26m51s
 * left on the game's own card. The character was signed up for Alchemy only, so
 * Milking, Cooking and Brewing were timed from their clears alone. Stamps before
 * the reload (`reloadedAt`) were written by watching the badge move; later ones
 * from the guild payload's per-party clear times. Cooking's T18 and T20 are
 * another cycle's clears left in the week's record.
 *
 * What the card drew for them, with the tier-timing model as it was:
 *
 * - Milking — "Est. fill ~13 work/s (falling ~1925%/tier) · Next tier in ~2h 59m ·
 *   Before it ends ~0 more tiers · Expected ~T18", its last tier having taken 520 s
 * - Cooking — "Est. fill ~82 work/s (falling ~221%/tier) · Next tier in ~23m ·
 *   ~1 more tier · Expected ~T18"
 * - Brewing — "Est. fill ~199 work/s (falling ~69%/tier) · Next tier in ~3m 45s ·
 *   ~1 more tier · Expected ~T17"
 * - Alchemy, joined and bar-measured — "Fill rate 206 work/s · Tier clears in 4m 15s"
 */

/** Client clock when the panel was captured */
export const CAPTURED_AT = 1790717644263;

/** The game's own countdown, read at `RENDERED_AT` */
export const TIME_LEFT_AT_RENDER_MS = 26 * 60_000 + 51_000;

/** When the card text above was drawn */
export const RENDERED_AT = CAPTURED_AT - 39_000;

/** The page reload: earlier stamps are watched badges, later ones stated by the server */
export const RELOADED_AT = 1790717450000;

/** Client minus server clock, as `serverClockOffset` had it */
export const SERVER_CLOCK_OFFSET_MS = 44;

/** When the last `guild_updated` arrived */
export const LAST_GUILD_UPDATED_AT = 1790717576493;

/** The learned work bases (`baseWork` is before the participant scale) */
export const WORK_BASES = {
    milking: null,
    cooking: { baseWork: 40000, tier: 1, target: 41200, participants: 3, learnedAt: 1786568408658 },
    brewing: { baseWork: 40000, tier: 17, target: 135200, participants: 30, learnedAt: 1789852958286 },
    alchemy: { baseWork: 40000, tier: 19, target: 143360, participants: 28, learnedAt: 1789768181886 },
};

/** Sign-ups, as each card stated them */
export const SIGNED_UP = { milking: 29, cooking: 22, brewing: 17, alchemy: 33 };

/**
 * Each tile record's timing fields. `serverTierAt` is as the build wrote it —
 * the last message's receipt for every party, not the party's own clear.
 */
export const TILES = {
    milking: {
        tierSeenAt: {
            11: 1790715896184,
            12: 1790715966123,
            13: 1790716032128,
            14: 1790716151199,
            15: 1790716327124,
            16: 1790716651241,
            17: 1790717056528,
            18: 1790717576497,
        },
        serverTier: 18,
        serverTierAt: 1790717576497,
        level: 270,
    },
    cooking: {
        tierSeenAt: {
            9: 1790715916185,
            10: 1790715987122,
            11: 1790716051127,
            12: 1790716131224,
            13: 1790716247169,
            14: 1790716404123,
            15: 1790716596210,
            16: 1790716906943,
            17: 1790717390077,
            18: 1790459756186,
            20: 1790550879670,
        },
        serverTier: 17,
        serverTierAt: 1790717576497,
        level: 260,
    },
    brewing: {
        tierSeenAt: {
            7: 1790715876201,
            8: 1790715932121,
            9: 1790715996234,
            10: 1790716075880,
            11: 1790716176322,
            12: 1790716286125,
            13: 1790716439134,
            14: 1790716606189,
            15: 1790716862130,
            16: 1790717211099,
        },
        serverTier: 16,
        serverTierAt: 1790717576497,
        level: 250,
    },
    alchemy: {
        tierSeenAt: {
            10: 1790715931058,
            11: 1790716011191,
            12: 1790716106126,
            13: 1790716236352,
            14: 1790716427640,
            15: 1790716691190,
            16: 1790717176061,
        },
        serverTier: 16,
        serverTierAt: 1790717576497,
        level: 250,
    },
};

/** Two parties of the last `guild_updated.currentTrialsData`, as parsed (server clock) */
export const LAST_PAYLOAD_PARTIES = {
    '/guild_skilling/alchemy': {
        highestTier: 16,
        budgetRemainingMs: 2040178,
        tierStartedAtMs: 1790717176017,
        highestTierReachedAtMs: 1790717176017,
        done: false,
    },
    '/guild_skilling/brewing': {
        highestTier: 16,
        budgetRemainingMs: 2005072,
        tierStartedAtMs: 1790717211055,
        highestTierReachedAtMs: 1790717211055,
        done: false,
    },
};

/**
 * The fields of `init_character_data` a reload seeds the trial status from, as
 * observed live on the test server that afternoon: `guild.currentTrialsData`
 * is the same JSON string `guild_updated` carries. Alchemy's party is as sent;
 * `currentTimestamp` (the server's clock when the payload went out) is set 90 s
 * after that clear for the test.
 */
export const INIT_CHARACTER_DATA = {
    character: { id: 30404, name: 'Tester' },
    currentTimestamp: new Date(1790718710224 + 90_000).toISOString(),
    guild: {
        name: 'SuperMoo',
        currentTrialsData: JSON.stringify({
            points: { '/guild_skilling/alchemy': 4000 },
            skilling: {
                status: 'in_progress',
                parties: {
                    '/guild_skilling/alchemy': {
                        highestTier: 18,
                        budgetRemainingMs: 506121,
                        tierStartedAtMs: 1790718710224,
                        highestTierReachedAtMs: 1790718710224,
                        done: false,
                    },
                },
            },
            combat: { status: '', parties: null },
        }),
    },
};
