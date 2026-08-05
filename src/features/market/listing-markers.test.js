import { describe, test, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import listingMarkers, { markerProblem, markerStateFor } from './listing-markers.js';

const workingMarker = {
    stateFor: () => ({ glyph: '★', active: true, title: 'Marked' }),
    onToggle: () => {},
};

describe('markerProblem', () => {
    test('a usable marker has nothing wrong with it', () => {
        expect(markerProblem(workingMarker)).toBeNull();
    });

    test('names what is missing rather than failing later', () => {
        // Caught at registration, not once per row of a table
        expect(markerProblem(null)).toMatch(/object/);
        expect(markerProblem({ onToggle: () => {} })).toMatch(/stateFor/);
        expect(markerProblem({ stateFor: () => {} })).toMatch(/onToggle/);
    });
});

describe('markerStateFor', () => {
    test('fills in what a marker leaves out', () => {
        const state = markerStateFor({ stateFor: () => ({ active: true }) }, {});
        expect(state).toMatchObject({ glyph: '★', active: true, title: '', color: null });
    });

    test('a marker may decline a row', () => {
        expect(markerStateFor({ stateFor: () => null }, {})).toBeNull();
    });

    test('a broken marker loses its own cell and nothing else', () => {
        // The table is the trading record; an annotation must not be able to
        // take it down
        const onError = vi.fn();
        const broken = {
            name: 'broken',
            stateFor: () => {
                throw new Error('nope');
            },
        };
        expect(markerStateFor(broken, {}, onError)).toBeNull();
        expect(onError).toHaveBeenCalledWith('broken', expect.any(Error));
    });
});

describe('the registry', () => {
    test('registers, lists and removes', () => {
        const remove = listingMarkers.register('test-a', workingMarker);
        expect(listingMarkers.all().map((m) => m.name)).toContain('test-a');
        remove();
        expect(listingMarkers.all().map((m) => m.name)).not.toContain('test-a');
    });

    test('refuses a marker the table could not use', () => {
        expect(() => listingMarkers.register('bad', { stateFor: () => {} })).toThrow(/onToggle/);
    });

    test('announces changes so an open table can redraw', () => {
        const seen = vi.fn();
        const stop = listingMarkers.onChange(seen);

        const remove = listingMarkers.register('test-b', workingMarker);
        expect(seen).toHaveBeenCalledTimes(1);
        remove();
        expect(seen).toHaveBeenCalledTimes(2);

        stop();
        listingMarkers.register('test-c', workingMarker)();
        expect(seen).toHaveBeenCalledTimes(2);
        listingMarkers.unregister('test-c');
    });

    test('removing something that was never there is not a change', () => {
        const seen = vi.fn();
        const stop = listingMarkers.onChange(seen);
        expect(listingMarkers.unregister('never-registered')).toBe(false);
        expect(seen).not.toHaveBeenCalled();
        stop();
    });
});

describe('surface context', () => {
    test('the marker is told where the row is being drawn', () => {
        // A finished trade and a working order are different things to mark,
        // and without this a marker has to treat them the same
        const seen = [];
        const marker = {
            stateFor: (listing, context) => {
                seen.push(context?.surface);
                return { glyph: '★', active: false, title: '' };
            },
            onToggle: () => {},
        };

        markerStateFor(marker, {}, undefined, { surface: 'history' });
        markerStateFor(marker, {}, undefined, { surface: 'myListings' });
        expect(seen).toEqual(['history', 'myListings']);
    });

    test('a marker written before contexts existed still works', () => {
        const state = markerStateFor({ stateFor: () => ({ glyph: '☆', active: false }) }, {});
        expect(state.glyph).toBe('☆');
    });
});

describe('what this repository does not name', () => {
    /**
     * Markers exist so a script whose meaning is private can draw in a public
     * one. That only works in one direction if the public one stays quiet about
     * it: the registry takes any name a caller likes, so nothing here needs to
     * know which script is calling, and an example or a comment that names one
     * ships that name to everybody who reads the built userscript.
     *
     * The registration key is the caller's own string and is untouched — this is
     * about what Toolasha itself says, not about what may be registered.
     */
    const here = dirname(fileURLToPath(import.meta.url));
    const srcRoot = join(here, '..', '..');

    /** Every .js under src/, so a mention cannot move somewhere unscanned */
    function sources(directory = srcRoot, found = []) {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) sources(path, found);
            else if (entry.name.endsWith('.js') || entry.name.endsWith('.json')) found.push(path);
        }
        return found;
    }

    test('no companion script is named anywhere in src/', () => {
        const naming = /flip[\s_-]?finder/i;
        const offenders = sources().filter((path) => naming.test(readFileSync(path, 'utf8')));
        expect(offenders).toEqual([]);
    });

    test('the example registration uses a neutral name', () => {
        const source = readFileSync(join(here, 'listing-markers.js'), 'utf8');
        expect(source).toContain("register('my-script'");
        expect(source).not.toMatch(/flip/i);
    });

    test('the hold-provider example does too', () => {
        const source = readFileSync(join(here, 'bulk-sell-assistant.js'), 'utf8');
        expect(source).toContain("'my-script'");
        expect(source).not.toMatch(/flip/i);
    });

    test('a marker may still register under any name it likes', () => {
        // The API is what an installed script already calls; renaming it here
        // would break the thing this is trying to stay quiet about
        const remove = listingMarkers.register('anything-at-all', workingMarker);
        expect(listingMarkers.all().map((m) => m.name)).toContain('anything-at-all');
        remove();
    });
});
