// blockbench-anim-ux — #14 Onion Skin (= 選択 Group subtree のみ、 前後 1 frame 半透明表示)
//
// 役割 :
//   - 選択 Group の subtree (= 子 OutlinerNode の mesh.geometry) を ±1 step 時刻でゴースト表示
//   - past = 青系 / future = 橙系 で時間方向を視覚化
//
// 経路 (= BB 既存 onion skin と同じ pattern、 ただし全 rig ではなく選択 Group のみ) :
//   1. Blockbench.on('display_animation_frame') / 'update_selection' で再構築 trigger
//   2. Timeline.time 退避 → Animator.showDefaultPose + Animator.stackAnimations で目標時刻に rig を当てる
//   3. group.forEachChild で node を巡って node.mesh.geometry を clone + 半透明 material に置換
//   4. ghost を Canvas.scene 直下の ghostRoot に add
//   5. Timeline.time 復元 + showDefaultPose + stackAnimations で実 rig を元に戻す
//
// 既存 BB onion skin (= Animator.onion_skin_object) との関係 :
//   - 並列で独立 (= anim_ux 側は Group.selected のみに scope を絞る差別化)
//   - 既存 BB onion skin が ON だと 2 重表示になる、 そのときはどちらか OFF にして使う想定
//
// 設計判断 :
//   - 編集中の animation のみで stack (= Animation.selected を [Animation.selected] で渡す)、
//     playing=false でも ghost が出るようにする (= 微調整中の用途を優先)
//   - stackAnimations が無い古い BB では Animator.preview に fallback はせず silent skip
//     (= 再帰トラップ回避が優先、 Codex 助言通り)

import { filterState } from './animatorPanelUI'

declare const Canvas:
	| { scene?: { add(o: unknown): void; remove(o: unknown): void; updateMatrixWorld?(force?: boolean): void } }
	| undefined
declare const Animator:
	| {
			showDefaultPose(reduced_updates?: boolean): void
			stackAnimations(animations: unknown[], in_loop: boolean, blend?: number): void
			displayMeshDeformation?(): void
	  }
	| undefined
declare const Animation:
	| { all: Array<{ playing?: boolean }>; selected?: unknown }
	| undefined
declare const Timeline: { time: number; getStep?(): number } | undefined
declare const Group:
	| {
			selected?: Array<{
				uuid: string
				mesh?: unknown
				visibility?: boolean
				forEachChild(cb: (node: { uuid: string; mesh?: { geometry?: unknown }; visibility?: boolean }) => void): void
			}>
			first_selected?: {
				uuid: string
				mesh?: unknown
				visibility?: boolean
				forEachChild(cb: (node: { uuid: string; mesh?: { geometry?: unknown }; visibility?: boolean }) => void): void
			}
	  }
	| undefined
declare const Modes: { animate: boolean } | undefined
declare const Blockbench:
	| {
			on(event: string, cb: () => void): void
			removeListener(event: string, cb: () => void): void
	  }
	| undefined
declare const THREE: {
	Object3D: new () => unknown
	Mesh: new (geometry?: unknown, material?: unknown) => unknown
	MeshBasicMaterial: new (opts: Record<string, unknown>) => unknown
	Vector3: new () => unknown
	Quaternion: new () => unknown
	DoubleSide: number
}

const ROOT_NAME = 'anim_ux_onion_skin_ghosts'
const COLOR_PAST = 0x66aaff
const COLOR_FUTURE = 0xffaa66
const OPACITY = 0.2
const DEFAULT_STEP = 1 / 20 // BB の標準 = 20 fps (= AJ も同じ)

let ghostRoot: unknown | undefined
let busy = false

function ensureRoot(): unknown {
	if (ghostRoot) return ghostRoot
	const root = new (THREE.Object3D as new () => Record<string, unknown>)()
	root.name = ROOT_NAME
	root.no_export = true
	Canvas?.scene?.add(root)
	ghostRoot = root
	return root
}

function disposeObject(root: unknown): void {
	const r = root as { traverse?(cb: (obj: unknown) => void); children?: Array<unknown>; remove?(c: unknown): void }
	if (!r?.traverse) return
	r.traverse(obj => {
		const o = obj as { geometry?: { dispose?(): void }; material?: { dispose?(): void } | Array<{ dispose?(): void }> }
		o.geometry?.dispose?.()
		if (Array.isArray(o.material)) o.material.forEach(m => m.dispose?.())
		else o.material?.dispose?.()
	})
	const kids = (r.children ?? []).slice()
	for (const c of kids) r.remove?.(c)
}

function clearGhosts(): void {
	if (ghostRoot) disposeObject(ghostRoot)
}

function makeGhostMaterial(color: number): unknown {
	return new (THREE.MeshBasicMaterial as new (opts: Record<string, unknown>) => unknown)({
		color,
		transparent: true,
		opacity: OPACITY,
		depthWrite: false,
		side: THREE.DoubleSide,
	})
}

type MeshLike = {
	geometry?: unknown
	updateWorldMatrix?(updateParents: boolean, updateChildren: boolean): void
	getWorldPosition(target: unknown): unknown
	getWorldQuaternion(target: unknown): unknown
	getWorldScale(target: unknown): unknown
}

