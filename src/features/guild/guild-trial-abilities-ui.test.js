/**
 * @vitest-environment happy-dom
 *
 * The Trial Abilities panel, exercised rather than reasoned about.
 *
 * The load-bearing assertion is the dull one: the panel draws every section
 * and none of them reports a failure. Beyond that, the panel's claims are what
 * matter — `Unknown` before the roster is fully captured, `MISSING` only
 * after, and a stat-only sighting drawn as unavailable rather than empty.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

/** The game data the panel reads, swapped between tests */
const game = vi.hoisted(() => ({ abilityDetailMap: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ abilityDetailMap: game.abilityDetailMap }),
        getCurrentCharacterId: () => 'me',
    },
}));

// Sessions and geometry live in IndexedDB, which is not what this file is about
vi.mock('../../core/storage.js', () => ({
    default: { get: async () => null, set: async () => {}, getJSON: async () => null, setJSON: async () => {} },
}));

vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
}));

/** The loadout capture, reduced to the two calls the panel makes */
const capture = vi.hoisted(() => ({ listeners: [], players: {} }));

vi.mock('./guild-loadout-capture.js', () => ({
    default: {
        onCaptured: (listener) => {
            capture.listeners.push(listener);
            return () => {
                capture.listeners = capture.listeners.filter((entry) => entry !== listener);
            };
        },
        forPlayer: (name) =>
            capture.players[
                String(name || '')
                    .trim()
                    .toLowerCase()
            ] || null,
    },
}));

const { guildTrialAbilities } = await import('./guild-trial-abilities.js');
const feature = (await import('./guild-trial-abilities-ui.js')).default;
const {
    guildTrialAbilitiesPanel,
    setControls,
    openTrialAbilitiesPanel,
    openNextTrialUnit,
    retryTrialUnit,
    resetTrialUnitRequests,
    tierRangeLabel,
    headerLine,
    completionLine,
} = await import('./guild-trial-abilities-ui.js');
const { REQUEST_TIMEOUT_MS } = await import('./guild-member-skills.js');

const NOW = 1_800_000_000_000;

const aura = (name) => ({
    name,
    isSpecialAbility: true,
    abilityEffects: [{ effectType: '/ability_effect_types/buff', targetType: 'allAllies', buffs: [{}] }],
});

/** A snapshot as the loadout store would hand it back */
function snapshot(name, characterId, abilities, over = {}) {
    return {
        name,
        characterId,
        abilities,
        abilitiesAuthoritative: true,
        source: 'battle_unit_fetched',
        at: NOW,
        ...over,
    };
}

/** Put a snapshot in the store and announce it, as a landed sheet would */
function land(snap) {
    capture.players[snap.name.toLowerCase()] = snap;
    for (const listener of [...capture.listeners]) {
        listener({
            characterId: snap.characterId ?? null,
            name: snap.name,
            source: snap.source,
            abilitiesAuthoritative: snap.abilitiesAuthoritative === true,
            at: snap.at,
        });
    }
}

const text = () => guildTrialAbilitiesPanel.panel.textContent;
const FAILED = 'could not be drawn';

/** The card whose heading starts with the given text */
function card(title) {
    for (const heading of guildTrialAbilitiesPanel.panel.querySelectorAll('div')) {
        if ((heading.firstChild?.textContent || '').startsWith(title)) return heading;
    }
    return null;
}

const button = (label) =>
    [...guildTrialAbilitiesPanel.panel.querySelectorAll('button')].find((el) => el.textContent === label);

