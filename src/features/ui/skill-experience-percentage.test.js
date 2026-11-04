/** @vitest-environment happy-dom */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ characterData: null, initClientData: null }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.characterData;
        },
        getInitClientData: () => game.initClientData,
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {}, onReady: () => () => {} } }));
vi.mock('../../core/config.js', () => ({
    default: {
        onSettingChange: () => {},
        isFeatureEnabled: () => true,
        SCRIPT_COLOR_MAIN: '#fff',
        COLOR_ACCENT: '#fff',
    },
}));

const feature = (await import('./skill-experience-percentage.js')).default;

const SPRITE = '/static/media/skills_sprite.0a1b2c.svg';

/** A nav row as the game draws it, with the bar at `width` */
function navRow(fragment, label, width) {
    document.body.innerHTML =
        '<div class="NavigationBar_nav__a">' +
        (fragment ? `<svg><use href="${SPRITE}#${fragment}"></use></svg>` : '') +
        '<div class="NavigationBar_contentContainer__b">' +
        `<div class="NavigationBar_textContainer__c"><span class="NavigationBar_label__d">${label}</span>` +
        '<span class="NavigationBar_level__e">117</span></div>' +
        '<div class="NavigationBar_experienceBar__f"><div class="NavigationBar_currentExperience__g"></div></div>' +
        '</div></div>';
    const bar = document.querySelector('[class*="NavigationBar_currentExperience"]');
    if (width) bar.style.width = width;
    return bar;
}

const shown = () => document.querySelector('.mwi-exp-percentage')?.textContent ?? null;

beforeEach(() => {
    // The figures from the player's report: level 117 at 54,737,939 XP is 17.9% through the level
    game.characterData = {
        characterSkills: [
            { skillHrid: '/skills/tailoring', level: 117, experience: 54737939 },
            { skillHrid: '/skills/cooking', level: 118, experience: 60000000 },
        ],
    };
    game.initClientData = {
        levelExperienceTable: { 117: 53929328, 118: 58444489 },
        skillDetailMap: { '/skills/tailoring': { name: 'Tailoring' }, '/skills/cooking': { name: 'Cooking' } },
    };
});

describe('the sidebar percentage', () => {
    test('comes from the skill experience, whatever the bar is stuck at', () => {
        feature.updateSkillPercentage(navRow('tailoring', 'Tailoring', '97.6%'));
        expect(shown()).toBe('17.9%');
    });

    test('names the skill by its icon in a translated game', () => {
        feature.updateSkillPercentage(navRow('tailoring', '裁缝', '97.6%'));
        expect(shown()).toBe('17.9%');
    });

    test('falls back to the bar before the character has loaded', () => {
        game.characterData = null;
        feature.updateSkillPercentage(navRow('tailoring', 'Tailoring', '40%'));
        expect(shown()).toBe('40.0%');
    });

    test('falls back to the bar at the level cap, where the table has no next level', () => {
        feature.updateSkillPercentage(navRow('cooking', 'Cooking', '100%'));
        expect(shown()).toBe('100.0%');
    });

    test('falls back to the bar for a row it cannot name', () => {
        feature.updateSkillPercentage(navRow(null, '裁缝', '40%'));
        expect(shown()).toBe('40.0%');
    });

    test('shows nothing when neither source has a figure', () => {
        game.characterData = null;
        feature.updateSkillPercentage(navRow('tailoring', 'Tailoring', null));
        expect(shown()).toBeNull();
    });
});
