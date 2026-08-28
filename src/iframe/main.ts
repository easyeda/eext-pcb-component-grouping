import type { GroupingMode, ProjectGroupingResult } from '../grouping/core';

import { loadLastGrouping } from '../grouping/core';
import { collectProjectGroupingFromSource as collectProjectGrouping } from '../source/source-grouping';

declare const eda: any;

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) {
	throw new Error('Missing app root');
}

let currentMode: GroupingMode = 'rectangle';

function escapeHtml(value: string): string {
	let output = value;
	output = output.split('&').join('&amp;');
	output = output.split('<').join('&lt;');
	output = output.split('>').join('&gt;');
	output = output.split('"').join('&quot;');
	output = output.split(String.fromCharCode(39)).join('&#39;');
	return output;
}

interface SummaryStats {
	groupCount: number;
	componentCount: number;
	pcbMatchCount: number;
}

function sumAssignments(result: ProjectGroupingResult): SummaryStats {
	const groupCount = result.pages.reduce((total, page) => total + page.rectangles.length, 0);
	const componentCount = result.pages.reduce(
		(total, page) => total + page.rectangles.reduce((rectTotal, rect) => rectTotal + rect.components.length, 0),
		0,
	);

	return {
		groupCount,
		componentCount,
		pcbMatchCount: result.pcbMatches.length,
	};
}

function render(result: ProjectGroupingResult | null, message = '', error = ''): void {
	const stats = result ? sumAssignments(result) : { groupCount: 0, componentCount: 0, pcbMatchCount: 0 };
	const groupLabel = currentMode === 'rectangle' ? '矩形组' : currentMode === 'page' ? '图页组' : '选中组';
	const pagesHtml = result?.pages.map(page => `
		<section class="card">
			<div class="card-head">
				<div>
					<div class="eyebrow">${escapeHtml(page.pageName || '页面')}</div>
					<h3>${escapeHtml(page.pageName || '未命名页面')}</h3>
				</div>
				<div class="meta">${escapeHtml(page.boardName)}</div>
			</div>
			<div class="group-list">
				${page.rectangles.map(rect => `
					<div class="group-item">
						<div class="group-item-title">${escapeHtml(rect.label)} <span>${rect.components.length} 个器件</span></div>
						<div class="chips">${rect.components.map(component => `<span class="chip">${escapeHtml(component.label)}</span>`).join('')}</div>
					</div>
				`).join('') || '<div class="empty">没有找到矩形。</div>'}
			</div>
			${page.unclassified.length ? `<div class="warning">未分类器件：${page.unclassified.map(item => escapeHtml(item.label)).join('、')}</div>` : ''}
		</section>
	`).join('') ?? '';

	root.innerHTML = `
		<div class="shell">
			<header class="hero">
				<div>
					<div class="eyebrow">EasyEDA 组图工具</div>
					<h1>原理图矩形驱动 PCB 器件分组</h1>
					<p>读取原理图中的分类矩形，自动把器件分到对应区域，再匹配到 PCB 器件位号。</p>
				</div>
				<div class="actions">
					<div class="mode-group">
						<button class="mode-btn ${currentMode === 'rectangle' ? 'active' : ''}" data-mode="rectangle">矩形分组</button>
						<button class="mode-btn ${currentMode === 'page' ? 'active' : ''}" data-mode="page">图页分组</button>
						<button class="mode-btn ${currentMode === 'selection' ? 'active' : ''}" data-mode="selection">选中分组</button>
					</div>
					<button id="scanBtn" class="primary">重新扫描</button>
					<button id="copyBtn" class="ghost" ${result ? '' : 'disabled'}>复制 JSON</button>
				</div>
			</header>

			<section class="summary">
				<div class="stat"><span>工程</span><strong>${escapeHtml(result?.projectName || '未扫描')}</strong></div>
				<div class="stat"><span>${groupLabel}</span><strong>${stats.groupCount}</strong></div>
				<div class="stat"><span>已分类器件</span><strong>${stats.componentCount}</strong></div>
				<div class="stat"><span>PCB 匹配</span><strong>${stats.pcbMatchCount}</strong></div>
			</section>

			${message ? `<div class="toast success">${escapeHtml(message)}</div>` : ''}
			${error ? `<div class="toast error">${escapeHtml(error)}</div>` : ''}

			<section class="grid">
				${pagesHtml || '<div class="card empty-state">还没有扫描结果，点击“重新扫描”。</div>'}
			</section>
		</div>
	`;

	const scanBtn = document.querySelector<HTMLButtonElement>('#scanBtn');
	const copyBtn = document.querySelector<HTMLButtonElement>('#copyBtn');

	// 模式按钮事件
	document.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach((btn) => {
		btn.onclick = () => {
			currentMode = (btn.dataset.mode as GroupingMode) || 'rectangle';
			render(result);
		};
	});

	if (scanBtn) {
		scanBtn.onclick = async () => {
			render(result, '正在扫描，请稍候...');
			try {
				const next = await collectProjectGrouping(currentMode);
				await eda.sys_Storage.setExtensionUserConfig('schematic-pcb-grouping:last-view', JSON.stringify(next));
				render(next, '扫描完成。');
				eda.sys_Message.showToastMessage('扫描完成');
			}
			catch (scanError) {
				render(result, '', scanError instanceof Error ? scanError.message : String(scanError));
			}
		};
	}

	if (copyBtn) {
		copyBtn.onclick = async () => {
			if (!result) {
				return;
			}
			await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
			eda.sys_Message.showToastMessage('JSON 已复制');
		};
	}
}

