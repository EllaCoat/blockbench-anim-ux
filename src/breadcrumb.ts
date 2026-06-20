// blockbench-anim-ux — D: 階層インデント / パンくず保持 (= 独自 tooltip 版)
//
// 役割 :
//   - 各 <li class="animator"> の <span class="timeline_animator_name"> に親階層 path を data 属性で保存
//   - hover 時に独自 floating div で表示 (= 「root > arm_L > finger_L_03」 形式)
//
// なぜ独自 tooltip にしたか :
//   - BB の `.timeline_animator_name` は `@mousedown="dragAnimator"` で draggable 化されており、
//     HTML 標準 title 属性による tooltip がブラウザに suppress される現象を確認 (= v0.1 実機検証)
//   - mouseover の delegated event 経由で独自 floating div を出す方式に切り替え

import { findAnimatorList, registerRefreshCallback } from './animatorPanelUI'

type OutlinerLike = { name?: string; parent?: unknown }

declare const OutlinerNode:
	| {
			uuids: Record<string, OutlinerLike>
	  }
	| undefined

const BREADCRUMB_ATTR = 'data-anim-ux-breadcrumb'
const TOOLTIP_ID = 'anim-ux-tooltip'
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

// ----- 独自 tooltip element -------------------------------------------------

function ensureTooltipElement(): HTMLElement {
	let el = document.getElementById(TOOLTIP_ID)
	if (!el) {
		el = document.createElement('div')
		el.id = TOOLTIP_ID
		el.style.cssText = [
			'position: fixed',
			'background: var(--color-back, #222)',
			'color: var(--color-text, #ddd)',
			'border: 1px solid var(--color-border, #444)',
			'padding: 4px 8px',
			'font-size: 12px',
			'border-radius: 2px',
			'z-index: 10000',
			'pointer-events: none',
			'display: none',
			'max-width: 400px',
			'word-break: break-all',
			'box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35)',
		].join('; ')
		document.body.appendChild(el)
	}
	return el
}

function showTooltip(text: string, x: number, y: number): void {
	const el = ensureTooltipElement()
	el.textContent = text
	el.style.display = 'block'
	el.style.left = `${x + 12}px`
	el.style.top = `${y + 16}px`
}

function hideTooltip(): void {
	const el = document.getElementById(TOOLTIP_ID)
	if (el) el.style.display = 'none'
}

function removeTooltipElement(): void {
	document.getElementById(TOOLTIP_ID)?.remove()
}

// ----- event handlers (= delegated) -----------------------------------------

function onMouseOver(e: MouseEvent): void {
	const target = (e.target as HTMLElement | null)?.closest(NAME_SELECTOR) as HTMLElement | null
	if (!target) return
	const bc = target.getAttribute(BREADCRUMB_ATTR)
	if (!bc) return
	showTooltip(bc, e.clientX, e.clientY)
}

function onMouseMove(e: MouseEvent): void {
	const el = document.getElementById(TOOLTIP_ID)
	if (!el || el.style.display === 'none') return
	const target = (e.target as HTMLElement | null)?.closest(NAME_SELECTOR) as HTMLElement | null
	if (!target) {
		hideTooltip()
		return
	}
	el.style.left = `${e.clientX + 12}px`
	el.style.top = `${e.clientY + 16}px`
}

function onMouseOut(e: MouseEvent): void {
	const target = (e.target as HTMLElement | null)?.closest(NAME_SELECTOR) as HTMLElement | null
	if (!target) return
	hideTooltip()
}

export function installBreadcrumbs(): () => void {
	const unregister = registerRefreshCallback(applyBreadcrumbs)
	applyBreadcrumbs()

	document.addEventListener('mouseover', onMouseOver, true)
	document.addEventListener('mousemove', onMouseMove, true)
	document.addEventListener('mouseout', onMouseOut, true)

	return () => {
		unregister()
		document.removeEventListener('mouseover', onMouseOver, true)
		document.removeEventListener('mousemove', onMouseMove, true)
		document.removeEventListener('mouseout', onMouseOut, true)
		hideTooltip()
		removeTooltipElement()
		clearAllBreadcrumbs()
	}
}
