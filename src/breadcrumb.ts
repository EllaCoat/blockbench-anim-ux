// blockbench-anim-ux — D: 階層インデント / パンくず保持 (= 簡易版)
//
// 各 <li class="animator"> の名前 <span> に、 親階層をたどったパンくず (例: "root > arm_L > finger_L_03")
// を title 属性として付与する。 フィルタで階層コンテキストが消えても、 hover で親 path が見える。
// 本格的な「親 row 半透明残し」 は v0.2 以降に持ち越し、 まずは tooltip だけで補う最小実装。

import { findAnimatorList, registerRefreshCallback } from './animatorPanelUI'

declare const Group:
	| {
			all: Array<{
				uuid: string
				name: string
				parent?: { name?: string; parent?: unknown } | string
			}>
	  }
	| undefined

const BREADCRUMB_ATTR = 'data-anim-ux-breadcrumb'

function buildBreadcrumb(uuid: string): string | undefined {
	const all = (typeof Group !== 'undefined' ? Group : undefined)?.all
	if (!all) return undefined
	const target = all.find(g => g.uuid === uuid)
	if (!target) return undefined
	const path: string[] = [target.name]
	let cur: unknown = target.parent
	const seen = new Set<unknown>()
	while (cur && typeof cur === 'object' && !seen.has(cur)) {
		seen.add(cur)
		const node = cur as { name?: string; parent?: unknown }
		if (typeof node.name === 'string') path.unshift(node.name)
		cur = node.parent
	}
	if (path.length <= 1) return undefined
	return path.join(' > ')
}

function applyBreadcrumbs(): void {
	const list = findAnimatorList()
	if (!list) return
	const rows = list.querySelectorAll<HTMLElement>('li.animator')
	for (const row of rows) {
		const uuid = row.getAttribute('uuid') ?? ''
		const nameEl = row.querySelector<HTMLElement>('.timeline_animator_name')
		if (!nameEl) continue
		const bc = buildBreadcrumb(uuid)
		if (bc) {
			nameEl.title = bc
			nameEl.setAttribute(BREADCRUMB_ATTR, '1')
		} else if (nameEl.getAttribute(BREADCRUMB_ATTR) === '1') {
			nameEl.removeAttribute('title')
			nameEl.removeAttribute(BREADCRUMB_ATTR)
		}
	}
}

function clearAllBreadcrumbs(): void {
	const list = findAnimatorList()
	if (!list) return
	const tagged = list.querySelectorAll<HTMLElement>(`[${BREADCRUMB_ATTR}="1"]`)
	for (const el of tagged) {
		el.removeAttribute('title')
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
