/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({
    unregister: vi.fn(),
    windowCallback: null,
    wsHandlers: {},
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: vi.fn(() => true) },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: vi.fn((_name, _cls, cb) => {
            game.windowCallback = cb;
            return game.unregister;
        }),
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: vi.fn((type, handler) => {
            game.wsHandlers[type] = handler;
        }),
        off: vi.fn((type, handler) => {
            if (game.wsHandlers[type] === handler) delete game.wsHandlers[type];
        }),
    },
}));
vi.mock('../../utils/toast.js', () => ({ showToast: vi.fn() }));

import { showToast } from '../../utils/toast.js';
import feature from './guild-profile-back.js';

const BUTTON = '.mwi-guild-profile-back-button';

/**
 * A profile_shared as the game sends it (live, test server 2026-11-24): only `{type, profile}`. The name is on
 * `profile.sharableCharacter` (which has no id); the id is on the character's own skill rows.
 */
function shareProfile(characterID, characterName) {
    game.wsHandlers.profile_shared?.({
        type: 'profile_shared',
        profile: {
            sharableCharacter: { name: characterName, gameMode: 'standard' },
            characterSkills: [{ characterID, skillHrid: '/skills/total_level', level: 2652 }],
            guildId: 899,
            guildName: 'SuperMoo',
        },
    });
}

/** The profile window with its guild link (live structure, test server 2026-11-24) */
function openProfileWindow(name) {
    const modal = document.createElement('div');
    modal.className = 'SharableProfile_modalContainer__a1b2c';
    modal.innerHTML =
        `<div class="SharableProfile_header__x">${name}</div>` +
        '<div class="SharableProfile_guildInfo__d3e4f SharableProfile_clickable__g5h6i">' +
        '<div class="GuildName_guildName__j7k8l GuildName_large__m9n0o"><span class="GuildName_name__p1q2r">SuperMoo</span></div></div>';
    document.body.appendChild(modal);
    return modal;
}

/** Click the guild link, then the game swaps the profile window for the guild window */
function clickGuildLinkAndOpenGuild(profileModal) {
    profileModal.querySelector('[class*="GuildName_name"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    profileModal.remove();
    return openGuildWindow();
}

/** The guild window as the game draws it (live): a full-screen container holding a background and the window */
function openGuildWindow() {
    const guildWindow = document.createElement('div');
    guildWindow.className = 'SharableGuildProfile_modalContainer__s3t4u';
    guildWindow.innerHTML =
        '<div class="SharableGuildProfile_background__b1"></div>' +
        '<div class="SharableGuildProfile_modal__m1"><div class="SharableGuildProfile_title__t1">SuperMoo</div></div>';
    document.body.appendChild(guildWindow);
    game.windowCallback(guildWindow);
    return guildWindow;
}

function installGameComponent(handleViewProfile) {
    const root = document.createElement('div');
    root.id = 'root';
    root._reactRootContainer = {
        current: {
            stateNode: null,
            sibling: null,
            child: {
                stateNode: { handleViewProfile, handleViewGuildProfile: vi.fn() },
                child: null,
                sibling: null,
            },
        },
    };
    document.body.appendChild(root);
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
    feature.initialize();
});

afterEach(() => {
    feature.disable();
    document.body.innerHTML = '';
    game.windowCallback = null;
    game.wsHandlers = {};
    vi.clearAllMocks();
    vi.useRealTimers();
});

describe('guild profile back button', () => {
    test('appears on a guild window opened from a profile, named for that character', () => {
        shareProfile(77, 'Alice');
        const guildWindow = clickGuildLinkAndOpenGuild(openProfileWindow('Alice'));
        const button = guildWindow.querySelector(BUTTON);
        expect(button).not.toBeNull();
        expect(button.textContent).toContain('Alice');
        // Inside the window itself, not on the full-screen overlay
        expect(button.parentElement.className).toMatch(/^SharableGuildProfile_modal__/);
    });

    test('does not appear on a guild window opened any other way', () => {
        shareProfile(77, 'Alice');
        openProfileWindow('Alice');
        const guildWindow = openGuildWindow();
        expect(guildWindow.querySelector(BUTTON)).toBeNull();
    });

    test('does not appear when the link click was long before the guild window', () => {
        shareProfile(77, 'Alice');
        const modal = openProfileWindow('Alice');
        modal.querySelector('[class*="GuildName_name"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        vi.advanceTimersByTime(6000);
        expect(openGuildWindow().querySelector(BUTTON)).toBeNull();
    });

    test('does not name a profile the open window does not belong to', () => {
        shareProfile(77, 'Alice');
        const guildWindow = clickGuildLinkAndOpenGuild(openProfileWindow('Bob'));
        expect(guildWindow.querySelector(BUTTON)).toBeNull();
    });

    // The game's handler takes the name (live: handleViewProfile(31519) did nothing, ('NikuDango') reopened it)
    test('one press calls handleViewProfile once, on the next task, with the character name', () => {
        const handleViewProfile = vi.fn();
        installGameComponent(handleViewProfile);
        shareProfile(77, 'Alice');
        const button = clickGuildLinkAndOpenGuild(openProfileWindow('Alice')).querySelector(BUTTON);
        button.click();
        button.click();
        expect(handleViewProfile).not.toHaveBeenCalled();
        vi.advanceTimersByTime(0);
        expect(handleViewProfile).toHaveBeenCalledTimes(1);
        expect(handleViewProfile).toHaveBeenCalledWith('Alice');
    });

    test('a missing handler shows a toast and does nothing', () => {
        shareProfile(77, 'Alice');
        const button = clickGuildLinkAndOpenGuild(openProfileWindow('Alice')).querySelector(BUTTON);
        button.click();
        vi.advanceTimersByTime(0);
        expect(showToast).toHaveBeenCalledTimes(1);
    });

    test('a second guild window from another profile carries that profile name', () => {
        shareProfile(77, 'Alice');
        const first = clickGuildLinkAndOpenGuild(openProfileWindow('Alice'));
        expect(first.querySelector(BUTTON).textContent).toContain('Alice');
        first.remove();
        shareProfile(88, 'Bob');
        const second = clickGuildLinkAndOpenGuild(openProfileWindow('Bob'));
        expect(second.querySelector(BUTTON).textContent).toContain('Bob');
        expect(second.querySelector(BUTTON).textContent).not.toContain('Alice');
    });

    test('a guild window opened the other way after one from a profile has no button', () => {
        shareProfile(77, 'Alice');
        const first = clickGuildLinkAndOpenGuild(openProfileWindow('Alice'));
        first.remove();
        expect(openGuildWindow().querySelector(BUTTON)).toBeNull();
    });

    test('disable removes the button, the listeners and the observer', () => {
        shareProfile(77, 'Alice');
        const guildWindow = clickGuildLinkAndOpenGuild(openProfileWindow('Alice'));
        feature.disable();
        expect(guildWindow.querySelector(BUTTON)).toBeNull();
        expect(game.unregister).toHaveBeenCalled();
        expect(game.wsHandlers.profile_shared).toBeUndefined();
        // The link click no longer arms anything
        shareProfile(77, 'Alice');
        expect(document.querySelector(BUTTON)).toBeNull();
        const modal = openProfileWindow('Alice');
        modal.querySelector('[class*="GuildName_name"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        feature.initialize();
        expect(openGuildWindow().querySelector(BUTTON)).toBeNull();
    });
});
