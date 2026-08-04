/**
 * Telling the two servers apart.
 *
 * The only thing this decides is whether something may be sent outward, so the
 * two ways to be wrong are not symmetric: calling live "test" silently stops a
 * real session contributing, and calling test "live" puts a wrong price into
 * somebody else's dataset where nothing marks it as wrong. Both are pinned.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { isTestServer } from './game-server.js';

const hadLocation = 'location' in globalThis;
const originalLocation = globalThis.location;

afterEach(() => {
    if (hadLocation) globalThis.location = originalLocation;
    else delete globalThis.location;
});

describe('isTestServer', () => {
    test('the test server is the test server', () => {
        expect(isTestServer('test.milkywayidle.com')).toBe(true);
        // The socket host too, for anything holding the URL rather than the page
        expect(isTestServer('api-test.milkywayidle.com')).toBe(true);
    });

    test('the live server is not', () => {
        expect(isTestServer('www.milkywayidle.com')).toBe(false);
        expect(isTestServer('milkywayidle.com')).toBe(false);
        expect(isTestServer('api.milkywayidle.com')).toBe(false);
    });

    test('case does not decide it', () => {
        expect(isTestServer('TEST.MilkyWayIdle.com')).toBe(true);
    });

    test('a hostname that merely contains "test" is not the test server', () => {
        // Substring matching would silence a real session on a mirror or a
        // proxy, and a session that quietly stops contributing looks exactly
        // like one that never could
        expect(isTestServer('latest.milkywayidle.com')).toBe(false);
        expect(isTestServer('milkywayidle.com.test.example.org')).toBe(false);
    });

    test('an unknown or missing host is treated as live', () => {
        expect(isTestServer('')).toBe(false);
        expect(isTestServer(null)).toBe(false);
        expect(isTestServer('example.com')).toBe(false);
    });

    test('with no argument it reads the page it is on', () => {
        globalThis.location = { hostname: 'test.milkywayidle.com' };
        expect(isTestServer()).toBe(true);

        globalThis.location = { hostname: 'www.milkywayidle.com' };
        expect(isTestServer()).toBe(false);
    });
});
