import type { BBox, Point } from './shape-geometry';
import { circleBBox, ellipseBBox, polylineBBox } from './shape-geometry';

export type RegionShape
	= | { type: 'rectangle'; id: string; x1: number; y1: number; x2: number; y2: number }
		| { type: 'polyline'; id: string; points: Point[]; closed?: boolean }
		| { type: 'circle'; id: string; cx: number; cy: number; radius: number }
		| { type: 'ellipse'; id: string; cx: number; cy: number; radiusX: number; radiusY: number; rotation?: number };

export interface RegionDiagnostic {
	code: 'open-loop' | 'ambiguous' | 'self-intersecting' | 'unsupported';
	sourceIds: string[];
	message: string;
}

export interface ClosedRegion {
	kind: 'rectangle' | 'polyline' | 'circle' | 'ellipse';
	sourceIds: string[];
	bbox: BBox;
	polygon: Point[];
	intersectsBBox: (bbox: BBox) => boolean;
}

export interface BuildShapeRegionsOptions {
	endpointTolerance?: number;
	curveSegments?: number;
}

const DEFAULT_ENDPOINT_TOLERANCE = 0.001;
const DEFAULT_CURVE_SEGMENTS = 64;

function rectanglePolygon(shape: Extract<RegionShape, { type: 'rectangle' }>): Point[] {
	return [
		{ x: shape.x1, y: shape.y1 },
		{ x: shape.x2, y: shape.y1 },
		{ x: shape.x2, y: shape.y2 },
		{ x: shape.x1, y: shape.y2 },
	];
}

function circlePolygon(shape: Extract<RegionShape, { type: 'circle' }>, segments: number): Point[] {
	const polygon: Point[] = [];
	for (let index = 0; index < segments; index += 1) {
		const angle = 2 * Math.PI * index / segments;
		polygon.push({ x: shape.cx + shape.radius * Math.cos(angle), y: shape.cy + shape.radius * Math.sin(angle) });
	}
	return polygon;
}

function ellipsePolygon(shape: Extract<RegionShape, { type: 'ellipse' }>, segments: number): Point[] {
	const rotation = (shape.rotation ?? 0) * Math.PI / 180;
	const cos = Math.cos(rotation);
	const sin = Math.sin(rotation);
	const polygon: Point[] = [];
	for (let index = 0; index < segments; index += 1) {
		const angle = 2 * Math.PI * index / segments;
		const localX = shape.radiusX * Math.cos(angle);
		const localY = shape.radiusY * Math.sin(angle);
		polygon.push({ x: shape.cx + localX * cos - localY * sin, y: shape.cy + localX * sin + localY * cos });
	}
	return polygon;
}

function key(point: Point, tolerance: number): string {
	const quantum = tolerance > 0 ? tolerance : DEFAULT_ENDPOINT_TOLERANCE;
	return `${Math.round(point.x / quantum)}:${Math.round(point.y / quantum)}`;
}

function orientation(a: Point, b: Point, c: Point): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Point, b: Point, p: Point): boolean {
	return Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y);
}

function segmentsIntersect(p1: Point, p2: Point, q1: Point, q2: Point): boolean {
	const o1 = orientation(p1, p2, q1);
	const o2 = orientation(p1, p2, q2);
	const o3 = orientation(q1, q2, p1);
	const o4 = orientation(q1, q2, p2);
	if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0)))
		return true;
	if (o1 === 0 && onSegment(p1, p2, q1))
		return true;
	if (o2 === 0 && onSegment(p1, p2, q2))
		return true;
	if (o3 === 0 && onSegment(q1, q2, p1))
		return true;
	if (o4 === 0 && onSegment(q1, q2, p2))
		return true;
	return false;
}

function polygonHasSelfIntersection(polygon: Point[]): boolean {
	for (let i = 0; i < polygon.length; i += 1) {
		const a1 = polygon[i];
		const a2 = polygon[(i + 1) % polygon.length];
		for (let j = i + 1; j < polygon.length; j += 1) {
			if (j === i)
				continue;
			const b1 = polygon[j];
			const b2 = polygon[(j + 1) % polygon.length];
			if (a1 === b1 || a1 === b2 || a2 === b1 || a2 === b2)
				continue;
			if (segmentsIntersect(a1, a2, b1, b2))
				return true;
		}
	}
	return false;
}

function polygonBBox(polygon: Point[]): BBox {
	return polylineBBox(polygon, true);
}

function pointInPolygon(polygon: Point[], point: Point): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const xi = polygon[i].x;
		const yi = polygon[i].y;
		const xj = polygon[j].x;
		const yj = polygon[j].y;
		const intersects = (yi > point.y) !== (yj > point.y) && point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi;
		if (intersects)
			inside = !inside;
	}
	return inside;
}

