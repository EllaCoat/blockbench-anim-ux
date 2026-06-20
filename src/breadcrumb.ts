// blockbench-anim-ux — D: 階層インデント / パンくず保持 (= 簡易版)
//
// 各 <li class="animator"> の名前 <span> に、 親階層をたどったパンくず (例: "root > arm_L > finger_L_03")
// を title 属性として付与する。 フィルタで階層コンテキストが消えても、 hover で親 path が見える。
//
// 実装ポイント :
//   - `OutlinerNode.uuids[uuid]` で直接 lookup (= AJ 拡張型 NullObject / Locator / VanillaItemDisplay も含めて O(1))
//   - 旧 v0.1 で使っていた `Group.all` は Group 型しか持たず AJ 拡張型で hit せず undefined となるバグの原因
//   - 単独 name (= 親階層なし) でも tooltip を出す (= v0.1.1、 動作確認可能性向上)

import { findAnimatorList, registerRefreshCallback } from './animatorPanelUI'

type OutlinerLike = { name?: string; parent?: unknown }

declare const OutlinerNode:
	| {
			uuids: Record<string, OutlinerLike>
	  }
	| undefined

const BREADCRUMB_ATTR = 'data-anim-ux-breadcrumb'

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
	if (!list) {
		console.log('[anim_ux/bc] applyBreadcrumbs: no list')
		return
	}

	const rows = list.querySelectorAll<HTMLElement>('li.animator')
	const uuidsObj = (typeof OutlinerNode !== 'undefined' ? OutlinerNode : undefined)?.uuids
	const totalUuids = uuidsObj ? Object.keys(uuidsObj).length : 'undefined'
	console.log(`[anim_ux/bc] apply: rows=${rows.length} OutlinerNode.uuids=${totalUuids}`)

	let applied = 0
	for (const row of rows) {
		const uuid = row.getAttribute('uuid') ?? ''
		const nameEl = row.querySelector<HTMLElement>('.timeline_animator_name')
		if (!nameEl) continue
		const target = getOutlinerNode(uuid)
		const bc = buildBreadcrumb(uuid)
		if (bc) {
			nameEl.title = bc
			nameEl.setAttribute(BREADCRUMB_ATTR, '1')
			applied++
			if (rows.length < 20) {
				const setVal = bc
				setTimeout(() => {
					if (nameEl.title !== setVal) {
						console.log(
							`[anim_ux/bc] title overwritten on uuid=${uuid.slice(0, 8)}: "${setVal}" → "${nameEl.title}"`
						)
					}
				}, 100)
			}
		} else if (nameEl.getAttribute(BREADCRUMB_ATTR) === '1') {
			nameEl.removeAttribute('title')
			nameEl.removeAttribute(BREADCRUMB_ATTR)
		}
		if (rows.length < 20) {
			console.log(
				`[anim_ux/bc]   uuid=${uuid.slice(0, 8)} target=${target ? 'yes' : 'no'} name="${target?.name}" parent=${typeof target?.parent} bc="${bc}"`
			)
		}
	}
	console.log(`[anim_ux/bc] applied=${applied}/${rows.length}`)
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
