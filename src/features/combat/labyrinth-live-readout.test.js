/**
 * Tests for the live attempt-bar readout: identifying the room from the action
 * bar, and refusing to quote a figure the fight has not earned.
 *
 * The bug behind these: before the labyrinth tab had ever been opened, nothing
 * knew which room the fight was in, so the sim-backed estimate never ran and
 * the display fell back to extrapolating off two health bars — which moves
 * twenty points between blows and read as the percentage swinging wildly.
 */

import { describe, test, expect } from 'vitest';

import {
    BAND_WIDTH_PCT,
    parseLabyrinthActionName,
    monsterHridByName,
    bandFor,
    liveClearDisplay,
} from './labyrinth-live-readout.js';

describe('reading the room off the action bar', () => {
    test('pulls the monster and level out of the header the game writes', () => {
        expect(parseLabyrinthActionName('Labyrinth - Mimic Lv.245')).toEqual({ name: 'Mimic', level: 245 });
    });

    test('ignores anything this script appended after it', () => {
        expect(parseLabyrinthActionName('Labyrinth - Mimic Lv.245 · Attempt #9')).toEqual({
            name: 'Mimic',
            level: 245,
        });
        expect(parseLabyrinthActionName('Labyrinth - Mimic Lv.245 [Clear 25–50%? | 97s left]')).toMatchObject({
            name: 'Mimic',
            level: 245,
        });
    });

    test('handles a multi-word monster name', () => {
        expect(parseLabyrinthActionName('Labyrinth - Elementalist Lv.180')).toEqual({
            name: 'Elementalist',
            level: 180,
        });
    });

    test('is not fooled by a row that is not a labyrinth fight', () => {
        expect(parseLabyrinthActionName('Combat - Fly Lv.10')).toBeNull();
        expect(parseLabyrinthActionName('')).toBeNull();
    });

    test('a labyrinth row with no level is no answer at all, not a level of zero', () => {
        expect(parseLabyrinthActionName('Labyrinth - Skilling Room')).toBeNull();
    });
});

describe('matching a display name to a monster', () => {
    const map = {
        '/monsters/mimic': { name: 'Mimic' },
        '/monsters/ent_ancient': { name: 'Ent Ancient' },
    };

    test('finds the hrid behind the name on screen', () => {
        expect(monsterHridByName('Mimic', map)).toBe('/monsters/mimic');
    });

    test('spacing and case are the header being written for people', () => {
        expect(monsterHridByName('ent ancient', map)).toBe('/monsters/ent_ancient');
    });

    test('an unknown name is null rather than a wrong guess', () => {
        expect(monsterHridByName('Nothing', map)).toBeNull();
        expect(monsterHridByName('Mimic', null)).toBeNull();
    });
});

describe('bands hold still', () => {
    test('a chance falls in its band', () => {
        expect(bandFor(0.3)).toEqual({ lo: 25, hi: 50 });
        expect(bandFor(0.02)).toEqual({ lo: 0, hi: BAND_WIDTH_PCT });
    });

    test('the top band does not run off the end', () => {
        expect(bandFor(1)).toEqual({ lo: 75, hi: 100 });
    });

    test('a chance hovering on an edge keeps the band it is already in', () => {
        const held = bandFor(0.48);
        expect(held).toEqual({ lo: 25, hi: 50 });
        // Nudging just past 50 would change band on its own, but not while
        // sitting in one — this is the flicker the margin exists to stop
        expect(bandFor(0.52, held)).toBe(held);
        expect(bandFor(0.52)).toEqual({ lo: 50, hi: 75 });
    });

    test('a real move does change band', () => {
        const held = bandFor(0.3);
        expect(bandFor(0.8, held)).toEqual({ lo: 75, hi: 100 });
    });
});

describe('what the attempt bar shows', () => {
    const provisional = (clearChance) => ({ clearChance, confident: false });
    const measured = (clearChance) => ({ clearChance, confident: true });

    test('a replay of this fight is quoted as a figure', () => {
        const out = liveClearDisplay({ estimate: measured(0.2), replay: { clearChance: 0.63 } });
        expect(out).toMatchObject({ text: 'Clear 63%', source: 'replay' });
    });

    test('an earned extrapolation is quoted as a figure', () => {
        expect(liveClearDisplay({ estimate: measured(0.62) })).toMatchObject({
            text: 'Clear ~60%',
            source: 'measured',
        });
    });

    test('an unearned one is quoted as a band, marked provisional', () => {
        expect(liveClearDisplay({ estimate: provisional(0.3) })).toMatchObject({
            text: 'Clear 25–50%?',
            source: 'provisional',
        });
    });

    test('the reported swing settles to one band', () => {
        // The actual readings the extrapolation produced for the reported
        // fight, second by second, before any of this existed
        let band = null;
        let smoothed = null;
        const seen = new Set();
        for (const chance of [0.51, 0.83, 0.52, 0.67, 0.52]) {
            const out = liveClearDisplay({
                estimate: provisional(chance),
                previousBand: band,
                previousSmoothed: smoothed,
            });
            band = out.band;
            smoothed = out.smoothed;
            seen.add(out.text);
        }
        expect([...seen]).toEqual(['Clear 50–75%?']);
    });

    test('a genuine move still moves the band — this damps noise, not news', () => {
        let band = null;
        let smoothed = null;
        let out;
        for (const chance of [0.2, 0.2, 0.2, 0.2]) {
            out = liveClearDisplay({ estimate: provisional(chance), previousBand: band, previousSmoothed: smoothed });
            band = out.band;
            smoothed = out.smoothed;
        }
        expect(out.text).toBe('Clear 0–25%?');

        for (const chance of [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9]) {
            out = liveClearDisplay({ estimate: provisional(chance), previousBand: band, previousSmoothed: smoothed });
            band = out.band;
            smoothed = out.smoothed;
        }
        expect(out.text).toBe('Clear 75–100%?');
    });

    test('smoothing is only ever applied to the provisional branch', () => {
        expect(liveClearDisplay({ estimate: measured(0.62), previousSmoothed: 0.1 }).smoothed).toBeNull();
        expect(liveClearDisplay({ estimate: measured(0.62), replay: { clearChance: 0.9 } }).smoothed).toBeNull();
    });

    test('nothing worth saying yet says nothing', () => {
        expect(liveClearDisplay({ estimate: { clearChance: null, confident: false } })).toMatchObject({
            text: '',
            source: 'none',
        });
        expect(liveClearDisplay({ estimate: null })).toMatchObject({ text: '', source: 'none' });
    });
});
