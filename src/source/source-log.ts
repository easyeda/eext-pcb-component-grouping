export interface SourceHeader {
	type: string;
	id?: string;
	ticket?: number;
	[key: string]: unknown;
}

export interface SourceRecord<T = unknown> {
	header: SourceHeader;
	data: T | '';
	raw: string;
	line: number;
}

export interface SourceDocument {
	records: SourceRecord[];
	docType: string;
	uuid: string;
	client: string;
}

export function parseSourceLine(line: string, lineNumber = 1): SourceRecord | null {
	if (!line.trim())
		return null;
	const separator = line.indexOf('||');
	if (separator < 0)
		throw new Error(`Invalid EasyEDA source line ${lineNumber}: missing ||`);
	const header = JSON.parse(line.slice(0, separator)) as SourceHeader;
	let dataText = line.slice(separator + 2);
	if (dataText.endsWith('|'))
		dataText = dataText.slice(0, -1);
	const data = JSON.parse(dataText) as unknown;
	return { header, data: data as any, raw: line, line: lineNumber };
}

export function parseSourceLog(source: string): SourceDocument {
	const records = source.split(/\r?\n/).map((line, index) => parseSourceLine(line, index + 1)).filter((record): record is SourceRecord => record !== null);
	const head = records.find(record => record.header.type === 'DOCHEAD');
	if (!head || typeof head.data !== 'object' || !head.data)
		throw new Error('EasyEDA source has no DOCHEAD');
	const data = head.data as Record<string, unknown>;
	if (typeof data.docType !== 'string' || typeof data.uuid !== 'string')
		throw new Error('Invalid EasyEDA DOCHEAD');
	return { records, docType: data.docType, uuid: data.uuid, client: String(data.client ?? '') };
}

export function recordKey(record: SourceRecord): string {
	return `${record.header.type}\u0000${String(record.header.id ?? '')}`;
}

export function resolveRecords<T = any>(document: SourceDocument, type?: string): Map<string, SourceRecord<T>> {
	const resolved = new Map<string, SourceRecord<T>>();
	for (const record of document.records) {
		if (record.header.type === 'DOCHEAD' || (type && record.header.type !== type) || record.header.id == null)
			continue;
		const key = recordKey(record);
		const current = resolved.get(key);
		if (!current || Number(record.header.ticket ?? 0) >= Number(current.header.ticket ?? 0)) {
			if (record.data === '')
				resolved.delete(key);
			else resolved.set(key, record as SourceRecord<T>);
		}
	}
	return resolved;
}

export function getMaxTicket(document: SourceDocument): number {
	return document.records.reduce((max, record) => Math.max(max, Number(record.header.ticket ?? 0)), 0);
}

export function appendRecords(source: string, records: Array<{ header: SourceHeader; data: unknown | '' }>): string {
	if (records.length === 0)
		return source;
	const body = source.trimEnd();
	const separator = body.endsWith('|') ? '' : '|';
	return `${body}${separator}\n${records.map(record => `${JSON.stringify(record.header)}||${JSON.stringify(record.data)}`).join('|\n')}`;
}

export function effectiveRecordsByType(document: SourceDocument, type: string): SourceRecord[] {
	return Array.from(resolveRecords(document, type).values());
}
