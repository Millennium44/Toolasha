/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { observerCallbacks, mockOnClass, dataManagerHandlers } = vi.hoisted(() => {
    const observerCallbacks = new Map();
    const mockOnClass = vi.fn((id, _className, callback) => {
        observerCallbacks.set(id, callback);
        return vi.fn(() => observerCallbacks.delete(id));
    });
    return { observerCallbacks, mockOnClass, dataManagerHandlers: new Map() };
});

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: mockOnClass,
        // Mirrors the real DOMObserver.onReady in its already-attached steady state
        onReady: vi.fn((name, callback) => {
            callback();
            return () => {};
        }),
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        isFeatureEnabled: vi.fn(() => true),
        onSettingChange: vi.fn(),
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: vi.fn((event, handler) => dataManagerHandlers.set(event, handler)),
        off: vi.fn((event) => dataManagerHandlers.delete(event)),
        getSkills: vi.fn(),
    },
}));

const { CombatLevelProgress, decimalCombatLevel } = await import('./combat-level-progress.js');
const dataManager = (await import('../../core/data-manager.js')).default;

function skill(hrid, level, experience = 0) {
    return { skillHrid: hrid, level, experience };
}

function makeSkills({ stamina = 5, intelligence = 5, attack = 6, defense = 5, melee = 5, ranged = 3, magic = 3 } = {}) {
    return [
        skill('/skills/stamina', stamina),
        skill('/skills/intelligence', intelligence),
        skill('/skills/attack', attack),
        skill('/skills/defense', defense),
        skill('/skills/melee', melee),
        skill('/skills/ranged', ranged),
        skill('/skills/magic', magic),
    ];
}

// Stamina 5, Intelligence 5, Attack 6, Defense 5, Melee 5, Ranged 3, Magic 3 ->
// offense max = 5, doubled max = 6 -> raw = 0.1*(5+5+6+5+5) + 0.5*6 = 2.6 + 3.0 = 5.6
function makeFullSkillSet() {
    return makeSkills();
}

