import { describe, test, expect } from 'vitest';
import config from '../../core/config.js';
import { readValuationSignature, diffSignatures } from './networth-markers.js';

describe('defaults', () => {
    test('an untouched switch reads its schema default, as the calculation reads it, so a first explicit set to the default is no change', () => {
        const untouched = readValuationSignature();
        // The task token switch defaults on; getSettingValue would answer null for it
        expect(config.getSettingValue('networth_includeTaskTokens')).toBe(null);
        expect(untouched.networth_includeTaskTokens).toBe(true);
        expect(untouched.networth_includeLabyrinthTokens).toBe(false);

        const explicit = { ...untouched, networth_includeTaskTokens: true };
        expect(diffSignatures(untouched, explicit)).toEqual([]);
    });
});
