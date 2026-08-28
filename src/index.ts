/**
 * 入口文件 / Entry File
 */
import extensionConfig from '../extension.json' with { type: 'json' };
import { collectProjectGroupingFromSource, restorePcbSourceBackup } from './source/source-grouping';

// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		eda.sys_I18n.text('EasyEDA extension SDK v', undefined, undefined, extensionConfig.version),
		eda.sys_I18n.text('About'),
	);
}

async function runGrouping(mode: 'rectangle' | 'page' | 'selection', label: string): Promise<void> {
	try {
		eda.sys_Message.showToastMessage(`正在执行${label}...`);
		const result = await collectProjectGroupingFromSource(mode);
		const groupCount = result.pages.reduce((t, p) => t + p.rectangles.length, 0);
		const componentCount = result.pages.reduce((t, p) => t + p.rectangles.reduce((rt, r) => rt + r.components.length, 0), 0);
		eda.sys_Message.showToastMessage(`${label}完成：${groupCount} 组，${componentCount} 个器件`);
	}
	catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		eda.sys_Dialog.showInformationMessage(`${label}失败：${msg}`, label);
	}
}

export async function groupingRectangle(): Promise<void> {
	await runGrouping('rectangle', '矩形分组');
}

export async function groupingPage(): Promise<void> {
	await runGrouping('page', '图页分组');
}

export async function groupingSelection(): Promise<void> {
	await runGrouping('selection', '选中分组');
}

export async function groupingRollback(): Promise<void> {
	try {
		await restorePcbSourceBackup();
		eda.sys_Message.showToastMessage('PCB 源码已回退到最近一次分组前的备份');
	}
	catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		eda.sys_Dialog.showInformationMessage(`源码回退失败：${msg}`, '源码回退');
	}
}
