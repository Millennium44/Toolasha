import { describe, test, expect, vi } from 'vitest';
import { holdKey, collectHeldKeys } from './bulk-sell-holds.js';

describe('holdKey', () => {
    test('an enhanced item is a different thing from its plain form', () => {
        expect(holdKey('/items/cheese_sword')).toBe('/items/cheese_sword');
        expect(holdKey('/items/cheese_sword', 0)).toBe('/items/cheese_sword');
        expect(holdKey('/items/cheese_sword', 3)).toBe('/items/cheese_sword+3');
    });

    test('reads a level however it arrives', () => {
        expect(holdKey('/items/cheese', '2')).toBe('/items/cheese+2');
        expect(holdKey('/items/cheese', null)).toBe('/items/cheese');
        expect(holdKey('/items/cheese', -1)).toBe('/items/cheese');
    });
});

describe('collectHeldKeys', () => {
    test('merges every provider and drops repeats', () => {
        const providers = new Map([
            ['reselling', () => ['/items/cheese', '/items/milk']],
            ['crafting', () => ['/items/milk', '/items/egg']],
        ]);
        expect([...collectHeldKeys(providers)].sort()).toEqual(['/items/cheese', '/items/egg', '/items/milk']);
    });

    test('a broken provider costs its own claim and nothing else', () => {
        // Holding nothing back is bad; being unable to sell at all is worse
        const onError = vi.fn();
        const providers = new Map([
            [
                'broken',
                () => {
                    throw new Error('nope');
                },
            ],
            ['fine', () => ['/items/cheese']],
        ]);

        expect([...collectHeldKeys(providers, onError)]).toEqual(['/items/cheese']);
        expect(onError).toHaveBeenCalledWith('broken', expect.any(Error));
    });

    test('ignores anything that is not a usable key', () => {
        const providers = new Map([['odd', () => ['/items/cheese', '', null, 42, undefined]]]);
        expect([...collectHeldKeys(providers)]).toEqual(['/items/cheese']);
    });

    test('a provider returning nothing is not an error', () => {
        const providers = new Map([
            ['empty', () => []],
            ['nullish', () => null],
        ]);
        expect(collectHeldKeys(providers).size).toBe(0);
    });

    test('no providers means nothing is held', () => {
        expect(collectHeldKeys(new Map()).size).toBe(0);
    });
});