function cloneSubtreeAtCurrentPose(group: NonNullable<NonNullable<typeof Group>['first_selected']>, color: number): unknown {
	const batch = new (THREE.Object3D as new () => Record<string, unknown>)()
	batch.name = `${group.uuid}_ghost_batch`
	group.forEachChild((node) => {
		const src = node.mesh as MeshLike | undefined
		if (!src?.geometry || node.visibility === false) return
		const geomClone = (src.geometry as { clone(): unknown }).clone()
		const copy = new (THREE.Mesh as new (g: unknown, m: unknown) => Record<string, unknown>)(geomClone, makeGhostMaterial(color))
		copy.name = `${node.uuid}_ghost`
		copy.no_export = true
		copy.renderOrder = 10
		copy.frustumCulled = false
		src.updateWorldMatrix?.(true, false)
		const tmpV1 = new (THREE.Vector3 as new () => unknown)()
		const tmpQ = new (THREE.Quaternion as new () => unknown)()
		const tmpV2 = new (THREE.Vector3 as new () => unknown)()
		// Three.js の Object3D.position / quaternion / scale は内部固定の Vector3/Quaternion で、
		// 別 instance を直接 assign すると Object3D 側の matrix 計算に反映されない (= 描画位置が更新されない)。
		// さらに tmpV1/tmpQ/tmpV2 を past/future で使い回してるため、 直接 assign すると future build 時に
		// past の position が future の値に上書きされる (= 両 ghost が同位置に表示される)。
		// .copy() で「値だけ」 を内部 instance に書き込むのが正しい経路。
		;(copy.position as { copy(v: unknown): void }).copy(src.getWorldPosition(tmpV1))
		;(copy.quaternion as { copy(v: unknown): void }).copy(src.getWorldQuaternion(tmpQ))
		;(copy.scale as { copy(v: unknown): void }).copy(src.getWorldScale(tmpV2))
		;(batch as { add(c: unknown): void }).add(copy)
	})
	return batch
}

function applyPoseAt(time: number): void {
	if (!Animator || !Animation || !Timeline) return
	Timeline.time = time
	Animator.showDefaultPose(true)
	// 編集中の animation のみで stack (= playing 状態に依らず ghost を出すため)
	const stack = Animation.selected ? [Animation.selected] : Animation.all.filter(a => a.playing)
	Animator.stackAnimations(stack, false)
	Animator.displayMeshDeformation?.()
	Canvas?.scene?.updateMatrixWorld?.(true)
}

function withPoseAt(time: number, cb: () => void): void {
	if (!Timeline) return
	const lastTime = Timeline.time
	// applyPoseAt(time) を try 内に入れて、 stackAnimations 等の途中 throw でも
	// finally 復元が確実に走るようにする (= playhead / 実 rig 汚染防止)。
	try {
		applyPoseAt(time)
		cb()
	} finally {
		applyPoseAt(lastTime)
	}
}

function rebuildGhosts(): void {
	if (busy) return
	// OFF / 編集モード外 / Animation 未選択 のいずれかなら、 既存 ghost を消してから抜ける。
	// (= 早期 return だけだと前回 ghost が scene に残ってメモリも保持されたままになる)
	if (!filterState.onionSkin || !Modes?.animate || !Animation?.selected) {
		clearGhosts()
		return
	}
	const group = Group?.selected?.[0] ?? Group?.first_selected
	if (!group?.mesh) {
		clearGhosts()
		return
	}
	busy = true
	try {
		clearGhosts()
		const root = ensureRoot() as { add(c: unknown): void }
		const step = Timeline?.getStep?.() ?? DEFAULT_STEP
		const now = Timeline?.time ?? 0
		withPoseAt(Math.max(0, now - step), () => {
			root.add(cloneSubtreeAtCurrentPose(group, COLOR_PAST))
		})
		withPoseAt(now + step, () => {
			root.add(cloneSubtreeAtCurrentPose(group, COLOR_FUTURE))
		})
	} catch (e) {
		console.warn('[anim_ux] onion skin rebuild failed', e)
		clearGhosts()
	} finally {
		busy = false
	}
}

function onFrame(): void {
	rebuildGhosts()
}

function onSelection(): void {
	rebuildGhosts()
}

function onModeChange(): void {
	clearGhosts()
}

// toggle 押下時の即時反映用 (= toggles.ts から呼ぶ、 event 待ちのラグを避ける)
export function forceRefreshOnionSkin(): void {
	rebuildGhosts()
}

export function installOnionSkin(): () => void {
	// 防御的ガード : 想定外の BB build で THREE が global に居ない場合は plugin 全体を巻き込まない。
	// (= BB 標準 + AJ 環境では `Animator.onion_skin_object = new THREE.Object3D()` が機能してるので
	//   通常はここで弾かれない)
	if (typeof THREE === 'undefined') {
		console.warn('[anim_ux] THREE not available, onion skin disabled')
		return () => {}
	}
	Blockbench?.on('display_animation_frame', onFrame)
	Blockbench?.on('update_selection', onSelection)
	Blockbench?.on('select_mode', onModeChange)
	Blockbench?.on('unselect_project', onModeChange)
	Blockbench?.on('reset_project', onModeChange)

	return () => {
		Blockbench?.removeListener('display_animation_frame', onFrame)
		Blockbench?.removeListener('update_selection', onSelection)
		Blockbench?.removeListener('select_mode', onModeChange)
		Blockbench?.removeListener('unselect_project', onModeChange)
		Blockbench?.removeListener('reset_project', onModeChange)
		if (ghostRoot) {
			Canvas?.scene?.remove(ghostRoot)
			disposeObject(ghostRoot)
			ghostRoot = undefined
		}
	}
}
