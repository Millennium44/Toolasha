/**
 * The registry the command palette reads.
 *
 * Three things are worth pinning, and they are the three the hand-written array
 * this replaced got wrong: that a feature which never initialises is never
 * offered, that one switched off mid-session takes its entry with it, and that
 * the order the palette draws does not depend on which bundle happened to load
 * first.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import { registerCommand, unregisterCommand, registeredCommands, resetCommands } from './command-registry.js';

const names = () => registeredCommands().map((command) => command.name);

beforeEach(() => {
    resetCommands();
});

describe('registerCommand', () => {
    test('a registered command is offered, with its hint and its run', () => {
        const run = vi.fn();
        expect(registerCommand({ name: 'Trade Ledger', hint: 'What your trades earned', run })).toBe(true);

        const [command] = registeredCommands();
        expect(command.name).toBe('Trade Ledger');
        expect(command.hint).toBe('What your trades earned');

        command.run();
        expect(run).toHaveBeenCalled();
    });

    test('a feature that never registers is never offered', () => {
        registerCommand({ name: 'Trade Ledger', hint: '', run: () => {} });
        expect(names()).not.toContain('Dungeon Tracker');
    });

    test('re-registering the same name replaces rather than duplicates', () => {
        const first = vi.fn();
        const second = vi.fn();
        registerCommand({ name: 'Overlay', hint: 'old', run: first });
        registerCommand({ name: 'Overlay', hint: 'new', run: second });

        const found = registeredCommands().filter((command) => command.name === 'Overlay');
        expect(found).toHaveLength(1);
        expect(found[0].hint).toBe('new');
        found[0].run();
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalled();
    });

    test('a command without a name or without a run is refused', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(registerCommand({ name: '', run: () => {} })).toBe(false);
        expect(registerCommand({ name: 'Broken' })).toBe(false);
        expect(registeredCommands()).toEqual([]);
        error.mockRestore();
    });
});

describe('unregisterCommand', () => {
    test('a feature that disables takes its command with it', () => {
        registerCommand({ name: 'Risk of Ruin', hint: '', run: () => {} });
        registerCommand({ name: 'Queue Monitor', hint: '', run: () => {} });

        expect(unregisterCommand('Risk of Ruin')).toBe(true);
        expect(names()).toEqual(['Queue Monitor']);
    });

    test('withdrawing something that was never there is not an error', () => {
        expect(unregisterCommand('Never Registered')).toBe(false);
    });

    test('register, withdraw and register again is the lifecycle of a re-initialised feature', () => {
        registerCommand({ name: 'Lab Simulator', hint: '', run: () => {} });
        unregisterCommand('Lab Simulator');
        registerCommand({ name: 'Lab Simulator', hint: '', run: () => {} });
        expect(names()).toEqual(['Lab Simulator']);
    });
});

describe('registeredCommands', () => {
    test('the order is by name, not by who registered first', () => {
        // Registration order is an accident of bundle load order and of which
        // features are switched on; a palette that reshuffles between sessions
        // is one nobody can learn
        for (const name of ['Trade Ledger', 'Ability Book', 'Overlay', 'Consumables']) {
            registerCommand({ name, hint: '', run: () => {} });
        }
        expect(names()).toEqual(['Ability Book', 'Consumables', 'Overlay', 'Trade Ledger']);
    });

    test('a `when` that says no leaves the command out', () => {
        registerCommand({ name: 'Sync push', hint: '', run: () => {}, when: () => false });
        registerCommand({ name: 'Overlay', hint: '', run: () => {} });
        expect(names()).toEqual(['Overlay']);
    });

    test('`when` is asked again on every read, so a setting can change under it', () => {
        let configured = false;
        registerCommand({ name: 'Sync push', hint: '', run: () => {}, when: () => configured });

        expect(names()).toEqual([]);
        configured = true;
        expect(names()).toEqual(['Sync push']);
    });

    test('a `when` that throws leaves the command offered rather than hidden', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        registerCommand({
            name: 'Health report',
            hint: '',
            run: () => {},
            when: () => {
                throw new Error('the feature is broken');
            },
        });

        // A diagnostic is most wanted when something is wrong, which is exactly
        // when its own gate is the thing that failed
        expect(names()).toEqual(['Health report']);
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });

    test('the list handed out is a copy, so a caller cannot edit the registry', () => {
        registerCommand({ name: 'Overlay', hint: '', run: () => {} });
        registeredCommands().push({ name: 'Injected', hint: '', run: () => {} });
        expect(names()).toEqual(['Overlay']);
    });
});

describe('kind', () => {
    test('a command that says nothing is a panel, which is what every old registrant meant', () => {
        registerCommand({ name: 'Overlay', hint: '', run: () => {} });
        expect(registeredCommands()[0].kind).toBe('panel');
    });

    test('a verb says so, and the palette can see it', () => {
        registerCommand({ name: 'Recompute lab sims', hint: '', kind: 'verb', run: () => 'nothing stale' });
        expect(registeredCommands()[0].kind).toBe('verb');
    });

    test('an unrecognised kind falls back to panel rather than being trusted', () => {
        // A typo must not quietly opt a command into being awaited and toasted
        registerCommand({ name: 'Overlay', hint: '', kind: 'action', run: () => {} });
        expect(registeredCommands()[0].kind).toBe('panel');
    });

    test('re-registering can change a command from a panel into a verb', () => {
        registerCommand({ name: 'Snapshot briefing now', hint: '', run: () => {} });
        registerCommand({ name: 'Snapshot briefing now', hint: '', kind: 'verb', run: () => 'snapshot written' });

        const found = registeredCommands();
        expect(found).toHaveLength(1);
        expect(found[0].kind).toBe('verb');
    });

    test('a verb with nothing to do is a result string, not a `when` that hides it', () => {
        // The design note: a verb that vanishes while idle is unlearnable, and
        // its absence is indistinguishable from the feature being switched off
        registerCommand({ name: 'Recompute lab sims', hint: '', kind: 'verb', run: () => 'nothing stale' });
        expect(names()).toContain('Recompute lab sims');
        expect(registeredCommands()[0].run()).toBe('nothing stale');
    });
});
