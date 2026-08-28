import type { BBox, ComponentAssignment, GroupingMode, PageGroupingResult, PcbComponentRecord, ProjectGroupingResult, SchematicTextRecord } from '../grouping/core';
import type { SourcePcbComponent } from './pcb-source';
import type { SourceHeader } from './source-log';
import { extractFootprintGeometries, transformFootprintBBox } from './footprint-source';
import { extractPcbDocument, matchByDesignator } from './pcb-source';
import { containsPoint, extractSchematicPage, intersects } from './schematic-source';
import { appendRecords, effectiveRecordsByType, getMaxTicket, parseSourceLog } from './source-log';

declare const eda: any;

const GENERATED_PREFIX = 'spg_';
const DOCUMENT_LAYER = 13;
const STORAGE_KEY = 'schematic-pcb-grouping:last-result';
const SOURCE_BACKUP_KEY = 'schematic-pcb-grouping:source-backup';

function requestConfirmation(content: string): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: boolean): void => {
			if (settled)
				return;
			settled = true;
			console.warn('[SourceGrouping] confirmation callback', value);
			resolve(value);
		};
		try {
			const result = eda.sys_Dialog.showConfirmationMessage(content, '矩形分组', '确定', '取消', finish);
			console.warn('[SourceGrouping] confirmation invocation', { returnType: typeof result, returnValue: result });
			if (typeof result === 'boolean')
				finish(result);
			else if (result && typeof result.then === 'function')
				result.then(finish).catch(() => finish(false));
		}
		catch (error) {
			console.error('[SourceGrouping] confirmation invocation failed', error);
			finish(false);
		}
	});
}

interface PendingRecord {
	header: SourceHeader;
	data: unknown | '';
}

interface PlannedGroup {
	page: PageGroupingResult;
	label: string;
	components: SourcePcbComponent[];
	texts: SchematicTextRecord[];
	sourceRectId: string;
}

function createId(index: number): string {
	return `${GENERATED_PREFIX}${Date.now().toString(16)}_${index.toString(16)}`;
}

function toSchematicComponent(component: ReturnType<typeof extractSchematicPage>['components'][number], pageName: string, pageUuid: string, rectangleId: string | null, rectangleLabel: string | null): ComponentAssignment {
	return {
		primitiveId: component.id,
		label: component.designator || component.name || component.id,
		designator: component.designator,
		name: component.name,
		uniqueId: component.uniqueId,
		pageName,
		pageUuid,
		x: component.x,
		y: component.y,
		rotation: component.rotation,
		rectangleId,
		rectangleLabel,
	};
}

function toSchematicText(item: ReturnType<typeof extractSchematicPage>['texts'][number], pageName: string, pageUuid: string): SchematicTextRecord {
	return { primitiveId: item.id, label: item.content || item.id, content: item.content, pageName, pageUuid, x: item.x, y: item.y, rotation: item.rotation, fontSize: item.fontSize, bbox: item.bbox };
}