describe('trial abilities panel', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        document.body.replaceChildren();
        game.abilityDetailMap = {
            '/abilities/fierce_aura': aura('Fierce Aura'),
            '/abilities/aqua_aura': aura('Aqua Aura'),
            '/abilities/sweep': { name: 'Sweep', isSpecialAbility: false, abilityEffects: [] },
        };
        capture.listeners = [];
        capture.players = {};
        resetTrialUnitRequests();
    });

    afterEach(() => {
        feature.cleanup();
        // A panel remembers its state between openings; a test must not
        guildTrialAbilities.session = null;
        guildTrialAbilities.roster = [];
        guildTrialAbilities.guildName = null;
        guildTrialAbilities.currentTier = null;
        vi.useRealTimers();
    });

    test('header counts the roster and hedges the coverage while collecting', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice', 'Bob', 'Cara']);
        guildTrialAbilities.setTier(4);
        guildTrialAbilities.recordCapture(snapshot('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 70 }]));

        openTrialAbilitiesPanel();
        expect(text()).toContain('Trial abilities — 1/3 captured');
        expect(text()).toContain('2 players still need Battle Info');
        expect(text()).toContain('Aura coverage unknown until capture is complete');
        expect(text()).toContain('T4');
        expect(text()).not.toContain(FAILED);
    });

    test('a complete single-tier roster reads "on T4"; mixed tiers read "across"', () => {
        expect(completionLine({ complete: true, capturedCount: 2, rosterCount: 2, capturedTiers: [4] })).toBe(
            '2/2 captured on T4'
        );
        expect(
            completionLine({ complete: true, capturedCount: 5, rosterCount: 5, capturedTiers: [4, 5], captureTier: 4 })
        ).toBe('5/5 captured across T4-T5');
        expect(completionLine({ complete: false })).toBeNull();
        expect(tierRangeLabel([5, 4, 5])).toBe('T4-T5');
        expect(headerLine({ capturedCount: 42, rosterCount: 50 })).toBe('Trial abilities — 42/50 captured');
    });

    test('coverage says Unknown before completion and MISSING only after', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice', 'Bob']);
        guildTrialAbilities.recordCapture(snapshot('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 78 }]));

        guildTrialAbilitiesPanel.show();
        const coverage = () => card('Equipped aura coverage').textContent;
        expect(coverage()).toContain('Lv78 — Alice');
        expect(coverage()).toContain('Unknown');
        expect(coverage()).not.toContain('MISSING');

        guildTrialAbilities.recordCapture(snapshot('Bob', 2, [{ hrid: '/abilities/sweep', level: 50 }]));
        guildTrialAbilitiesPanel.render();
        expect(coverage()).toContain('MISSING');
        expect(coverage()).not.toContain('Unknown');
        expect(text()).toContain('2/2 captured');
        expect(text()).not.toContain(FAILED);
    });

    test('a duplicated aura names its redundant copies without double-counting', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice', 'Bob']);
        guildTrialAbilities.recordCapture(snapshot('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 78 }]));
        guildTrialAbilities.recordCapture(snapshot('Bob', 2, [{ hrid: '/abilities/fierce_aura', level: 40 }]));

        guildTrialAbilitiesPanel.show();
        const coverage = card('Equipped aura coverage').textContent;
        expect(coverage).toContain('Lv78 — Alice');
        expect(coverage).toContain('1 redundant copy');
        expect(text()).not.toContain(FAILED);
    });

    test('a stat-only capture draws as unavailable, not as an empty kit', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice']);
        guildTrialAbilities.recordCapture(snapshot('Alice', 1, [], { abilitiesAuthoritative: false, source: 'popup' }));

        guildTrialAbilitiesPanel.show();
        expect(text()).toContain('abilities unavailable');
        expect(text()).not.toContain('no abilities equipped');
        expect(text()).toContain('0/1 captured');
        expect(text()).not.toContain(FAILED);
    });

    test('an authoritative empty kit draws as captured with none equipped', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice']);
        guildTrialAbilities.recordCapture(snapshot('Alice', 1, []));

        guildTrialAbilitiesPanel.show();
        expect(text()).toContain('no abilities equipped');
        expect(text()).toContain('1/1 captured');
        expect(text()).not.toContain(FAILED);
    });

    test('outstanding players sort first while collecting, alphabetical when complete', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Ann', 'Zed']);
        guildTrialAbilities.recordCapture(snapshot('Ann', 1, []));

        guildTrialAbilitiesPanel.show();
        let players = card('Players (').textContent;
        expect(players.indexOf('Zed')).toBeLessThan(players.indexOf('Ann'));

        guildTrialAbilities.recordCapture(snapshot('Zed', 2, []));
        guildTrialAbilitiesPanel.render();
        players = card('Players (').textContent;
        expect(players.indexOf('Ann')).toBeLessThan(players.indexOf('Zed'));
        expect(text()).not.toContain(FAILED);
    });

    /** A unit box as the game draws one, recording clicks into `log` */
    function unitBox(kind, name, log) {
        const box = document.createElement('div');
        box.className = kind === 'combat' ? 'CombatUnit_combatUnit__1m3XT' : 'MiniUnit_miniUnit__379cK';
        const nameEl = document.createElement('div');
        nameEl.className = kind === 'combat' ? 'CombatUnit_name__1SlO1' : 'MiniUnit_name__3Rczb';
        nameEl.textContent = name;
        box.appendChild(nameEl);
        box.addEventListener('click', () => log.push(name));
        return box;
    }

    /**
     * A spectated trial fight, structured as the real DOM draws it: the
     * watcher's own full card plus mini units in the players area, and a
     * "Trial …" boss in the monsters grid anchoring the whole thing.
     * @returns {{clicks: string[]}} The clicks the units received
     */
    function fightView(miniNames, { boss = 'Trial Chameleon', self = null } = {}) {
        const clicks = [];
        const panel = document.createElement('div');
        panel.className = 'BattlePanel_battlePanel__1yPCP';

        const players = document.createElement('div');
        if (self) players.appendChild(unitBox('combat', self, clicks));
        for (const name of miniNames) players.appendChild(unitBox('mini', name, clicks));

        const monsters = document.createElement('div');
        monsters.className = 'BattlePanel_combatUnitGrid__2hTAM';
        if (boss) monsters.appendChild(unitBox('combat', boss, clicks));

        panel.append(players, monsters);
        document.body.appendChild(panel);
        return { clicks };
    }

    // Runs before anything calls setControls: the defaults are under test
    test('the default controls click outstanding fighters even when the roster store holds fresh sheets', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Me', 'Ada']);
        // The roster feature would call both of these "fresh" — a new_battle
        // kit and a stat-only popup sighting, seconds old — and its cycler
        // would therefore never click either. The trial session accepts
        // neither source, so the trial's own cycler must still click them,
        // the watcher's own full card included.
        capture.players.me = snapshot('Me', 1, [], { source: 'new_battle' });
        capture.players.ada = snapshot('Ada', 2, [], { abilitiesAuthoritative: false, source: 'popup' });
        const { clicks } = fightView(['Ada'], { self: 'Me' });

        guildTrialAbilitiesPanel.show();
        button('Open next Battle Info').click();
        button('Open next Battle Info').click();
        expect(clicks).toEqual(['Me', 'Ada']);
        expect(text()).not.toContain(FAILED);
    });

    test('a captured player is skipped; an unanswered request is retried after its window, never skipped', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Ann', 'Bob']);
        guildTrialAbilities.recordCapture(snapshot('Ann', 1, []));
        const { clicks } = fightView(['Ann', 'Bob']);

        expect(openNextTrialUnit(NOW)).toMatchObject({ opened: 'Bob', how: 'unit' });
        // Asked a moment ago: in flight, so neither re-clicked nor skipped
        expect(openNextTrialUnit(NOW + 1000)).toMatchObject({ opened: null, how: 'awaiting' });
        // The window lapsed with no sheet: the same player is offered again
        expect(openNextTrialUnit(NOW + REQUEST_TIMEOUT_MS)).toMatchObject({ opened: 'Bob', how: 'unit' });
        expect(clicks).toEqual(['Bob', 'Bob']);
    });

    test('retry re-asks at once, and a landed sheet both captures and clears the in-flight window', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Bob', 'Cara']);
        const { clicks } = fightView(['Bob', 'Cara']);

        expect(openNextTrialUnit(NOW)).toMatchObject({ opened: 'Bob', how: 'unit' });
        // The retry button's gesture: the request window is ignored
        expect(retryTrialUnit('Bob', NOW + 1000)).toMatchObject({ opened: 'Bob', how: 'unit' });

        guildTrialAbilitiesPanel.show();
        land(snapshot('Bob', 1, []));
        // Bob answered: captured, out of the cycle; the next click moves on
        expect(text()).toContain('1/2 captured');
        expect(openNextTrialUnit(NOW + 2000)).toMatchObject({ opened: 'Cara', how: 'unit' });
        expect(clicks).toEqual(['Bob', 'Bob', 'Cara']);
    });

    test('with no fight on screen the cycler answers no-unit and clicks nothing', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Ann']);
        expect(openNextTrialUnit(NOW)).toEqual({ opened: null, how: 'no-unit' });
        expect(retryTrialUnit('Ann', NOW)).toEqual({ opened: null, how: 'no-unit' });
    });

    test('the controls invoke their callbacks, and retry names the outstanding player', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice', 'Bob']);
        guildTrialAbilities.recordCapture(snapshot('Bob', 2, []));

        const openNext = vi.fn();
        const retryCurrent = vi.fn();
        setControls({ openNext, retryCurrent });

        guildTrialAbilitiesPanel.show();
        button('Open next Battle Info').click();
        expect(openNext).toHaveBeenCalledTimes(1);

        button('Retry current player').click();
        expect(retryCurrent).toHaveBeenCalledWith('Alice');
        expect(text()).not.toContain(FAILED);
    });

    test('recapture throws the session away from the panel', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice']);
        guildTrialAbilities.recordCapture(snapshot('Alice', 1, []));

        guildTrialAbilitiesPanel.show();
        expect(text()).toContain('1/1 captured');
        button('Recapture trial roster').click();
        expect(text()).toContain('0/1 captured');
        expect(text()).toContain('needs Battle Info');
        expect(text()).not.toContain(FAILED);
    });

    test('a landed sheet re-renders the panel through onCaptured', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice']);

        guildTrialAbilitiesPanel.show();
        expect(text()).toContain('0/1 captured');

        land(snapshot('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 70 }]));
        expect(text()).toContain('1/1 captured');
        expect(card('Equipped aura coverage').textContent).toContain('Lv70 — Alice');
        expect(text()).not.toContain(FAILED);
    });

    test('cleanup unsubscribes from the capture events', async () => {
        await feature.initialize('Cats');
        expect(capture.listeners).toHaveLength(1);
        feature.cleanup();
        expect(capture.listeners).toHaveLength(0);
    });
});
