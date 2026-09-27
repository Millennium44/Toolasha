import { describe, test, expect } from 'vitest';
import { processingConversions } from './gathering-processing.js';

describe('processingConversions', () => {
    test('maps each raw resource to its processed material and the raw count one takes', () => {
        const conversions = processingConversions({
            '/actions/milking/cow': {
                type: '/action_types/milking',
                dropTable: [{ itemHrid: '/items/milk', dropRate: 1, minCount: 1, maxCount: 1 }],
            },
            '/actions/cheesesmithing/cheese': {
                type: '/action_types/cheesesmithing',
                inputItems: [{ itemHrid: '/items/milk', count: 2 }],
                outputItems: [{ itemHrid: '/items/cheese', count: 1 }],
            },
            '/actions/crafting/lumber': {
                type: '/action_types/crafting',
                inputItems: [{ itemHrid: '/items/log', count: 2 }],
                outputItems: [{ itemHrid: '/items/lumber', count: 1 }],
            },
            // Not a processing skill, so not something Processing performs
            '/actions/cooking/donut': {
                type: '/action_types/cooking',
                inputItems: [{ itemHrid: '/items/egg', count: 1 }],
                outputItems: [{ itemHrid: '/items/donut', count: 1 }],
            },
        });

        expect(conversions.get('/items/milk')).toEqual({ outputItemHrid: '/items/cheese', conversionRatio: 2 });
        expect(conversions.get('/items/log')).toEqual({ outputItemHrid: '/items/lumber', conversionRatio: 2 });
        expect(conversions.has('/items/egg')).toBe(false);
    });

    test('no game data is no conversions', () => {
        expect(processingConversions(null).size).toBe(0);
    });
});
