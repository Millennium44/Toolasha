/**
 * The room → skill map both house panels draw their icons from.
 *
 * Worth its own test now that it is one map rather than two: the failure it
 * guards against is a room silently losing its icon, which nothing else in the
 * project would notice.
 */

import { describe, test, expect } from 'vitest';
import { ROOM_SKILLS, roomSkill } from './room-skills.js';

describe('roomSkill', () => {
    test('names the skill a room boosts', () => {
        expect(roomSkill('/house_rooms/dairy_barn')).toBe('milking');
        expect(roomSkill('/house_rooms/mystical_study')).toBe('magic');
        expect(roomSkill('/house_rooms/dojo')).toBe('attack');
    });

    test('a room it has never heard of falls back to its own name', () => {
        // Which finds no sprite and draws a spacer — a missing icon rather than
        // a wrong one
        expect(roomSkill('/house_rooms/newly_added')).toBe('newly_added');
    });

    test('nothing is not a room', () => {
        expect(roomSkill(null)).toBe('');
        expect(roomSkill(undefined)).toBe('');
    });

    test('covers every room the game currently has', () => {
        // A count rather than a list: the point is to notice a deletion, and
        // the additions are what the fallback above is for
        expect(Object.keys(ROOM_SKILLS)).toHaveLength(17);
    });
});
