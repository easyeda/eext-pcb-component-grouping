import type { BBox } from '../grouping/core';
import { effectiveRecordsByType, parseSourceLog } from './source-log';

export interface FootprintGeometry {
	footprintUuid: string;
	bbox: BBox;
}

function number(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function addPoint(points: Array<[number, number]>, x: unknown, y: unknown): void {
	const nx = number(x);
	const ny = number(y);
	if (nx !== null && ny !== null)
		points.push([nx, ny]);
}

function collectPath(points: Array<[number, number]>, path: unknown): void {
	if (!Array.isArray(path))
		return;
	for (let index = 0; index + 1 < path.length; index += 1) {
		if (typeof path[index] === 'number' && typeof path[index + 1] === 'number')
			addPoint(points, path[index], path[index + 1]);
	}
}

function addBox(points: Array<[number, number]>, x: number, y: number, halfX: number, halfY: number): void {
	points.push([x - halfX, y - halfY], [x + halfX, y + halfY]);
}

function collectNestedNumericPairs(points: Array<[number, number]>, value: unknown): void {
	if (!Array.isArray(value))
		return;
	for (let index = 0; index + 1 < value.length; index += 1) {
		if (typeof value[index] === 'number' && typeof value[index + 1] === 'number')
			addPoint(points, value[index], value[index + 1]);
		else
			collectNestedNumericPairs(points, value[index]);
	}
}

function collectPrimitiveGeometry(points: Array<[number, number]>, data: Record<string, unknown>): void {
	points.push(...recordPoints(data));
	const x = number(data.centerX) ?? number(data.x) ?? number(data.positionX);
	const y = number(data.centerY) ?? number(data.y) ?? number(data.positionY);
	if (x === null || y === null)
		return;
	const width = number(data.width) ?? number(data.diameter) ?? number(data.radius);
	const height = number(data.height) ?? number(data.diameter) ?? number(data.radius);
	if (width !== null || height !== null)
		addBox(points, x, y, (width ?? 0) / 2, (height ?? width ?? 0) / 2);
	collectNestedNumericPairs(points, data.defaultPad);
}

function collectArrayGeometry(points: Array<[number, number]>, value: unknown): void {
	if (!Array.isArray(value))
		return;
	for (const item of value) {
		if (item && typeof item === 'object' && !Array.isArray(item))
			collectPrimitiveGeometry(points, item as Record<string, unknown>);
		else if (Array.isArray(item))
			collectArrayGeometry(points, item);
	}
	const numeric = value.filter(item => typeof item === 'number' && Number.isFinite(item)) as number[];
	for (let index = 0; index + 1 < numeric.length; index += 2)
		addPoint(points, numeric[index], numeric[index + 1]);
}

function recordPoints(data: Record<string, unknown>): Array<[number, number]> {
	const points: Array<[number, number]> = [];
	addPoint(points, data.x, data.y);
	addPoint(points, data.positionX, data.positionY);
	addPoint(points, data.startX, data.startY);
	addPoint(points, data.endX, data.endY);
	addPoint(points, data.centerX, data.centerY);
	addPoint(points, data.cx, data.cy);
	collectPath(points, data.path);
	return points;
}

export function extractFootprintGeometry(documentSource: string, footprintUuid: string): FootprintGeometry | null {
	const document = parseSourceLog(documentSource);
	const points: Array<[number, number]> = [];
	for (const record of document.records) {
		if (record.header.type === 'DOCHEAD' || record.header.type === 'ATTR')
			continue;
		if (!record.data || typeof record.data !== 'object')
			continue;
		if (Array.isArray(record.data))
			collectArrayGeometry(points, record.data);
		else
			collectPrimitiveGeometry(points, record.data as Record<string, unknown>);
	}
	if (points.length === 0)
		return null;
	return {
		footprintUuid,
		bbox: {
			minX: Math.min(...points.map(point => point[0])),
			minY: Math.min(...points.map(point => point[1])),
			maxX: Math.max(...points.map(point => point[0])),
			maxY: Math.max(...points.map(point => point[1])),
		},
	};
}

export function extractFootprintGeometries(sources: Array<{ footprintUuid: string; documentSource: string }>): Map<string, FootprintGeometry> {
	const geometries = new Map<string, FootprintGeometry>();
	for (const source of sources) {
		const geometry = extractFootprintGeometry(source.documentSource, source.footprintUuid);
		if (geometry)
			geometries.set(source.footprintUuid.trim().toLowerCase(), geometry);
		try {
			const document = parseSourceLog(source.documentSource);
			if (geometry)
				geometries.set(document.uuid.trim().toLowerCase(), geometry);
		}
		catch {
			// The external footprint UUID remains the primary key.
		}
	}
	return geometries;
}

export function transformFootprintBBox(geometry: BBox, x: number, y: number, angle: number, mirror: boolean): BBox {
	const radians = angle * Math.PI / 180;
	const corners = [[geometry.minX, geometry.minY], [geometry.minX, geometry.maxY], [geometry.maxX, geometry.minY], [geometry.maxX, geometry.maxY]];
	const transformed = corners.map(([px, py]) => {
		const mx = mirror ? -px : px;
		return [x + mx * Math.cos(radians) - py * Math.sin(radians), y + mx * Math.sin(radians) + py * Math.cos(radians)];
	});
	return {
		minX: Math.min(...transformed.map(point => point[0])),
		minY: Math.min(...transformed.map(point => point[1])),
		maxX: Math.max(...transformed.map(point => point[0])),
		maxY: Math.max(...transformed.map(point => point[1])),
	};
}

export function footprintRecordsCount(documentSource: string): number {
	return effectiveRecordsByType(parseSourceLog(documentSource), 'PAD').length;
}