async function init(): Promise<void> {
	root.innerHTML = '<div class="shell"><div class="card"><div class="empty">加载中...</div></div></div>';
	const previous = await loadLastGrouping();
	render(previous);
	try {
		const result = await collectProjectGrouping(currentMode);
		await eda.sys_Storage.setExtensionUserConfig('schematic-pcb-grouping:last-view', JSON.stringify(result));
		render(result, '扫描完成。');
	}
	catch (error) {
		render(previous, '', error instanceof Error ? error.message : String(error));
	}
}

void init();

const style = document.createElement('style');
style.textContent = `
	:root {
		color-scheme: light;
		--bg: #f4f8fc;
		--panel: #ffffff;
		--panel-2: #f7fafd;
		--line: #d7e4f0;
		--text: #17324d;
		--muted: #5f7b95;
		--accent: #1479c4;
		--accent-2: #3aa0e8;
		--warn: #c07b12;
		--error: #d2445a;
	}
	* { box-sizing: border-box; }
	body {
		margin: 0;
		font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		background:
			radial-gradient(circle at top left, rgba(20, 121, 196, 0.1), transparent 30%),
			radial-gradient(circle at top right, rgba(58, 160, 232, 0.08), transparent 28%),
			linear-gradient(180deg, #eef5fb 0%, var(--bg) 100%);
		color: var(--text);
	}
	button {
		border: 0;
		border-radius: 6px;
		padding: 12px 16px;
		font: inherit;
		font-weight: 700;
		cursor: pointer;
		transition: transform 0.16s ease, opacity 0.16s ease, box-shadow 0.16s ease;
	}
	button:hover { transform: translateY(-1px); }
	button:disabled { opacity: 0.45; cursor: not-allowed; transform: none; }
	.shell {
		padding: 18px;
		display: grid;
		gap: 16px;
	}
	.hero, .card, .summary, .toast {
		background: var(--panel);
		border: 1px solid var(--line);
		box-shadow: 0 8px 24px rgba(23, 50, 77, 0.08);
	}
	.hero {
		padding: 18px;
		border-radius: 8px;
		display: flex;
		justify-content: space-between;
		gap: 16px;
		align-items: flex-start;
	}
	.eyebrow {
		text-transform: uppercase;
		letter-spacing: 0.18em;
		font-size: 11px;
		color: var(--accent);
		font-weight: 800;
		margin-bottom: 8px;
	}
	h1 {
		margin: 0 0 10px;
		font-size: clamp(24px, 3vw, 36px);
		line-height: 1.08;
	}
	h3 {
		margin: 0;
		font-size: 16px;
	}
	p {
		margin: 0;
		color: var(--muted);
		line-height: 1.65;
	}
	.actions {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
		align-items: center;
	}
	.mode-group {
		display: flex;
		gap: 4px;
		background: var(--panel-2);
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 3px;
	}
	.mode-btn {
		padding: 8px 14px;
		border-radius: 4px;
		font-size: 13px;
		font-weight: 600;
		background: transparent;
		color: var(--muted);
		box-shadow: none;
		transition: background 0.16s, color 0.16s;
	}
	.mode-btn:hover {
		background: rgba(20, 121, 196, 0.08);
		color: var(--text);
		transform: none;
	}
	.mode-btn.active {
		background: var(--accent);
		color: #ffffff;
		box-shadow: 0 2px 8px rgba(20, 121, 196, 0.24);
	}
	.primary {
		background: linear-gradient(135deg, #1479c4, #3aa0e8);
		color: #ffffff;
		box-shadow: 0 10px 24px rgba(20, 121, 196, 0.24);
	}
	.ghost {
		background: #ffffff;
		color: var(--text);
		border: 1px solid var(--line);
	}
	.summary {
		border-radius: 8px;
		padding: 12px;
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 12px;
	}
	.stat {
		padding: 14px;
		border-radius: 6px;
		background: var(--panel-2);
		border: 1px solid var(--line);
	}
	.stat span {
		display: block;
		font-size: 12px;
		color: var(--muted);
		margin-bottom: 6px;
	}
	.stat strong {
		font-size: 16px;
		line-height: 1.35;
	}
	.toast {
		padding: 12px 14px;
		border-radius: 6px;
		font-weight: 600;
	}
	.toast.success { border-color: rgba(20, 121, 196, 0.35); color: #0d6294; }
	.toast.error { border-color: rgba(210, 68, 90, 0.35); color: var(--error); }
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 16px;
	}
	.card {
		border-radius: 8px;
		padding: 16px;
	}
	.card-head {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		align-items: flex-start;
		margin-bottom: 14px;
	}
	.meta {
		color: var(--muted);
		font-size: 12px;
	}
	.group-list {
		display: grid;
		gap: 12px;
	}
	.group-item {
		padding: 12px;
		border-radius: 6px;
		background: var(--panel-2);
		border: 1px solid var(--line);
	}
	.group-item-title {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		font-weight: 700;
		margin-bottom: 10px;
	}
	.group-item-title span {
		color: var(--muted);
		font-weight: 600;
		font-size: 12px;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.chip {
		padding: 6px 10px;
		border-radius: 4px;
		background: rgba(20, 121, 196, 0.08);
		border: 1px solid rgba(20, 121, 196, 0.2);
		color: #0d6294;
		font-size: 12px;
	}
	.warning {
		margin-top: 12px;
		padding: 10px 12px;
		border-radius: 4px;
		background: rgba(192, 123, 18, 0.08);
		border: 1px solid rgba(192, 123, 18, 0.24);
		color: var(--warn);
		font-size: 13px;
	}
	.empty,
	.empty-state {
		color: var(--muted);
		padding: 18px;
		text-align: center;
	}
	@media (max-width: 700px) {
		.hero {
			flex-direction: column;
		}
		.summary {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@media (max-width: 450px) {
		.shell { padding: 12px; }
		.summary {
			grid-template-columns: 1fr;
		}
		.card-head {
			flex-direction: column;
		}
	}
`;
document.head.appendChild(style);