function buildNavBarFixture() {
    document.body.innerHTML = `
        <div class="NavigationBar_navigationBar__1gRln">
            <div class="NavigationBar_navigationLink__3eAHA">
                <div class="NavigationBar_nav__3uuUl">
                    <svg aria-label="navigationBar.combat"><use href="#combat"></use></svg>
                    <div class="NavigationBar_contentContainer__1x6WS">
                        <div class="NavigationBar_textContainer__7TdaI">
                            <span class="NavigationBar_label__1uH-y">Combat</span>
                            <span class="NavigationBar_level__3C7eR">5</span>
                        </div>
                    </div>
                </div>
                <div class="NavigationBar_subSkills__37qWb">
                    <div class="NavigationBar_nav__3uuUl">
                        <svg aria-label="Icon"><use href="#stamina"></use></svg>
                        <div class="NavigationBar_contentContainer__1x6WS">
                            <div class="NavigationBar_textContainer__7TdaI">
                                <span class="NavigationBar_label__1uH-y">Stamina</span>
                                <span class="NavigationBar_level__3C7eR">5</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

describe('decimalCombatLevel', () => {
    test('matches the player-reported example: whole skill levels -> 133.2, not an XP-interpolated 133.39', () => {
        const skills = makeSkills({
            stamina: 125,
            intelligence: 124,
            attack: 130,
            defense: 125,
            melee: 105,
            ranged: 138,
            magic: 77,
        });
        expect(decimalCombatLevel(skills)).toBe(133.2);
    });

    test('an exact result has no float noise (0.1 * 3 !== 0.30000000000000004)', () => {
        // flat sum = 3, doubled max = attack = 1 -> 0.3 + 0.5
        expect(
            decimalCombatLevel(
                makeSkills({ stamina: 1, intelligence: 1, attack: 1, defense: 0, melee: 0, ranged: 0, magic: 0 })
            )
        ).toBe(0.8);
    });

    test('changing XP while whole levels stay put does not change the result', () => {
        const skills = makeSkills();
        const withXp = skills.map((s) => ({ ...s, experience: s.experience + 999 }));
        expect(decimalCombatLevel(withXp)).toBe(decimalCombatLevel(skills));
    });

    test('a real whole-skill level-up moves it', () => {
        expect(decimalCombatLevel(makeSkills({ attack: 10 }))).toBeGreaterThan(
            decimalCombatLevel(makeSkills({ attack: 5 }))
        );
    });

    test('returns null when a combat skill is missing or there are no skills', () => {
        expect(decimalCombatLevel(makeSkills().filter((s) => s.skillHrid !== '/skills/magic'))).toBeNull();
        expect(decimalCombatLevel(null)).toBeNull();
    });

    test('never mutates the skills it is given', () => {
        const skills = makeSkills();
        const snapshot = JSON.parse(JSON.stringify(skills));
        decimalCombatLevel(skills);
        expect(skills).toEqual(snapshot);
    });
});

describe('CombatLevelProgress', () => {
    let feature;

    beforeEach(() => {
        observerCallbacks.clear();
        mockOnClass.mockClear();
        dataManagerHandlers.clear();
        dataManager.getSkills.mockReset();
        buildNavBarFixture();
        feature = new CombatLevelProgress();
    });

    afterEach(() => {
        feature.disable();
        document.body.innerHTML = '';
    });

    test('appends inside the native Combat level span so it reads flush, never overwriting the native text node', () => {
        dataManager.getSkills.mockReturnValue(makeFullSkillSet());
        feature.initialize();

        const levelSpan = document.querySelector('[class*="NavigationBar_level"]');
        expect(levelSpan.firstChild.nodeValue).toBe('5'); // native text node untouched

        const companion = document.querySelector('.mwi-combat-level-precise');
        expect(companion).not.toBeNull();
        expect(companion.parentElement).toBe(levelSpan);
        expect(companion.textContent).toBe('.6');
    });

    test('renders an exact-integer raw value with one decimal (N.0), never as a bare integer', () => {
        // all levels at 1 -> raw = 0.1*(1+1+1+1+1) + 0.5*1 = 1.0 exactly
        dataManager.getSkills.mockReturnValue(
            makeSkills({ stamina: 1, intelligence: 1, attack: 1, defense: 1, melee: 1, ranged: 1, magic: 1 })
        );
        feature.initialize();

        expect(document.querySelector('.mwi-combat-level-precise').textContent).toBe('.0');
    });

    test('finds the Combat row via the stable aria-label icon anchor, not the sub-skill rows', () => {
        dataManager.getSkills.mockReturnValue(makeFullSkillSet());
        feature.initialize();

        const companions = document.querySelectorAll('.mwi-combat-level-precise');
        expect(companions.length).toBe(1);

        const staminaTextContainer = document
            .querySelector('.NavigationBar_subSkills__37qWb')
            .querySelector('[class*="NavigationBar_textContainer"]');
        expect(staminaTextContainer.querySelector('.mwi-combat-level-precise')).toBeNull();
    });

    test('removes the companion span when required data becomes unavailable (e.g. character switching)', () => {
        dataManager.getSkills.mockReturnValue(makeFullSkillSet());
        feature.initialize();
        expect(document.querySelector('.mwi-combat-level-precise')).not.toBeNull();

        dataManager.getSkills.mockReturnValue(null);
        feature.update();

        expect(document.querySelector('.mwi-combat-level-precise')).toBeNull();
    });

    test('needs only whole skill levels - no level/XP table', () => {
        dataManager.getSkills.mockReturnValue(makeFullSkillSet());
        feature.initialize();

        expect(document.querySelector('.mwi-combat-level-precise')).not.toBeNull();
    });

    test('recomputes when dataManager reports a skill update, not on a timer', () => {
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        dataManager.getSkills.mockReturnValue(makeFullSkillSet());
        feature.initialize();

        expect(setIntervalSpy).not.toHaveBeenCalled();

        // Attack 6 -> 8: raw = 0.1*(5+5+8+5+5) + 0.5*8 = 2.8 + 4.0 = 6.8
        dataManager.getSkills.mockReturnValue(makeSkills({ attack: 8 }));
        dataManagerHandlers.get('action_completed')();

        const levelSpan = document.querySelector('[class*="NavigationBar_level"]');
        expect(levelSpan.firstChild.nodeValue).toBe('5'); // untouched by re-render, only re-read
        expect(document.querySelector('.mwi-combat-level-precise').textContent).toBe('.8');

        setIntervalSpy.mockRestore();
    });

    test('disable() removes injected spans and unsubscribes from dataManager events', () => {
        dataManager.getSkills.mockReturnValue(makeFullSkillSet());
        feature.initialize();
        expect(document.querySelector('.mwi-combat-level-precise')).not.toBeNull();

        feature.disable();

        expect(document.querySelector('.mwi-combat-level-precise')).toBeNull();
        expect(dataManagerHandlers.has('action_completed')).toBe(false);
        expect(dataManagerHandlers.has('skills_updated')).toBe(false);
        expect(dataManagerHandlers.has('character_initialized')).toBe(false);
    });

    test('does nothing when the feature setting is disabled', async () => {
        const config = (await import('../../core/config.js')).default;
        config.isFeatureEnabled.mockReturnValue(false);
        dataManager.getSkills.mockReturnValue(makeFullSkillSet());

        feature.initialize();

        expect(document.querySelector('.mwi-combat-level-precise')).toBeNull();
        config.isFeatureEnabled.mockReturnValue(true);
    });
});
