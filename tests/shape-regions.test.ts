import type { Point } from '../src/source/shape-geometry.ts';
/* eslint-disable test/no-import-node-test -- Tests run with Node's built-in runner. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildShapeRegions, chooseSmallestContainingRegion, regionContainsPoint } from '../src/source/shape-regions.ts';

type Shape = Parameters<typeof buildShapeRegions>[0][number];
const rect = (id: string, x1: number, y1: number, x2: number, y2: number): Shape => ({ type: 'rectangle', id, x1, y1, x2, y2 });
const poly = (id: string, points: Point[], closed = false): Shape => ({ type: 'polyline', id, points, closed });

test('detects a rectangle as one closed region', () => {
	const result = buildShapeRegions([rect('r1', 0, 0, 10, 8)]);
	assert.equal(result.regions.length, 1);
	assert.equal(result.regions[0].kind, 'polyline');
	assert.deepEqual(result.regions[0].bbox, { minX: 0, minY: 0, maxX: 10, maxY: 8 });
});

test('closes a rectangle with an endpoint-connected open polyline', () => {
	const result = buildShapeRegions([rect('r', 0, 0, 10, 10), poly('edge', [{ x: 0, y: 0 }, { x: 10, y: 0 }])]);
	assert.equal(result.regions.length, 1);
	assert.equal(result.regions[0].sourceIds.some(id => id === 'r' || id === 'edge'), true);
});

test('detects multiple connected polylines and closed polylines', () => {
	const shapes = [
		poly('a', [{ x: 0, y: 0 }, { x: 4, y: 0 }]),
		poly('b', [{ x: 4, y: 0 }, { x: 4, y: 4 }]),
		poly('c', [{ x: 4, y: 4 }, { x: 0, y: 4 }]),
		poly('d', [{ x: 0, y: 4 }, { x: 0, y: 0 }]),
		poly('closed', [{ x: 10, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 2 }, { x: 10, y: 2 }], true),
	];
	const result = buildShapeRegions(shapes);
	assert.equal(result.regions.length, 2);
	assert.deepEqual([...result.regions.map(item => item.sourceIds)].sort((a, b) => a[0].localeCompare(b[0])), [['a', 'b', 'c', 'd'], ['closed']]);
});
test('samples circles and ellipses as closed regions', () => {
	const result = buildShapeRegions([{ type: 'circle', id: 'c', cx: 0, cy: 0, radius: 3 }, { type: 'ellipse', id: 'e', cx: 10, cy: 0, radiusX: 4, radiusY: 2, rotation: 30 }]);
	assert.deepEqual(result.regions.map(item => item.kind), ['circle', 'ellipse']);
	assert.equal(regionContainsPoint(result.regions[0], { x: 0, y: 2 }), true);
});

test('chooses the smallest nested containing region', () => {
	const result = buildShapeRegions([rect('outer', 0, 0, 20, 20), rect('inner', 5, 5, 10, 10)]);
	assert.equal(chooseSmallestContainingRegion(result.regions, { x: 7, y: 7 })?.sourceIds[0], 'inner');
});

test('uses endpoint tolerance but leaves disconnected open lines unclassified', () => {
	const result = buildShapeRegions([poly('a', [{ x: 0, y: 0 }, { x: 10, y: 0 }]), poly('b', [{ x: 10.0004, y: 0 }, { x: 10, y: 10 }]), poly('c', [{ x: 10, y: 10 }, { x: 0, y: 10 }]), poly('d', [{ x: 0, y: 10 }, { x: 0, y: 0 }])], { endpointTolerance: 0.001 });
	assert.equal(result.regions.length, 1);
	assert.equal(buildShapeRegions([poly('open', [{ x: 0, y: 0 }, { x: 1, y: 0 }])]).regions.length, 0);
});

test('rejects ambiguous and self-intersecting loops with diagnostics', () => {
	const result = buildShapeRegions([poly('bow', [{ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }, { x: 4, y: 0 }], true)]);
	assert.equal(result.regions.length, 0);
	assert.ok(result.diagnostics.some(item => item.code === 'ambiguous' || item.code === 'self-intersecting'));
});

test('intersects region bboxes through actual region geometry', () => {
	const [region] = buildShapeRegions([{ type: 'circle', id: 'c', cx: 0, cy: 0, radius: 5 }]).regions;
	assert.equal(region.intersectsBBox({ minX: 4, minY: 0, maxX: 6, maxY: 4 }), true);
	assert.equal(region.intersectsBBox({ minX: 6, minY: 6, maxX: 7, maxY: 7 }), false);
});
