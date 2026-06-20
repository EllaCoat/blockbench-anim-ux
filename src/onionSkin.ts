// blockbench-anim-ux — #14 Onion Skin (= 選択 Group subtree のみ、 前後 1 frame 半透明表示)
//
// 役割 :
//   - 選択 Group の subtree (= 子 OutlinerNode の mesh.geometry) を ±1 step 時刻でゴースト表示
//   - past = 青系 / future = 橙系 で時間方向を視覚化
//
// 経路 (= BB 既存 onion skin と同じ pattern、 ただし全 rig ではなく選択 Group のみ) :
//   1. Blockbench.on('display_animation_frame') / 'update_selection' で再構築 trigger
//   2. Timeline.time 退避 → Animator.showDefaultPose + Animator.stackAnimations で目標時刻に rig を当てる
//   3. 選択 Group の subtree を走査して各 src.mesh に対応する ghost mesh を ghostMeshes Map で確保
//   4. src の world transform を ghost に .copy() で書き戻す (= 差分更新、 毎 frame の dispose ナシ)
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
//   - ghost mesh は Map<srcUuid|direction, Mesh> で永続管理 (= v0.3 で差分更新化)。
//     v0.2 初版は毎 frame dispose + 再 clone で GC ストッターを誘発していた。 現在は :
//       * selection / 子構成が変わった時のみ Map をクリア + ensureGhost で再生成
//       * 通常 frame は src の world transform を ghost に .copy() するだけ (= no allocation)
//       * material は past/future で 1 つずつ共有 (= ghost ごとに作らず dispose も不要)
//       * matrixAutoUpdate=false + 手動 updateMatrix() で内部 matrix 計算も最小化

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
declare const Action: new (id: string, opts: Record<string, unknown>) => { delete(): void }
declare const Dialog: new (opts: Record<string, unknown>) => { show(): void }
declare const MenuBar:
	| { menus: Record<string, { addAction(action: unknown): void; removeAction(action: unknown): void } | undefined> }
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
const OPACITY_BASE = 0.2
const DEFAULT_STEP = 1 / 20 // BB の標準 = 20 fps (= AJ も同じ)

// range = ±N frame の N。 dialog で設定変更可、 localStorage 永続。
// 範囲は 1〜5、 デフォルト 1 (= v0.2 互換)。 上限は pose 当て直しコストとの兼ね合いで保守的に。
const RANGE_STORAGE_KEY = 'anim_ux_onion_skin_range'
const DEFAULT_RANGE = 1
const MIN_RANGE = 1
const MAX_RANGE = 5
let onionSkinRange = DEFAULT_RANGE

function loadRange(): void {
	try {
		const v = window.localStorage.getItem(RANGE_STORAGE_KEY)
		const n = v != null ? Number.parseInt(v, 10) : Number.NaN
		if (Number.isFinite(n) && n >= MIN_RANGE && n <= MAX_RANGE) {
			onionSkinRange = n
		}
	} catch {
		/* localStorage 不可 (= private mode 等) は default のまま */
	}
}

function saveRange(n: number): void {
	try {
		window.localStorage.setItem(RANGE_STORAGE_KEY, String(n))
	} catch {
		/* ignore */
	}
}

// distance ごとの opacity。 線形減衰 = OPACITY_BASE * (1 - (distance-1) / range)。
// range=1 → distance=1 で OPACITY_BASE (= v0.2 互換)、 range=N → distance=N で OPACITY_BASE/N。
function opacityFor(distance: number, range: number): number {
	if (range <= 1) return OPACITY_BASE
	return OPACITY_BASE * (1 - (distance - 1) / range)
}

type GhostMesh = {
	geometry?: { dispose?(): void }
	material?: unknown
	position: { copy(v: unknown): void }
	quaternion: { copy(v: unknown): void }
	scale: { copy(v: unknown): void }
	updateMatrix(): void
	matrixAutoUpdate: boolean
	name?: string
	renderOrder?: number
	frustumCulled?: boolean
	no_export?: boolean
}

type SrcMesh = {
	geometry?: unknown
	updateWorldMatrix?(updateParents: boolean, updateChildren: boolean): void
	getWorldPosition(target: unknown): unknown
	getWorldQuaternion(target: unknown): unknown
	getWorldScale(target: unknown): unknown
}

type GhostDirection = 'past' | 'future'

