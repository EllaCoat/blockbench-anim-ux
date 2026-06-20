// blockbench-anim-ux — 3D 選択状態の rAF polling を multiplex する共通 module
//
// 役割 :
//   - OutlinerNode.uuids 全走査で selected uuid set を snapshot
//   - rAF tick で前回 set と差分検知 → 登録 listener に (current, previous) を配信
//   - listener が 1 つ以上ある間だけ polling を回す (= 0 になったら自動停止)
//
// 経緯 :
//   - BB の select 経路は複数 (= outliner click / 3D view click / select_all action 等) で
//     個別 patch では取りこぼす。 v0.1 の C (onlySelected) は toggles.ts 内で
//     独自の rAF polling を持ってた。 v0.2 で E (autoScroll) も同じ polling が必要に
//     なったため共通化。
//   - Group.all だと AJ 拡張型 (= NullObject / Locator / VanillaItemDisplay) が
//     拾えないので OutlinerNode.uuids 経由で全 outliner node を走査する。

declare const OutlinerNode:
	| { uuids: Record<string, { selected?: boolean } | undefined> }
	| undefined

export type SelectionListener = (current: Set<string>, previous: Set<string>) => void

const listeners = new Set<SelectionListener>()
let watchHandle: number | undefined
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

function tick(): void {
	const cur = snapshot()
	if (!setsEqual(cur, prevUuids)) {
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
	watchHandle = requestAnimationFrame(tick)
}

function startIfIdle(): void {
	if (watchHandle !== undefined) return
	prevUuids = snapshot()
	watchHandle = requestAnimationFrame(tick)
}

function stopIfNoListeners(): void {
	if (watchHandle === undefined) return
	if (listeners.size > 0) return
	cancelAnimationFrame(watchHandle)
	watchHandle = undefined
}

// listener 登録 + 解除関数を返す。 解除すると polling は他に listener がなければ自動停止。
export function addSelectionListener(cb: SelectionListener): () => void {
	listeners.add(cb)
	startIfIdle()
	return () => {
		listeners.delete(cb)
		stopIfNoListeners()
	}
}
