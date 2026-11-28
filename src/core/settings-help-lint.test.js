/**
 * Settings text lint: keeps descriptions short, spelled the American way, and out of changelog voice.
 *
 * Settings help is read in a narrow panel. Long entries accumulate when every change appends a clause, so a
 * help string over MAX_HELP_LENGTH has to be justified here instead of growing quietly.
 */

import { describe, expect, it } from 'vitest';
import { settingsGroups } from './settings-schema.js';

const MAX_HELP_LENGTH = 300;

/**
 * Settings whose help is allowed to exceed MAX_HELP_LENGTH, each with the reason.
 * A stale entry (help now short enough, or the setting is gone) fails the test, so delete it when you trim.
 */
const LONG_HELP_ALLOWED = {
    // Required disclosures: a third-party host, an IP address, a license, or plain-text storage.
    leaderboardRankBadges: 'discloses the third-party host and that it sees the IP address; keep',
    market_pooledHistory: 'names the third-party dataset host and its MIT license; keep',
    market_historySource: 'names both third-party hosts and what is sent to them; keep',
    market_historyVolumeFromMooket2: 'discloses the second third-party server and what it learns; keep',
    sync_enabled: 'discloses that data goes to the GitHub gist; keep',
    sync_token: 'discloses plain-text token storage and the scope needed; keep',
    sync_passphrase: 'discloses plain-text passphrase storage and no recovery; keep',

    // Documented guarantees: the margin and quiet conditions are pinned against the code in
    // alchemy-catalyst-check.test.js, so shortening them would drop real behavior.
    alchemyCatalystCheck: 'states the exact 10K / 5% margin and every quiet condition, pinned against the code',
};

/**
 * British spellings the project does not use in player-facing text (American spelling).
 * "grey"/"greyed" is deliberately absent: the UI and code use both "gray" and "grey/greyed" widely
 * ("greyed out"), so flagging it would be noise rather than a guard.
 */
const BRITISH_WORDS = [
    'behaviours?',
    'behavioural',
    'colours?',
    'coloured',
    'colouring',
    'favourites?',
    'favoured',
    'centres?',
    'centred',
    'labelled',
    'labelling',
    'cancelled',
    'cancelling',
    'levelling',
    'levelled',
    'modelling',
    'modelled',
    'travelled',
    'travelling',
    'signalling',
    'fuelled',
    'defences?',
    'offences?',
    'licences?',
    'catalogues?',
    'dialogues?',
    'honour(?:s|ed)?',
    'neighbou?rs?',
    'flavours?',
    'metres?',
    'fibres?',
    'artefacts?',
    'programmes?',
    'ageing',
    'whilst',
    'amongst',
    'practise[sd]?',
    'jewellery',
    'fulfil',
    'enrol',
    'skilful',
    'sulphur',
    'ploughs?',
    '\\w*(?:optimis|organis|recognis|minimis|maximis|customis|summaris|normalis|initialis|synchronis|prioritis|utilis|visualis|serialis|finalis|realis|emphasis|categoris|standardis|authoris|apologis|capitalis|characteris|specialis|generalis|personalis|stabilis|penalis|monetis|sanitis)(?:e|es|ed|ing|ation|ations|er|ers)',
    'analys(?:e|ed|ing|er|ers)',
];
const BRITISH_RE = new RegExp(`\\b(?:${BRITISH_WORDS.join('|')})\\b`, 'gi');

/** Changelog-voice words that have no legitimate use in a description of what a setting does now. */
const CHANGELOG_VOICE_RE = /\b(?:previously|formerly|was never|were never)\b/gi;

/**
 * Every player-visible string of every setting.
 * @param {Object} groups - settingsGroups-shaped object
 * @returns {Array<{id: string, field: string, text: string}>}
 */
function collectTexts(groups) {
    const texts = [];
    for (const [groupKey, group] of Object.entries(groups)) {
        if (typeof group.title === 'string') texts.push({ id: groupKey, field: 'group title', text: group.title });
        for (const [key, setting] of Object.entries(group.settings || {})) {
            for (const field of ['label', 'help', 'buttonLabel', 'placeholder']) {
                if (typeof setting[field] === 'string') texts.push({ id: key, field, text: setting[field] });
            }
            for (const listName of ['options', 'tiers']) {
                // Some option lists are built lazily (a function); only static lists can be read here.
                const list = Array.isArray(setting[listName]) ? setting[listName] : [];
                for (const option of list) {
                    if (option && typeof option.label === 'string') {
                        texts.push({ id: key, field: `${listName} label "${option.value}"`, text: option.label });
                    }
                }
            }
        }
    }
    return texts;
}

