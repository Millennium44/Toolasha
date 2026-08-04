/** @vitest-environment happy-dom
 *
 * Which chat announcements get a clickable name.
 *
 * The pattern is a list of verbs, and the list is the feature: an announcement
 * whose verb is missing gets no link and nobody files a bug about a link that
 * is not there. "has joined the guild!" sat outside the list for exactly that
 * reason.
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => false } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../utils/dom.js', () => ({ addStyles: () => {} }));

const { ANNOUNCE_RE } = await import('./chat-profile-link.js');

const nameIn = (message) => message.match(ANNOUNCE_RE)?.[1] ?? null;

describe('announcements that get a link', () => {
    test('a level-up names its player', () => {
        expect(nameIn('PlayerName has reached level 150 Magic!')).toBe('PlayerName');
    });

    test('joining the guild does too', () => {
        expect(nameIn('Mazo has joined the guild!')).toBe('Mazo');
    });

    test('and leaving it, which is the same sentence pointed the other way', () => {
        expect(nameIn('Mazo has left the guild.')).toBe('Mazo');
    });

    test('a channel tag in front does not hide the name', () => {
        expect(nameIn('[General] Someone has completed a task')).toBe('Someone');
    });
});

describe('messages that do not', () => {
    test('ordinary chat is not an announcement', () => {
        // Regular messages already have the game's own clickable sender
        expect(nameIn('anyone selling cheese?')).toBe(null);
    });

    test('nor is "has" mid-sentence doing ordinary work', () => {
        expect(nameIn('the market has been wild today')).toBe(null);
    });
});
