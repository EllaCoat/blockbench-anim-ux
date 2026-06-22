// blockbench-anim-ux — D: 階層インデント / パンくず保持 (= body 直下 fixed tooltip 版)
//
// 役割 :
//   - 各 <li class="animator"> の <span class="timeline_animator_name"> に親階層 path を data 属性で保存
//   - mouseover で document.body 直下の fixed-position div として tooltip を表示
//
// 表示位置 :
//   - span の左端の左 12px に tooltip の右端を揃える (= span の左隣にぴったり配置)
//   - 垂直方向は span の中央
//
// 表示位置を body 直下 fixed にした理由 :
//   - timeline panel の中で z-index を上げても、 他 panel (= ANIMATIONS / MCP / KEYFRAME / PLACEHOLDERS 等)
//     の方が BB の panel システムで上位 stacking context を持ち、 子の z-index がそれを超えられない
//   - body 直下に置けば panel 階層と無関係、 viewport 基準で常に最前面に出せる

import { findAnimatorList, registerRefreshCallback } from './animatorPanelUI'
import { addDocumentListener, getDocuments } from './popoutBus'

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

// ----- 独自 tooltip element (= body 直下 fixed) ------------------------------

// popout 中は hover 対象の span が子窓に居て、 getBoundingClientRect も子窓 viewport 基準。
// tooltip element も同じ document に作って append しないと、 座標がズレるか body 直下なのに
// 別 document で表示できない (= Codex 確認)。 ownerDocument を起点に揃える。
function ensureTooltipElement(doc: Document): HTMLElement {
	let el = doc.getElementById(TOOLTIP_ID)
	if (!el) {
		el = doc.createElement('div')
		el.id = TOOLTIP_ID
		el.style.cssText = [
			'position: fixed',
			'background: var(--color-back, #222)',
			'color: var(--color-text, #ddd)',
			'border: 1px solid var(--color-border, #444)',
			'padding: 4px 8px',
			'font-size: 12px',
			'border-radius: 2px',
			'z-index: 99999',
			'pointer-events: none',
			'display: none',
			'max-width: 400px',
			'white-space: nowrap',
			'box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35)',
		].join('; ')
		doc.body.appendChild(el)
	}
	return el
}

function showTooltipFor(target: HTMLElement, text: string): void {
	const doc = target.ownerDocument ?? document
	const win = doc.defaultView ?? window
	const el = ensureTooltipElement(doc)
	const rect = target.getBoundingClientRect()
	el.textContent = text
	el.style.display = 'block'
	// span 左端の左 12px に tooltip の右端を揃える (= span の左隣に密接配置)
	el.style.left = ''
	el.style.right = `${Math.max(8, win.innerWidth - rect.left + 12)}px`
	el.style.top = `${rect.top + rect.height / 2}px`
	el.style.transform = 'translateY(-50%)'
}

// 親 + 子窓両方の tooltip を hide (= popout 状態遷移過渡期に両方残らないように)
function hideTooltip(): void {
	for (const doc of getDocuments()) {
		const el = doc.getElementById(TOOLTIP_ID)
		if (el) el.style.display = 'none'
	}
}

function removeTooltipElement(): void {
	for (const doc of getDocuments()) {
		doc.getElementById(TOOLTIP_ID)?.remove()
	}
}

// ----- event handlers (= delegated mouseover / mouseout) --------------------

function onMouseOver(e: MouseEvent): void {
	const target = (e.target as HTMLElement | null)?.closest(NAME_SELECTOR) as HTMLElement | null
	if (!target) return
	const bc = target.getAttribute(BREADCRUMB_ATTR)
	if (!bc) {
		hideTooltip()
		return
	}
	showTooltipFor(target, bc)
}

function onMouseOut(e: MouseEvent): void {
	const target = (e.target as HTMLElement | null)?.closest(NAME_SELECTOR) as HTMLElement | null
	if (!target) return
	hideTooltip()
}

export function installBreadcrumbs(): () => void {
	const unregister = registerRefreshCallback(applyBreadcrumbs)
	applyBreadcrumbs()
	// popout 中は子窓 document にも自動 attach (= TIMELINE 別窓内の hover も拾う)
	const removeOver = addDocumentListener('mouseover', onMouseOver, true)
	const removeOut = addDocumentListener('mouseout', onMouseOut, true)
	return () => {
		unregister()
		removeOver()
		removeOut()
		hideTooltip()
		removeTooltipElement()
		clearAllBreadcrumbs()
	}
}
