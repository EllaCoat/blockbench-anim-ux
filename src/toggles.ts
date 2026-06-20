// blockbench-anim-ux — B + C: 「keyframes only」 / 「only show selected」 toggle
//
// filter bar 内の <button.anim-ux-toggle> 2 個に対するクリックを delegated に listen。
// onlySelected = true の間だけ selectionWatch に listener を 1 本登録して applyFilter を再発火する。
// (= 選択変化検知は selectionWatch.ts に共通化済 = v0.2 で E 機能とも共有)

import { applyFilter, filterState, type FilterState } from './animatorPanelUI'
import { addSelectionListener } from './selectionWatch'

const TOGGLE_SELECTOR = '.anim-ux-toggle'
const TOGGLE_KEYS: Array<keyof FilterState> = ['keyframesOnly', 'onlySelected', 'autoScroll']

let unsubscribeSelection: (() => void) | undefined

function startSelectionWatch(): void {
	if (unsubscribeSelection) return
	unsubscribeSelection = addSelectionListener(() => applyFilter())
}

function stopSelectionWatch(): void {
	unsubscribeSelection?.()
	unsubscribeSelection = undefined
}

// 同 panel 内の全 toggle button (= 同一 key を持つもの含む) に active class を反映。
// MutationObserver で bar が再 inject された後でも button が新規 element になるため、
// applyFilter() を呼ぶたびに class 状態も再描画する。
function syncToggleVisuals(): void {
	const buttons = document.querySelectorAll<HTMLElement>(TOGGLE_SELECTOR)
	for (const btn of buttons) {
		const key = btn.dataset.key as keyof FilterState | undefined
		if (!key || !TOGGLE_KEYS.includes(key)) continue
		btn.classList.toggle('active', Boolean(filterState[key]))
	}
}

export function installTogglesHandler(): () => void {
	function handler(e: Event) {
		const target = (e.target as HTMLElement | null)?.closest(TOGGLE_SELECTOR) as HTMLElement | null
		if (!target) return
		const key = target.dataset.key as keyof FilterState | undefined
		if (!key || !TOGGLE_KEYS.includes(key)) return

		const next = !filterState[key]
		// FilterState の各 key は boolean。 query (= string) は対象外なので switch で絞る。
		if (key === 'keyframesOnly') filterState.keyframesOnly = next
		else if (key === 'onlySelected') filterState.onlySelected = next
		else if (key === 'autoScroll') filterState.autoScroll = next

		if (key === 'onlySelected') {
			if (next) startSelectionWatch()
			else stopSelectionWatch()
		}

		syncToggleVisuals()
		applyFilter()
	}

	document.addEventListener('click', handler, true)

	return () => {
		document.removeEventListener('click', handler, true)
		stopSelectionWatch()
	}
}