function bboxIntersectsPolygon(bbox: BBox, polygon: Point[]): boolean {
	const polygonB = polygonBBox(polygon);
	if (bbox.maxX < polygonB.minX || bbox.minX > polygonB.maxX || bbox.maxY < polygonB.minY || bbox.minY > polygonB.maxY)
		return false;
	const bboxCorners: Point[] = [
		{ x: bbox.minX, y: bbox.minY },
		{ x: bbox.maxX, y: bbox.minY },
		{ x: bbox.maxX, y: bbox.maxY },
		{ x: bbox.minX, y: bbox.maxY },
	];
	if (bboxCorners.some(corner => pointInPolygon(polygon, corner)))
		return true;
	if (polygon.some(point => point.x >= bbox.minX && point.x <= bbox.maxX && point.y >= bbox.minY && point.y <= bbox.maxY))
		return true;
	const polygonSegments = polygon.map((start, index) => ({ start, end: polygon[(index + 1) % polygon.length] }));
	const bboxSegments = [
		{ start: bboxCorners[0], end: bboxCorners[1] },
		{ start: bboxCorners[1], end: bboxCorners[2] },
		{ start: bboxCorners[2], end: bboxCorners[3] },
		{ start: bboxCorners[3], end: bboxCorners[0] },
	];
	return polygonSegments.some(polySegment => bboxSegments.some(bboxSegment => segmentsIntersect(polySegment.start, polySegment.end, bboxSegment.start, bboxSegment.end)));
}

function createRegion(kind: ClosedRegion['kind'], sourceIds: string[], polygon: Point[], bbox: BBox): ClosedRegion {
	return {
		kind,
		sourceIds,
		bbox,
		polygon,
		intersectsBBox: (target: BBox) => bboxIntersectsPolygon(target, polygon),
	};
}

interface BoundaryEdge {
	sourceId: string;
	start: Point;
	end: Point;
}

function boundaryEdges(points: Point[], sourceId: string, closed: boolean): BoundaryEdge[] {
	const edgeCount = closed ? points.length : points.length - 1;
	const edges: BoundaryEdge[] = [];
	for (let index = 0; index < edgeCount; index += 1) {
		edges.push({ sourceId, start: points[index], end: points[(index + 1) % points.length] });
	}
	return edges;
}

function splitEdgeAt(edge: BoundaryEdge, point: Point): [BoundaryEdge, BoundaryEdge] {
	return [
		{ sourceId: edge.sourceId, start: edge.start, end: point },
		{ sourceId: edge.sourceId, start: point, end: edge.end },
	];
}

// A divider polyline often touches the middle of a rectangle edge rather than
// a rectangle vertex. Split touched edges so endpoint matching can form loops.
function injectPolylineEndpoints(edges: BoundaryEdge[], tolerance: number): BoundaryEdge[] {
	let result = edges;
	let changed = true;
	while (changed) {
		changed = false;
		for (let outer = 0; outer < result.length && !changed; outer += 1) {
			for (let inner = 0; inner < result.length && !changed; inner += 1) {
				if (outer === inner)
					continue;
				for (const endpoint of [result[inner].start, result[inner].end]) {
					const onEdge = onSegment(result[outer].start, result[outer].end, endpoint);
					const notEndpoint = key(endpoint, tolerance) !== key(result[outer].start, tolerance) && key(endpoint, tolerance) !== key(result[outer].end, tolerance);
					if (onEdge && notEndpoint) {
						const [left, right] = splitEdgeAt(result[outer], endpoint);
						result = [...result.slice(0, outer), left, right, ...result.slice(outer + 1)];
						changed = true;
						break;
					}
				}
			}
		}
	}
	return result;
}

function extractLoops(edges: BoundaryEdge[], tolerance: number): BoundaryEdge[][] {
	const nodes = new Map<string, BoundaryEdge[]>();
	for (const edge of edges) {
		nodes.set(key(edge.start, tolerance), [...(nodes.get(key(edge.start, tolerance)) ?? []), edge]);
		nodes.set(key(edge.end, tolerance), [...(nodes.get(key(edge.end, tolerance)) ?? []), edge]);
	}
	const loops: BoundaryEdge[][] = [];
	const walk = (edge: BoundaryEdge, startKey: string): BoundaryEdge[] | null => {
		const path: BoundaryEdge[] = [edge];
		let current = edge;
		while (true) {
			const endKey = key(current.end, tolerance);
			if (path.length > 1 && endKey === startKey)
				return path;
			const next = (nodes.get(endKey) ?? []).filter(candidate => candidate !== current && !path.includes(candidate));
			if (next.length === 0)
				return null;
			// At a T-junction, turn right relative to the incoming direction. This
			// is the standard planar-face walk and yields the two faces on either
			// side of a divider polyline.
			const heading = { x: current.end.x - current.start.x, y: current.end.y - current.start.y };
			const ranked = next.map((candidate) => {
				const direction = { x: candidate.end.x - candidate.start.x, y: candidate.end.y - candidate.start.y };
				const cross = heading.x * direction.y - heading.y * direction.x;
				const dot = heading.x * direction.x + heading.y * direction.y;
				return { candidate, score: cross * 1e9 - dot };
			}).sort((a, b) => b.score - a.score);
			path.push(ranked[0].candidate);
			current = ranked[0].candidate;
		}
	};
	const used = new Set<BoundaryEdge>();
	for (const edge of edges) {
		if (used.has(edge))
			continue;
		const loop = walk(edge, key(edge.start, tolerance));
		if (!loop)
			continue;
		loops.push(loop);
		for (const item of loop)
			used.add(item);
	}
	return loops;
}