function buildPageResult(source: string, boardName: string, boardIndex: number, schematicUuid: string, pageName: string, mode: Exclude<GroupingMode, 'selection'>): PageGroupingResult {
	const parsed = extractSchematicPage(source);
	const warnings: string[] = [];
	if (mode === 'page') {
		const componentPoints = parsed.components.map(component => ({ minX: component.x, minY: component.y, maxX: component.x, maxY: component.y }));
		const bbox: BBox = componentPoints.length
			? {
					minX: Math.min(...componentPoints.map(item => item.minX)),
					minY: Math.min(...componentPoints.map(item => item.minY)),
					maxX: Math.max(...componentPoints.map(item => item.maxX)),
					maxY: Math.max(...componentPoints.map(item => item.maxY)),
				}
			: { minX: 0, minY: 0, maxX: 100, maxY: 100 };
		return { boardName, boardIndex, schematicUuid, pageUuid: parsed.uuid, pageName, rectangles: [{ primitiveId: `page-${parsed.uuid}`, label: pageName, bbox, components: parsed.components.map(component => toSchematicComponent(component, pageName, parsed.uuid, `page-${parsed.uuid}`, pageName)), texts: parsed.texts.map(item => toSchematicText(item, pageName, parsed.uuid)) }], unclassified: [], warnings };
	}
	const assignments = parsed.components.map((component) => {
		const anchorX = component.designatorX ?? component.x;
		const anchorY = component.designatorY ?? component.y;
		const hits = parsed.rects.filter(rect => containsPoint(rect.bbox, anchorX, anchorY) || containsPoint(rect.bbox, component.x, component.y)).sort((a, b) => (a.bbox.maxX - a.bbox.minX) * (a.bbox.maxY - a.bbox.minY) - (b.bbox.maxX - b.bbox.minX) * (b.bbox.maxY - b.bbox.minY));
		const rect = hits[0];
		if (!rect && mode !== 'hybrid')
			warnings.push(`页面 ${pageName} 中器件 ${component.designator || component.id} 未落入任何矩形（锚点 ${anchorX},${anchorY}）。`);
		return toSchematicComponent(component, pageName, parsed.uuid, rect?.id ?? null, rect?.label ?? null);
	});
	const rectangles = parsed.rects.map(rect => ({ primitiveId: rect.id, label: rect.label, bbox: rect.bbox, components: assignments.filter(item => item.rectangleId === rect.id), texts: parsed.texts.filter(item => containsPoint(rect.bbox, item.x, item.y) || intersects(rect.bbox, item.bbox)).map(item => toSchematicText(item, pageName, parsed.uuid)) }));
	const unclassified = assignments.filter(item => !item.rectangleId);
	if (mode === 'hybrid' && unclassified.length) {
		const pageGroupId = `page-unframed-${parsed.uuid}`;
		const points = unclassified.map(component => ({ minX: component.x, minY: component.y, maxX: component.x, maxY: component.y }));
		const bbox: BBox = {
			minX: Math.min(...points.map(item => item.minX)),
			minY: Math.min(...points.map(item => item.minY)),
			maxX: Math.max(...points.map(item => item.maxX)),
			maxY: Math.max(...points.map(item => item.maxY)),
		};
		const framedTextIds = new Set(rectangles.flatMap(rectangle => rectangle.texts.map(text => text.primitiveId)));
		rectangles.push({
			primitiveId: pageGroupId,
			label: `${pageName}（未框选）`,
			bbox,
			components: unclassified.map(component => ({ ...component, rectangleId: pageGroupId, rectangleLabel: `${pageName}（未框选）` })),
			texts: parsed.texts.filter(item => !framedTextIds.has(item.id)).map(item => toSchematicText(item, pageName, parsed.uuid)),
		});
	}
	return {
		boardName,
		boardIndex,
		schematicUuid,
		pageUuid: parsed.uuid,
		pageName,
		rectangles,
		unclassified: mode === 'hybrid' ? [] : unclassified,
		warnings,
	};
}

function componentBBox(component: SourcePcbComponent, geometry?: Map<string, BBox>): BBox {
	const measured = geometry?.get(component.id);
	if (measured)
		return measured;
	return componentFallbackBBox(component);
}

function sourceComponentGeometry(_component: SourcePcbComponent, _records: ReturnType<typeof parseSourceLog>['records']): BBox | null {
	// COMPONENT/ATTR/PAD_NET records contain absolute text and net coordinates,
	// not the footprint-local outline. Treating those values as geometry inflates
	// the bbox by thousands of mils, so only the footprint source may provide it.
	return null;
}

