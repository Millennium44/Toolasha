import { describe, test, expect } from 'vitest';

import {
    LEGACY_SYNC_DESCRIPTION,
    descriptionServer,
    isServerMarkerFile,
    markerServer,
    parseGistId,
    serverMarkerFile,
    serverKind,
    syncGistDescription,
} from './sync-server.js';

const ID = '0123456789abcdef0123456789abcdef';

describe('serverKind', () => {
    test('the test host is the test server, and everything else is live', () => {
        expect(serverKind('test.milkywayidle.com')).toBe('test');
        expect(serverKind('www.milkywayidle.com')).toBe('live');
        expect(serverKind('')).toBe('live');
    });
});

describe('gist descriptions', () => {
    test('a tagged description reads back as its server, and keeps the old prefix', () => {
        for (const server of ['live', 'test']) {
            const description = syncGistDescription(server);
            expect(description.startsWith('Toolasha cross-device sync')).toBe(true);
            expect(descriptionServer(description)).toBe(server);
        }
        expect(syncGistDescription('test')).toBe('Toolasha cross-device sync — test server (do not edit by hand)');
        expect(syncGistDescription('live')).toBe('Toolasha cross-device sync — live (do not edit by hand)');
    });

    test('the legacy description, a hand-edited one and none are untagged', () => {
        expect(descriptionServer(LEGACY_SYNC_DESCRIPTION)).toBeNull();
        expect(descriptionServer('Toolasha cross-device sync — livestock')).toBeNull();
        expect(descriptionServer('my sync gist')).toBeNull();
        expect(descriptionServer(null)).toBeNull();
        expect(syncGistDescription(null)).toBe(LEGACY_SYNC_DESCRIPTION);
    });
});

describe('parseGistId', () => {
    test.each([
        [ID, ID],
        [`  ${ID.toUpperCase()}  `, ID],
        [`https://gist.github.com/someone/${ID}`, ID],
        [`https://gist.github.com/someone/${ID}#file-toolasha-sync-json`, ID],
        [`https://gist.github.com/${ID}`, ID],
        [`https://api.github.com/gists/${ID}`, ID],
        [`https://gist.githubusercontent.com/someone/${ID}/raw/${'f'.repeat(40)}/toolasha-sync.json`, ID],
    ])('%s is the id', (input, expected) => {
        expect(parseGistId(input)).toBe(expected);
    });

    test.each([
        ['', 'empty'],
        ['abc123', 'too short'],
        [`${ID}0`, 'too long'],
        [`${ID.slice(0, 31)}g`, 'not hex'],
        [`http://gist.github.com/someone/${ID}`, 'not https'],
        [`https://example.com/${ID}`, 'another host'],
        ['https://gist.github.com/someone', 'a link with no id'],
    ])('%s is refused (%s)', (input) => {
        expect(parseGistId(input)).toBeNull();
    });
});

describe('server marker files', () => {
    test('are named for the server and recognized', () => {
        expect(serverMarkerFile('live')).toBe('toolasha-server-live.txt');
        expect(serverMarkerFile('test')).toBe('toolasha-server-test.txt');
        expect(isServerMarkerFile('toolasha-server-test.txt')).toBe(true);
        expect(isServerMarkerFile('toolasha-sync.json')).toBe(false);
    });

    test('markerServer reads one marker, and nothing from none or both', () => {
        expect(markerServer(['toolasha-sync.json', 'toolasha-server-test.txt'])).toBe('test');
        expect(markerServer(['toolasha-server-live.txt'])).toBe('live');
        expect(markerServer(['toolasha-sync.json'])).toBeNull();
        expect(markerServer(['toolasha-server-live.txt', 'toolasha-server-test.txt'])).toBeNull();
        expect(markerServer(null)).toBeNull();
    });
});
