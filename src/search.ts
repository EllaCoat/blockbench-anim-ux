// blockbench-anim-ux — A: incremental search による animator filter
//
// filter bar 内の <input.anim-ux-search> に対する input event を delegated に listen し、
// filterState.query を更新 + applyFilter() で表示反映する。
// bar が再 inject されても DOM 寿命に依存しない (= document レベルで capture)。

import { applyFilter, filterState } from './animatorPanelUI'
import { addDocumentListener } from './popoutBus'

const SEARCH_SELECTOR = '.anim-ux-search'

export function installSearchHandler(): () => void {
	function handler(e: Event) {
		const target = e.target as HTMLElement | null
		if (!target || !target.matches(SEARCH_SELECTOR)) return
		filterState.query = (target as HTMLInputElement).value
		applyFilter()
	}
	// popout 中は子窓 document にも自動 attach (= TIMELINE 別窓内の検索入力も拾う)
	const removeListener = addDocumentListener('input', handler, true)
	return () => {
		removeListener()
	}
}