async function measurePcbGeometry(components: SourcePcbComponent[], footprintSources: Array<{ footprintUuid: string; documentSource: string }>, records: ReturnType<typeof parseSourceLog>['records']): Promise<Map<string, BBox>> {
	const geometry = new Map<string, BBox>();
	const footprints = extractFootprintGeometries(footprintSources);
	for (const component of components) {
		const footprint = footprints.get(component.footprintUuid.trim().toLowerCase()) || footprints.get(component.data.footprintUuid && String(component.data.footprintUuid).trim().toLowerCase());
		if (footprint) {
			geometry.set(component.id, transformFootprintBBox(footprint.bbox, component.x, component.y, component.angle, component.layerId === 2));
			continue;
		}
		const local = sourceComponentGeometry(component, records);
		if (local)
			geometry.set(component.id, local);
	}
	// The beta footprint-source API is empty in some documents. Measure only the
	// missing component geometry in bounded parallel batches; all placement and
	// writing remains source-driven.
	const missing = components.filter(component => !geometry.has(component.id));
	for (let offset = 0; offset < missing.length; offset += 12) {
		const batch = missing.slice(offset, offset + 12);
		const boxes = await Promise.all(batch.map(component => eda.pcb_Primitive.getPrimitivesBBox([component.id]).catch(() => undefined)));
		for (let index = 0; index < batch.length; index++)
			geometry.set(batch[index].id, boxes[index] ?? componentFallbackBBox(batch[index]));
	}
	return geometry;
}

function componentFallbackBBox(component: SourcePcbComponent): BBox {
	const name = component.footprintUuid.toLowerCase();
	let width = 150;
	let height = 100;
	if (/screen|14cf8bd8454bda87/.test(name)) {
		width = 2100;
		height = 1100;
	}
	else if (/h618|67684515093d9c1d/.test(name)) {
		width = 1500;
		height = 1150;
	}
	else if (/hdmi|20e9004a15e48e80/.test(name)) {
		width = 800;
		height = 550;
	}
	else if (/rj-|3e3cbe312db63af5/.test(name)) {
		width = 700;
		height = 750;
	}
	else if (/esop|5a11c8bea3005e61/.test(name)) {
		width = 280;
		height = 320;
	}
	else if (/^u/i.test(component.designator)) {
		width = 500;
		height = 400;
	}
	else if (/h618|screen|hdmi|rj-|conn|audio|sot|ipex|sw-|module|usb/.test(name)) {
		width = 800;
		height = 800;
	}
	else if (/^r|^c|^l|^d/i.test(component.designator) || /0402|0603|0805/.test(name)) {
		width = 125;
		height = 70;
	}
	return { minX: component.x - width / 2, minY: component.y - height / 2, maxX: component.x + width / 2, maxY: component.y + height / 2 };
}

function componentLayoutBBox(component: SourcePcbComponent, geometry: Map<string, BBox>, silkRecords: ReturnType<typeof effectiveRecordsByType>): BBox {
	const body = componentBBox(component, geometry);
	const result = { ...body };
	for (const record of silkRecords) {
		const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {};
		if (data.parentId !== component.id || String(data.key ?? '').toLowerCase() !== 'designator' || !(data.valueVisible === true || data.valueVisible === 1))
			continue;
		const fontSize = typeof data.fontSize === 'number' && data.fontSize > 0 ? data.fontSize : 45;
		const text = String(data.value ?? component.designator);
		const textWidth = Math.max(fontSize, text.length * fontSize * 0.62);
		// Reserve the exact target used by componentSilkRecords. The original
		// attribute coordinates are stale after packing and cannot drive layout.
		result.minX = Math.min(result.minX, body.minX);
		result.maxX = Math.max(result.maxX, body.minX + textWidth);
		result.maxY = Math.max(result.maxY, body.maxY + 5 + fontSize);
	}
	return result;
}

function moveComponentData(component: SourcePcbComponent, x: number, y: number, angle: number): Record<string, unknown> {
	const data = { ...component.data };
	if ('x' in data)
		data.x = x;
	if ('y' in data)
		data.y = y;
	if ('angle' in data)
		data.angle = angle;
	if ('positionX' in data)
		data.positionX = x;
	if ('positionY' in data)
		data.positionY = y;
	if ('rotation' in data)
		data.rotation = angle;
	return data;
}