export function buildShapeRegions(shapes: RegionShape[], options: BuildShapeRegionsOptions = {}): { regions: ClosedRegion[]; diagnostics: RegionDiagnostic[] } {
	const tolerance = options.endpointTolerance ?? DEFAULT_ENDPOINT_TOLERANCE;
	const curveSegments = options.curveSegments ?? DEFAULT_CURVE_SEGMENTS;
	const regions: ClosedRegion[] = [];
	const diagnostics: RegionDiagnostic[] = [];
	const openEdges: BoundaryEdge[] = [];
	for (const shape of shapes) {
		if (shape.type === 'rectangle') {
			const polygon = rectanglePolygon(shape);
			openEdges.push(...boundaryEdges(polygon, shape.id, true));
		}
		else if (shape.type === 'circle') {
			const polygon = circlePolygon(shape, curveSegments);
			regions.push(createRegion('circle', [shape.id], polygon, circleBBox(shape)));
		}
		else if (shape.type === 'ellipse') {
			const polygon = ellipsePolygon(shape, curveSegments);
			regions.push(createRegion('ellipse', [shape.id], polygon, ellipseBBox(shape)));
		}
		else if (shape.type === 'polyline') {
			if (shape.closed) {
				const polygon = shape.points;
				if (polygonHasSelfIntersection(polygon)) {
					diagnostics.push({ code: 'self-intersecting', sourceIds: [shape.id], message: 'Closed polyline self-intersects' });
					continue;
				}
				regions.push(createRegion('polyline', [shape.id], polygon, polygonBBox(polygon)));
			}
			else {
				openEdges.push(...boundaryEdges(shape.points, shape.id, false));
			}
		}
	}
	const loops = extractLoops(injectPolylineEndpoints(openEdges, tolerance), tolerance);
	const seenRegionKeys = new Set<string>();
	for (const loop of loops) {
		const polygon: Point[] = [];
		for (const edge of loop) {
			if (polygon.length === 0 || polygon[polygon.length - 1].x !== edge.start.x || polygon[polygon.length - 1].y !== edge.start.y)
				polygon.push(edge.start);
			// The walk may reverse an edge at a T-junction; the resulting vertex
			// sequence still traces the face when duplicates are skipped.
			polygon.push(edge.end);
		}
		if (polygon.length > 1 && polygon[0].x === polygon[polygon.length - 1].x && polygon[0].y === polygon[polygon.length - 1].y)
			polygon.pop();
		const compact = polygon.filter((point, index) => {
			const previous = polygon[index - 1];
			const next = polygon[index + 1];
			return !previous || !next || !(point.x === previous.x && point.y === previous.y) || !(point.x === next.x && point.y === next.y);
		});
		if (compact.length < 3) {
			diagnostics.push({ code: 'open-loop', sourceIds: loop.map(edge => edge.sourceId), message: 'Connected edges do not form a closed region' });
			continue;
		}
		if (polygonHasSelfIntersection(compact)) {
			diagnostics.push({ code: 'self-intersecting', sourceIds: loop.map(edge => edge.sourceId), message: 'Connected loop self-intersects' });
			continue;
		}
		const sourceIds = Array.from(new Set(loop.map(edge => edge.sourceId)));
		const polygonKey = compact.map(point => `${point.x},${point.y}`).join('\u0002');
		const regionKey = polygonKey;
		if (seenRegionKeys.has(regionKey))
			continue;
		seenRegionKeys.add(regionKey);
		regions.push(createRegion('polyline', sourceIds, compact, polygonBBox(compact)));
	}
	return { regions, diagnostics };
}

export function chooseSmallestContainingRegion(regions: ClosedRegion[], point: Point): ClosedRegion | null {
	const containing = regions.filter(region => regionContainsPoint(region, point));
	if (containing.length === 0)
		return null;
	return containing.sort((a, b) => (a.bbox.maxX - a.bbox.minX) * (a.bbox.maxY - a.bbox.minY) - (b.bbox.maxX - b.bbox.minX) * (b.bbox.maxY - b.bbox.minY))[0] ?? null;
}

export function regionContainsPoint(region: ClosedRegion, point: Point): boolean {
	return pointInPolygon(region.polygon, point);
}

export function regionIntersectsBBox(region: ClosedRegion, bbox: BBox): boolean {
	return region.intersectsBBox(bbox);
}
