/**
 * The fingerprint's version rules. Records key on the value and are split into
 * cohorts by the stamp, so these pin what an absent, malformed or mismatched
 * version reads as, and that the level part is stable and complete.
 */

import { describe, test, expect } from 'vitest';
import {
    FINGERPRINT_VERSION,
    FINGERPRINT_PREFIX,
    FINGERPRINT_SPEC,
    SIM_COMBAT_SKILLS,
    fingerprintVersionOf,
    isCurrentFingerprintVersion,
    combatLevelsPart,
    fingerprintInput,
    tagFingerprint,
} from './labyrinth-fingerprint.js';

const levels = (over = {}) => ({
    stamina: 90,
    intelligence: 80,
    attack: 95,
    defense: 92,
    melee: 99,
    ranged: 1,
    magic: 1,
    ...over,
});

describe('fingerprintVersionOf', () => {
    test('a record without the field is version 1 — the gear-only fingerprint', () => {
        expect(fingerprintVersionOf({})).toBe(1);
        expect(fingerprintVersionOf(null)).toBe(1);
        expect(fingerprintVersionOf(undefined)).toBe(1);
    });

    test('a stamped record reads its stamp', () => {
        expect(fingerprintVersionOf({ fingerprintVersion: 2 })).toBe(2);
        expect(fingerprintVersionOf({ fingerprintVersion: 7 })).toBe(7);
    });

    test('a malformed stamp is not trusted, and reads as the pre-migration cohort', () => {
        // Number(null) is 0 and Number(undefined) is NaN, so the field is
        // checked for being a positive integer before it is believed
        for (const bad of [null, 0, -1, 1.5, '2', NaN, {}, true]) {
            expect(fingerprintVersionOf({ fingerprintVersion: bad })).toBe(1);
        }
    });
});

describe('isCurrentFingerprintVersion', () => {
    test('only an exact match is current', () => {
        expect(isCurrentFingerprintVersion({ fingerprintVersion: FINGERPRINT_VERSION })).toBe(true);
        expect(isCurrentFingerprintVersion({})).toBe(false);
    });

    test('a newer version is no more poolable than an older one', () => {
        // A record synced from a build ahead of this one describes a
        // fingerprint this build cannot compute, so it is not evidence either
        expect(isCurrentFingerprintVersion({ fingerprintVersion: FINGERPRINT_VERSION + 1 })).toBe(false);
    });
});

describe('combatLevelsPart', () => {
    test('exactly the seven levels the sim reads, in a fixed order', () => {
        const part = combatLevelsPart(levels());
        expect(part).toBe('levels=stamina:90,intelligence:80,attack:95,defense:92,melee:99,ranged:1,magic:1');
        expect(SIM_COMBAT_SKILLS).toHaveLength(7);
    });

    test('a level the sim does not read cannot reach the hash', () => {
        expect(combatLevelsPart({ ...levels(), woodcutting: 200, enhancing: 150 })).toBe(combatLevelsPart(levels()));
    });

    test('every one of the seven changes the string', () => {
        const base = combatLevelsPart(levels());
        for (const name of SIM_COMBAT_SKILLS) {
            expect(combatLevelsPart(levels({ [name]: 123 }))).not.toBe(base);
        }
    });

    test('unreadable levels are a placeholder, told apart from a levelled character', () => {
        expect(combatLevelsPart(null)).toBe('levels=unknown');
        expect(combatLevelsPart(undefined)).toBe('levels=unknown');
        expect(combatLevelsPart('nonsense')).toBe('levels=unknown');
        expect(combatLevelsPart({})).not.toBe('levels=unknown');
    });

    test('a missing or nonsense level within a known map counts as zero, not as absent', () => {
        expect(combatLevelsPart({})).toBe(
            'levels=stamina:0,intelligence:0,attack:0,defense:0,melee:0,ranged:0,magic:0'
        );
        expect(combatLevelsPart(levels({ melee: 'x' }))).toBe(combatLevelsPart(levels({ melee: 0 })));
    });
});

describe('the hashed input and its tag', () => {
    test('all three halves reach the string', () => {
        const base = fingerprintInput({ stored: 'a', worn: 'b', levels: 'c' });
        expect(fingerprintInput({ stored: 'z', worn: 'b', levels: 'c' })).not.toBe(base);
        expect(fingerprintInput({ stored: 'a', worn: 'z', levels: 'c' })).not.toBe(base);
        expect(fingerprintInput({ stored: 'a', worn: 'b', levels: 'z' })).not.toBe(base);
    });

    test('the tag is what makes a cross-version collision impossible rather than unlikely', () => {
        // Two definitions can collide on a hash; they cannot collide on the
        // prefix in front of it, and a v1 value carries none
        expect(tagFingerprint('123')).toBe(`${FINGERPRINT_PREFIX}123`);
        expect(tagFingerprint('123')).not.toBe('123');
    });

    test('the spec names the version it describes', () => {
        expect(FINGERPRINT_SPEC).toContain(`v${FINGERPRINT_VERSION}`);
        expect(FINGERPRINT_PREFIX).toBe(`v${FINGERPRINT_VERSION}:`);
    });
});
