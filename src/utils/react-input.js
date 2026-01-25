/**
 * React Input Utility
 * Handles programmatic updates to React-controlled input elements
 *
 * React uses an internal _valueTracker to detect changes. When setting
 * input values programmatically, we must manipulate this tracker to
 * ensure React recognizes the change and updates its state.
 */

/**
 * Set value on a React-controlled input element
 * This is the critical pattern for making React recognize programmatic changes
 *
 * @param {HTMLInputElement} input - Input element (text, number, etc.)
 * @param {string|number} value - Value to set
 * @param {Object} options - Optional configuration
 * @param {boolean} options.focus - Whether to focus the input after setting (default: true)
 * @param {boolean} options.dispatchInput - Whether to dispatch input event (default: true)
 * @param {boolean} options.dispatchChange - Whether to dispatch change event (default: false)
 */
export function setReactInputValue(input, value, options = {}) {
    const { focus = true, dispatchInput = true, dispatchChange = false } = options;

    if (!input) {
        console.warn('[React Input] No input element provided');
        return;
    }

    // Save the current value
    const lastValue = input.value;

    // Set the new value directly on the DOM
    input.value = value;

    // This is the critical part: React stores an internal _valueTracker
    // We need to set it to the old value before dispatching the event
    // so React sees the difference and updates its state
    const tracker = input._valueTracker;
    if (tracker) {
        tracker.setValue(lastValue);
    }

    // Dispatch events based on options
    if (dispatchInput) {
        const inputEvent = new Event('input', { bubbles: true });
        inputEvent.simulated = true;
        input.dispatchEvent(inputEvent);
    }

    if (dispatchChange) {
        const changeEvent = new Event('change', { bubbles: true });
        changeEvent.simulated = true;
        input.dispatchEvent(changeEvent);
    }

    // Focus the input to show the value
    if (focus) {
        input.focus();
    }
}

/**
 * Check if an input element is React-controlled
 * React-controlled inputs have an internal _valueTracker property
 *
 * @param {HTMLInputElement} input - Input element to check
 * @returns {boolean} True if React-controlled
 */
export function isReactControlledInput(input) {
    return input && input._valueTracker !== undefined;
}

/**
 * Set value on a select element (non-React pattern, for completeness)
 *
 * @param {HTMLSelectElement} select - Select element
 * @param {string} value - Value to select
 * @param {boolean} dispatchChange - Whether to dispatch change event (default: true)
 */
export function setSelectValue(select, value, dispatchChange = true) {
    if (!select) {
        console.warn('[React Input] No select element provided');
        return;
    }

    // Find and select the option
    for (let i = 0; i < select.options.length; i++) {
        if (select.options[i].value === value) {
            select.options[i].selected = true;
            break;
        }
    }

    // Dispatch change event
    if (dispatchChange) {
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

/**
 * Set checked state on a checkbox/radio input (non-React pattern, for completeness)
 *
 * @param {HTMLInputElement} input - Checkbox or radio input
 * @param {boolean} checked - Checked state
 * @param {boolean} dispatchChange - Whether to dispatch change event (default: true)
 */
export function setCheckboxValue(input, checked, dispatchChange = true) {
    if (!input) {
        console.warn('[React Input] No input element provided');
        return;
    }

    input.checked = checked;

    // Dispatch change event
    if (dispatchChange) {
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }
}
