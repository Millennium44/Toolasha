import { describe, test, expect } from 'vitest';
import { csvField, buildTaskStatisticsCsv } from './task-statistics-export.js';

describe('csvField', () => {
    test('a plain value passes through unquoted', () => {
        expect(csvField('Egg')).toBe('Egg');
        expect(csvField(100)).toBe('100');
    });

    test('null and undefined become an empty field', () => {
        expect(csvField(null)).toBe('');
        expect(csvField(undefined)).toBe('');
    });

    test('a comma forces quoting', () => {
        expect(csvField('Skill - Action, Deluxe')).toBe('"Skill - Action, Deluxe"');
    });

    test('an embedded quote is doubled and the field quoted', () => {
        expect(csvField('12" Pizza')).toBe('"12"" Pizza"');
    });
});

describe('buildTaskStatisticsCsv', () => {
    const rewards = {
        totalCoins: 5000,
        totalTokens: 6,
        totalActionProfit: 12345,
        totalCompletionSeconds: 7200,
        taskDetails: [
            {
                name: 'Foraging - Egg',
                isCombat: false,
                coinReward: 1000,
                tokenReward: 2,
                actionProfit: 5000,
                completionSeconds: 3600,
                goalCount: 100,
                currentCount: 50,
            },
            {
                name: 'Cow',
                isCombat: true,
                coinReward: 4000,
                tokenReward: 4,
                actionProfit: null,
                completionSeconds: null,
                goalCount: 10,
                currentCount: 0,
            },
        ],
    };

    test('one row per task plus a header and a total, in order', () => {
        const lines = buildTaskStatisticsCsv(rewards).split('\n');

        expect(lines).toHaveLength(4);
        expect(lines[0]).toBe('Task,Type,Coins,Tokens,Action Profit,Completion (s),Progress');
        expect(lines[1]).toBe('Foraging - Egg,Action,1000,2,5000,3600,50/100');
        expect(lines[3]).toBe('Total,,5000,6,12345,7200,');
    });

    test('a combat task carries no action profit or completion time', () => {
        const lines = buildTaskStatisticsCsv(rewards).split('\n');
        expect(lines[2]).toBe('Cow,Combat,4000,4,,,0/10');
    });

    test('no tasks is still a header and a total row', () => {
        const lines = buildTaskStatisticsCsv({ taskDetails: [] }).split('\n');
        expect(lines).toHaveLength(2);
        expect(lines[1]).toBe('Total,,,,,,');
    });

    test('a task name with a comma is quoted, not split across columns', () => {
        const withComma = {
            taskDetails: [
                {
                    name: 'Foraging - Egg, Deluxe',
                    isCombat: false,
                    coinReward: 0,
                    tokenReward: 0,
                    actionProfit: 0,
                    completionSeconds: 0,
                    goalCount: 1,
                    currentCount: 0,
                },
            ],
        };
        const lines = buildTaskStatisticsCsv(withComma).split('\n');
        expect(lines[1]).toBe('"Foraging - Egg, Deluxe",Action,0,0,0,0,0/1');
    });
});