let ghostRoot: { add(c: unknown): void; remove(c: unknown): void } | undefined
let busy = false

// `${srcNodeUuid}|${'past' | 'future'}` をキーに ghost mesh を保持。
// selection / 子構成が同じ間は再利用して transform だけ更新する (= GC ストッター対策の本体)。
const ghostMeshes = new Map<string, GhostMesh>()
// 「同じ集合の上で transform だけ更新できるか」 を判定するための signature。
// `${groupUuid}|${子 uuid を巡回順に join}` で表現。 forEachChild 順序は安定と仮定。
let lastSrcSignature: string | undefined

// material は (direction, distance) ごとに 1 つを Map で共有 (= ghost dispose 時は触らない、
// plugin unload / range 変更時にまとめて dispose)。 同 direction + 同 distance の ghost は
// 同 material instance を共有 = ghost 全数ぶん作らずに済む。
type GhostMaterial = { dispose?(): void; opacity?: number }
const materials = new Map<string, GhostMaterial>()

// transform 取得用の一時 Vector/Quaternion (= frame 毎の allocation を抑える)。
// THREE が globals に居ないとき (= plugin load gate で弾く前) は touch しないため遅延初期化。
let tmpsInited = false
let tmpVec1: unknown
let tmpQuat: unknown
let tmpVec2: unknown
function ensureTmps(): void {
	if (tmpsInited) return
	tmpVec1 = new (THREE.Vector3 as new () => unknown)()
	tmpQuat = new (THREE.Quaternion as new () => unknown)()
	tmpVec2 = new (THREE.Vector3 as new () => unknown)()
	tmpsInited = true
}

function ensureRoot(): { add(c: unknown): void; remove(c: unknown): void } {
	if (ghostRoot) return ghostRoot
	const root = new (THREE.Object3D as new () => Record<string, unknown>)()
	root.name = ROOT_NAME
	root.no_export = true
	Canvas?.scene?.add(root)
	ghostRoot = root as { add(c: unknown): void; remove(c: unknown): void }
	return ghostRoot
}

function getMaterial(direction: GhostDirection, distance: number): unknown {
	const key = `${direction}|${distance}`
	const existing = materials.get(key)
	if (existing) return existing
	const color = direction === 'past' ? COLOR_PAST : COLOR_FUTURE
	const mat = makeGhostMaterial(color, opacityFor(distance, onionSkinRange)) as GhostMaterial
	materials.set(key, mat)
	return mat
}

function makeGhostMaterial(color: number, opacity: number): unknown {
	return new (THREE.MeshBasicMaterial as new (opts: Record<string, unknown>) => unknown)({
		color,
		transparent: true,
		opacity,
		depthWrite: false,
		side: THREE.DoubleSide,
	})
}

function disposeAllMaterials(): void {
	for (const m of materials.values()) m.dispose?.()
	materials.clear()
}

// 選択 Group subtree を走査して、 ghost にできる src node entry の配列を返す。
// 「ghost にできる」 = mesh + geometry + visibility ≠ false + geometry.clone 関数あり。
function collectGhostableSrcs(group: NonNullable<NonNullable<typeof Group>['first_selected']>): Array<{ uuid: string; src: SrcMesh }> {
	const list: Array<{ uuid: string; src: SrcMesh }> = []
	group.forEachChild((node) => {
		const src = node.mesh as SrcMesh | undefined
		if (!src?.geometry || node.visibility === false) return
		// geometry.clone 関数を持たない実装 (= AJ 拡張型 / 独自 mesh) は silent skip。
		// v0.2 で type ガード追加済、 v0.3 でも維持。
		const geom = src.geometry as { clone?: () => unknown }
		if (typeof geom.clone !== 'function') return
		list.push({ uuid: node.uuid, src })
	})
	return list
}

