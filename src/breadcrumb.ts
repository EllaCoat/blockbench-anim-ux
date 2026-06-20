// blockbench-anim-ux — D: 階層インデント / パンくず保持 (= CSS :hover::after 版)
//
// 役割 :
//   - 各 <li class="animator"> の <span class="timeline_animator_name"> に親階層 path を data 属性で保存
//   - 表示は animatorPanelUI.ts 内の CSS `:hover::after { content: attr(data-anim-ux-breadcrumb) }` で行う
//
// なぜ CSS approach にしたか :
//   - HTML `title` 属性 / JS の `mouseover` event を経由する tooltip は、 BB の draggable + 独自 mousedown 干渉で
//     どちらも標準動作が抑制される現象を v0.1 実機検証で確認 (= title は完全 suppress、 mouseover は確認中)
//   - CSS `:hover::after` は擬似要素を element 直下に絶対配置するため、 JS event に依存せず確実に動く

import { findAnimatorList, registerRefreshCallback } from './animatorPanelUI'

type OutlinerLike = { name?: string; parent?: unknown }

declare const OutlinerNode:
	| {
			uuids: Record<string, OutlinerLike>
	  }
	| undefined

const BREADCRUMB_ATTR = 'data-anim-ux-breadcrumb'
const NAME_SELECTOR = '.timeline_animator_name'

function getOutlinerNode(uuid: string): OutlinerLike | undefined {
	const uuids = (typeof OutlinerNode !== 'undefined' ? OutlinerNode : undefined)?.uuids
	return uuids?.[uuid]
}

function buildBreadcrumb(uuid: string): string | undefined {
	const target = getOutlinerNode(uuid)
	if (!target || typeof target.name !== 'string') return undefined
	const path: string[] = [target.name]
	let cur: unknown = target.parent
	const seen = new Set<unknown>()
	while (cur && typeof cur === 'object' && !seen.has(cur)) {
		seen.add(cur)
		const node = cur as OutlinerLike
		if (typeof node.name === 'string') path.unshift(node.name)
		cur = node.parent
	}
	return path.join(' > ')
}

function applyBreadcrumbs(): void {
	const list = findAnimatorList()
	if (!list) return
	const rows = list.querySelectorAll<HTMLElement>('li.animator')
	for (const row of rows) {
		const uuid = row.getAttribute('uuid') ?? ''
		const nameEl = row.querySelector<HTMLElement>(NAME_SELECTOR)
		if (!nameEl) continue
		const bc = buildBreadcrumb(uuid)
		if (bc) {
			nameEl.setAttribute(BREADCRUMB_ATTR, bc)
		} else if (nameEl.hasAttribute(BREADCRUMB_ATTR)) {
			nameEl.removeAttribute(BREADCRUMB_ATTR)
		}
	}
}

function clearAllBreadcrumbs(): void {
	const list = findAnimatorList()
	if (!list) return
	const tagged = list.querySelectorAll<HTMLElement>(`[${BREADCRUMB_ATTR}]`)
	for (const el of tagged) {
		el.removeAttribute(BREADCRUMB_ATTR)
	}
}

export function installBreadcrumbs(): () => void {
	const unregister = registerRefreshCallback(applyBreadcrumbs)
	applyBreadcrumbs()
	return () => {
		unregister()
		clearAllBreadcrumbs()
	}
}
