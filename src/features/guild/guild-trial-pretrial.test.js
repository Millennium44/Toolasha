import { describe, test, expect } from 'vitest';
import { combatTrialsThisWeek, signedUpForCombatTrial, pretrialState } from './guild-trial-pretrial.js';
import { parsePlan } from './guild-trial-plan.js';

const WEEK = '2026-09-28T00:00:00Z';
const ABILITIES = { '/abilities/fierce_aura': { name: 'Fierce Aura' }, '/abilities/sweep': { name: 'Sweep' } };

/** A tracker shaped like guild-xp-tracker's member accessors; `members` maps id to meta */
function tracker(members, week = WEEK) {
    return {
        getCurrentWeekStartAt: () => week,
        getMemberList: () => Object.entries(members).map(([characterID, meta]) => ({ characterID, ...meta })),
        getMemberMeta: (id) => members[id] || null,
    };
}

const MEMBERS = {
    1: { name: 'Alice', signedUpCombatTrialHrid: '/guild_combat/badger', signupWeekStartAt: WEEK },
    2: { name: 'Bob', signedUpCombatTrialHrid: '/guild_combat/swarm', signupWeekStartAt: WEEK },
    3: { name: 'Cara', signedUpCombatTrialHrid: '/guild_combat/badger', signupWeekStartAt: WEEK },
    4: { name: 'Old', signedUpCombatTrialHrid: '/guild_combat/badger', signupWeekStartAt: '2026-09-21T00:00:00Z' },
    5: { name: 'None', signedUpCombatTrialHrid: '', signupWeekStartAt: WEEK },
};

describe('pre-trial checking', () => {
    test('the week has the combat trials that current sign-ups name, most signed-up first', () => {
        expect(combatTrialsThisWeek(tracker(MEMBERS))).toEqual([
            { hrid: '/guild_combat/badger', key: 'badger', name: 'Badger', count: 2 },
            { hrid: '/guild_combat/swarm', key: 'swarm', name: 'Swarm', count: 1 },
        ]);
    });

    test('the roster is the members signed up this week, not last week', () => {
        expect(signedUpForCombatTrial(tracker(MEMBERS), '/guild_combat/badger')).toEqual([
            { characterId: '1', name: 'Alice' },
            { characterId: '3', name: 'Cara' },
        ]);
    });

    test('one loadout per player is compared against each trial own plan section', () => {
        const plan = parsePlan(
            ['== Badger ==', 'Alice: Fierce Aura', '== Swarm ==', 'Alice: Sweep', 'Bob: Sweep'].join('\n'),
            ABILITIES
        );
        const loadouts = {
            1: {
                characterId: '1',
                name: 'Alice',
                abilitiesAuthoritative: true,
                abilities: [{ hrid: '/abilities/fierce_aura', level: 5 }],
                at: 9,
                source: 'view_loadout',
            },
            2: {
                characterId: '2',
                name: 'Bob',
                abilitiesAuthoritative: true,
                abilities: [{ hrid: '/abilities/sweep', level: 5 }],
                at: 9,
                source: 'view_loadout',
            },
        };
        const lookup = (member) => loadouts[member.characterId] || null;
        const t = tracker(MEMBERS);
        const [badger, swarm] = combatTrialsThisWeek(t);

        const forBadger = pretrialState({ tracker: t, trial: badger, lookup, plan, abilityDetailMap: ABILITIES });
        expect(forBadger.rosterCount).toBe(2);
        expect(forBadger.capturedCount).toBe(1);
        expect(forBadger.planCompare.byName.alice.status).toBe('ok');
        // Cara has no plan line and no capture; Bob is not signed up for Badger
        expect(forBadger.planCompare.notInTrial).toEqual([]);

        const forSwarm = pretrialState({ tracker: t, trial: swarm, lookup, plan, abilityDetailMap: ABILITIES });
        expect(forSwarm.planCompare.byName.bob.status).toBe('ok');
        // Alice is planned for Swarm but signed up for Badger
        expect(forSwarm.planCompare.notInTrial).toEqual(['Alice']);
        expect(forSwarm.planCompare.byName.alice).toBeUndefined();
    });
});
