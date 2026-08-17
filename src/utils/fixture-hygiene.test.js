/**
 * Fixtures and tests carry synthetic data by construction.
 *
 * Recorded payloads make the best fixtures, but anything recorded from a live
 * session can carry community content along with the mechanics — so the
 * convention is: identities in committed fixtures are always synthetic
 * (PlayerNN names, 9xxxxx ids), and any external link that a fixture needs for
 * its shape uses the designated placeholder values below. This test is the
 * convention's enforcement: it fails on any invite-style or channel-style link
 * that is not one of the placeholders, and on webhook URLs outright.
 */

import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The placeholder link values fixtures are allowed to use */
const PLACEHOLDER_INVITE = 'discord.gg/0synthetic0';
const PLACEHOLDER_CHANNEL_IDS = new Set(['1234500000000000001', '1525000000000000321', '1527000000000000654']);

/** Every file under src/, because a link can hide in a comment as easily as a fixture */
function allSourceFiles(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) out.push(...allSourceFiles(path));
        else if (/\.(js|json|md)$/.test(name)) out.push(path);
    }
    return out;
}

describe('committed data is synthetic', () => {
    const files = allSourceFiles('src');

    test('invite-style links are the placeholder, never a live code', () => {
        const offenders = [];
        for (const file of files) {
            const text = readFileSync(file, 'utf8');
            for (const match of text.matchAll(/discord\.gg\/([A-Za-z0-9]+)/g)) {
                if (`discord.gg/${match[1]}` !== PLACEHOLDER_INVITE) offenders.push(`${file}: ${match[0]}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('channel-style links use placeholder ids, never live ones', () => {
        const offenders = [];
        for (const file of files) {
            const text = readFileSync(file, 'utf8');
            for (const match of text.matchAll(/discord\.com\/channels\/(\d+)\/(\d+)/g)) {
                if (!PLACEHOLDER_CHANNEL_IDS.has(match[1]) || !PLACEHOLDER_CHANNEL_IDS.has(match[2])) {
                    offenders.push(`${file}: ${match[0]}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    test('webhook URLs never appear at all', () => {
        const offenders = [];
        for (const file of files) {
            const text = readFileSync(file, 'utf8');
            if (/discord\.com\/api\/webhooks|hooks\.slack\.com/.test(text)) offenders.push(file);
        }
        // This file names the patterns it forbids, so it excuses itself
        expect(offenders.filter((f) => !f.includes('fixture-hygiene'))).toEqual([]);
    });
});
