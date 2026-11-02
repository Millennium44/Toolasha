/**
 * Two real trials from the test server, 2026-11-02, with the guild's own completion
 * announcement for each (read off the guild chat by the maintainer):
 *
 * - 11/1: 24,419 Guild Points; 127 eligible members each received 9,245 Guild Token and
 *   87 participants a further 4,623.
 * - 11/2: 23,544 Guild Points; 128 eligible members each received 8,913 and 87
 *   participants a further 4,457.
 *
 * Builder's Hall Lv.20 (+40%) and Treasury Lv.3 (+6%) from the same guild's
 * `guildBuildingLevelMap`. The announcement's text is not parsed anywhere; these
 * numbers are the expected values only.
 */

export const ANNOUNCED = {
    nov1: { points: 24419, eligibleTokens: 9245, participantExtra: 4623 },
    nov2: { points: 23544, eligibleTokens: 8913, participantExtra: 4457 },
};

export const HALL_BONUS = 0.4;
export const TREASURY_BONUS = 0.06;

/**
 * The last `guild_updated` of the 11/2 trial: `guild.currentTrialsData`, a JSON
 * string as the game sends it. Its `points` map sums to 23,544.
 */
export const NOV2_CURRENT_TRIALS_DATA =
    '{"points":{"/guild_combat/jellyfish":6160,"/guild_combat/swarm":6160,"/guild_skilling/alchemy":2981,"/guild_skilling/brewing":2834,"/guild_skilling/foraging":2689,"/guild_skilling/woodcutting":2720},"skilling":{"status":"completed","parties":{"/guild_skilling/alchemy":{"highestTier":20,"budgetRemainingMs":0,"tierStartedAtMs":1793656808120,"highestTierReachedAtMs":1793656393130,"nextTierProgress":0.5872,"done":true},"/guild_skilling/brewing":{"highestTier":19,"budgetRemainingMs":0,"tierStartedAtMs":1793656807766,"highestTierReachedAtMs":1793656232124,"nextTierProgress":0.4891,"done":true},"/guild_skilling/foraging":{"highestTier":18,"budgetRemainingMs":0,"tierStartedAtMs":1793656807831,"highestTierReachedAtMs":1793656393340,"nextTierProgress":0.4196,"done":true},"/guild_skilling/woodcutting":{"highestTier":18,"budgetRemainingMs":0,"tierStartedAtMs":1793656807742,"highestTierReachedAtMs":1793655808374,"nextTierProgress":0.8608,"done":true}}},"combat":{"status":"completed","parties":{"/guild_combat/jellyfish":{"highestTier":21,"budgetRemainingMs":2334128,"tierStartedAtMs":1793658094676,"highestTierReachedAtMs":1793658094676,"done":true},"/guild_combat/swarm":{"highestTier":21,"budgetRemainingMs":2452259,"tierStartedAtMs":1793657987302,"highestTierReachedAtMs":1793657987302,"done":true}}},"cooperativeRewardGranted":false}';

/**
 * The 11/1 cycle's tiles as the test character's record held them when it was backed
 * up (`guildTrials_SuperMoo.tiles`, fields trimmed to the ones that matter). The
 * alchemy card read 0 points after the cycle's roll and still quoted 2,944 for T20;
 * the six stated figures sum to 24,419.
 */
export const NOV1_TILES = {
    'skilling::alchemy': {
        name: 'Alchemy',
        kind: 'skilling',
        tier: 20,
        points: 0,
        serverTier: 19,
        serverTierAt: 1793569657955,
        serverDone: false,
        completed: false,
        pointsByTier: { 20: 2944 },
    },
    'combat::trial hedgehog': {
        name: 'Trial Hedgehog',
        kind: 'combat',
        tier: 21,
        points: 6160,
        serverTier: 21,
        serverTierAt: 1793571247062,
        serverDone: true,
        completed: false,
        pointsByTier: { 20: 6160, 21: 6160 },
    },
    'skilling::cheesesmithing': {
        name: 'Cheesesmithing',
        kind: 'skilling',
        tier: 21,
        points: 3080,
        completed: false,
        pointsByTier: { 21: 3080 },
    },
    'skilling::tailoring': {
        name: 'Tailoring',
        kind: 'skilling',
        tier: 21,
        points: 3080,
        completed: false,
        pointsByTier: { 21: 3080 },
    },
    'skilling::cooking': {
        name: 'Cooking',
        kind: 'skilling',
        tier: 20,
        points: 2995,
        completed: false,
        pointsByTier: { 20: 2995 },
    },
    'combat::trial badger': {
        name: 'Trial Badger',
        kind: 'combat',
        tier: 21,
        points: 6160,
        serverTier: 20,
        serverTierAt: 1793571345300,
        serverDone: false,
        completed: false,
        pointsByTier: { 20: 6160, 21: 6160 },
    },
};
