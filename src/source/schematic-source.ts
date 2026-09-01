import type { ClosedRegion } from './shape-regions';
import type { SourceRecord } from './source-log';
import { circleBBox, ellipseBBox, polylineBBox, rectangleBBox } from './shape-geometry';
import { buildShapeRegions } from './shape-regions';
import { effectiveRecordsByType, parseSourceLog } from './source-log';

export interface BBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface SourceSchematicComponent {
	id: string;
	designator: string;
	name: string;
	uniqueId: string;
	x: number;
	y: number;
	rotation: number;
	mirror: boolean;
	attrs: Record<string, string>;
	designatorX: number | null;
	designatorY: number | null;
}

export interface SourceSchematicText {
	id: string;
	content: string;
	x: number;
	y: number;
	rotation: number;
	fontSize: number;
	bbox: BBox;
}

export interface SourceRect {
	id: string;
	label: string;
	bbox: BBox;
}

export interface SourceRegionGroup {
	id: string;
	label: string;
	sourceIds: string[];
	bbox: BBox;
}

export type SourceSchematicShape
	= | { id: string; type: 'RECT'; rotation: number; bbox: BBox; corner1: { x: number; y: number }; corner2: { x: number; y: number } }
		| { id: string; type: 'POLY'; points: Array<{ x: number; y: number }>; closed: boolean; bbox: BBox }
		| { id: string; type: 'CIRCLE'; center: { x: number; y: number }; radius: number; bbox: BBox }
		| { id: string; type: 'ELLIPSE'; center: { x: number; y: number }; radiusX: number; radiusY: number; rotation: number; bbox: BBox };

export interface SourceSchematicDiagnostic {
	id: string;
	type: string;
	message: string;
}

export interface ParsedSchematicPage {
	uuid: string;
	rects: SourceRect[];
	regions: SourceRegionGroup[];
	shapes: SourceSchematicShape[];
	diagnostics: SourceSchematicDiagnostic[];
	components: SourceSchematicComponent[];
	texts: SourceSchematicText[];
}

function number(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value.trim() || fallback : fallback;
}

function primitiveData(record: SourceRecord): Record<string, unknown> {
	return record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {};
}

function rectBBox(data: Record<string, unknown>): BBox {
	return rectangleBBox({
		x1: number(data.dotX1),
		y1: number(data.dotY1),
		x2: number(data.dotX2),
		y2: number(data.dotY2),
	});
}

function parsePolyPoints(points: unknown): Array<{ x: number; y: number }> | null {
	if (!Array.isArray(points) || points.length < 2)
		return null;
	const source = points.every(item => typeof item === 'number') && points.length % 2 === 0
		? points.flatMap((_, index) => index % 2 === 0 ? [[points[index], points[index + 1]] as [number, number]] : [])
		: points as Array<Record<string, unknown>>;
	const parsed: Array<{ x: number; y: number }> = [];
	for (const item of source) {
		const x = Array.isArray(item) ? item[0] : item.x;
		const y = Array.isArray(item) ? item[1] : item.y;
		const numericX = number(x, Number.NaN);
		const numericY = number(y, Number.NaN);
		if (!Number.isFinite(numericX) || !Number.isFinite(numericY))
			return null;
		parsed.push({ x: numericX, y: numericY });
	}
	return parsed;
}

function toRegionShape(shape: SourceSchematicShape): import('./shape-regions').RegionShape | null {
	switch (shape.type) {
		case 'RECT':
			return { type: 'rectangle', id: shape.id, x1: shape.corner1.x, y1: shape.corner1.y, x2: shape.corner2.x, y2: shape.corner2.y };
		case 'POLY':
			return { type: 'polyline', id: shape.id, points: shape.points, closed: shape.closed };
		case 'CIRCLE':
			return { type: 'circle', id: shape.id, cx: shape.center.x, cy: shape.center.y, radius: shape.radius };
		case 'ELLIPSE':
			return { type: 'ellipse', id: shape.id, cx: shape.center.x, cy: shape.center.y, radiusX: shape.radiusX, radiusY: shape.radiusY, rotation: shape.rotation };
	}
}

function parseShapeRecord(record: SourceRecord, attrs: Record<string, string>, diagnostics: SourceSchematicDiagnostic[]): SourceSchematicShape | null {
	const data = primitiveData(record);
	const id = String(record.header.id);
	switch (record.header.type) {
		case 'RECT': {
			const rotation = number(data.rotation);
			const corner1 = { x: number(data.dotX1), y: number(data.dotY1) };
			const corner2 = { x: number(data.dotX2), y: number(data.dotY2) };
			const bbox = rectBBox(data);
			return { id, type: 'RECT', rotation, bbox, corner1, corner2 };
		}
		case 'POLY': {
			const points = parsePolyPoints(data.points);
			if (!points || points.length < 2) {
				diagnostics.push({ id, type: 'POLY', message: 'POLY has invalid or missing points' });
				return null;
			}
			const closed = data.closed === true || data.closed === 1;
			return { id, type: 'POLY', points, closed, bbox: polylineBBox(points, closed) };
		}
		case 'CIRCLE': {
			const center = { x: number(data.centerX), y: number(data.centerY) };
			const radius = number(data.radius);
			if (radius <= 0) {
				diagnostics.push({ id, type: 'CIRCLE', message: 'CIRCLE has invalid radius' });
				return null;
			}
			return { id, type: 'CIRCLE', center, radius, bbox: circleBBox({ cx: center.x, cy: center.y, radius }) };
		}
		case 'ELLIPSE': {
			const center = { x: number(data.centerX), y: number(data.centerY) };
			const radiusX = number(data.radiusX);
			const radiusY = number(data.radiusY);
			const rotation = number(data.rotation);
			if (radiusX <= 0 || radiusY <= 0) {
				diagnostics.push({ id, type: 'ELLIPSE', message: 'ELLIPSE has invalid radii' });
				return null;
			}
			return { id, type: 'ELLIPSE', center, radiusX, radiusY, rotation, bbox: ellipseBBox({ cx: center.x, cy: center.y, radiusX, radiusY, rotation }) };
		}
		default:
			return null;
	}
}

