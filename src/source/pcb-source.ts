import type { SourceRecord } from './source-log';
import { effectiveRecordsByType, parseSourceLog } from './source-log';

export interface SourcePcbComponent {
	id: string;
	designator: string;
	footprintUuid: string;
	deviceUuid: string;
	x: number;
	y: number;
	angle: number;
	layerId: number;
	groupId: number | string;
	locked: boolean;
	data: Record<string, unknown>;
	header: SourceRecord['header'];
}

export interface ParsedPcbDocument {
	uuid: string;
	components: SourcePcbComponent[];
	records: SourceRecord[];
}

function value(record: SourceRecord): Record<string, unknown> {
	return record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown): boolean {
	return value === true || value === 1 || value === '1' || (typeof value === 'string' && value.toLowerCase() === 'true');
}

function attributeValue(attrs: Record<string, unknown>, key: string): string {
	const wanted = key.toLowerCase();
	const actual = Object.keys(attrs).find(name => name.toLowerCase() === wanted);
	return stringValue(actual ? attrs[actual] : '');
}

export function extractPcbDocument(source: string): ParsedPcbDocument {
	const document = parseSourceLog(source);
	const attrs = new Map<string, Record<string, string>>();
	for (const record of effectiveRecordsByType(document, 'ATTR')) {
		const data = value(record);
		const parentId = stringValue(data.parentId);
		const key = stringValue(data.key);
		if (!parentId || !key)
			continue;
		if (!attrs.has(parentId))
			attrs.set(parentId, {});
		attrs.get(parentId)![key.toLowerCase()] = stringValue(data.value);
	}
	const components = effectiveRecordsByType(document, 'COMPONENT').map((record) => {
		const data = value(record);
		const id = String(record.header.id);
		const componentAttrs = attrs.get(id) ?? {};
		const embeddedAttrs = data.attrs && typeof data.attrs === 'object' && !Array.isArray(data.attrs) ? data.attrs as Record<string, unknown> : {};
		return {
			id,
			designator: componentAttrs.designator || attributeValue(embeddedAttrs, 'Designator') || stringValue(data.designator),
			footprintUuid: componentAttrs.footprint || attributeValue(embeddedAttrs, 'Footprint') || stringValue(data.footprintUuid),
			deviceUuid: componentAttrs.device || attributeValue(embeddedAttrs, 'Device') || stringValue(data.deviceUuid),
			x: numberValue(data.positionX ?? data.x),
			y: numberValue(data.positionY ?? data.y),
			angle: numberValue(data.rotation ?? data.angle),
			layerId: numberValue(data.layerId),
			groupId: typeof data.groupId === 'string' ? data.groupId : numberValue(data.groupId),
			locked: booleanValue(data.locked ?? data.primitiveLock ?? data.isLocked),
			data,
			header: record.header,
		};
	});
	return { uuid: document.uuid, components, records: document.records };
}

export function matchByDesignator(schematicDesignator: string, pcb: SourcePcbComponent[]): SourcePcbComponent | undefined {
	const matches = pcb.filter(component => component.designator === schematicDesignator);
	if (matches.length > 1)
		throw new Error(`Duplicate PCB designator: ${schematicDesignator}`);
	return matches[0];
}