// src 1 件 + (direction, distance) から ghost mesh を取得 (= 既存ならそのまま、 未生成なら作って Map と root に add)。
// geometry は src.geometry.clone() で 1 回だけ作って ghost に固定、 以後は src 変形に追従しない。
// (= 通常 src の geometry は mesh edit でしか変わらず、 そのときは selection/構成変動扱いで Map 全リセットされる)
function ensureGhost(entry: { uuid: string; src: SrcMesh }, direction: GhostDirection, distance: number): GhostMesh {
	const key = `${entry.uuid}|${direction}|${distance}`
	const existing = ghostMeshes.get(key)
	if (existing) return existing

	const geom = (entry.src.geometry as { clone(): unknown }).clone()
	const mesh = new (THREE.Mesh as new (g: unknown, m: unknown) => Record<string, unknown>)(geom, getMaterial(direction, distance)) as GhostMesh & Record<string, unknown>
	mesh.name = `${entry.uuid}_ghost_${direction}_${distance}`
	mesh.no_export = true
	mesh.renderOrder = 10
	mesh.frustumCulled = false
	// 通常 frame は updateMatrix() を手動で呼ぶ前提 (= 内部の auto 計算を切って計算量削減)。
	mesh.matrixAutoUpdate = false
	ghostMeshes.set(key, mesh as GhostMesh)
	ensureRoot().add(mesh)
	return mesh as GhostMesh
}

// src の現在 world transform を ghost に .copy() で書き戻して、 手動 updateMatrix() で内部 matrix 更新。
// Three.js の Object3D.position / quaternion / scale は内部固定 instance なので、 別 instance assign は NG。
function applyTransformFromSrc(ghost: GhostMesh, src: SrcMesh): void {
	src.updateWorldMatrix?.(true, false)
	ghost.position.copy(src.getWorldPosition(tmpVec1))
	ghost.quaternion.copy(src.getWorldQuaternion(tmpQuat))
	ghost.scale.copy(src.getWorldScale(tmpVec2))
	ghost.updateMatrix()
}

// Map と root から全 ghost を取り除いて geometry を dispose。 material は共有なので触らない。
function disposeAllGhosts(): void {
	const root = ghostRoot
	for (const ghost of ghostMeshes.values()) {
		ghost.geometry?.dispose?.()
		root?.remove(ghost)
	}
	ghostMeshes.clear()
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
		disposeAllGhosts()
		lastSrcSignature = undefined
		return
	}
	const group = Group?.selected?.[0] ?? Group?.first_selected
	if (!group?.mesh) {
		disposeAllGhosts()
		lastSrcSignature = undefined
		return
	}
	busy = true
	try {
		ensureTmps()
		ensureRoot()
		const step = Timeline?.getStep?.() ?? DEFAULT_STEP
		const now = Timeline?.time ?? 0
		const range = onionSkinRange

		// 選択 Group の子構成 + range の signature を計算 → 前回と違えば Map を全リセット
		// (= selection 変動 / 子追加削除 / visibility 変動 / 別 group へ切替 / range 変更を一括検知)。
		// 一致なら ghost mesh を再利用、 transform だけ書き戻す。
		const srcs = collectGhostableSrcs(group)
		const signature = `${group.uuid}|${range}|${srcs.map((e) => e.uuid).join(',')}`
		if (signature !== lastSrcSignature) {
			disposeAllGhosts()
			lastSrcSignature = signature
		}

		// past: distance 1..range で各 pose を当てて、 距離別の ghost に transform 反映
		for (let d = 1; d <= range; d++) {
			withPoseAt(Math.max(0, now - step * d), () => {
				for (const entry of srcs) {
					const ghost = ensureGhost(entry, 'past', d)
					applyTransformFromSrc(ghost, entry.src)
				}
			})
		}
		// future: 同じく ±N 化
		for (let d = 1; d <= range; d++) {
			withPoseAt(now + step * d, () => {
				for (const entry of srcs) {
					const ghost = ensureGhost(entry, 'future', d)
					applyTransformFromSrc(ghost, entry.src)
				}
			})
		}
	} catch (e) {
		console.warn('[anim_ux] onion skin rebuild failed', e)
		disposeAllGhosts()
		lastSrcSignature = undefined
	} finally {
		busy = false
	}
}

// range を変更 → 永続化 → ghost と material を全消し (= 次 rebuild で新 range の構成で作り直す)。
// 範囲外の値は clamp、 整数化。 toggle が OFF の場合でも localStorage には保存される。
// NaN / 非数 (= dialog の空文字確定等) は **silent 無視** (= 現値維持、 localStorage 書き換えなし)。
// Math.floor(NaN) は NaN を返すので、 isFinite ガードを先に置かないと localStorage に "NaN" が
// 書かれて以後ロード時に default に戻り続けることになる (= Codex review 指摘)。
export function setOnionSkinRange(n: number): void {
	if (!Number.isFinite(n)) return
	const clamped = Math.max(MIN_RANGE, Math.min(MAX_RANGE, Math.floor(n)))
	if (clamped === onionSkinRange) return
	onionSkinRange = clamped
	saveRange(clamped)
	disposeAllGhosts()
	disposeAllMaterials()
	lastSrcSignature = undefined
	rebuildGhosts()
}

