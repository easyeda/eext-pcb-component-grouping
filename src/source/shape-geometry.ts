export interface Point {
	x: number;
	y: number;
}

export interface BBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface Rectangle {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

export interface Circle {
	cx: number;
	cy: number;
	radius: number;
}

export interface Ellipse {
	cx: number;
	cy: number;
	radiusX: number;
	radiusY: number;
	rotation?: number;
}

function finite(value: number, name: string): number {
	if (!Number.isFinite(value))
		throw new Error(`${name} must be finite`);
	return value;
}

function positive(value: number, name: string): number {
	finite(value, name);
	if (value <= 0)
		throw new Error(`${name} must be greater than zero`);
	return value;
}

function point(value: Point, name: string): Point {
	if (!value || typeof value !== 'object')
		throw new Error(`${name} must be a point`);
	return { x: finite(value.x, `${name}.x`), y: finite(value.y, `${name}.y`) };
}

function orderedBBox(bbox: BBox): BBox {
	if (bbox.minX > bbox.maxX || bbox.minY > bbox.maxY)
		throw new Error('bbox coordinates must be ordered');
	return bbox;
}

export function rectangleBBox(rectangle: Rectangle): BBox {
	const x1 = finite(rectangle.x1, 'x1');
	const y1 = finite(rectangle.y1, 'y1');
	const x2 = finite(rectangle.x2, 'x2');
	const y2 = finite(rectangle.y2, 'y2');
	return { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) };
}

export function polylineBBox(points: readonly Point[], _closed = false): BBox {
	if (points.length === 0)
		throw new Error('polyline must contain at least one point');
	const checked = points.map((item, index) => point(item, `points[${index}]`));
	return {
		minX: Math.min(...checked.map(item => item.x)),
		minY: Math.min(...checked.map(item => item.y)),
		maxX: Math.max(...checked.map(item => item.x)),
		maxY: Math.max(...checked.map(item => item.y)),
	};
}

export function circleBBox(circle: Circle): BBox {
	const cx = finite(circle.cx, 'cx');
	const cy = finite(circle.cy, 'cy');
	const radius = positive(circle.radius, 'radius');
	return { minX: cx - radius, minY: cy - radius, maxX: cx + radius, maxY: cy + radius };
}

export function ellipseBBox(ellipse: Ellipse): BBox {
	const cx = finite(ellipse.cx, 'cx');
	const cy = finite(ellipse.cy, 'cy');
	const radiusX = positive(ellipse.radiusX, 'radiusX');
	const radiusY = positive(ellipse.radiusY, 'radiusY');
	const radians = finite(ellipse.rotation ?? 0, 'rotation') * Math.PI / 180;
	const extentX = Math.sqrt(radiusX ** 2 * Math.cos(radians) ** 2 + radiusY ** 2 * Math.sin(radians) ** 2);
	const extentY = Math.sqrt(radiusX ** 2 * Math.sin(radians) ** 2 + radiusY ** 2 * Math.cos(radians) ** 2);
	return { minX: cx - extentX, minY: cy - extentY, maxX: cx + extentX, maxY: cy + extentY };
}

export function rotatedBBox(bbox: BBox, rotation: number, center?: Point): BBox {
	orderedBBox(bbox);
	finite(rotation, 'rotation');
	const pivot = center ? point(center, 'center') : { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 };
	const radians = rotation * Math.PI / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const corners = [
		{ x: bbox.minX, y: bbox.minY },
		{ x: bbox.maxX, y: bbox.minY },
		{ x: bbox.maxX, y: bbox.maxY },
		{ x: bbox.minX, y: bbox.maxY },
	].map(item => ({ x: pivot.x + (item.x - pivot.x) * cos - (item.y - pivot.y) * sin, y: pivot.y + (item.x - pivot.x) * sin + (item.y - pivot.y) * cos }));
	return polylineBBox(corners);
}

export function containsPoint(bbox: BBox, item: Point, inclusive = true): boolean {
	orderedBBox(bbox);
	const checked = point(item, 'point');
	return inclusive
		? checked.x >= bbox.minX && checked.x <= bbox.maxX && checked.y >= bbox.minY && checked.y <= bbox.maxY
		: checked.x > bbox.minX && checked.x < bbox.maxX && checked.y > bbox.minY && checked.y < bbox.maxY;
}

export function quantizeEndpoint(value: number, quantum: number): number {
	finite(value, 'value');
	positive(quantum, 'quantum');
	const result = Math.round(value / quantum) * quantum;
	return Number(result.toPrecision(12));
}

export function quantizePolylineEndpoints(points: readonly Point[], quantum: number): Point[] {
	positive(quantum, 'quantum');
	return points.map((item, index) => {
		const checked = point(item, `points[${index}]`);
		return { x: quantizeEndpoint(checked.x, quantum), y: quantizeEndpoint(checked.y, quantum) };
	});
}
