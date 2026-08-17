/**
 * A guild's notice board, exactly as it reached the trial record — in shape.
 *
 * The original was a live guild's notice filed as a *trial card*: braille art,
 * a welcome, three Discord links and the kick rules, with the two Discord
 * channel ids in it recorded as its progress bar. Every identity in it — the
 * guild names, the invite code, the server and channel ids, the member stats —
 * has been replaced with synthetic values of the same shape; the structure the
 * refusal rules key on (the newlines, the link forms, the id-shaped numbers,
 * the length) is preserved. `1234500000000000001 / 1525000000000000321` has the
 * shape of a reading and nothing else about it does.
 *
 * The refusal rules are about this *shape* of string, so the shape is what the
 * fixture keeps. Nothing in it identifies a real guild or player.
 */
export const NOTICE_BOARD_NAME =
    '[⠁⠃⠉⠙⠑⠋⠛⠓⠊⠚⠅⠇⠍⠝⠕⠏⠟⠗⠎⠞⠥⠧⠺⠭⠽⠵⠁⠃⠉⠙⠑⠋⠛⠓⠊⠚⠅⠇⠍⠝⠕⠏⠟⠗⠎⠞⠥⠧]\nWelcome to Creamland!\n\nJOIN DISCORD: \nhttps://discord.gg/0synthetic0 ( DO NOT SHARE THIS LINK IT IS FOR GUILDIES ONLY)\nCHECK GUILD NOTICE:\nhttps://discord.com/channels/1234500000000000001/1525000000000000321\nCHECK WEEKLY TRIAL ROSTER:\nhttps://discord.com/channels/1234500000000000001/1527000000000000654\n\nguild network:\n\nCreamland - main guild combat mains @ CL 130, Good total levelers (exempt from CL req). High (135+) Gathering / Alchemy / Enhancing / Cooking / Brewing  (exempt from CL req). \ncurdmaxxing - sister guild total levelers and combat mains only, must be CL 115 FL8 to join\ncurding - sister guild newbies and combat mains\n\nguild kick rules:\n\n- 7 days offline with zero notice or if you grief trials more than a few times without reason it will result in a kick\n- If you are frequently going idle / running out of offline time you may be moved down to another guild or just removed from the community. Case by Case Basis';

/** The key it was filed under, derived from the name by an older build */
export const NOTICE_BOARD_KEY =
    'skilling::[⠁⠃⠉⠙⠑⠋⠛⠓⠊⠚⠅⠇⠍⠝⠕⠏⠟⠗⠎⠞⠥⠧⠺⠭⠽⠵⠁⠃⠉⠙⠑⠋⠛⠓⠊⠚⠅⠇⠍⠝⠕⠏⠟⠗⠎⠞⠥⠧]\nwelcome to creamland!\n\njoin discord: \nhttps://discord.gg/0synthetic0 ( do not share this link it is for guildies only)\ncheck guild notice:\nhttps://discord.com/channels/1234500000000000001/1525000000000000321\ncheck weekly trial roster:\nhttps://discord.com/channels/1234500000000000001/1527000000000000654\n\nguild network:\n\ncreamland - main guild combat mains @ cl 130, good total levelers (exempt from cl req). high (135+) gathering / alchemy / enhancing / cooking / brewing  (exempt from cl req). \ncurdmaxxing - sister guild total levelers and combat mains only, must be cl 115 fl8 to join\ncurding - sister guild newbies and combat mains\n\nguild kick rules:\n\n- 7 days offline with zero notice or if you grief trials more than a few times without reason it will result in a kick\n- if you are frequently going idle / running out of offline time you may be moved down to another guild or just removed from the community. case by case basis';

/** Its first two samples, as stored (ids lose precision as JS numbers, as the real ones did) */
export const NOTICE_BOARD_SAMPLES = [
    {
        t: 1785955245884,
        readings: [
            {
                current: 1234500000000000000,
                max: 1525000000000000256,
            },
            {
                current: 1234500000000000000,
                max: 1527000000000000768,
            },
        ],
    },
    {
        t: 1785955247415,
        readings: [
            {
                current: 1234500000000000000,
                max: 1525000000000000256,
            },
            {
                current: 1234500000000000000,
                max: 1527000000000000768,
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