export function getOnionSkinRange(): number {
	return onionSkinRange
}

// MenuBar.menus.animation 経由で起動する設定 dialog。 form は number 1 件 (= range)。
// 確定時に setOnionSkinRange を呼んで即時反映 (= toggle ON 中なら ghost が新 range で再構築)。
function openOnionSkinRangeDialog(): void {
	if (typeof Dialog === 'undefined') return
	new Dialog({
		id: 'anim_ux_onion_skin_range',
		title: 'Onion Skin Range',
		form: {
			range: {
				label: 'Frames (±N)',
				description: `Show ghosts at ±1..N frames around the playhead. Past=blue, future=orange. Opacity decays linearly with distance (range=1 keeps v0.2 behavior). Range: ${MIN_RANGE}–${MAX_RANGE}.`,
				type: 'number',
				value: onionSkinRange,
				min: MIN_RANGE,
				max: MAX_RANGE,
				step: 1,
			},
		},
		onConfirm(result: { range: number }) {
			setOnionSkinRange(result.range)
		},
	}).show()
}

function onFrame(): void {
	rebuildGhosts()
}

function onSelection(): void {
	rebuildGhosts()
}

function onModeChange(): void {
	// project reset / mode 切替で Canvas.scene が差し替わる可能性に備えて、
	// ghost mesh + ghostRoot を全部捨てる (= 次 rebuild で ensureRoot/ensureGhost が新 scene 上で再生成)。
	// Map と signature もリセットして、 再生成経路を確実に通す。 material は共有なのでそのまま残す。
	disposeAllGhosts()
	if (ghostRoot) {
		Canvas?.scene?.remove(ghostRoot)
		ghostRoot = undefined
	}
	lastSrcSignature = undefined
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

	// localStorage から保存済 range を復元 (= 失敗時は default のまま)。
	loadRange()

	Blockbench?.on('display_animation_frame', onFrame)
	Blockbench?.on('update_selection', onSelection)
	Blockbench?.on('select_mode', onModeChange)
	Blockbench?.on('unselect_project', onModeChange)
	Blockbench?.on('reset_project', onModeChange)

	// Animation menu に「Onion Skin Range...」 Action を追加 (= dialog 起動口)。
	// shortcut は付けない (= 設定変更は稀、 キー衝突避ける)。 condition で animate 限定 (= 既存
	// shortcut action と同じ object 形式、 menu の condition が effective だが Action 単体で
	// 呼ばれたとき (= 検索パレット等) にも筋を通す。 Codex review IMO 反映)。
	let rangeAction: { delete(): void } | undefined
	if (typeof Action !== 'undefined') {
		rangeAction = new Action('anim_ux_set_onion_skin_range', {
			name: 'Anim UX: Onion Skin Range...',
			icon: 'layers',
			category: 'animation',
			condition: { modes: ['animate'] },
			click: openOnionSkinRangeDialog,
		})
		const animationMenu = (typeof MenuBar !== 'undefined' ? MenuBar : undefined)?.menus?.animation
		animationMenu?.addAction(rangeAction)
	}

	return () => {
		Blockbench?.removeListener('display_animation_frame', onFrame)
		Blockbench?.removeListener('update_selection', onSelection)
		Blockbench?.removeListener('select_mode', onModeChange)
		Blockbench?.removeListener('unselect_project', onModeChange)
		Blockbench?.removeListener('reset_project', onModeChange)
		if (rangeAction) {
			const animationMenu = (typeof MenuBar !== 'undefined' ? MenuBar : undefined)?.menus?.animation
			animationMenu?.removeAction(rangeAction)
			try {
				rangeAction.delete()
			} catch (e) {
				console.warn('[anim_ux] onion skin range action delete failed', e)
			}
		}
		disposeAllGhosts()
		if (ghostRoot) {
			Canvas?.scene?.remove(ghostRoot)
			ghostRoot = undefined
		}
		lastSrcSignature = undefined
		// plugin unload 時のみ共有 material を dispose (= rebuild 経路では再利用される)
		disposeAllMaterials()
	}
}
