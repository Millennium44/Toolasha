import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => false, COLOR_TEXT_PRIMARY: '#fff' } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/data-manager.js', () => ({ default: {} }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: () => 1 }));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerTimeout: () => {}, clearAll: () => {} }),
}));

const { formatOrdinal, describeLuck } = await import('./combat-drop-luck.js');

describe('formatOrdinal', () => {
    test('gets the ordinary suffixes right', () => {
        expect(formatOrdinal(0.21)).toBe('21st');
        expect(formatOrdinal(0.22)).toBe('22nd');
        expect(formatOrdinal(0.23)).toBe('23rd');
        expect(formatOrdinal(0.24)).toBe('24th');
    });

    test('gets the teens right', () => {
        // 11th, not 11st — the one case a bare last-digit rule gets wrong
        expect(formatOrdinal(0.11)).toBe('11th');
        expect(formatOrdinal(0.12)).toBe('12th');
        expect(formatOrdinal(0.13)).toBe('13th');
    });

    test('never reads as a certainty in either direction', () => {
        // "100th percentile" claims no session could have done better, and
        // "0th" claims none could have done worse. Neither is ever true.
        expect(formatOrdinal(1)).toBe('99th');
        expect(formatOrdinal(0)).toBe('1st');
        expect(formatOrdinal(0.999)).toBe('99th');
    });
});

describe('describeLuck', () => {
    test('says how many runs beat it, not the percentile twice', () => {
        expect(describeLuck(0.73).text).toBe('73rd percentile — 27 runs in 100 beat it');
    });

    test('sorts sessions into lucky, unlucky and unremarkable', () => {
        expect(describeLuck(0.9).tone).toBe('lucky');
        expect(describeLuck(0.05).tone).toBe('unlucky');
        expect(describeLuck(0.5).tone).toBe('normal');
    });

    test('the boundaries count as notable rather than normal', () => {
        expect(describeLuck(0.75).tone).toBe('lucky');
        expect(describeLuck(0.25).tone).toBe('unlucky');
    });
});
