import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ settings: { queueMonitor: false, notifications_otherCharacterIdle: false } }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => game.settings[key],
        onSettingChange: vi.fn(),
        offSettingChange: vi.fn(),
    },
}));
vi.mock('./queue-snapshot.js', () => ({ default: { initialize: vi.fn(), disable: vi.fn() } }));
vi.mock('./queue-monitor-ui.js', () => ({ default: { initialize: vi.fn(), disable: vi.fn() } }));
vi.mock('./queue-alerts.js', () => ({ default: { initialize: vi.fn(), disable: vi.fn() } }));

const config = (await import('../../core/config.js')).default;
const queueSnapshot = (await import('./queue-snapshot.js')).default;
const queueMonitorUI = (await import('./queue-monitor-ui.js')).default;
const queueAlerts = (await import('./queue-alerts.js')).default;
const queueMonitor = (await import('./queue-monitor.js')).default;

describe('queue monitor initialize', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        game.settings = { queueMonitor: false, notifications_otherCharacterIdle: false };
    });

    test('the snapshot listener and the idle alert always start, panel setting or not', () => {
        queueMonitor.initialize();

        expect(queueSnapshot.initialize).toHaveBeenCalled();
        expect(queueAlerts.initialize).toHaveBeenCalled();
        expect(queueMonitorUI.initialize).not.toHaveBeenCalled();
    });

    test('the panel only starts when its own setting is on', () => {
        game.settings.queueMonitor = true;
        queueMonitor.initialize();

        expect(queueMonitorUI.initialize).toHaveBeenCalled();
    });

    test('toggling the panel setting on and off drives the panel', () => {
        queueMonitor.initialize();
        const handler = config.onSettingChange.mock.calls.find((call) => call[0] === 'queueMonitor')[1];

        handler(true);
        expect(queueMonitorUI.initialize).toHaveBeenCalledTimes(1);

        handler(false);
        expect(queueMonitorUI.disable).toHaveBeenCalledTimes(1);
    });

    test('disable tears down every subsystem and the setting listener', () => {
        queueMonitor.initialize();
        queueMonitor.disable();

        expect(queueSnapshot.disable).toHaveBeenCalled();
        expect(queueMonitorUI.disable).toHaveBeenCalled();
        expect(queueAlerts.disable).toHaveBeenCalled();
        expect(config.offSettingChange).toHaveBeenCalledWith('notifications_otherCharacterIdle', expect.any(Function));
    });
});
