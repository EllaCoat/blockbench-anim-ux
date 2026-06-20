// blockbench-anim-ux — 3D 選択状態の変化を multiplex する共通 module
//
// 役割 :
//   - OutlinerNode.uuids 全走査で selected uuid set を snapshot
//   - Blockbench の `update_selection` event で差分検知 → 登録 listener に (current, previous) を配信
//   - listener が 1 つ以上ある間だけ event を attach (= 0 になったら自動 detach)
//
// 経緯 :
//   - BB の select 経路は多数 (= outliner click / 3D view click / select_all / undo / mode 切替等) だが、
//     `js/misc.js:107 updateSelection()` を最終的に通過 → 末尾の `dispatchEvent('update_selection')` で
//     全経路が global event に集約される (= 2026-06-20 BB source grep で確認、 weight_paint /
//     element_panel / cube highlight 等の既存 BB feature も同 event 駆動で動いてる)。
//   - v0.1〜v0.2 は rAF polling だったが、 idle 時も毎 frame 走るのが無駄 + 設計上の冗長性。
//     v0.3 で event 駆動に切替 (= update_selection を直接 listen、 idle cost ゼロ)。
//   - Group.all だと AJ 拡張型 (= NullObject / Locator / VanillaItemDisplay) が拾えないので、
//     差分 snapshot は引き続き OutlinerNode.uuids 全走査 (= AJ 拡張型を含む全 outliner node)。

declare const OutlinerNode:
	| { uuids: Record<string, { selected?: boolean } | undefined> }
	| undefined
declare const Blockbench:
	| { on(event: string, cb: () => void): void; removeListener(event: string, cb: () => void): void }
	| undefined

export type SelectionListener = (current: Set<string>, previous: Set<string>) => void

const listeners = new Set<SelectionListener>()
let attached = false
let prevUuids: Set<string> = new Set()

function snapshot(): Set<string> {
	const set = new Set<string>()
	const uuids = (typeof OutlinerNode !== 'undefined' ? OutlinerNode : undefined)?.uuids
	if (!uuids) return set
	for (const uuid in uuids) {
		if (uuids[uuid]?.selected) set.add(uuid)
	}
	return set
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false
	for (const v of a) if (!b.has(v)) return false
	return true
}

function onUpdateSelection(): void {
	const cur = snapshot()
	if (setsEqual(cur, prevUuids)) return
	const prev = prevUuids
	prevUuids = cur
	for (const cb of listeners) {
		try {
			cb(cur, prev)
		} catch (e) {
			console.warn('[anim_ux] selection listener failed', e)
		}
	}
}

function attachIfIdle(): void {
	if (attached) return
	// 初回 attach 時点の現状を baseline に (= attach 直後の event で「全部新規追加」 と誤判定するのを防ぐ)。
	prevUuids = snapshot()
	Blockbench?.on('update_selection', onUpdateSelection)
	attached = true
}

function detachIfNoListeners(): void {
	if (!attached || listeners.size > 0) return
	Blockbench?.removeListener('update_selection', onUpdateSelection)
	attached = false
	prevUuids = new Set()
}

// listener 登録 + 解除関数を返す。 解除すると他に listener がなければ event を detach。
export function addSelectionListener(cb: SelectionListener): () => void {
	listeners.add(cb)
	attachIfIdle()
	return () => {
		listeners.delete(cb)
		detachIfNoListeners()
	}
}
