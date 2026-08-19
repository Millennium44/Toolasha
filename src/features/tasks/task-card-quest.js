/**
 * The quest behind a task card.
 *
 * The game puts nothing identifying in a task card's DOM — no hrid, no id, not
 * even a stable class. What it does still expose is the React root container,
 * and the card's `characterQuest` prop hangs off the fiber above any element
 * inside it. Every feature that has to say *which* task a card is showing walks
 * the same path, so it lives here once.
 *
 * The `__reactFiber$…` keys elements used to carry were removed in the February
 * 2026 update; `_reactRootContainer` was not, which is why the walk starts at
 * the root and looks for the element rather than starting at the element.
 */

/**
 * Extract the quest a task card is showing.
 *
 * Several anchors are tried because the card's action row is redrawn on every
 * step of the reroll flow: a card mid-chooser has no Go button, and a card
 * showing Confirm Discard has almost nothing else either.
 *
 * @param {Element|null|undefined} taskCard - A task card
 * @returns {Object|null} The `characterQuest`, or null when it cannot be read
 */
export function questForTaskCard(taskCard) {
    if (!taskCard || typeof taskCard.querySelector !== 'function') return null;
    if (typeof document === 'undefined') return null;

    const rootEl = document.getElementById('root');
    const rootFiber = rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
    if (!rootFiber) return null;

    function walk(fiber, target) {
        if (!fiber) return null;
        if (fiber.stateNode === target) return fiber;
        return walk(fiber.child, target) || walk(fiber.sibling, target);
    }

    function questAbove(startFiber) {
        let fiber = startFiber?.return;
        while (fiber) {
            if (fiber.memoizedProps?.characterQuest) return fiber.memoizedProps.characterQuest;
            fiber = fiber.return;
        }
        return null;
    }

    const anchors = [
        taskCard.querySelector('button.Button_success__6d6kU'),
        taskCard.querySelector('button'),
        taskCard.querySelector('[class*="RandomTask_name"]'),
        taskCard,
    ];

    for (const anchor of anchors) {
        if (!anchor) continue;
        const fiber = walk(rootFiber, anchor);
        if (!fiber) continue;
        const quest = questAbove(fiber);
        if (quest) return quest;
    }

    return null;
}

export default { questForTaskCard };