function componentSilkRecords(source: SourcePcbComponent, target: SourcePcbComponent, body: BBox, records: ReturnType<typeof effectiveRecordsByType>): PendingRecord[] {
	const result: PendingRecord[] = [];
	for (const record of records) {
		const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {};
		if (data.parentId !== source.id || String(data.key ?? '').toLowerCase() !== 'designator' || !(data.valueVisible === true || data.valueVisible === 1))
			continue;
		const nextX = target.x + body.minX - source.x;
		const nextY = target.y + body.maxY - source.y + 5;
		const next: Record<string, unknown> = { ...data, parentId: source.id, layerId: 3, mirror: target.layerId === 2 };
		if ('positionX' in data)
			next.positionX = nextX;
		if ('positionY' in data)
			next.positionY = nextY;
		if ('x' in data)
			next.x = nextX;
		if ('y' in data)
			next.y = nextY;
		if ('angle' in data)
			next.angle = target.angle;
		if ('rotation' in data)
			next.rotation = target.angle;
		result.push({ header: { ...record.header, ticket: 0 }, data: next });
	}
	return result;
}

function normalizedDesignator(value: string): string {
	// Multi-part symbols may be written as U1A/U1B while the PCB contains U1.
	return value.trim().toUpperCase().replace(/([A-Z]+\d+)[A-Z]+$/, '$1');
}

function planGroups(pages: PageGroupingResult[], pcbComponents: SourcePcbComponent[]): PlannedGroup[] {
	const movableComponents = pcbComponents.filter(component => !component.locked);
	const claimed = new Set<string>();
	const groups: PlannedGroup[] = [];
	const ordered = pages.flatMap(page => page.rectangles.map(rect => ({ page, rect })));
	// Hybrid page-level remainder groups are always placed after all explicit
	// schematic rectangles across the Board.
	ordered.sort((a, b) => Number(a.rect.primitiveId.startsWith('page-unframed-')) - Number(b.rect.primitiveId.startsWith('page-unframed-')));
	for (const { page, rect } of ordered) {
		const components: SourcePcbComponent[] = [];
		for (const item of rect.components) {
			const wanted = normalizedDesignator(item.designator);
			if (!wanted)
				continue;
			const pcb = movableComponents.find(component => normalizedDesignator(component.designator) === wanted) ?? matchByDesignator(item.designator, movableComponents);
			if (!pcb || claimed.has(pcb.id))
				continue;
			claimed.add(pcb.id);
			components.push(pcb);
		}
		if (components.length)
			groups.push({ page, label: rect.label, sourceRectId: rect.primitiveId, texts: rect.texts, components });
	}
	return groups;
}

function prefixOf(designator: string): string {
	return /^[A-Z]+/i.exec(designator)?.[0].toUpperCase() ?? 'OTHER';
}

function prefixRank(prefix: string): number {
	const rank = ['U', 'R', 'C', 'L', 'D', 'Q'];
	const index = rank.indexOf(prefix);
	return index < 0 ? 99 : index;
}

