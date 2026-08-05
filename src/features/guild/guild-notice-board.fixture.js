/**
 * A guild's notice board, exactly as it reached the trial record.
 *
 * From a live 106-member guild: braille art, a welcome, three Discord links and
 * the kick rules — 987 characters over twenty lines — filed as a *trial card*,
 * with the two Discord channel ids in it recorded as its progress bar:
 *
 * ```
 * https://discord.com/channels/1234500000000000001/1525000000000000321
 * ```
 *
 * `1234500000000000001 / 1525000000000000321` has the shape of a reading and
 * nothing else about it does. It was sampled every five seconds for the length
 * of a session, the Overview tab's guild statistics were attached to it as the
 * player's own action stats, and it was live enough to start the recorder.
 *
 * Kept verbatim — the braille, the newlines, the lot — because every rule that
 * now refuses it is a rule about this exact string.
 */
export const NOTICE_BOARD_NAME =
    '[⠁⠃⠉⠙⠑⠋⠛⠓⠊⠚⠅⠇⠍⠝⠕⠏⠟⠗⠎⠞⠥⠧⠺⠭⠽⠵⠁⠃⠉⠙⠑⠋⠛⠓⠊⠚⠅⠇⠍⠝⠕⠏⠟⠗⠎⠞⠥⠧]\nWelcome to Creamland!\n\nJOIN DISCORD: \nhttps://discord.gg/0synthetic0 ( DO NOT SHARE THIS LINK IT IS FOR GUILDIES ONLY)\nCHECK GUILD NOTICE:\nhttps://discord.com/channels/1234500000000000001/1525000000000000321\nCHECK WEEKLY TRIAL ROSTER:\nhttps://discord.com/channels/1234500000000000001/1527000000000000654\n\nguild network:\n\nCreamland - main guild combat mains @ CL 130, Good total levelers (exempt from CL req). High (135+) Gathering / Alchemy / Enhancing / Cooking / Brewing  (exempt from CL req). \ncurdmaxxing - sister guild total levelers and combat mains only, must be CL 115 FL8 to join\ncurding - sister guild newbies and combat mains\n\nguild kick rules:\n\n- 7 days offline with zero notice or if you grief trials more than a few times without reason it will result in a kick\n- If you are frequently going idle / running out of offline time you may be moved down to another guild or just removed from the community. Case by Case Basis';

/** The key it was filed under, derived from the name by an older build */
export const NOTICE_BOARD_KEY =
    'skilling::[⠁⠃⠉⠙⠑⠋⠛⠓⠊⠚⠅⠇⠍⠝⠕⠏⠟⠗⠎⠞⠥⠧⠺⠭⠽⠵⠁⠃⠉⠙⠑⠋⠛⠓⠊⠚⠅⠇⠍⠝⠕⠏⠟⠗⠎⠞⠥⠧]\nwelcome to creamland!\n\njoin discord: \nhttps://discord.gg/0synthetic0 ( do not share this link it is for guildies only)\ncheck guild notice:\nhttps://discord.com/channels/1234500000000000001/1525000000000000321\ncheck weekly trial roster:\nhttps://discord.com/channels/1234500000000000001/1527000000000000654\n\nguild network:\n\ncreamland - main guild combat mains @ cl 130, good total levelers (exempt from cl req). high (135+) gathering / alchemy / enhancing / cooking / brewing  (exempt from cl req). \ncurdmaxxing - sister guild total levelers and combat mains only, must be cl 115 fl8 to join\ncurding - sister guild newbies and combat mains\n\nguild kick rules:\n\n- 7 days offline with zero notice or if you grief trials more than a few times without reason it will result in a kick\n- if you are frequently going idle / running out of offline time you may be moved down to another guild or just removed from the community. case by case basis';

/** Its first two samples, as stored */
export const NOTICE_BOARD_SAMPLES = [
    {
        t: 1785955245884,
        readings: [
            {
                current: 1234500000000000000,
                max: 1525000000000000320,
            },
            {
                current: 1234500000000000000,
                max: 1527000000000000640,
            },
        ],
    },
    {
        t: 1785955247415,
        readings: [
            {
                current: 1234500000000000000,
                max: 1525000000000000320,
            },
            {
                current: 1234500000000000000,
                max: 1527000000000000640,
            },
        ],
    },
];

/** The Overview tab's statistics, attached to it as a player's action stats */
export const NOTICE_BOARD_PERSONAL = {
    Guild: '10001',
    'Lifetime Guild Points': '42,564',
    'Guild Points': '1,114',
    Trials: '0',
    'Guild Level': '127',
    'Guild Experience': '145,279,118',
    'Exp to Level Up': '2,040,538',
    'Guild Members': '106',
};
