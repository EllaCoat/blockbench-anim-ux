// blockbench-anim-ux — E: 3D 選択 → animator panel auto-scroll + 一時ハイライト
//
// 役割 :
//   - filterState.autoScroll = true の間、 selectionWatch の listener として動く
//   - 直前 snapshot に無かった uuid (= 新規選択) を 1 つ拾って、 対応 animator row へ scrollIntoView
//   - 移動先 row に anim-ux-flash class を 600ms 付与 (= CSS keyframe で背景フェード)
//
// 設計判断 :
//   - 「新規選択」 = current にだけ存在する uuid。 複数同時に増えたときは最初の 1 つを target (= 走査順、 OutlinerNode.uuids の挿入順依存)
//   - row が `display: none` (= filter で隠されてる) なら skip。 表示されてない row へ scroll しても UX 上意味ない
//   - panel が timeline panel ではなく他 panel になってる場合 (= findAnimatorList が undefined) も skip
//   - keyframesOnly / onlySelected が ON のままでも害なし (= 隠れてる row には scroll しないだけ)

import { filterState, findAnimatorList } from './animatorPanelUI'
import { addSelectionListener } from './selectionWatch'

const FLASH_CLASS = 'anim-ux-flash'
const FLASH_DURATION_MS = 600

let unsubscribe: (() => void) | undefined

function findRowForUuid(uuid: string): HTMLElement | undefined {
	const list = findAnimatorList()
	if (!list) return undefined
	// CSS.escape は uuid (= 16 進 + ハイフン) では実害ないが、 安全側に倒す
	const selector = `li.animator[uuid="${CSS.escape(uuid)}"]`
	return list.querySelector<HTMLElement>(selector) ?? undefined
}

function pickNewlySelected(current: Set<string>, previous: Set<string>): string | undefined {
	for (const uuid of current) {
		if (!previous.has(uuid)) return uuid
	}
	return undefined
}

function onSelectionChange(current: Set<string>, previous: Set<string>): void {
	if (!filterState.autoScroll) return
	const target = pickNewlySelected(current, previous)
	if (!target) return
	const row = findRowForUuid(target)
	if (!row) return
	if (row.style.display === 'none') return
	row.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
	row.classList.add(FLASH_CLASS)
	window.setTimeout(() => row.classList.remove(FLASH_CLASS), FLASH_DURATION_MS)
}

export function installAutoScroll(): () => void {
	unsubscribe = addSelectionListener(onSelectionChange)
	return () => {
		unsubscribe?.()
		unsubscribe = undefined
		const list = findAnimatorList()
		if (list) {
			const flashed = list.querySelectorAll<HTMLElement>(`.${FLASH_CLASS}`)
			for (const el of flashed) el.classList.remove(FLASH_CLASS)
		}
	}
}
