import type { SourceRecord } from './source-log';
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

export interface ParsedSchematicPage {
	uuid: string;
	rects: SourceRect[];
	components: SourceSchematicComponent[];
	texts: SourceSchematicText[];
}

function number(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value.trim() || fallback : fallback;
}

function bbox(points: Array<[number, number]>): BBox {
	return {
		minX: Math.min(...points.map(point => point[0])),
		minY: Math.min(...points.map(point => point[1])),
		maxX: Math.max(...points.map(point => point[0])),
		maxY: Math.max(...points.map(point => point[1])),
	};
}

function rectBBox(data: Record<string, unknown>): BBox {
	const x1 = number(data.dotX1);
	const y1 = number(data.dotY1);
	const x2 = number(data.dotX2);
	const y2 = number(data.dotY2);
	const rotation = number(data.rotation);
	const radians = rotation * Math.PI / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const points: Array<[number, number]> = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]].map(([x, y]) => [
		x1 + (x - x1) * cos - (y - y1) * sin,
		y1 + (x - x1) * sin + (y - y1) * cos,
	]);
	return bbox(points);
}

function primitiveData(record: SourceRecord): Record<string, unknown> {
	return record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {};
}

export function extractSchematicPage(source: string): ParsedSchematicPage {
	const document = parseSourceLog(source);
	const rectRecords = effectiveRecordsByType(document, 'RECT');
	const componentRecords = effectiveRecordsByType(document, 'COMPONENT');
	const attrRecords = effectiveRecordsByType(document, 'ATTR');
	const textRecords = effectiveRecordsByType(document, 'TEXT');
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
	const rects = rectRecords.map((record, index) => {
		const data = primitiveData(record);
		const attrs = attrsByParent.get(String(record.header.id)) ?? {};
		return { id: String(record.header.id), label: attrs.Name || `矩形 ${index + 1}`, bbox: rectBBox(data) };
	});
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
	return { uuid: document.uuid, rects, components, texts };
}

export function containsPoint(rect: BBox, x: number, y: number): boolean {
	return x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY;
}

export function intersects(a: BBox, b: BBox): boolean {
	return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}