function shapeRegionLabel(sourceIds: string[], shapeNames: Map<string, string>, kind: ClosedRegion['kind'], index: number): string {
	const name = sourceIds.map(id => shapeNames.get(id)).find(Boolean);
	if (name)
		return name;
	const names: Record<ClosedRegion['kind'], string> = { rectangle: '矩形', polyline: '折线', circle: '圆形', ellipse: '椭圆' };
	return `${names[kind]} ${index + 1}`;
}

export function extractSchematicPage(source: string): ParsedSchematicPage {
	const document = parseSourceLog(source);
	const rectRecords = effectiveRecordsByType(document, 'RECT');
	const polyRecords = effectiveRecordsByType(document, 'POLY');
	const circleRecords = effectiveRecordsByType(document, 'CIRCLE');
	const ellipseRecords = effectiveRecordsByType(document, 'ELLIPSE');
	const arcRecords = effectiveRecordsByType(document, 'ARC');
	const componentRecords = effectiveRecordsByType(document, 'COMPONENT');
	const attrRecords = effectiveRecordsByType(document, 'ATTR');
	const textRecords = effectiveRecordsByType(document, 'TEXT');
	const diagnostics: SourceSchematicDiagnostic[] = [];
	const attrsByParent = new Map<string, Record<string, string>>();
	for (const record of attrRecords) {
		const data = primitiveData(record);
		const parentId = text(data.parentId);
		const key = text(data.key);
		if (!parentId || !key)
			continue;
		if (!attrsByParent.has(parentId))
			attrsByParent.set(parentId, {});
		attrsByParent.get(parentId)![key] = text(data.value);
	}
	const shapeRecords = [...rectRecords, ...polyRecords, ...circleRecords, ...ellipseRecords];
	const shapes = shapeRecords
		.map(record => parseShapeRecord(record, attrsByParent.get(String(record.header.id)) ?? {}, diagnostics))
		.filter((shape): shape is SourceSchematicShape => shape !== null);
	for (const record of arcRecords)
		diagnostics.push({ id: String(record.header.id), type: 'ARC', message: 'ARC retained without normalized bbox' });
	const rects = shapes
		.filter((shape): shape is Extract<SourceSchematicShape, { type: 'RECT' }> => shape.type === 'RECT')
		.map((shape, index) => ({ id: shape.id, label: attrsByParent.get(shape.id)?.Name ?? `矩形 ${index + 1}`, bbox: shape.bbox }));
	const regionShapes = shapes.map(toRegionShape).filter((shape): shape is import('./shape-regions').RegionShape => shape !== null);
	const builtRegions = buildShapeRegions(regionShapes);
	const shapeNames = new Map(shapes.map(shape => [shape.id, attrsByParent.get(shape.id)?.Name ?? '']));
	const regions: SourceRegionGroup[] = builtRegions.regions.map((region, index) => ({
		id: region.sourceIds[0] ?? `region-${index + 1}`,
		label: shapeRegionLabel(region.sourceIds, shapeNames, region.kind, index),
		sourceIds: region.sourceIds,
		bbox: region.bbox,
	}));
	const components = componentRecords.map((record) => {
		const data = primitiveData(record);
		const id = String(record.header.id);
		const attrs = attrsByParent.get(id) ?? {};
		const designatorRecord = attrRecords.find((attr) => {
			const attrData = primitiveData(attr);
			return attrData.parentId === id && attrData.key === 'Designator';
		});
		const designatorData = designatorRecord ? primitiveData(designatorRecord) : {};
		return {
			id,
			designator: attrs.Designator ?? '',
			name: attrs.Device ?? attrs.Name ?? '',
			uniqueId: attrs['Unique ID'] ?? attrs.UniqueID ?? '',
			x: number(data.x ?? data.positionX),
			y: number(data.y ?? data.positionY),
			rotation: number(data.rotation),
			mirror: Boolean(data.isMirror),
			attrs,
			designatorX: typeof designatorData.x === 'number' ? designatorData.x : null,
			designatorY: typeof designatorData.y === 'number' ? designatorData.y : null,
		};
	});
	const texts = textRecords.map((record) => {
		const data = primitiveData(record);
		const x = number(data.x);
		const y = number(data.y);
		const fontSize = number(data.fontSize, 30);
		const content = text(data.value ?? data.text);
		const lines = content.split(/\r?\n/);
		const maxLineLength = Math.max(1, ...lines.map(line => line.length));
		const lineHeight = fontSize * 1.2;
		return { id: String(record.header.id), content, x, y, rotation: number(data.rotation), fontSize, bbox: { minX: x, minY: y - lines.length * lineHeight, maxX: x + Math.max(fontSize, maxLineLength * fontSize * 0.65), maxY: y } };
	});
	return { uuid: document.uuid, rects, regions, shapes, diagnostics, components, texts };
}

export function containsPoint(rect: BBox, x: number, y: number): boolean {
	return x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY;
}

export function intersects(a: BBox, b: BBox): boolean {
	return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}
