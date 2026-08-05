/**
 * @vitest-environment happy-dom
 */
import { describe, test, expect, beforeEach } from 'vitest';
import {
    ANNOTATION_CONTAINER_CLASS,
    getAnnotationContainer,
    pruneEmptyAnnotationContainers,
} from './labyrinth-annotations.js';

describe('getAnnotationContainer', () => {
    let cell;

    beforeEach(() => {
        cell = document.createElement('div');
        document.body.appendChild(cell);
    });

    test('creates the shared container on first use', () => {
        const container = getAnnotationContainer(cell);

        expect(container.className).toBe(ANNOTATION_CONTAINER_CLASS);
        expect(cell.contains(container)).toBe(true);
    });

    test('a second call returns the same element rather than a duplicate', () => {
        const first = getAnnotationContainer(cell);
        const second = getAnnotationContainer(cell);

        expect(second).toBe(first);
        expect(cell.querySelectorAll(`.${ANNOTATION_CONTAINER_CLASS}`)).toHaveLength(1);
    });
});

describe('pruneEmptyAnnotationContainers', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    test('removes containers left with no badges', () => {
        const cell = document.createElement('div');
        document.body.appendChild(cell);
        getAnnotationContainer(cell);

        pruneEmptyAnnotationContainers();

        expect(document.querySelector(`.${ANNOTATION_CONTAINER_CLASS}`)).toBeNull();
    });

    test('leaves a container alone once it holds a badge', () => {
        const cell = document.createElement('div');
        document.body.appendChild(cell);
        const container = getAnnotationContainer(cell);
        container.appendChild(document.createElement('span'));

        pruneEmptyAnnotationContainers();

        expect(document.querySelector(`.${ANNOTATION_CONTAINER_CLASS}`)).not.toBeNull();
    });
});