/**
 * Problems with help length, allowlist staleness, spelling and voice.
 * @param {Object} groups - settingsGroups-shaped object
 * @param {Object} allowed - the LONG_HELP_ALLOWED map
 * @returns {{long: string[], stale: string[], british: string[], voice: string[]}}
 */
function lintSettings(groups, allowed) {
    const helps = new Map();
    for (const group of Object.values(groups)) {
        for (const [key, setting] of Object.entries(group.settings || {})) {
            helps.set(key, typeof setting.help === 'string' ? setting.help : '');
        }
    }

    const long = [];
    const stale = [];
    for (const [id, help] of helps) {
        if (help.length > MAX_HELP_LENGTH && !(id in allowed)) {
            long.push(
                `${id}: help is ${help.length} chars; shorten to <=${MAX_HELP_LENGTH} chars ` +
                    `or add ${id} to LONG_HELP_ALLOWED with a reason`
            );
        }
    }
    for (const id of Object.keys(allowed)) {
        if (!helps.has(id)) {
            stale.push(`${id}: no longer a setting; remove it from LONG_HELP_ALLOWED`);
        } else if (helps.get(id).length <= MAX_HELP_LENGTH) {
            stale.push(
                `${id}: help is now ${helps.get(id).length} chars (<=${MAX_HELP_LENGTH}); remove it from LONG_HELP_ALLOWED`
            );
        }
    }

    const british = [];
    const voice = [];
    for (const { id, field, text } of collectTexts(groups)) {
        for (const match of text.matchAll(BRITISH_RE)) {
            british.push(`${id} (${field}): "${match[0]}" is British; use the American spelling`);
        }
        for (const match of text.matchAll(CHANGELOG_VOICE_RE)) {
            voice.push(
                `${id} (${field}): "${match[0]}" reads like a changelog; describe what the setting does now, ` +
                    `and put the history in CHANGELOG.md`
            );
        }
    }
    return { long, stale, british, voice };
}

const report = (problems) => `\n${problems.join('\n')}\n`;

describe('settings help lint', () => {
    const result = lintSettings(settingsGroups, LONG_HELP_ALLOWED);

    it(`keeps every help string within ${MAX_HELP_LENGTH} characters unless allowlisted`, () => {
        expect(result.long, report(result.long)).toEqual([]);
    });

    it('has no stale LONG_HELP_ALLOWED entries', () => {
        expect(result.stale, report(result.stale)).toEqual([]);
    });

    it('uses American spelling in every label, help and option label', () => {
        expect(result.british, report(result.british)).toEqual([]);
    });

    it('keeps changelog voice out of help text', () => {
        expect(result.voice, report(result.voice)).toEqual([]);
    });

    describe('the lint itself', () => {
        const fixture = (help, extra = {}) => ({
            g: { title: 'Group', settings: { a_setting: { id: 'a_setting', label: 'Label', help, ...extra } } },
        });

        it('flags an over-long help, and accepts it once allowlisted', () => {
            const groups = fixture('x'.repeat(MAX_HELP_LENGTH + 1));
            expect(lintSettings(groups, {}).long).toHaveLength(1);
            expect(lintSettings(groups, { a_setting: 'reason' }).long).toEqual([]);
        });

        it('flags stale and unknown allowlist entries', () => {
            const groups = fixture('short');
            expect(lintSettings(groups, { a_setting: 'r' }).stale).toHaveLength(1);
            expect(lintSettings(groups, { gone: 'r' }).stale).toHaveLength(1);
        });

        it('flags British spellings in label, help and option labels, all at once', () => {
            const groups = {
                g: {
                    title: 'Group',
                    settings: {
                        a_setting: {
                            id: 'a_setting',
                            label: 'Colour picker',
                            help: 'Optimises the behaviour; analyse it.',
                            options: [{ value: 'x', label: 'Favourite' }],
                        },
                    },
                },
            };
            const { british } = lintSettings(groups, {});
            expect(british).toHaveLength(5);
        });

        it('leaves American spellings and unrelated words alone', () => {
            const groups = fixture(
                'Optimizes the behavior, color, favorite center; analyzed and organized. Greyed out.'
            );
            expect(lintSettings(groups, {}).british).toEqual([]);
        });

        it('flags changelog voice', () => {
            expect(lintSettings(fixture('Previously this was off.'), {}).voice).toHaveLength(1);
            expect(lintSettings(fixture('Reload now or open a new tab.'), {}).voice).toEqual([]);
        });
    });
});
