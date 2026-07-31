import { describe, test, expect, vi } from 'vitest';
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