function buildPcbPatch(source: string, groups: PlannedGroup[], geometry: Map<string, BBox>): { source: string; overlays: ProjectGroupingResult['pcbOverlays']; updated: SourcePcbComponent[] } {
	const document = parseSourceLog(source);
	let ticket = getMaxTicket(document);
	const pending: PendingRecord[] = [];
	const silkRecords = effectiveRecordsByType(document, 'ATTR');
	for (const record of document.records) {
		if (record.header.id?.startsWith(GENERATED_PREFIX) && record.header.type !== 'DOCHEAD')
			pending.push({ header: { type: record.header.type, id: record.header.id, ticket: ++ticket }, data: '' });
	}
	const overlays: ProjectGroupingResult['pcbOverlays'] = [];
	const updated: SourcePcbComponent[] = [];
	let groupX = 0;
	let groupY = 0;
	let rowHeight = 0;
	let generatedIndex = 0;
	const estimatedGroupArea = (group: PlannedGroup): number => {
		const boxes = group.components.map(component => componentLayoutBBox(component, geometry, silkRecords));
		const width = boxes.reduce((sum, box) => sum + box.maxX - box.minX + 10, 30);
		const height = Math.max(...boxes.map(box => box.maxY - box.minY), 1) + 120;
		return width * height;
	};
	const sortedGroups = [...groups].sort((a, b) => estimatedGroupArea(a) - estimatedGroupArea(b) || a.components.length - b.components.length || a.label.localeCompare(b.label, undefined, { numeric: true }));
	const groupSizes = sortedGroups.map((group) => {
		const byPrefix = new Map<string, SourcePcbComponent[]>();
		for (const component of group.components) {
			const prefix = prefixOf(component.designator);
			if (!byPrefix.has(prefix))
				byPrefix.set(prefix, []);
			byPrefix.get(prefix)!.push(component);
		}
		const rows = Array.from(byPrefix.entries()).sort(([a], [b]) => prefixRank(a) - prefixRank(b)).map(([, items]) => {
			const boxes = items.map(item => componentLayoutBBox(item, geometry, silkRecords));
			return {
				width: boxes.reduce((sum, box) => sum + box.maxX - box.minX, 0) + Math.max(0, boxes.length - 1) * 20,
				height: Math.max(...boxes.map(box => box.maxY - box.minY)),
			};
		});
		return {
			width: Math.max(...rows.map(row => row.width)) + 60,
			height: rows.reduce((sum, row) => sum + row.height, 0) + Math.max(0, rows.length - 1) * 20 + 130,
		};
	});
	const totalArea = groupSizes.reduce((sum, size) => sum + size.width * size.height, 0);
	const maxGroupWidth = Math.max(...groupSizes.map(size => size.width));
	const rowLimit = Math.max(maxGroupWidth, Math.round(Math.sqrt(totalArea)));
	for (const group of sortedGroups) {
		const sorted = [...group.components].sort((a, b) => prefixRank(prefixOf(a.designator)) - prefixRank(prefixOf(b.designator)) || prefixOf(a.designator).localeCompare(prefixOf(b.designator)) || a.designator.localeCompare(b.designator, undefined, { numeric: true }));
		const rowMap = new Map<string, SourcePcbComponent[]>();
		for (const component of sorted) {
			const prefix = prefixOf(component.designator);
			if (!rowMap.has(prefix))
				rowMap.set(prefix, []);
			rowMap.get(prefix)!.push(component);
		}
		const rows = Array.from(rowMap.entries()).sort(([a, aItems], [b, bItems]) => aItems.length - bItems.length || prefixRank(a) - prefixRank(b));
		const componentGap = 10;
		const rowGap = 15;
		const margin = 15;
		const rowSizes = rows.map(([, items]) => {
			const boxes = items.map(component => componentLayoutBBox(component, geometry, silkRecords));
			return {
				width: boxes.reduce((total, box) => total + box.maxX - box.minX, 0) + Math.max(0, boxes.length - 1) * componentGap,
				height: Math.max(...boxes.map(box => box.maxY - box.minY)),
			};
		});
		const width = Math.max(...rowSizes.map(row => row.width)) + margin * 2;
		const contentHeight = rowSizes.reduce((total, row) => total + row.height, 0) + Math.max(0, rowSizes.length - 1) * rowGap;
		const labelHeight = 70;
		const height = contentHeight + margin * 2 + labelHeight + 20;
		if (groupX > 0 && groupX + width > rowLimit) {
			groupX = 0;
			groupY += rowHeight + 120;
			rowHeight = 0;
		}
		const minX = groupX;
		const minY = groupY;
		let rowTop = minY + margin;
		const placedBoxes: BBox[] = [];
		for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
			const row = rows[rowIndex][1];
			const rowHeight = rowSizes[rowIndex].height;
			let cursorX = minX + margin;
			for (const component of row) {
				const content = componentLayoutBBox(component, geometry, silkRecords);
				const body = componentBBox(component, geometry);
				let x = cursorX - (content.minX - component.x);
				let y = rowTop - (content.minY - component.y);
				for (let pass = 0; pass < placedBoxes.length + 1; pass += 1) {
					const candidate = { minX: content.minX + x - component.x, minY: content.minY + y - component.y, maxX: content.maxX + x - component.x, maxY: content.maxY + y - component.y };
					const hit = placedBoxes.find(previous => candidate.minX < previous.maxX && candidate.maxX > previous.minX && candidate.minY < previous.maxY && candidate.maxY > previous.minY);
					if (!hit)
						break;
					const pushX = hit.maxX - candidate.minX + componentGap;
					const pushY = hit.maxY - candidate.minY + rowGap;
					if (pushX <= pushY)
						x += pushX;
					else
						y += pushY;
				}
				placedBoxes.push({ minX: content.minX + x - component.x, minY: content.minY + y - component.y, maxX: content.maxX + x - component.x, maxY: content.maxY + y - component.y });
				const angle = /^[RCL]\d+/i.test(component.designator) ? 0 : component.angle;
				const moved = { ...component, x, y, angle };
				const componentData = moveComponentData(component, x, y, angle);
				pending.push({ header: { ...component.header, ticket: ++ticket }, data: componentData });
				for (const silk of componentSilkRecords(component, moved, body, silkRecords))
					pending.push({ header: { ...silk.header, ticket: ++ticket }, data: silk.data });
				updated.push(moved);
				cursorX = Math.max(cursorX + content.maxX - content.minX + componentGap, placedBoxes[placedBoxes.length - 1].maxX + componentGap);
			}
			rowTop = Math.max(rowTop + rowHeight, ...placedBoxes.map(box => box.maxY)) + rowGap;
		}
		const textLines = [`${group.page.pageName} / ${group.label}`, ...group.texts.flatMap(text => text.content.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
		const labelWidth = Math.max(...textLines.map(text => Math.max(30, text.length * 30 * 0.62)));
		const contentMaxY = Math.max(minY + margin + contentHeight, ...placedBoxes.map(box => box.maxY));
		const separatorY = contentMaxY + 20;
		const finalMaxX = Math.max(minX + width, minX + margin + labelWidth, ...placedBoxes.map(box => box.maxX + margin));
		const finalMaxY = Math.max(minY + height, separatorY + 35 + textLines.length * 40 + margin);
		const finalWidth = finalMaxX - minX;
		const finalHeight = finalMaxY - minY;
		const rectId = createId(generatedIndex++);
		pending.push({ header: { type: 'POLY', id: rectId, ticket: ++ticket }, data: { partitionId: '', groupId: 0, netName: '', layerId: DOCUMENT_LAYER, width: 10, path: ['R', minX, finalMaxY, finalWidth, finalHeight, 0, 0], locked: false, zIndex: -1, polyType: 'NORMAL' } });
		const separatorId = createId(generatedIndex++);
		pending.push({ header: { type: 'POLY', id: separatorId, ticket: ++ticket }, data: { partitionId: '', groupId: 0, netName: '', layerId: DOCUMENT_LAYER, width: 10, path: [minX, separatorY, 'L', finalMaxX, separatorY], locked: false, zIndex: -1, polyType: 'NORMAL' } });
		let textY = separatorY + 35;
		const textIds: string[] = [];
		for (const item of textLines) {
			const id = createId(generatedIndex++);
			textIds.push(id);
			pending.push({ header: { type: 'STRING', id, ticket: ++ticket }, data: { partitionId: '', groupId: 0, layerId: DOCUMENT_LAYER, x: minX + 18, y: textY, text: item, fontFamily: 'default', fontSize: 30, strokeWidth: 3, bold: 0, italic: 0, origin: 'LEFT_BOTTOM', angle: 0, reverse: false, expansion: 0, mirror: false, locked: false, zIndex: -1, specialColor: null } });
			textY += 40;
		}
		overlays.push({ groupLabel: `${group.page.pageName} / ${group.label}`, sourceRectId: group.sourceRectId, primitiveIds: [rectId, separatorId, ...textIds], bbox: { minX, minY, maxX: finalMaxX, maxY: finalMaxY } });
		groupX = finalMaxX + 120;
		rowHeight = Math.max(rowHeight, finalHeight);
	}
	return { source: appendRecords(source, pending), overlays, updated };
}

export async function collectProjectGroupingFromSource(mode: GroupingMode): Promise<ProjectGroupingResult> {
	const project = await eda.dmt_Project.getCurrentProjectInfo();
	if (!project)
		throw new Error('当前没有打开工程。');
	if (mode === 'selection')
		throw new Error('源码模式暂不支持选中分组，请使用矩形分组、图页分组或混合分组。');
	const currentDocument = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (!currentDocument?.uuid)
		throw new Error('无法识别当前文档，请先打开当前 Board 的原理图页或 PCB。');
	const boardIndex = project.data.findIndex((board: any) => board.pcb?.uuid === currentDocument.uuid || (board.schematic?.page ?? []).some((page: any) => page.uuid === currentDocument.uuid));
	if (boardIndex < 0)
		throw new Error('当前文档不属于工程中的任何 Board。');
	const board = project.data[boardIndex];
	const pages: PageGroupingResult[] = [];
	let pcbSource = '';
	let pcbUuid = '';
	for (const page of board.schematic?.page ?? []) {
		const tab = await eda.dmt_EditorControl.openDocument(page.uuid);
		await eda.dmt_EditorControl.activateDocument(tab);
		const source = await eda.sys_FileManager.getDocumentSource();
		if (!source)
			throw new Error(`无法获取原理图源码：${page.name}`);
		pages.push(buildPageResult(source, board.name, boardIndex, board.schematic.uuid, page.name, mode));
	}
	if (board.pcb?.uuid) {
		const tab = await eda.dmt_EditorControl.openDocument(board.pcb.uuid);
		await eda.dmt_EditorControl.activateDocument(tab);
		pcbSource = await eda.sys_FileManager.getDocumentSource();
		pcbUuid = board.pcb.uuid;
	}
	if (!pcbSource)
		throw new Error('工程中没有可用的 PCB 源码。');
	const parsedPcb = extractPcbDocument(pcbSource);
	if (parsedPcb.uuid !== pcbUuid)
		throw new Error('当前 PCB 源码与工程 PCB 不匹配。');
	const groups = planGroups(pages, parsedPcb.components);
	if (groups.length === 0)
		throw new Error(`没有可匹配的 PCB 分组器件。原理图未分类器件：${pages.flatMap(page => page.unclassified).map(item => item.designator || item.primitiveId).join(', ') || '无'}`);
	const footprintSources = await eda.sys_FileManager.getDocumentFootprintSources();
	console.warn('[SourceGrouping] geometry inputs', {
		componentCount: parsedPcb.components.length,
		footprintSourceCount: Array.isArray(footprintSources) ? footprintSources.length : 0,
		components: parsedPcb.components.map(component => ({ designator: component.designator, id: component.id, footprintUuid: component.footprintUuid })).filter(component => /^U|^C14$/.test(component.designator)),
	});
	const geometry = await measurePcbGeometry(parsedPcb.components, Array.isArray(footprintSources) ? footprintSources : [], parseSourceLog(pcbSource).records);
	const patch = buildPcbPatch(pcbSource, groups, geometry);
	console.warn('[SourceGrouping] plan ready', {
		mode,
		pageCount: pages.length,
		groupCount: groups.length,
		updatedComponentCount: patch.updated.length,
		overlayCount: patch.overlays.length,
	});
	const confirmation = await requestConfirmation(`将通过源码移动 ${patch.updated.length} 个 PCB 器件，并生成 ${patch.overlays.length} 个分组。是否继续？`);
	console.warn('[SourceGrouping] confirmation result', confirmation);
	if (!confirmation)
		throw new Error('确认窗口未返回“确定”，已停止操作。');
	await eda.sys_Storage.setExtensionUserConfig(SOURCE_BACKUP_KEY, JSON.stringify({ pcbUuid, source: pcbSource, createdAt: new Date().toISOString(), mode }));
	console.warn('[SourceGrouping] writing PCB source', { length: patch.source.length });
	const success = await eda.sys_FileManager.setDocumentSource(patch.source);
	if (!success)
		throw new Error('PCB 源码写入失败。');
	const written = await eda.sys_FileManager.getDocumentSource();
	if (!written) {
		await eda.sys_FileManager.setDocumentSource(pcbSource);
		throw new Error('写入后无法重新读取 PCB 源码，已恢复原始源码。');
	}
	const verified = extractPcbDocument(written);
	for (const expected of patch.updated) {
		const actual = verified.components.find(component => component.id === expected.id);
		if (!actual || Math.abs(actual.x - expected.x) > 0.001 || Math.abs(actual.y - expected.y) > 0.001 || Math.abs(actual.angle - expected.angle) > 0.001) {
			console.error('[SourceGrouping] component verification failed', { designator: expected.designator, id: expected.id, expected: { x: expected.x, y: expected.y, angle: expected.angle }, actual: actual ? { x: actual.x, y: actual.y, angle: actual.angle, data: actual.data } : null });
			await eda.sys_FileManager.setDocumentSource(pcbSource);
			throw new Error(`器件 ${expected.designator || expected.id} 源码验证失败（期望 ${expected.x},${expected.y},${expected.angle}；实际 ${actual?.x},${actual?.y},${actual?.angle}），已恢复原始源码。`);
		}
	}
	await eda.pcb_Document.save();
	const pcbComponents: PcbComponentRecord[] = verified.components.map(component => ({ primitiveId: component.id, label: component.designator || component.id, designator: component.designator, name: component.deviceUuid, uniqueId: '', x: component.x, y: component.y, rotation: component.angle }));
	const matches: ProjectGroupingResult['pcbMatches'] = [];
	const unmatched: ProjectGroupingResult['unmatchedSchematic'] = [];
	const matchesByPcbId = new Map<string, ProjectGroupingResult['pcbMatches'][number]>();
	for (const page of pages) {
		for (const rect of page.rectangles) {
			for (const item of rect.components) {
				const pcb = verified.components.find(component => normalizedDesignator(component.designator) === normalizedDesignator(item.designator)) ?? matchByDesignator(item.designator, verified.components);
				if (pcb) {
					const schematicMatch = { boardName: page.boardName, pageName: page.pageName, label: item.label, primitiveId: item.primitiveId, uniqueId: item.uniqueId };
					const existing = matchesByPcbId.get(pcb.id);
					if (existing) {
						existing.matchedSchematic.push(schematicMatch);
					}
					else {
						const match = { designator: pcb.designator, name: pcb.deviceUuid, primitiveId: pcb.id, x: pcb.x, y: pcb.y, rotation: pcb.angle, matchedSchematic: [schematicMatch] };
						matchesByPcbId.set(pcb.id, match);
						matches.push(match);
					}
				}
				else {
					unmatched.push({ boardName: page.boardName, pageName: page.pageName, label: item.label, primitiveId: item.primitiveId, uniqueId: item.uniqueId });
				}
			}
		}
	}
	const result: ProjectGroupingResult = { projectUuid: project.uuid, projectName: project.friendlyName || project.name, generatedAt: new Date().toISOString(), pages, pcbComponents, pcbMatches: matches, unmatchedSchematic: unmatched, warnings: pages.flatMap(page => page.warnings), pcbOverlays: patch.overlays };
	await eda.sys_Storage.setExtensionUserConfig(STORAGE_KEY, JSON.stringify(result));
	return result;
}

export function sourceComponentBBoxes(components: SourcePcbComponent[]): BBox[] {
	return components.map(component => componentBBox(component));
}

export async function restorePcbSourceBackup(): Promise<void> {
	const raw = await eda.sys_Storage.getExtensionUserConfig(SOURCE_BACKUP_KEY);
	if (!raw)
		throw new Error('没有可回退的 PCB 源码备份。');
	const backup = JSON.parse(String(raw)) as { pcbUuid?: string; source?: string };
	if (!backup.source)
		throw new Error('PCB 源码备份无效。');
	const current = await eda.sys_FileManager.getDocumentSource();
	if (!current)
		throw new Error('请先打开需要回退的 PCB 文档。');
	const currentUuid = extractPcbDocument(current).uuid;
	if (backup.pcbUuid && backup.pcbUuid !== currentUuid)
		throw new Error('当前 PCB 与备份不匹配，已停止回退。');
	if (!await eda.sys_FileManager.setDocumentSource(backup.source))
		throw new Error('PCB 源码回退写入失败。');
	const restored = await eda.sys_FileManager.getDocumentSource();
	if (!restored || extractPcbDocument(restored).uuid !== currentUuid)
		throw new Error('PCB 源码回退验证失败。');
	await eda.pcb_Document.save();
}
