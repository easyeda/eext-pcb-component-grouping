import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
/* eslint-disable test/no-import-node-test -- Tests run with Node's built-in runner. */
import test from 'node:test';
import { extractSchematicPage } from '../src/source/schematic-source.ts';

import {
	circleBBox,
	containsPoint,
	ellipseBBox,
	polylineBBox,
	quantizeEndpoint,
	quantizePolylineEndpoints,
	rectangleBBox,
	rotatedBBox,
} from '../src/source/shape-geometry.ts';

const schematicShapesFixture = readFileSync(new URL('./fixtures/schematic-shapes.source', import.meta.url), 'utf8');

test('extracts normalized schematic shape records and preserves existing primitives', () => {
	const page = extractSchematicPage(schematicShapesFixture);
	assert.equal(page.uuid, 'page-shapes');
	assert.deepEqual(page.rects, [{ id: 'rect-1', label: '矩形 1', bbox: { minX: 1, minY: 2, maxX: 3, maxY: 4 } }]);
	assert.deepEqual(page.shapes, [
		{ id: 'rect-1', type: 'RECT', bbox: { minX: 1, minY: 2, maxX: 3, maxY: 4 }, rotation: 0, corner1: { x: 1, y: 2 }, corner2: { x: 3, y: 4 } },
		{ id: 'poly-1', type: 'POLY', closed: true, points: [{ x: 10, y: 20 }, { x: 50, y: 20 }, { x: 50, y: 60 }], bbox: { minX: 10, minY: 20, maxX: 50, maxY: 60 } },
		{ id: 'circle-1', type: 'CIRCLE', center: { x: 200, y: 100 }, radius: 15, bbox: { minX: 185, minY: 85, maxX: 215, maxY: 115 } },
		{ id: 'ellipse-1', type: 'ELLIPSE', center: { x: 300, y: 100 }, radiusX: 30, radiusY: 10, rotation: 90, bbox: { minX: 290, minY: 70, maxX: 310, maxY: 130 } },
	]);
	assert.deepEqual(page.components[0].designator, 'U1');
	assert.equal(page.texts[0].content, 'keep me');
	assert.deepEqual(page.diagnostics, [{ id: 'arc-1', type: 'ARC', message: 'ARC retained without normalized bbox' }]);
});

test('computes a normalized rectangle bbox', () => {
	assert.deepEqual(rectangleBBox({ x1: 8, y1: 6, x2: 2, y2: 1 }), { minX: 2, minY: 1, maxX: 8, maxY: 6 });
});

test('computes open and closed polyline bboxes', () => {
	const points = [{ x: 3, y: 5 }, { x: -2, y: 1 }, { x: 4, y: -1 }];
	assert.deepEqual(polylineBBox(points, false), { minX: -2, minY: -1, maxX: 4, maxY: 5 });
	assert.deepEqual(polylineBBox(points, true), { minX: -2, minY: -1, maxX: 4, maxY: 5 });
});

test('computes circle and rotated ellipse bboxes', () => {
	assert.deepEqual(circleBBox({ cx: 10, cy: -2, radius: 3 }), { minX: 7, minY: -5, maxX: 13, maxY: 1 });
	const bbox = ellipseBBox({ cx: 0, cy: 0, radiusX: 4, radiusY: 2, rotation: 90 });
	assert.ok(Math.abs(bbox.minX + 2) < 1e-12);
	assert.ok(Math.abs(bbox.maxX - 2) < 1e-12);
	assert.ok(Math.abs(bbox.minY + 4) < 1e-12);
	assert.ok(Math.abs(bbox.maxY - 4) < 1e-12);
});

test('computes bbox for a rectangle rotated around its center', () => {
	const bbox = rotatedBBox({ minX: 0, minY: 0, maxX: 4, maxY: 2 }, 90);
	assert.ok(Math.abs(bbox.minX - 1) < 1e-12);
	assert.ok(Math.abs(bbox.maxX - 3) < 1e-12);
	assert.ok(Math.abs(bbox.minY + 1) < 1e-12);
	assert.ok(Math.abs(bbox.maxY - 3) < 1e-12);
});

test('contains points on and inside a bbox, but not outside', () => {
	const bbox = { minX: 0, minY: 0, maxX: 4, maxY: 2 };
	assert.equal(containsPoint(bbox, { x: 0, y: 1 }), true);
	assert.equal(containsPoint(bbox, { x: 2, y: 1 }), true);
	assert.equal(containsPoint(bbox, { x: 4.001, y: 1 }), false);
	assert.equal(containsPoint(bbox, { x: 4, y: 1 }, false), false);
});

test('quantizes endpoints deterministically', () => {
	assert.equal(quantizeEndpoint(1.24, 0.1), 1.2);
	assert.equal(quantizeEndpoint(1.25, 0.1), 1.3);
	assert.deepEqual(quantizePolylineEndpoints([{ x: 0.04, y: 1.06 }, { x: 2.14, y: 3.26 }], 0.1), [{ x: 0, y: 1.1 }, { x: 2.1, y: 3.3 }]);
});

test('rejects invalid and degenerate geometry inputs', () => {
	assert.throws(() => rectangleBBox({ x1: 0, y1: 0, x2: Number.NaN, y2: 1 }), /finite/);
	assert.throws(() => polylineBBox([], false), /at least one/);
	assert.throws(() => circleBBox({ cx: 0, cy: 0, radius: -1 }), /radius/);
	assert.throws(() => ellipseBBox({ cx: 0, cy: 0, radiusX: 0, radiusY: 2 }), /radius/);
	assert.throws(() => rotatedBBox({ minX: 2, minY: 0, maxX: 1, maxY: 1 }, 0), /ordered/);
	assert.throws(() => quantizeEndpoint(1, 0), /quantum/);
});
