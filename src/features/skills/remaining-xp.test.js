/** @vitest-environment happy-dom */

/**
 * Tests for the Remaining XP calculation
 *
 * The feature is mostly observer plumbing, but one method does arithmetic worth
 * pinning: "XP left in this level", from the skill's experience against the
 * level experience table. That method is what is tested here; the observers, the
 * injected span and its styling are left alone.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    characterData: null,
    initClientData: null,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.characterData;
        },
        getInitClientData: () => game.initClientData,
        on: () => {},
        off: () => {},
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {} },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (_key, fallback) => fallback,
        getSettingValue: (_key, fallback) => fallback,
        COLOR_REMAINING_XP: '#fff',
    },
}));

const remainingXP = (await import('./remaining-xp.js')).default;

beforeEach(() => {
    game.characterData = {
        characterSkills: [
            { skillHrid: '/skills/milking', level: 30, experience: 24000 },
            { skillHrid: '/skills/cooking', level: 99, experience: 5000000 },
        ],
    };
    // Level 30 starts at 20,000 XP and level 31 at 30,000 → 10,000 XP band.
    // Cooking is at the top of the table, so it has no next level.
    game.initClientData = {
        levelExperienceTable: { 29: 15000, 30: 20000, 31: 30000, 99: 5000000 },
    };
});

describe('calculateRemainingXP', () => {
    const milkingAt = (experience) => {
        game.characterData.characterSkills[0].experience = experience;
    };

    test('is the distance from the skill experience to the next level', () => {
        expect(remainingXP.calculateRemainingXP('Milking')).toBe(6000);
    });

    test('a level just started owes all of it and a level just finished owes nothing', () => {
        milkingAt(20000);
        expect(remainingXP.calculateRemainingXP('Milking')).toBe(10000);
        milkingAt(30000);
        expect(remainingXP.calculateRemainingXP('Milking')).toBe(0);
    });

    test('rounds a partial XP point up so the display never reads zero early', () => {
        milkingAt(29999.5);
        expect(remainingXP.calculateRemainingXP('Milking')).toBe(1);
    });

    test('never reports a negative remainder', () => {
        milkingAt(31000);
        expect(remainingXP.calculateRemainingXP('Milking')).toBe(0);
    });

    test('matches skills case-insensitively via the hrid', () => {
        expect(remainingXP.calculateRemainingXP('milking')).toBe(6000);
    });

    test('returns null at max level, where there is no next level to reach', () => {
        expect(remainingXP.calculateRemainingXP('Cooking')).toBeNull();
    });

    test('returns null for an unknown skill', () => {
        expect(remainingXP.calculateRemainingXP('Alchemy')).toBeNull();
    });

    test('returns null rather than a guess when the experience is missing', () => {
        milkingAt(undefined);
        expect(remainingXP.calculateRemainingXP('Milking')).toBeNull();
    });

    test('returns null before the character or the game data has loaded', () => {
        game.characterData = null;
        expect(remainingXP.calculateRemainingXP('Milking')).toBeNull();

        game.characterData = { characterSkills: [{ skillHrid: '/skills/milking', level: 30, experience: 24000 }] };
        game.initClientData = null;
        expect(remainingXP.calculateRemainingXP('Milking')).toBeNull();
    });
});

describe('addRemainingXP names the skill by its icon', () => {
    const SPRITE = '/static/media/skills_sprite.0a1b2c.svg';

    beforeEach(() => {
        document.body.innerHTML = '';
        game.initClientData.skillDetailMap = { '/skills/milking': { name: 'Milking' } };
    });

    /** A regular nav link as the game draws it: icon, label, XP bar */
    const navLink = (fragment, label) => {
        const link = document.createElement('div');
        link.className = 'NavigationBar_navigationLink__x';
        link.innerHTML =
            (fragment ? `<svg><use href="${SPRITE}#${fragment}"></use></svg>` : '') +
            `<span class="NavigationBar_label__y">${label}</span>` +
            '<div class="NavigationBar_progress__z"><div class="NavigationBar_currentExperience__w"></div></div>';
        document.body.appendChild(link);
        const bar = link.querySelector('[class*="NavigationBar_currentExperience"]');
        bar.style.width = '40%';
        return { link, bar };
    };

    test('a translated label with the right icon still shows the XP left', () => {
        const { link, bar } = navLink('milking', '挤奶');

        remainingXP.addRemainingXP(bar);

        expect(link.querySelector('.mwi-remaining-xp')?.textContent).toContain('XP left');
    });

    test('an icon-less English entry falls back to its label', () => {
        const { link, bar } = navLink(null, 'Milking');

        remainingXP.addRemainingXP(bar);

        expect(link.querySelector('.mwi-remaining-xp')?.textContent).toContain('XP left');
    });

    test('a translated label with no icon cannot be named and shows nothing', () => {
        const { link, bar } = navLink(null, '挤奶');

        remainingXP.addRemainingXP(bar);

        expect(link.querySelector('.mwi-remaining-xp')).toBeNull();
    });

    test('the calculation takes an hrid as well as a name', () => {
        expect(remainingXP.calculateRemainingXP('/skills/milking')).toBe(6000);
    });

    test('a stuck bar width does not change the XP left', () => {
        const stuck = navLink('milking', 'Milking');
        stuck.bar.style.width = '96.8814%';
        remainingXP.addRemainingXP(stuck.bar);
        const fromStuck = stuck.link.querySelector('.mwi-remaining-xp')?.textContent;

        const normal = navLink('milking', 'Milking');
        normal.bar.style.width = '40%';
        remainingXP.addRemainingXP(normal.bar);

        expect(fromStuck).toContain('XP left');
        expect(fromStuck).toBe(normal.link.querySelector('.mwi-remaining-xp')?.textContent);
    });
});
