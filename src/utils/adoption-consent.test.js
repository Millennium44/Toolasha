/** @vitest-environment happy-dom */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockDataManager = vi.hoisted(() => ({
    currentCharacterId: 'market123',
    currentName: 'Millennium',
    getCurrentCharacterId: vi.fn(() => mockDataManager.currentCharacterId),
    getCurrentCharacterName: vi.fn(() => mockDataManager.currentName),
}));

const mockStorage = vi.hoisted(() => {
    const store = new Map();
    return {
        store,
        get: vi.fn(async (key, _storeName, defaultValue = null) => (store.has(key) ? store.get(key) : defaultValue)),
        set: vi.fn(async (key, value) => {
            store.set(key, value);
            return true;
        }),
        delete: vi.fn(async (key) => {
            store.delete(key);
            return true;
        }),
    };
});

vi.mock('../core/data-manager.js', () => ({ default: mockDataManager }));
vi.mock('../core/storage.js', () => ({ default: mockStorage }));

import {
    getAdoptionTargetId,
    setAdoptionTargetId,
    resetAdoptionDecision,
    requestAdoptionConsent,
    _resetConsentCache,
} from './adoption-consent.js';

const dialog = () => document.querySelector('input[name="mwi-adopt-target"]')?.closest('div[style*="fixed"]');

describe('adoption consent', () => {
    beforeEach(() => {
        mockStorage.store.clear();
        mockDataManager.currentCharacterId = 'market123';
        mockDataManager.currentName = 'Millennium';
        document.body.innerHTML = '';
        _resetConsentCache();
    });

    it('remembers a stored decision', async () => {
        await setAdoptionTargetId('market123');
        _resetConsentCache();
        expect(await getAdoptionTargetId()).toBe('market123');
    });

    it('reports undecided as null', async () => {
        expect(await getAdoptionTargetId()).toBeNull();
    });

    it('lists known characters with the recommended one preselected', async () => {
        mockStorage.store.set('accountCharacterNames', { market123: 'Millennium', iron456: 'MillenniumIron' });
        const pending = requestAdoptionConsent({ recommendedId: 'market123' });

        await vi.waitFor(() => expect(dialog()).toBeTruthy());
        const inputs = [...document.querySelectorAll('input[name="mwi-adopt-target"]')];
        expect(inputs.map((i) => i.value).sort()).toEqual(['iron456', 'market123']);
        expect(inputs.find((i) => i.value === 'market123').checked).toBe(true);

        document.querySelector('#mwi-adopt-confirm').click();
        expect(await pending).toBe('market123');
        expect(await getAdoptionTargetId()).toBe('market123');
        expect(dialog()).toBeFalsy();
    });

    it('confirming another character stores that character', async () => {
        mockStorage.store.set('accountCharacterNames', { market123: 'Millennium', alt789: 'Alt' });
        const pending = requestAdoptionConsent({ recommendedId: 'market123' });
        await vi.waitFor(() => expect(dialog()).toBeTruthy());

        document.querySelector('input[value="alt789"]').checked = true;
        document.querySelector('#mwi-adopt-confirm').click();
        expect(await pending).toBe('alt789');
        expect(await getAdoptionTargetId()).toBe('alt789');
    });

    it('"Not now" stores nothing and does not re-prompt this session', async () => {
        const pending = requestAdoptionConsent({});
        await vi.waitFor(() => expect(dialog()).toBeTruthy());
        document.querySelector('#mwi-adopt-later').click();
        expect(await pending).toBeNull();
        expect(await getAdoptionTargetId()).toBeNull();

        const again = await requestAdoptionConsent({});
        expect(again).toBeNull();
        expect(dialog()).toBeFalsy();
    });

    it('concurrent requests share one dialog', async () => {
        const a = requestAdoptionConsent({});
        const b = requestAdoptionConsent({});
        await vi.waitFor(() => expect(dialog()).toBeTruthy());
        expect(document.querySelectorAll('#mwi-adopt-confirm')).toHaveLength(1);
        document.querySelector('#mwi-adopt-confirm').click();
        expect(await a).toBe(await b);
    });

    it('includes the current character even when the name map is missing', async () => {
        const pending = requestAdoptionConsent({});
        await vi.waitFor(() => expect(dialog()).toBeTruthy());
        const inputs = [...document.querySelectorAll('input[name="mwi-adopt-target"]')];
        expect(inputs.map((i) => i.value)).toEqual(['market123']);
        document.querySelector('#mwi-adopt-later').click();
        await pending;
    });

    it('a character name with markup in it is escaped, not injected as an element', async () => {
        // In-game names can legally contain '<', '>' and '&' (see the guild trial
        // scoreboard's own-row-note fix) — showDialog() interpolates the display
        // name straight into the modal's innerHTML with no escaping.
        const hostileName = '<img src=x onerror="window.__pwned = true">';
        mockDataManager.currentName = hostileName;
        const pending = requestAdoptionConsent({});
        await vi.waitFor(() => expect(dialog()).toBeTruthy());

        // No <img> (or any other markup the name supplied) actually landed in the
        // DOM — an unescaped interpolation would have created one, and its
        // onerror would have run as soon as the (invalid, src=x) image failed to
        // load.
        expect(dialog().querySelector('img')).toBeNull();
        expect(window.__pwned).toBeUndefined();
        // The escaped text is still legible in the label, just inert
        expect(dialog().innerHTML).toContain('&lt;img src=x onerror=');

        document.querySelector('#mwi-adopt-later').click();
        await pending;
    });

    it('reset clears the decision and allows a new prompt', async () => {
        await setAdoptionTargetId('market123');
        await resetAdoptionDecision();
        expect(await getAdoptionTargetId()).toBeNull();
        const pending = requestAdoptionConsent({});
        await vi.waitFor(() => expect(dialog()).toBeTruthy());
        document.querySelector('#mwi-adopt-later').click();
        await pending;
    });
});
