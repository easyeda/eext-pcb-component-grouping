declare const eda: any;

export interface BBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface RectRecord {
	primitiveId: string;
	label: string;
	pageName: string;
	pageUuid: string;
	bbox: BBox;
}

export interface SchematicComponentRecord {
	primitiveId: string;
	label: string;
	designator: string;
	name: string;
	uniqueId: string;
	pageName: string;
	pageUuid: string;
	x: number;
	y: number;
	rotation: number;
}

export interface SchematicTextRecord {
	primitiveId: string;
	label: string;
	content: string;
	pageName: string;
	pageUuid: string;
	x: number;
	y: number;
	rotation: number;
	fontSize: number;
	bbox: BBox;
}

export interface PcbTextPlacement {
	text: SchematicTextRecord;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PcbTextRecord extends PcbTextPlacement {
	primitiveId: string;
}

export interface PcbComponentRecord {
	primitiveId: string;
	label: string;
	designator: string;
	name: string;
	uniqueId: string;
	x: number;
	y: number;
	rotation: number;
}

export interface ComponentAssignment extends SchematicComponentRecord {
	rectangleId: string | null;
	rectangleLabel: string | null;
}

export interface PageGroupingResult {
	boardName: string;
	boardIndex: number;
	schematicUuid: string;
	pageUuid: string;
	pageName: string;
	rectangles: Array<{
		primitiveId: string;
		label: string;
		bbox: BBox;
		components: ComponentAssignment[];
		texts: SchematicTextRecord[];
	}>;
	unclassified: ComponentAssignment[];
	warnings: string[];
}

export interface ProjectGroupingResult {
	projectUuid: string;
	projectName: string;
	generatedAt: string;
	pages: PageGroupingResult[];
	pcbComponents: PcbComponentRecord[];
	pcbMatches: Array<{
		designator: string;
		name: string;
		primitiveId: string;
		x: number;
		y: number;
		rotation: number;
		matchedSchematic: Array<{
			boardName: string;
			pageName: string;
			label: string;
			primitiveId: string;
			uniqueId: string;
		}>;
	}>;
	unmatchedSchematic: Array<{
		boardName: string;
		pageName: string;
		label: string;
		primitiveId: string;
		uniqueId: string;
	}>;
	warnings: string[];
	pcbOverlays: Array<{
		groupLabel: string;
		sourceRectId: string;
		primitiveIds: string[];
		bbox: BBox;
	}>;
}

interface CollectedBoardGrouping {
	pageResults: PageGroupingResult[];
	pcbComponents: PcbComponentRecord[];
	warnings: string[];
}

export type GroupingMode = 'rectangle' | 'page' | 'selection';

export const GROUPING_STORAGE_KEY = 'schematic-pcb-grouping:last-result';
const OVERLAY_STORAGE_KEY = 'schematic-pcb-grouping:pcb-overlay-ids';
const TEXT_OVERLAY_STORAGE_KEY = 'schematic-pcb-grouping:pcb-text-ids';
const PCB_DOCUMENT_LAYER = 13;

function asText(value: unknown, fallback = ''): string {
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function toNumber(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readNumber(raw: any, property: string, getter: string, fallback = 0): number {
	const direct = toNumber(raw?.[property], Number.NaN);
	if (Number.isFinite(direct)) {
		return direct;
	}
	try {
		return toNumber(raw?.[getter]?.(), fallback);
	}
	catch {
		return fallback;
	}
}

function isBBox(value: unknown): value is BBox {
	return Boolean(value)
		&& typeof value === 'object'
		&& typeof (value as BBox).minX === 'number'
		&& typeof (value as BBox).minY === 'number'
		&& typeof (value as BBox).maxX === 'number'
		&& typeof (value as BBox).maxY === 'number';
}

function bboxArea(bbox: BBox): number {
	return Math.max(0, bbox.maxX - bbox.minX) * Math.max(0, bbox.maxY - bbox.minY);
}

function pointInBBox(bbox: BBox, x: number, y: number): boolean {
	return x >= bbox.minX && x <= bbox.maxX && y >= bbox.minY && y <= bbox.maxY;
}

function overlapArea(a: BBox, b: BBox): number {
	const minX = Math.max(a.minX, b.minX);
	const minY = Math.max(a.minY, b.minY);
	const maxX = Math.min(a.maxX, b.maxX);
	const maxY = Math.min(a.maxY, b.maxY);
	return Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
}

function bboxesOverlap(a: BBox, b: BBox): boolean {
	return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

function unionBBox(a: BBox, b: BBox): BBox {
	return {
		minX: Math.min(a.minX, b.minX),
		minY: Math.min(a.minY, b.minY),
		maxX: Math.max(a.maxX, b.maxX),
		maxY: Math.max(a.maxY, b.maxY),
	};
}

function expandBBox(bbox: BBox, expansion: number): BBox {
	return {
		minX: bbox.minX - expansion,
		minY: bbox.minY - expansion,
		maxX: bbox.maxX + expansion,
		maxY: bbox.maxY + expansion,
	};
}

/** Effective footprint bbox = union of component body bbox and all pad bboxes, expanded by clearance. */
async function getEffectiveFootprintBBox(componentPrimitiveId: string, bodyBBox: BBox): Promise<BBox> {
	const SILK_TO_PAD_CLEARANCE = 30; // 增大缓冲，避免器件位号丝印重叠
	let effective = bodyBBox;
	try {
		const pads = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(componentPrimitiveId);
		if (Array.isArray(pads) && pads.length > 0) {
			for (const pad of pads) {
				const padBBox = await getBBoxOfPrimitive(eda.pcb_Primitive, pad);
				if (padBBox) {
					effective = unionBBox(effective, padBBox);
				}
			}
		}
	}
	catch {
		// If pad query fails, fall back to body-only bbox.
	}
	return expandBBox(effective, SILK_TO_PAD_CLEARANCE);
}

function rectDisplayName(rect: any, index: number): string {
	return asText(rect?.name, `矩形 ${index + 1}`);
}

function componentDisplayLabel(component: any, fallbackIndex: number): string {
	return asText(component?.designator)
		|| asText(component?.name)
		|| asText(component?.uniqueId)
		|| asText(component?.primitiveId, `C${fallbackIndex + 1}`);
}

function normalizeSchematicRect(raw: any, bbox: BBox, index: number, pageName: string, pageUuid: string): RectRecord {
	return {
		primitiveId: asText(raw?.primitiveId, `rect-${index + 1}`),
		label: rectDisplayName(raw, index),
		pageName,
		pageUuid,
		bbox,
	};
}

function normalizeSchematicComponent(raw: any, index: number, pageName: string, pageUuid: string): SchematicComponentRecord {
	return {
		primitiveId: asText(raw?.primitiveId, `sch-component-${index + 1}`),
		label: componentDisplayLabel(raw, index),
		designator: asText(raw?.designator, ''),
		name: asText(raw?.name, ''),
		uniqueId: asText(raw?.uniqueId, ''),
		pageName,
		pageUuid,
		x: readNumber(raw, 'x', 'getState_X'),
		y: readNumber(raw, 'y', 'getState_Y'),
		rotation: readNumber(raw, 'rotation', 'getState_Rotation'),
	};
}

function normalizePcbComponent(raw: any, index: number): PcbComponentRecord {
	return {
		primitiveId: asText(raw?.primitiveId, `pcb-component-${index + 1}`),
		label: componentDisplayLabel(raw, index),
		designator: asText(raw?.designator, ''),
		name: asText(raw?.name, ''),
		uniqueId: asText(raw?.uniqueId, ''),
		x: readNumber(raw, 'x', 'getState_X'),
		y: readNumber(raw, 'y', 'getState_Y'),
		rotation: readNumber(raw, 'rotation', 'getState_Rotation'),
	};
}

function normalizeSchematicText(raw: any, index: number, pageName: string, pageUuid: string, bbox: BBox): SchematicTextRecord {
	return {
		primitiveId: asText(raw?.primitiveId, `sch-text-${index + 1}`),
		label: asText(raw?.name, asText(raw?.content, `文本 ${index + 1}`)),
		content: asText(raw?.content, ''),
		pageName,
		pageUuid,
		x: readNumber(raw, 'x', 'getState_X'),
		y: readNumber(raw, 'y', 'getState_Y'),
		rotation: readNumber(raw, 'rotation', 'getState_Rotation'),
		fontSize: readNumber(raw, 'fontSize', 'getState_FontSize', 30),
		bbox,
	};
}

function packTextRows(texts: SchematicTextRecord[], startY: number, _rowLimit: number, _gap: number): Array<{ text: SchematicTextRecord; x: number; y: number; width: number; height: number }> {
	const ordered = [...texts].sort((a, b) => a.y - b.y || a.x - b.x || a.content.localeCompare(b.content));
	const placements: Array<{ text: SchematicTextRecord; x: number; y: number; width: number; height: number }> = [];
	// 每个文本独占一行，间距根据字号动态调整
	let rowBottom = startY;
	for (const text of ordered) {
		const fontSize = text.fontSize || 30;
		const width = Math.max(40, Math.round(fontSize * Math.max(1, text.content.length) * 0.65));
		const height = Math.max(24, Math.round(fontSize * 1.2));
		const dynamicGap = Math.max(4, Math.round(fontSize * 0.2));
		placements.push({ text, x: 0, y: rowBottom, width, height });
		rowBottom -= (height + dynamicGap);
	}
	return placements;
}

async function getBBoxOfPrimitive(api: any, primitive: any): Promise<BBox | null> {
	try {
		const bbox = await api.getPrimitivesBBox([primitive]);
		return isBBox(bbox) ? bbox : null;
	}
	catch {
		return null;
	}
}

function pickRectangleByPoint(rectangles: RectRecord[], x: number, y: number): RectRecord | null {
	const hits = rectangles.filter(rect => pointInBBox(rect.bbox, x, y));
	if (hits.length === 0) {
		return null;
	}
	return hits.sort((a, b) => bboxArea(a.bbox) - bboxArea(b.bbox))[0] ?? null;
}

function pickRectangleByBBox(rectangles: RectRecord[], bbox: BBox): RectRecord | null {
	const hits = rectangles
		.map(rect => ({ rect, overlap: overlapArea(rect.bbox, bbox) }))
		.filter(item => item.overlap > 0)
		.sort((a, b) => b.overlap - a.overlap || bboxArea(a.rect.bbox) - bboxArea(b.rect.bbox));
	return hits[0]?.rect ?? null;
}

function buildAssignment(component: SchematicComponentRecord, rectangle: RectRecord | null): ComponentAssignment {
	return {
		...component,
		rectangleId: rectangle?.primitiveId ?? null,
		rectangleLabel: rectangle?.label ?? null,
	};
}

async function deletePreviousPcbOverlays(): Promise<void> {
	const rawIds = eda.sys_Storage.getExtensionUserConfig(OVERLAY_STORAGE_KEY);
	try {
		const ids = rawIds ? JSON.parse(String(rawIds)) : [];
		if (Array.isArray(ids) && ids.length > 0) {
			await eda.pcb_PrimitivePolyline.delete(ids);
		}
	}
	catch {
		// Ignore stale IDs from an earlier PCB document.
	}

	const rawTextIds = eda.sys_Storage.getExtensionUserConfig(TEXT_OVERLAY_STORAGE_KEY);
	try {
		const textIds = rawTextIds ? JSON.parse(String(rawTextIds)) : [];
		if (Array.isArray(textIds) && textIds.length > 0) {
			await eda.pcb_PrimitiveString.delete(textIds);
		}
	}
	catch {
		// Ignore stale text IDs from an earlier PCB document.
	}
}

async function createPcbOverlays(
	pages: PageGroupingResult[],
	pcbByDesignator: Map<string, PcbComponentRecord>,
): Promise<ProjectGroupingResult['pcbOverlays']> {
	await deletePreviousPcbOverlays();
	const overlays: ProjectGroupingResult['pcbOverlays'] = [];
	const allPolylineIds: string[] = [];
	const allTextIds: string[] = [];
	const targetGap = 20;
	const componentMargin = 30;
	const rectGap = 120;
	const SILK_TO_RECT_BORDER = 8;

	const originX = 0;
	const originY = 0;

	// Phase 1: Place components within each rectangle at a temporary origin (0,0),
	// run the auto-fixup loop, and record the relative BBox of each rectangle.
	interface PlacedRect {
		page: PageGroupingResult;
		rectangle: PageGroupingResult['rectangles'][number];
		placements: Array<{
			pcb: PcbComponentRecord;
			designator: string;
			bbox: BBox;
			effectiveBBox: BBox;
		}>;
		textPlacements: Array<{
			text: SchematicTextRecord;
			x: number;
			y: number;
			width: number;
			height: number;
		}>;
		relativeBBox: BBox;
	}
	const placedRects: PlacedRect[] = [];

	for (const page of pages) {
		for (const rectangle of page.rectangles) {
			const placements: Array<{
				pcb: PcbComponentRecord;
				designator: string;
				schematicX: number;
				schematicY: number;
				bbox: BBox;
				effectiveBBox: BBox;
			}> = [];
			for (const schematic of rectangle.components) {
				const pcb = schematic.designator ? pcbByDesignator.get(schematic.designator) : undefined;
				if (!pcb) {
					continue;
				}
				if (/^(?:LED|FB|RV|TVS|[RCLDQT])\d+/i.test(pcb.designator ?? '')) {
					const all = await eda.pcb_PrimitiveComponent.getAll();
					const live = (Array.isArray(all) ? all : []).find((item: any) => item?.primitiveId === pcb.primitiveId);
					if (live?.setState_Rotation && live.getState_Rotation?.() !== 0) {
						live.setState_Rotation(0);
						live.done();
						await new Promise(resolve => setTimeout(resolve, 50));
					}
				}
				const bbox = await getBBoxOfPrimitive(eda.pcb_Primitive, pcb.primitiveId);
				if (bbox) {
					const effectiveBBox = await getEffectiveFootprintBBox(pcb.primitiveId, bbox);
					placements.push({ pcb, designator: pcb.designator ?? schematic.designator ?? '', schematicX: schematic.x, schematicY: schematic.y, bbox, effectiveBBox });
				}
			}

			if (placements.length === 0) {
				continue;
			}

			// Prefix-grouped shelf packing.
			const prefixOf = (designator: string): string => {
				const match = /^([a-z]+)/i.exec(designator);
				return match ? match[1].toUpperCase() : 'OTHER';
			};
			const prefixGroups = new Map<string, typeof placements>();
			for (const item of placements) {
				const prefix = prefixOf(item.designator);
				if (!prefixGroups.has(prefix)) {
					prefixGroups.set(prefix, []);
				}
				prefixGroups.get(prefix)!.push(item);
			}
			const sortedPrefixes = Array.from(prefixGroups.keys()).sort((a, b) => {
				if (a === 'U' && b !== 'U')
					return -1;
				if (b === 'U' && a !== 'U')
					return 1;
				return a.localeCompare(b);
			});
			for (const prefix of sortedPrefixes) {
				prefixGroups.get(prefix)!.sort((a, b) => a.schematicY - b.schematicY || a.schematicX - b.schematicX);
			}

			const positions = new Map<PcbComponentRecord, { x: number; y: number }>();
			let cursorRowTop = 0;
			for (const prefix of sortedPrefixes) {
				const group = prefixGroups.get(prefix)!;
				const maxItemWidth = Math.max(...group.map(item => item.effectiveBBox.maxX - item.effectiveBBox.minX));
				const maxRowWidth = maxItemWidth * 4;
				let rowItems: typeof placements = [];
				let rowWidth = 0;
				const rows: Array<typeof placements> = [];
				for (const item of group) {
					const width = item.effectiveBBox.maxX - item.effectiveBBox.minX;
					if (rowItems.length > 0 && rowWidth + width + targetGap > maxRowWidth) {
						rows.push(rowItems);
						rowItems = [];
						rowWidth = 0;
					}
					rowItems.push(item);
					rowWidth += width + targetGap;
				}
				if (rowItems.length > 0) {
					rows.push(rowItems);
				}
				for (const row of rows) {
					const rowHeight = Math.max(...row.map(item => item.effectiveBBox.maxY - item.effectiveBBox.minY));
					let cursorRowX = 0;
					for (const item of row) {
						const width = item.effectiveBBox.maxX - item.effectiveBBox.minX;
						const centerX = cursorRowX + width / 2;
						const centerY = cursorRowTop + rowHeight / 2;
						positions.set(item.pcb, { x: centerX, y: centerY });
						cursorRowX += width + targetGap;
					}
					cursorRowTop += rowHeight + targetGap;
				}
			}

			// Compute relative rectangle bbox from packed positions.
			const positionMinX = Math.min(...placements.map(item => item.effectiveBBox.minX + positions.get(item.pcb)!.x - item.pcb.x));
			const positionMaxX = Math.max(...placements.map(item => item.effectiveBBox.maxX + positions.get(item.pcb)!.x - item.pcb.x));
			const positionMinY = Math.min(...placements.map(item => item.effectiveBBox.minY + positions.get(item.pcb)!.y - item.pcb.y));
			const positionMaxY = Math.max(...placements.map(item => item.effectiveBBox.maxY + positions.get(item.pcb)!.y - item.pcb.y));
			const rectWidth = (positionMaxX - positionMinX) + componentMargin * 2;
			const rectHeight = (positionMaxY - positionMinY) + componentMargin * 2;

			// Place at temporary origin (0,0).
			const tempBbox: BBox = { minX: 0, minY: 0, maxX: rectWidth, maxY: rectHeight };
			const tempTargetMinX = tempBbox.minX + componentMargin - positionMinX;
			const tempTargetMinY = tempBbox.minY + componentMargin - positionMinY;
			for (const item of placements) {
				const position = positions.get(item.pcb)!;
				const bboxOffsetX = ((item.effectiveBBox.minX + item.effectiveBBox.maxX) / 2) - item.pcb.x;
				const bboxOffsetY = ((item.effectiveBBox.minY + item.effectiveBBox.maxY) / 2) - item.pcb.y;
				const x = tempTargetMinX + position.x + bboxOffsetX;
				const y = tempTargetMinY + position.y + bboxOffsetY;
				await eda.pcb_PrimitiveComponent.modify(item.pcb.primitiveId, { x, y });
				item.pcb.x = x;
				item.pcb.y = y;
			}

			// Auto-fixup loop for intra-rect component overlaps.
			const MAX_FIXUP_ITERATIONS = 20;
			const PUSH_DISTANCE = 20;
			for (let iteration = 0; iteration < MAX_FIXUP_ITERATIONS; iteration++) {
				const liveBBoxes: Array<{ item: typeof placements[number]; bbox: BBox }> = [];
				for (const item of placements) {
					const body = await getBBoxOfPrimitive(eda.pcb_Primitive, item.pcb.primitiveId);
					const live = await getEffectiveFootprintBBox(item.pcb.primitiveId, body ?? item.bbox);
					liveBBoxes.push({ item, bbox: live });
				}
				let overlapsFound = false;
				const adjustments = new Map<PcbComponentRecord, { dx: number; dy: number }>();
				for (let i = 0; i < liveBBoxes.length; i++) {
					for (let j = i + 1; j < liveBBoxes.length; j++) {
						const a = liveBBoxes[i];
						const b = liveBBoxes[j];
						if (!bboxesOverlap(a.bbox, b.bbox)) {
							continue;
						}
						overlapsFound = true;
						const overlapX = Math.min(a.bbox.maxX, b.bbox.maxX) - Math.max(a.bbox.minX, b.bbox.minX);
						const overlapY = Math.min(a.bbox.maxY, b.bbox.maxY) - Math.max(a.bbox.minY, b.bbox.minY);
						if (overlapX <= overlapY) {
							const push = overlapX / 2 + PUSH_DISTANCE;
							const aCenter = (a.bbox.minX + a.bbox.maxX) / 2;
							const bCenter = (b.bbox.minX + b.bbox.maxX) / 2;
							const dir = aCenter <= bCenter ? -1 : 1;
							adjustments.set(a.item.pcb, { dx: (adjustments.get(a.item.pcb)?.dx ?? 0) + dir * push, dy: adjustments.get(a.item.pcb)?.dy ?? 0 });
							adjustments.set(b.item.pcb, { dx: (adjustments.get(b.item.pcb)?.dx ?? 0) - dir * push, dy: adjustments.get(b.item.pcb)?.dy ?? 0 });
						}
						else {
							const push = overlapY / 2 + PUSH_DISTANCE;
							const aCenter = (a.bbox.minY + a.bbox.maxY) / 2;
							const bCenter = (b.bbox.minY + b.bbox.maxY) / 2;
							const dir = aCenter <= bCenter ? -1 : 1;
							adjustments.set(a.item.pcb, { dx: adjustments.get(a.item.pcb)?.dx ?? 0, dy: (adjustments.get(a.item.pcb)?.dy ?? 0) + dir * push });
							adjustments.set(b.item.pcb, { dx: adjustments.get(b.item.pcb)?.dx ?? 0, dy: (adjustments.get(b.item.pcb)?.dy ?? 0) - dir * push });
						}
					}
				}
				if (!overlapsFound) {
					break;
				}
				for (const [pcb, adj] of Array.from(adjustments.entries())) {
					const item = placements.find(p => p.pcb === pcb)!;
					const newX = item.pcb.x + adj.dx;
					const newY = item.pcb.y + adj.dy;
					await eda.pcb_PrimitiveComponent.modify(item.pcb.primitiveId, { x: newX, y: newY });
					item.pcb.x = newX;
					item.pcb.y = newY;
				}
			}

			// Recompute relative BBox from final positions after fixup.
			const finalBBoxes: Array<{ bbox: BBox }> = [];
			for (const item of placements) {
				const body = await getBBoxOfPrimitive(eda.pcb_Primitive, item.pcb.primitiveId);
				const live = await getEffectiveFootprintBBox(item.pcb.primitiveId, body ?? item.bbox);
				finalBBoxes.push({ bbox: live });
			}
			const relMinX = Math.min(...finalBBoxes.map(f => f.bbox.minX));
			const relMaxX = Math.max(...finalBBoxes.map(f => f.bbox.maxX));
			const relMinY = Math.min(...finalBBoxes.map(f => f.bbox.minY));
			const relMaxY = Math.max(...finalBBoxes.map(f => f.bbox.maxY));
			const componentLeft = relMinX - componentMargin - SILK_TO_RECT_BORDER;
			const componentRight = relMaxX + componentMargin + SILK_TO_RECT_BORDER;
			const componentTop = relMinY - componentMargin - SILK_TO_RECT_BORDER - 50; // 50mil缓冲给分隔线+位号丝印
			const componentBottom = relMaxY + componentMargin + SILK_TO_RECT_BORDER;
			const textGap = 30;
			const textLimit = Math.max(200, componentRight - componentLeft - componentMargin * 2);
			const textPlacements = packTextRows(rectangle.texts, componentTop - textGap, textLimit, 5);
			const textBBoxes = textPlacements.map(text => ({
				minX: componentLeft + componentMargin + text.x,
				minY: text.y,
				maxX: componentLeft + componentMargin + text.x + text.width,
				maxY: text.y + text.height,
			}));
			const allLocalBBoxes = [
				{ minX: componentLeft, minY: componentTop, maxX: componentRight, maxY: componentBottom },
				...textBBoxes,
			];

			placedRects.push({
				page,
				rectangle,
				placements: placements.map(p => ({ pcb: p.pcb, designator: p.designator, bbox: p.bbox, effectiveBBox: p.effectiveBBox })),
				textPlacements,
				relativeBBox: {
					minX: Math.min(...allLocalBBoxes.map(b => b.minX)),
					minY: Math.min(...allLocalBBoxes.map(b => b.minY)) - SILK_TO_RECT_BORDER,
					maxX: Math.max(...allLocalBBoxes.map(b => b.maxX)),
					maxY: Math.max(...allLocalBBoxes.map(b => b.maxY)) + SILK_TO_RECT_BORDER,
				},
			});
		}
	}

	if (placedRects.length === 0) {
		await eda.sys_Storage.setExtensionUserConfig(OVERLAY_STORAGE_KEY, JSON.stringify(allPolylineIds));
		return overlays;
	}

	// Sort rectangles from small to large before grid packing. Use the final
	// effective footprint bounds so the visual order reflects actual usage.
	placedRects.sort((a, b) => {
		const aWidth = a.relativeBBox.maxX - a.relativeBBox.minX;
		const aHeight = a.relativeBBox.maxY - a.relativeBBox.minY;
		const bWidth = b.relativeBBox.maxX - b.relativeBBox.minX;
		const bHeight = b.relativeBBox.maxY - b.relativeBBox.minY;
		return aWidth * aHeight - bWidth * bHeight
			|| Math.max(aWidth, aHeight) - Math.max(bWidth, bHeight)
			|| aHeight - bHeight
			|| aWidth - bWidth;
	});

	// Phase 2: Pack rectangles into rows with exact 120mil gaps. We search a
	// handful of candidate row widths and pick the layout whose overall aspect
	// ratio is closest to square. Rows are shelf-packed, so every adjacent pair
	// in X and Y keeps an exact 120mil gap.
	const rectSizes = placedRects.map(pr => ({
		w: pr.relativeBBox.maxX - pr.relativeBBox.minX,
		h: pr.relativeBBox.maxY - pr.relativeBBox.minY,
	}));
	const totalArea = rectSizes.reduce((sum, item) => sum + item.w * item.h, 0);
	const minRowWidth = Math.max(...rectSizes.map(item => item.w));
	const maxRowWidth = rectSizes.reduce((sum, item) => sum + item.w, 0) + rectGap * (placedRects.length - 1);
	const targetRowWidth = Math.max(minRowWidth, Math.sqrt(totalArea));
	const candidateRowWidths = Array.from(new Set([
		minRowWidth,
		targetRowWidth * 0.75,
		targetRowWidth * 0.9,
		targetRowWidth,
		targetRowWidth * 1.1,
		targetRowWidth * 1.25,
		maxRowWidth,
	].map(value => Math.min(maxRowWidth, Math.max(minRowWidth, value))))).sort((a, b) => a - b);

	const packRows = (limit: number): Array<{ items: typeof placedRects; width: number; height: number }> => {
		const rows: Array<{ items: typeof placedRects; width: number; height: number }> = [];
		let currentItems: typeof placedRects = [];
		let currentWidth = 0;
		let currentHeight = 0;
		for (const rect of placedRects) {
			const w = rect.relativeBBox.maxX - rect.relativeBBox.minX;
			const h = rect.relativeBBox.maxY - rect.relativeBBox.minY;
			const nextWidth = currentItems.length === 0 ? w : currentWidth + rectGap + w;
			if (currentItems.length > 0 && nextWidth > limit) {
				rows.push({ items: currentItems, width: currentWidth, height: currentHeight });
				currentItems = [];
				currentWidth = 0;
				currentHeight = 0;
			}
			currentItems.push(rect);
			if (currentItems.length === 1) {
				currentWidth = w;
				currentHeight = h;
			}
			else {
				currentWidth += rectGap + w;
				currentHeight = Math.max(currentHeight, h);
			}
		}
		if (currentItems.length > 0) {
			rows.push({ items: currentItems, width: currentWidth, height: currentHeight });
		}
		return rows;
	};

	let bestLayout: ReturnType<typeof packRows> = packRows(targetRowWidth);
	let bestAspect = Number.POSITIVE_INFINITY;
	for (const limit of candidateRowWidths) {
		const rows = packRows(limit);
		const layoutWidth = Math.max(...rows.map(row => row.width));
		const layoutHeight = rows.reduce((sum, row) => sum + row.height, 0) + rectGap * (rows.length - 1);
		const aspect = Math.abs(layoutWidth / layoutHeight - 1);
		if (aspect < bestAspect) {
			bestAspect = aspect;
			bestLayout = rows;
		}
	}

	const rectTargets: Array<{ placedRect: PlacedRect; targetMinX: number; targetMinY: number }> = [];
	let rowCursorY = originY;
	for (const row of bestLayout) {
		let rowCursorX = originX;
		for (const rect of row.items) {
			rectTargets.push({ placedRect: rect, targetMinX: rowCursorX, targetMinY: rowCursorY });
			rowCursorX += (rect.relativeBBox.maxX - rect.relativeBBox.minX) + rectGap;
		}
		rowCursorY += row.height + rectGap;
	}

	// Translate all components from their temporary origin to the grid position.
	for (const { placedRect, targetMinX, targetMinY } of rectTargets) {
		const dx = targetMinX - placedRect.relativeBBox.minX;
		const dy = targetMinY - placedRect.relativeBBox.minY;
		for (const item of placedRect.placements) {
			const newX = item.pcb.x + dx;
			const newY = item.pcb.y + dy;
			await eda.pcb_PrimitiveComponent.modify(item.pcb.primitiveId, { x: newX, y: newY });
			item.pcb.x = newX;
			item.pcb.y = newY;
		}
		for (const text of placedRect.textPlacements) {
			text.x += dx;
			text.y += dy;
		}
	}

	// Inter-rect auto-fixup: detect rectangle BBox overlaps and push apart.
	const MAX_RECT_FIXUP = 10;
	const RECT_PUSH = 40;
	for (let iteration = 0; iteration < MAX_RECT_FIXUP; iteration++) {
		const rectBBoxes: Array<{ target: typeof rectTargets[number]; bbox: BBox }> = [];
		for (const target of rectTargets) {
			const items = target.placedRect.placements;
			const liveBBoxes: BBox[] = [];
			for (const item of items) {
				const body = await getBBoxOfPrimitive(eda.pcb_Primitive, item.pcb.primitiveId);
				const live = await getEffectiveFootprintBBox(item.pcb.primitiveId, body ?? item.bbox);
				liveBBoxes.push(live);
			}
			const rMinX = Math.min(...liveBBoxes.map(b => b.minX)) - componentMargin - SILK_TO_RECT_BORDER;
			const rMinY = Math.min(...liveBBoxes.map(b => b.minY)) - componentMargin - SILK_TO_RECT_BORDER;
			const rMaxX = Math.max(...liveBBoxes.map(b => b.maxX)) + componentMargin + SILK_TO_RECT_BORDER;
			const rMaxY = Math.max(...liveBBoxes.map(b => b.maxY)) + componentMargin + SILK_TO_RECT_BORDER;
			rectBBoxes.push({ target, bbox: { minX: rMinX, minY: rMinY, maxX: rMaxX, maxY: rMaxY } });
		}

		let overlapsFound = false;
		const rectAdjustments = new Map<number, { dx: number; dy: number }>();
		for (let i = 0; i < rectBBoxes.length; i++) {
			for (let j = i + 1; j < rectBBoxes.length; j++) {
				const a = rectBBoxes[i];
				const b = rectBBoxes[j];
				if (!bboxesOverlap(a.bbox, b.bbox)) {
					continue;
				}
				overlapsFound = true;
				const overlapX = Math.min(a.bbox.maxX, b.bbox.maxX) - Math.max(a.bbox.minX, b.bbox.minX);
				const overlapY = Math.min(a.bbox.maxY, b.bbox.maxY) - Math.max(a.bbox.minY, b.bbox.minY);
				if (overlapX <= overlapY) {
					const push = overlapX / 2 + RECT_PUSH;
					const aCenter = (a.bbox.minX + a.bbox.maxX) / 2;
					const bCenter = (b.bbox.minX + b.bbox.maxX) / 2;
					const dir = aCenter <= bCenter ? -1 : 1;
					rectAdjustments.set(i, { dx: (rectAdjustments.get(i)?.dx ?? 0) + dir * push, dy: rectAdjustments.get(i)?.dy ?? 0 });
					rectAdjustments.set(j, { dx: (rectAdjustments.get(j)?.dx ?? 0) - dir * push, dy: rectAdjustments.get(j)?.dy ?? 0 });
				}
				else {
					const push = overlapY / 2 + RECT_PUSH;
					const aCenter = (a.bbox.minY + a.bbox.maxY) / 2;
					const bCenter = (b.bbox.minY + b.bbox.maxY) / 2;
					const dir = aCenter <= bCenter ? -1 : 1;
					rectAdjustments.set(i, { dx: rectAdjustments.get(i)?.dx ?? 0, dy: (rectAdjustments.get(i)?.dy ?? 0) + dir * push });
					rectAdjustments.set(j, { dx: rectAdjustments.get(j)?.dx ?? 0, dy: (rectAdjustments.get(j)?.dy ?? 0) - dir * push });
				}
			}
		}

		if (!overlapsFound) {
			break;
		}

		for (const [idx, adj] of Array.from(rectAdjustments.entries())) {
			const { placedRect } = rectTargets[idx];
			for (const item of placedRect.placements) {
				const newX = item.pcb.x + adj.dx;
				const newY = item.pcb.y + adj.dy;
				await eda.pcb_PrimitiveComponent.modify(item.pcb.primitiveId, { x: newX, y: newY });
				item.pcb.x = newX;
				item.pcb.y = newY;
			}
			for (const text of placedRect.textPlacements) {
				text.x += adj.dx;
				text.y += adj.dy;
			}
		}
	}

	// Phase 3: Draw document-layer rectangles at final positions.
	// 预加载 Silkscreen 层文本图元，用于位号丝印约束检查
	const TOP_SILKSCREEN = 3;
	const BOTTOM_SILKSCREEN = 4;
	const silkscreenTexts: Array<{ bbox: BBox }> = [];
	try {
		const topSilk = await eda.pcb_PrimitiveString.getAll(TOP_SILKSCREEN);
		const bottomSilk = await eda.pcb_PrimitiveString.getAll(BOTTOM_SILKSCREEN);
		const allSilk = [...(Array.isArray(topSilk) ? topSilk : []), ...(Array.isArray(bottomSilk) ? bottomSilk : [])];
		for (const s of allSilk) {
			const sbbox = await getBBoxOfPrimitive(eda.pcb_Primitive, s);
			if (sbbox)
				silkscreenTexts.push({ bbox: sbbox });
		}
	}
	catch { /* 丝印查询失败不影响主流程 */ }

	for (const { placedRect } of rectTargets) {
		const items = placedRect.placements;
		const liveBBoxes: BBox[] = [];
		for (const item of items) {
			const body = await getBBoxOfPrimitive(eda.pcb_Primitive, item.pcb.primitiveId);
			const live = await getEffectiveFootprintBBox(item.pcb.primitiveId, body ?? item.bbox);
			liveBBoxes.push(live);
		}
		// 丝印匹配：在器件区域扩展200mil范围内查找所有丝印文本
		const componentUnionBBox: BBox = {
			minX: Math.min(...liveBBoxes.map(b => b.minX)),
			minY: Math.min(...liveBBoxes.map(b => b.minY)),
			maxX: Math.max(...liveBBoxes.map(b => b.maxX)),
			maxY: Math.max(...liveBBoxes.map(b => b.maxY)),
		};
		const matchedSilk = silkscreenTexts.filter(s =>
			s.bbox.maxX >= componentUnionBBox.minX - 200 && s.bbox.minX <= componentUnionBBox.maxX + 200
			&& s.bbox.maxY >= componentUnionBBox.minY - 200 && s.bbox.minY <= componentUnionBBox.maxY + 200,
		);

		// ── 第1步：计算分隔线位置（器件区域底部，低于所有丝印和位号文本）──
		const allCompBBoxes = [...liveBBoxes, ...matchedSilk.map(s => s.bbox)];
		const compBottomEdge = Math.max(...allCompBBoxes.map(b => b.maxY));
		// 额外50mil缓冲，避免器件位号丝印文本（无法通过API获取位置）超出分隔线
		const separatorY = compBottomEdge - componentMargin - 50;

		// ── 第2步：在分隔线下方放置文本和标签，从上到下堆叠 ──
		// 文本和标签必须在矩形框内（不超出 targetBBox.minY）
		const createdTextRefs: Array<{ primitiveId: string; bbox: BBox }> = [];
		let cursorY = separatorY - 15; // 分隔线下方15mil（线半宽5 + 间隙10）
		// 先放原理图文本（字号较小）
		for (const text of placedRect.textPlacements) {
			const fontSize = Math.max(12, text.text.fontSize || 30);
			const height = Math.max(24, Math.round(fontSize * 1.2));
			const anchorY = cursorY - height;
			const created = await eda.pcb_PrimitiveString.create(PCB_DOCUMENT_LAYER, text.x, anchorY, text.text.content, 'default', fontSize, 3, 3, 0, false, 0, false, false);
			const createdId = created?.getState_PrimitiveId?.();
			if (createdId) {
				const tbbox = await getBBoxOfPrimitive(eda.pcb_Primitive, created);
				const b = tbbox ?? { minX: text.x, minY: anchorY, maxX: text.x + text.width, maxY: anchorY + height };
				createdTextRefs.push({ primitiveId: createdId, bbox: b });
				allTextIds.push(createdId);
				cursorY = b.minY - Math.max(4, Math.round(fontSize * 0.2));
			}
		}
		// 再放页名标签（字号较大），在所有文本下方，左对齐在器件区域内
		const pageLabel = `${placedRect.page.pageName || '页面'} / ${placedRect.rectangle.label}`;
		const labelFontSize = 30;
		const labelHeight = Math.max(24, Math.round(labelFontSize * 1.2));
		const labelAnchorY = cursorY - labelHeight;
		const labelX = Math.min(...allCompBBoxes.map(b => b.minX)) - componentMargin + 10;
		const pageLabelCreated = await eda.pcb_PrimitiveString.create(PCB_DOCUMENT_LAYER, labelX, labelAnchorY, pageLabel, 'default', labelFontSize, 3, 3, 0, false, 0, false, false);
		let labelBBox: BBox | null = null;
		if (pageLabelCreated?.getState_PrimitiveId?.()) {
			allTextIds.push(pageLabelCreated.getState_PrimitiveId());
			labelBBox = await getBBoxOfPrimitive(eda.pcb_Primitive, pageLabelCreated);
		}

		// ── 第3步：计算矩形区域 ──
		// 水平方向和顶部由 targetBBox（网格���距）控制，向下扩展包含文本和标签
		// 矩形从实际器件位置计算，向下扩展包含文本和标签
		const compMinX = Math.min(...allCompBBoxes.map(b => b.minX)) - componentMargin;
		const compMaxX = Math.max(...allCompBBoxes.map(b => b.maxX)) + componentMargin;
		const compMaxY = Math.max(...allCompBBoxes.map(b => b.maxY)) + componentMargin;
		const allContent = [...createdTextRefs.map(r => r.bbox)];
		if (labelBBox)
			allContent.push(labelBBox);
		const contentMinY = allContent.length > 0
			? Math.min(...allContent.map(b => b.minY)) - SILK_TO_RECT_BORDER
			: separatorY - 50;
		const bbox: BBox = {
			minX: compMinX - SILK_TO_RECT_BORDER,
			maxX: compMaxX + SILK_TO_RECT_BORDER,
			maxY: compMaxY + SILK_TO_RECT_BORDER,
			minY: contentMinY,
		};

		// ── 第4步：绘制矩形框 ──
		// 如果 targetBBox 无效（无器件匹配），用内容区域计算
		if (!Number.isFinite(bbox.minX) || !Number.isFinite(bbox.maxX) || !Number.isFinite(bbox.minY) || !Number.isFinite(bbox.maxY)) {
			const allContent = [...createdTextRefs.map(r => r.bbox)];
			if (labelBBox)
				allContent.push(labelBBox);
			if (allContent.length > 0) {
				bbox.minX = Math.min(...allContent.map(b => b.minX)) - SILK_TO_RECT_BORDER;
				bbox.maxX = Math.max(...allContent.map(b => b.maxX)) + SILK_TO_RECT_BORDER;
				bbox.minY = Math.min(...allContent.map(b => b.minY)) - SILK_TO_RECT_BORDER;
				bbox.maxY = Math.max(...allContent.map(b => b.maxY)) + SILK_TO_RECT_BORDER;
			}
			else { continue; }
		}
		const rectWidth = bbox.maxX - bbox.minX;
		const rectHeight = bbox.maxY - bbox.minY;
		if (rectWidth <= 0 || rectHeight <= 0)
			continue;
		const polygon = eda.pcb_MathPolygon.createPolygon(['R', bbox.minX, bbox.maxY, rectWidth, rectHeight, 0, 0]);
		if (!polygon) {
			throw new Error(`无法创建分组矩形多边形：${placedRect.rectangle.label}`);
		}
		const polyline = await eda.pcb_PrimitivePolyline.create('', PCB_DOCUMENT_LAYER, polygon, 10, false);
		if (polyline?.primitiveId) {
			allPolylineIds.push(polyline.primitiveId);
			overlays.push({
				groupLabel: `${placedRect.page.boardName} / ${placedRect.page.pageName} / ${placedRect.rectangle.label}`,
				sourceRectId: placedRect.rectangle.primitiveId,
				primitiveIds: [polyline.primitiveId],
				bbox,
			});
		}

		// ── 第5步：绘制分隔线 ──
		const separatorPolygon = eda.pcb_MathPolygon.createPolygon([bbox.minX, separatorY, 'L', bbox.maxX, separatorY]);
		if (separatorPolygon) {
			const separatorLine = await eda.pcb_PrimitivePolyline.create('', PCB_DOCUMENT_LAYER, separatorPolygon, 10, false);
			if (separatorLine?.primitiveId) {
				allPolylineIds.push(separatorLine.primitiveId);
			}
		}
	}

	await eda.sys_Storage.setExtensionUserConfig(OVERLAY_STORAGE_KEY, JSON.stringify(allPolylineIds));
	await eda.sys_Storage.setExtensionUserConfig(TEXT_OVERLAY_STORAGE_KEY, JSON.stringify(allTextIds));
	return overlays;
}

async function collectBoardGrouping(boardEntry: any, boardIndex: number, mode: GroupingMode = 'rectangle'): Promise<CollectedBoardGrouping> {
	const boardName = asText(boardEntry?.name, `Board ${boardIndex + 1}`);
	const schematic = boardEntry?.schematic;
	const pcb = boardEntry?.pcb;
	const pages: Array<any> = Array.isArray(schematic?.page) ? schematic.page : [];
	const pageResults: PageGroupingResult[] = [];
	const warnings: string[] = [];

	for (const page of pages) {
		const pageTabId = await eda.dmt_EditorControl.openDocument(page.uuid);
		if (!pageTabId) {
			throw new Error(`无法打开原理图页面：${page.uuid}`);
		}
		await eda.dmt_EditorControl.activateDocument(pageTabId);
		const pageName = asText(page?.name, '');
		const rawRects = await eda.sch_PrimitiveRectangle.getAll();
		const rawComponents = await eda.sch_PrimitiveComponent.getAll();
		const rawTexts = await eda.sch_PrimitiveText.getAll();
		const partComponents = (Array.isArray(rawComponents) ? rawComponents : []).filter((item: any) => item?.componentType === 'part');

		const rectRecords: RectRecord[] = [];
		for (let i = 0; i < (rawRects?.length ?? 0); i += 1) {
			const rawRect = rawRects[i];
			const bbox = await getBBoxOfPrimitive(eda.sch_Primitive, rawRect);
			if (bbox) {
				rectRecords.push(normalizeSchematicRect(rawRect, bbox, i, pageName, page.uuid));
			}
		}

		const assignments: ComponentAssignment[] = [];
		const textAssignments: Array<SchematicTextRecord & { rectangleId: string | null }> = [];
		const unresolved: Array<{ raw: any; record: SchematicComponentRecord }> = [];
		const pageWarnings: string[] = [];

		for (let i = 0; i < partComponents.length; i += 1) {
			const rawComponent = partComponents[i];
			const record = normalizeSchematicComponent(rawComponent, i, pageName, page.uuid);
			const rectangle = pickRectangleByPoint(rectRecords, record.x, record.y);
			if (rectangle) {
				assignments.push(buildAssignment(record, rectangle));
			}
			else {
				unresolved.push({ raw: rawComponent, record });
			}
		}

		for (const item of unresolved) {
			const bbox = await getBBoxOfPrimitive(eda.sch_Primitive, item.raw);
			const rectangle = bbox ? pickRectangleByBBox(rectRecords, bbox) : null;
			assignments.push(buildAssignment(item.record, rectangle));
			if (!rectangle) {
				pageWarnings.push(`页面 ${pageName} 中器件 ${item.record.label} 未落入任何矩形。`);
			}
		}

		for (let i = 0; i < (rawTexts?.length ?? 0); i += 1) {
			const rawText = rawTexts[i];
			const bbox = await getBBoxOfPrimitive(eda.sch_Primitive, rawText);
			if (!bbox) {
				continue;
			}
			const textRecord = normalizeSchematicText(rawText, i, pageName, page.uuid, bbox);
			const rectangle = pickRectangleByPoint(rectRecords, textRecord.x, textRecord.y) || pickRectangleByBBox(rectRecords, bbox);
			textAssignments.push({ ...textRecord, rectangleId: rectangle?.primitiveId ?? null });
			if (!rectangle) {
				pageWarnings.push(`页面 ${pageName} 中文本 ${textRecord.label} 未落入任何矩形。`);
			}
		}

		if (mode === 'page') {
			// 图页模式：将整页所有器件和文本归入一个虚拟矩形
			const allBBoxes: BBox[] = [];
			for (const raw of partComponents) {
				const bbox = await getBBoxOfPrimitive(eda.sch_Primitive, raw);
				if (bbox)
					allBBoxes.push(bbox);
			}
			const virtualBBox: BBox = allBBoxes.length > 0
				? {
						minX: Math.min(...allBBoxes.map(b => b.minX)),
						minY: Math.min(...allBBoxes.map(b => b.minY)),
						maxX: Math.max(...allBBoxes.map(b => b.maxX)),
						maxY: Math.max(...allBBoxes.map(b => b.maxY)),
					}
				: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
			pageResults.push({
				boardName,
				boardIndex,
				schematicUuid: asText(schematic?.uuid, ''),
				pageUuid: page.uuid,
				pageName,
				rectangles: [{
					primitiveId: `page-${page.uuid}`,
					label: pageName || `页面 ${page.uuid}`,
					bbox: virtualBBox,
					components: assignments,
					texts: textAssignments.map(({ rectangleId, ...text }) => text),
				}],
				unclassified: [],
				warnings: pageWarnings,
			});
		}
		else {
			pageResults.push({
				boardName,
				boardIndex,
				schematicUuid: asText(schematic?.uuid, ''),
				pageUuid: page.uuid,
				pageName,
				rectangles: rectRecords.map(rect => ({
					primitiveId: rect.primitiveId,
					label: rect.label,
					bbox: rect.bbox,
					components: assignments.filter(item => item.rectangleId === rect.primitiveId),
					texts: textAssignments.filter(item => item.rectangleId === rect.primitiveId).map(({ rectangleId, ...text }) => text),
				})),
				unclassified: assignments.filter(item => !item.rectangleId),
				warnings: pageWarnings,
			});
		}
		warnings.push(...pageWarnings);
	}

	const pcbComponents: PcbComponentRecord[] = [];
	if (pcb?.uuid) {
		const pcbTabId = await eda.dmt_EditorControl.openDocument(pcb.uuid);
		if (!pcbTabId) {
			throw new Error(`无法打开 PCB 文档：${pcb.uuid}`);
		}
		await eda.dmt_EditorControl.activateDocument(pcbTabId);
		const rawPcbComponents = await eda.pcb_PrimitiveComponent.getAll();
		for (let i = 0; i < (rawPcbComponents?.length ?? 0); i += 1) {
			pcbComponents.push(normalizePcbComponent(rawPcbComponents[i], i));
		}
	}

	return {
		pageResults,
		pcbComponents,
		warnings,
	};
}

export async function collectProjectGrouping(mode: GroupingMode = 'rectangle'): Promise<ProjectGroupingResult> {
	const project = await eda.dmt_Project.getCurrentProjectInfo();
	if (!project) {
		throw new Error('当前没有打开工程。');
	}

	const boardEntries: Array<any> = Array.isArray(project?.data) ? project.data : [];
	if (boardEntries.length === 0) {
		throw new Error('工程中没有可用的 Board 数据。');
	}

	const pages: PageGroupingResult[] = [];
	const pcbComponents: PcbComponentRecord[] = [];
	const warnings: string[] = [];

	if (mode === 'selection') {
		// 选中模式：从当前原理图页面获取选中的器件
		const docInfo = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		if (!docInfo || docInfo.documentType !== 1) {
			throw new Error('选中模式需要在原理图页面中使用。请先打开一个原理图页面并选中器件。');
		}
		const selectedIds = await eda.sch_SelectControl.getAllSelectedPrimitives_PrimitiveId();
		if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
			throw new Error('当前没有选中任何图元。请先在原理图中选中器件。');
		}
		const allRaw = await eda.sch_PrimitiveComponent.getAll();
		const selectedComponents = (Array.isArray(allRaw) ? allRaw : []).filter((item: any) =>
			item?.componentType === 'part' && selectedIds.includes(item?.primitiveId),
		);
		if (selectedComponents.length === 0) {
			throw new Error('选中的图元中没有器件。请选中原理图器件后重试。');
		}
		const pageName = asText(docInfo?.name, '选中区域');
		const pageUuid = asText(docInfo?.uuid, '');
		const assignments: ComponentAssignment[] = [];
		const allBBoxes: BBox[] = [];
		for (let i = 0; i < selectedComponents.length; i += 1) {
			const raw = selectedComponents[i];
			const record = normalizeSchematicComponent(raw, i, pageName, pageUuid);
			const bbox = await getBBoxOfPrimitive(eda.sch_Primitive, raw);
			if (bbox)
				allBBoxes.push(bbox);
			assignments.push({ ...record, rectangleId: 'selection', rectangleLabel: '选中区域' });
		}
		const virtualBBox: BBox = allBBoxes.length > 0
			? {
					minX: Math.min(...allBBoxes.map(b => b.minX)),
					minY: Math.min(...allBBoxes.map(b => b.minY)),
					maxX: Math.max(...allBBoxes.map(b => b.maxX)),
					maxY: Math.max(...allBBoxes.map(b => b.maxY)),
				}
			: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
		// 获取选中区域内的文本
		const rawTexts = await eda.sch_PrimitiveText.getAll();
		const textAssignments: SchematicTextRecord[] = [];
		for (let i = 0; i < (rawTexts?.length ?? 0); i += 1) {
			const rawText = rawTexts[i];
			const tbbox = await getBBoxOfPrimitive(eda.sch_Primitive, rawText);
			if (!tbbox)
				continue;
			if (pointInBBox(virtualBBox, tbbox.minX, tbbox.minY) || pointInBBox(virtualBBox, tbbox.maxX, tbbox.maxY)) {
				textAssignments.push(normalizeSchematicText(rawText, i, pageName, pageUuid, tbbox));
			}
		}
		pages.push({
			boardName: '选中分组',
			boardIndex: 0,
			schematicUuid: pageUuid,
			pageUuid,
			pageName,
			rectangles: [{
				primitiveId: 'selection',
				label: '选中区域',
				bbox: virtualBBox,
				components: assignments,
				texts: textAssignments,
			}],
			unclassified: [],
			warnings: [],
		});
		// 获取 PCB 器件
		const firstBoard = boardEntries[0];
		if (firstBoard?.pcb?.uuid) {
			const pcbTabId = await eda.dmt_EditorControl.openDocument(firstBoard.pcb.uuid);
			if (pcbTabId) {
				await eda.dmt_EditorControl.activateDocument(pcbTabId);
				const rawPcbComponents = await eda.pcb_PrimitiveComponent.getAll();
				for (let i = 0; i < (rawPcbComponents?.length ?? 0); i += 1) {
					pcbComponents.push(normalizePcbComponent(rawPcbComponents[i], i));
				}
			}
		}
	}
	else {
		for (let i = 0; i < boardEntries.length; i += 1) {
			const result = await collectBoardGrouping(boardEntries[i], i, mode);
			pages.push(...result.pageResults);
			pcbComponents.push(...result.pcbComponents);
			warnings.push(...result.warnings);
		}
	}

	const pcbByDesignator = new Map<string, PcbComponentRecord>();
	for (const pcbComponent of pcbComponents) {
		if (pcbComponent.designator && !pcbByDesignator.has(pcbComponent.designator)) {
			pcbByDesignator.set(pcbComponent.designator, pcbComponent);
		}
	}

	const pcbMatches: ProjectGroupingResult['pcbMatches'] = [];
	const unmatchedSchematic: ProjectGroupingResult['unmatchedSchematic'] = [];

	for (const page of pages) {
		for (const rect of page.rectangles) {
			for (const component of rect.components) {
				if (!component.designator) {
					unmatchedSchematic.push({
						boardName: page.boardName,
						pageName: page.pageName,
						label: component.label,
						primitiveId: component.primitiveId,
						uniqueId: component.uniqueId,
					});
					continue;
				}

				let match = pcbMatches.find(item => item.designator === component.designator);
				if (!match) {
					const pcbComponent = pcbByDesignator.get(component.designator);
					if (pcbComponent) {
						match = {
							designator: pcbComponent.designator,
							name: pcbComponent.name,
							primitiveId: pcbComponent.primitiveId,
							x: pcbComponent.x,
							y: pcbComponent.y,
							rotation: pcbComponent.rotation,
							matchedSchematic: [],
						};
						pcbMatches.push(match);
					}
				}

				if (match) {
					match.matchedSchematic.push({
						boardName: page.boardName,
						pageName: page.pageName,
						label: component.label,
						primitiveId: component.primitiveId,
						uniqueId: component.uniqueId,
					});
				}
				else {
					unmatchedSchematic.push({
						boardName: page.boardName,
						pageName: page.pageName,
						label: component.label,
						primitiveId: component.primitiveId,
						uniqueId: component.uniqueId,
					});
				}
			}
		}
	}

	const result: ProjectGroupingResult = {
		projectUuid: asText(project?.uuid, ''),
		projectName: asText(project?.friendlyName || project?.name, '当前工程'),
		generatedAt: new Date().toISOString(),
		pages,
		pcbComponents,
		pcbMatches,
		unmatchedSchematic,
		warnings,
		pcbOverlays: [],
	};
	result.pcbOverlays = await createPcbOverlays(pages, pcbByDesignator);
	await eda.pcb_Document.setCanvasOrigin(0, 0);
	const currentDocument = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (currentDocument?.documentType !== 3 || !currentDocument.tabId) {
		throw new Error('PCB 文档未成功激活，已停止绘制以避免操作空文档。');
	}
	const finalComponents = await eda.pcb_PrimitiveComponent.getAll();
	if (!Array.isArray(finalComponents) || finalComponents.length === 0) {
		throw new Error('当前 PCB 文档没有器件，已停止绘制。请确认 PCB 与原理图属于同一工程。');
	}

	await eda.dmt_EditorControl.zoomToAllPrimitives(currentDocument.tabId);
	await eda.pcb_Document.save();

	await eda.sys_Storage.setExtensionUserConfig(GROUPING_STORAGE_KEY, JSON.stringify(result));
	return result;
}

export async function loadLastGrouping(): Promise<ProjectGroupingResult | null> {
	const raw = eda.sys_Storage.getExtensionUserConfig(GROUPING_STORAGE_KEY);
	if (!raw) {
		return null;
	}

	try {
		return JSON.parse(String(raw)) as ProjectGroupingResult;
	}
	catch {
		return null;
	}
}
