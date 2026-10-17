import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
    getCatalystWhatIf,
    setCatalystWhatIf,
    getCatalystWhatIfResult,
    publishCatalystWhatIfResult,
    onCatalystWhatIfChange,
    resetCatalystWhatIf,
} from './alchemy-catalyst-whatif.js';

const RESULT = {
    itemHrid: '/items/egg',
    actionType: 'decompose',
    catalystHrid: '/items/prime_catalyst',
    successRate: 0.8,
};

beforeEach(() => resetCatalystWhatIf());

describe('the catalyst what-if state', () => {
    test('starts on the equipped catalyst with nothing published', () => {
        expect(getCatalystWhatIf()).toBeNull();
        expect(getCatalystWhatIfResult()).toBeNull();
    });

    test('a choice is kept, and anything unknown means the equipped catalyst', () => {
        setCatalystWhatIf('prime');
        expect(getCatalystWhatIf()).toBe('prime');
        setCatalystWhatIf('platinum');
        expect(getCatalystWhatIf()).toBeNull();
    });

    test('a new choice drops the result computed for the old one', () => {
        setCatalystWhatIf('prime');
        publishCatalystWhatIfResult(RESULT);
        expect(getCatalystWhatIfResult()).toEqual(RESULT);

        setCatalystWhatIf('none');
        expect(getCatalystWhatIfResult()).toBeNull();
    });

    test('no result is read while on the equipped catalyst', () => {
        publishCatalystWhatIfResult(RESULT);
        expect(getCatalystWhatIfResult()).toBeNull();
    });

    test('listeners hear which kind of change it was, once per real change', () => {
        const heard = [];
        const off = onCatalystWhatIfChange((kind) => heard.push(kind));
        setCatalystWhatIf('prime');
        setCatalystWhatIf('prime');
        publishCatalystWhatIfResult(RESULT);
        publishCatalystWhatIfResult({ ...RESULT });
        publishCatalystWhatIfResult(null);
        expect(heard).toEqual(['choice', 'result', 'result']);
        off();
        setCatalystWhatIf('none');
        expect(heard).toHaveLength(3);
    });

    test('a throwing listener does not stop the rest', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const second = vi.fn();
        const offA = onCatalystWhatIfChange(() => {
            throw new Error('boom');
        });
        const offB = onCatalystWhatIfChange(second);
        setCatalystWhatIf('prime');
        expect(second).toHaveBeenCalledWith('choice');
        offA();
        offB();
        spy.mockRestore();
    });

    test('reset goes back to the equipped catalyst and keeps subscribers', () => {
        const heard = vi.fn();
        const off = onCatalystWhatIfChange(heard);
        setCatalystWhatIf('prime');
        resetCatalystWhatIf();
        expect(getCatalystWhatIf()).toBeNull();
        setCatalystWhatIf('none');
        expect(heard).toHaveBeenCalledTimes(3);
        off();
    });
});
