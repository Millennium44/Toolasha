/** @vitest-environment happy-dom */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import dragSizeRestore, { applyOnce } from './drag-size-restore.js';

let game;

function mountGame(state) {
    game = { handleGoToMarketplace: () => {}, state, setState: vi.fn() };
    const root = document.createElement('div');
    root.id = 'root';
    root._reactRootContainer = { current: { child: { stateNode: game } } };
    document.body.appendChild(root);
}

describe('drag size restore', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        localStorage.clear();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        dragSizeRestore.cleanup();
        vi.useRealTimers();
    });

    it('puts the exact saved sizes back when the game truncated them', () => {
        localStorage.setItem('inventoryDragSize', '25.62034832591766');
        localStorage.setItem('chatDragSize', '28.75160016390535');
        mountGame({ inventoryDragSize: 25, chatDragSize: 28 });

        expect(applyOnce()).toBe(true);

        expect(game.setState).toHaveBeenCalledTimes(1);
        expect(game.setState).toHaveBeenCalledWith({
            inventoryDragSize: 25.62034832591766,
            chatDragSize: 28.75160016390535,
        });
    });

    it('restores only the key that still holds the truncated value', () => {
        localStorage.setItem('inventoryDragSize', '25.62');
        localStorage.setItem('chatDragSize', '28.75');
        mountGame({ inventoryDragSize: 25, chatDragSize: 31.2 });

        applyOnce();

        expect(game.setState).toHaveBeenCalledWith({ inventoryDragSize: 25.62 });
    });

    it('does nothing when the player has dragged since (state differs from trunc(saved))', () => {
        localStorage.setItem('inventoryDragSize', '25.62');
        localStorage.setItem('chatDragSize', '28.75');
        mountGame({ inventoryDragSize: 40.5, chatDragSize: 33 });

        applyOnce();

        expect(game.setState).not.toHaveBeenCalled();
    });

    it('does nothing when the stored value is missing or garbage', () => {
        localStorage.setItem('chatDragSize', 'abc');
        mountGame({ inventoryDragSize: 25, chatDragSize: 28 });

        applyOnce();

        expect(game.setState).not.toHaveBeenCalled();
    });

    it('does nothing for an out-of-range stored value', () => {
        localStorage.setItem('inventoryDragSize', '0.5');
        localStorage.setItem('chatDragSize', '250.5');
        mountGame({ inventoryDragSize: 0, chatDragSize: 250 });

        applyOnce();

        expect(game.setState).not.toHaveBeenCalled();
    });

    it('does nothing when the state already equals the saved value', () => {
        localStorage.setItem('inventoryDragSize', '25.62');
        localStorage.setItem('chatDragSize', '28');
        mountGame({ inventoryDragSize: 25.62, chatDragSize: 28 });

        applyOnce();

        expect(game.setState).not.toHaveBeenCalled();
    });

    it('never writes localStorage', () => {
        localStorage.setItem('inventoryDragSize', '25.62');
        mountGame({ inventoryDragSize: 25, chatDragSize: 28 });
        const setItem = vi.spyOn(Storage.prototype, 'setItem');

        applyOnce();

        expect(setItem).not.toHaveBeenCalled();
        setItem.mockRestore();
    });

    it('retries until the game component is mounted, then applies once', () => {
        localStorage.setItem('inventoryDragSize', '25.62');
        dragSizeRestore.initialize();
        expect(document.getElementById('root')).toBeNull();

        vi.advanceTimersByTime(1000);
        mountGame({ inventoryDragSize: 25, chatDragSize: 28 });
        vi.advanceTimersByTime(600);
        vi.advanceTimersByTime(5000);

        expect(game.setState).toHaveBeenCalledTimes(1);
        expect(game.setState).toHaveBeenCalledWith({ inventoryDragSize: 25.62 });
    });

    it('stops retrying after cleanup', () => {
        localStorage.setItem('inventoryDragSize', '25.62');
        dragSizeRestore.initialize();
        dragSizeRestore.cleanup();

        mountGame({ inventoryDragSize: 25, chatDragSize: 28 });
        vi.advanceTimersByTime(5000);

        expect(game.setState).not.toHaveBeenCalled();
    });
});
