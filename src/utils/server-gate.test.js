import { describe, test, expect, afterEach, vi } from 'vitest';
import { isTestServer } from './server-gate.js';
import { isTestServer as gameServerIsTestServer } from './game-server.js';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('server-gate isTestServer', () => {
    test('is the same helper game-server.js decides data-sharing with', () => {
        expect(isTestServer).toBe(gameServerIsTestServer);
    });

    test('true on the test server, false on the live server', () => {
        vi.stubGlobal('location', { hostname: 'test.milkywayidle.com' });
        expect(isTestServer()).toBe(true);

        vi.stubGlobal('location', { hostname: 'www.milkywayidle.com' });
        expect(isTestServer()).toBe(false);
    });

    test('false with no location at all (e.g. a worker blob), never throws', () => {
        vi.stubGlobal('location', undefined);
        expect(() => isTestServer()).not.toThrow();
        expect(isTestServer()).toBe(false);
    });
});
