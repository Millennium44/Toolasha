/**
 * Party-channel system messages (`chat_message_received` `message` objects). Captured on the test
 * server 2026-11-13 (Enchanted Fortress T2 party). Member names are the test party's.
 *
 * Battle started posts ONCE when the party's combat action begins, names the action by `actionHrid`
 * (the display name only appears in the rendered DOM line), and posts ~8 ms before the first Key
 * counts. Key counts posts at EVERY run start after that, with no Battle started between.
 */

export const PARTY_CHAT_CAPTURE = [
    {
        chan: '/chat_channel_types/party',
        id: 2554904,
        isSystemMessage: true,
        m: 'systemChatMessage.partyBattleStarted',
        systemMetadata: '{"actionHrid":"/actions/combat/enchanted_fortress"}',
        t: '2026-11-13T18:40:24.487820764Z',
    },
    {
        chan: '/chat_channel_types/party',
        id: 2554905,
        isSystemMessage: true,
        m: 'systemChatMessage.partyKeyCount',
        systemMetadata:
            '{"keyCountString":"[PugsElite - 98073] [MillenniumTest - 9987] [Kakas123 - 999522] [stone1992 - 10526] [TestYahoooooo - 99658] "}',
        t: '2026-11-13T18:40:24.496056892Z',
    },
];

/** The same two messages as the chat panel renders them. */
export const PARTY_CHAT_DOM_TEXT = [
    '[11/13 12:40:24 PM] Battle started: Enchanted Fortress',
    '[11/13 12:40:24 PM] Key counts: [PugsElite - 98073] [MillenniumTest - 9987] [Kakas123 - 999522] [stone1992 - 10526] [TestYahoooooo - 99658]',
];

/**
 * @param {string} actionHrid - The party action the message names
 * @param {string} t - ISO timestamp
 * @param {number} id - Message id (consecutive ids in the capture)
 * @returns {Object} A `partyBattleStarted` chat message
 */
export function buildPartyBattleStarted(actionHrid, t, id = 1) {
    return { ...PARTY_CHAT_CAPTURE[0], id, t, systemMetadata: JSON.stringify({ actionHrid }) };
}

/**
 * @param {string} keyCountString - The roster, `[Name - count] ...`
 * @param {string} t - ISO timestamp
 * @param {number} id - Message id
 * @returns {Object} A `partyKeyCount` chat message
 */
export function buildPartyKeyCount(keyCountString, t, id = 2) {
    return { ...PARTY_CHAT_CAPTURE[1], id, t, systemMetadata: JSON.stringify({ keyCountString }) };
}
