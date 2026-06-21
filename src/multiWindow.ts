// blockbench-anim-ux — Multi-window 同期 (v0.4、 Phase 1〜5 + Settings 実装)
//
// 役割 :
//   - BB の「File > Open in New Window」 で起動された別 window 間で state をリアルタイム同期
//   - Phase 1 = Timeline.time (= 再生位置、 channel = 'anim_ux:timeline:time')
//   - Phase 2 = Keyframe selection (= 選択中 keyframe、 channel = 'anim_ux:timeline:selection')
//   - Phase 3 = Timeline.playing (= 再生状態) + OutlinerNode selection (= bone 選択) + Animation 切替
//   - Phase 4 = BB Settings 個別 toggle (= 各 sync を ON/OFF、 default ON / edit のみ OFF)
//   - Phase 5 = Keyframe edit (= 値変更、 experimental + default OFF、 Keyframe.prototype.set monkey patch)
//   - feature detect = window.require が無ければ silent 無効化 (= 他機能は活きたまま)
//
// IPC 経路 (= 非公式 / 抜け道、 詳細記録は [[aj-blockbench-anim-ux-v04]] 予定) :
//   - BB の renderer は nodeIntegration: true, contextIsolation: false, enableRemoteModule: true
//   - plugin loader の whitelist (= requireNativeModule) を window.require で回避
//   - `window.require('electron').ipcRenderer` + `window.require('@electron/remote').BrowserWindow`
//   - 公式 API ではないので BB / Electron 更新で壊れる可能性、 try/catch で fallback 必須
//   - 参考実装 : EaseCation/blockbench-multi-window (MIT)、 アプローチのみ参考 (= コード直接 copy なし)
//
// 設計 :
//   - 共通基盤 = tryLoadElectron + SENDER_ID + getOtherWindowIds + broadcast (= ファイル先頭)
//   - broadcast() は payload に sender id + project uuid を自動付加、 receive は isWrongProject で別 project を drop
//   - 各 sync は独立した install*Sync() 関数、 cleanup 関数を返す
//   - installMultiWindow() が複数 sync を compose して plugin の onload から呼ばれる
//   - 各 sync は自身の applyingRemote flag で「受信→反映→自分発の event→再 send」 ループを防止
//   - Timeline.time は flag だけだと非同期境界をまたいで echo するため、 lastSentTime + lastAppliedRemoteTime の
//     epsilon 比較で同値送信を追加抑止
//   - Animation 切替と OutlinerNode 選択が同時に変わる場合は Animation→OutlinerNode の順に適用 (= animation.select() が
//     unselectAllElements() を呼ぶため、 OutlinerNode 反映が先だと吹き飛ぶ)
//   - Phase 5 monkey patch は patchedSet を保持、 cleanup 時に他 plugin が後付け patch した場合は復帰 skip
//   - cleanup は ipcRenderer.removeListener(channel, receive) で個別解除 (= removeAllListeners は他 listener を巻き込む)
//   - Setting オブジェクトは plugin unload 時に delete() で UI / registry 残骸も除去 (= BB 古版は silent fallback)

declare const Blockbench:
	| { on(event: string, cb: () => void): void; removeListener(event: string, cb: () => void): void }
	| undefined
declare class Setting {
	constructor(
		id: string,
		opts: {
			value: boolean
			category?: string
			name?: string
			description?: string
			type?: string
			onChange?: (v: boolean) => void
		},
	)
	value: boolean
}
declare const Timeline:
	| {
			time?: number
			playing?: boolean
			selected?: Array<{ uuid: string; selected?: boolean }> & { empty(): void; safePush(item: unknown): void }
			start?(): void
			pause?(): void
			setTime?(time: number, editing?: boolean): void
	  }
	| undefined
declare const Animator: { preview?: () => void } | undefined
declare const Animation:
	| {
			selected?: {
				uuid?: string
				animators?: Record<
					string,
					{ uuid?: string; keyframes?: Array<KeyframeLike> } | undefined
				>
			}
			all?: Array<{ uuid: string; select?(): void }>
	  }
	| undefined

interface KeyframeLike {
	uuid: string
	selected?: boolean
	channel?: string
	animator?: { uuid?: string }
	set?(axis: string, value: number | string, data_point?: number): unknown
}

declare const Keyframe:
	| {
			prototype: {
				set(axis: string, value: number | string, data_point?: number): unknown
			}
	  }
	| undefined
declare const OutlinerNode:
	| { uuids: Record<string, { uuid: string; selected?: boolean; select?(): void } | undefined> }
	| undefined
declare const Project: { uuid?: string } | undefined
declare function updateKeyframeSelection(): void
declare function updateSelection(): void
declare function unselectAllElements(): void

interface IpcRenderer {
	on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
	removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
	removeAllListeners(channel: string): void
	sendTo(webContentsId: number, channel: string, ...args: unknown[]): void
}

interface BrowserWindowStatic {
	getAllWindows(): Array<{ webContents: { id: number } }>
}

interface ElectronRemote {
	BrowserWindow: BrowserWindowStatic
	getCurrentWebContents(): { id: number }
}

interface ElectronAccess {
	ipcRenderer: IpcRenderer
	remote: ElectronRemote
}

// 自 window 由来 msg を識別するための sender id。 plugin load ごとに新規発行 (= reload で更新される)。
const SENDER_ID = `anim_ux-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`

const CHANNEL_TIME = 'anim_ux:timeline:time'
const CHANNEL_SELECTION = 'anim_ux:timeline:selection'
const CHANNEL_PLAYING = 'anim_ux:timeline:playing'
const CHANNEL_OUTLINER = 'anim_ux:outliner:selection'
const CHANNEL_ANIMATION = 'anim_ux:animation:select'
const CHANNEL_EDIT = 'anim_ux:keyframe:edit'

function tryLoadElectron(): ElectronAccess | null {
	try {
		const w = window as unknown as { require?: (m: string) => unknown }
		if (typeof w.require !== 'function') return null
		const electron = w.require('electron') as { ipcRenderer?: IpcRenderer }
		const remote = w.require('@electron/remote') as ElectronRemote | undefined
		if (!electron?.ipcRenderer || !remote?.BrowserWindow || !remote?.getCurrentWebContents) return null
		return { ipcRenderer: electron.ipcRenderer, remote }
	} catch (e) {
		console.warn('[anim_ux:multi-window] electron API unavailable, sync disabled', e)
		return null
	}
}

function getOtherWindowIds(remote: ElectronRemote): number[] {
	try {
		const selfId = remote.getCurrentWebContents().id
		return remote.BrowserWindow.getAllWindows()
			.map(w => w.webContents.id)
			.filter(id => id !== selfId)
	} catch {
		return []
	}
}

function getCurrentProjectUuid(): string | undefined {
	const P = typeof Project !== 'undefined' ? Project : undefined
	return typeof P?.uuid === 'string' ? P.uuid : undefined
}

function broadcast(
	ipcRenderer: IpcRenderer,
	remote: ElectronRemote,
	channel: string,
	payload: Record<string, unknown>,
): void {
	const others = getOtherWindowIds(remote)
	if (others.length === 0) return
	const wrapped = { sender: SENDER_ID, project: getCurrentProjectUuid(), ...payload }
	for (const id of others) {
		ipcRenderer.sendTo(id, channel, wrapped)
	}
}

// 別 project が同 BB window で開かれてる場合、 受信した同期 msg を drop する判定。
// 自 window が project 未開、 もしくは payload に project info が無い (= 旧版送信者) なら drop しない (= 緩め判定、 後方互換)。
function isWrongProject(payload: { project?: unknown }): boolean {
	const cur = getCurrentProjectUuid()
	if (!cur) return false
	if (typeof payload.project !== 'string') return false
	return payload.project !== cur
}

// --- Phase 1: Timeline.time 同期 ---

function installTimelineTimeSync(access: ElectronAccess): () => void {
	const { ipcRenderer, remote } = access
	let applyingRemote = false
	// echo 防止用 = 直前に他 window に送った値 / 受信して反映した値を保持。
	// display_animation_frame は非同期境界をまたいで再発火するため、 applyingRemote flag
	// だけでは setTime() 起因の echo を抑止できない。 epsilon 内で一致してたら送信スキップ。
	const TIME_EPSILON = 1e-6
	let lastSentTime = Number.NaN
	let lastAppliedRemoteTime = Number.NaN

	const receive = (_event: unknown, data: unknown): void => {
		if (!data || typeof data !== 'object') return
		const payload = data as { sender?: string; project?: string; time?: number }
		if (payload.sender === SENDER_ID) return
		if (isWrongProject(payload)) return
		if (typeof payload.time !== 'number' || !Number.isFinite(payload.time)) return
		applyingRemote = true
		try {
			const T = typeof Timeline !== 'undefined' ? Timeline : undefined
			// 正規 API setTime() で playhead UI も同期反映 (= 直代入だと playhead 位置が遅延更新になる)
			if (T?.setTime) T.setTime(payload.time, true)
			else if (T) T.time = payload.time
			lastAppliedRemoteTime = payload.time
			const A = typeof Animator !== 'undefined' ? Animator : undefined
			A?.preview?.()
		} catch (e) {
			console.warn('[anim_ux:multi-window] apply remote time failed', e)
		} finally {
			applyingRemote = false
		}
	}

	const send = (): void => {
		if (applyingRemote) return
		try {
			const T = typeof Timeline !== 'undefined' ? Timeline : undefined
			const time = T?.time
			if (typeof time !== 'number' || !Number.isFinite(time)) return
			// 直近反映した remote 値 / 自分が直前に送った値と一致するなら送信スキップ (= echo 抑止)
			if (Math.abs(time - lastAppliedRemoteTime) < TIME_EPSILON) return
			if (Math.abs(time - lastSentTime) < TIME_EPSILON) return
			lastSentTime = time
			broadcast(ipcRenderer, remote, CHANNEL_TIME, { time })
		} catch {
			// 毎 frame 発火経路、 warn は spam になるので silent
		}
	}

	ipcRenderer.on(CHANNEL_TIME, receive)
	const Bb = typeof Blockbench !== 'undefined' ? Blockbench : undefined
	Bb?.on('display_animation_frame', send)

	return (): void => {
		try {
			ipcRenderer.removeListener(CHANNEL_TIME, receive)
		} catch {
			/* noop */
		}
		try {
			Bb?.removeListener('display_animation_frame', send)
		} catch {
			/* noop */
		}
	}
}

// --- Phase 2: Keyframe selection 同期 ---

function getAllKeyframes(): Array<KeyframeLike> {
	const A = typeof Animation !== 'undefined' ? Animation : undefined
	const animators = A?.selected?.animators
	if (!animators) return []
	return Object.values(animators).flatMap(a => a?.keyframes ?? [])
}

function snapshotKeyframeSelection(): string[] {
	const T = typeof Timeline !== 'undefined' ? Timeline : undefined
	const sel = T?.selected
	if (!sel) return []
	const out: string[] = []
	for (const kf of sel) out.push(kf.uuid)
	return out
}

function uuidSetsEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false
	const set = new Set(a)
	for (const v of b) if (!set.has(v)) return false
	return true
}

function applyKeyframeSelection(uuids: string[]): void {
	const T = typeof Timeline !== 'undefined' ? Timeline : undefined
	if (!T?.selected) return
	const wanted = new Set(uuids)
	const all = getAllKeyframes()
	T.selected.empty()
	for (const kf of all) {
		kf.selected = wanted.has(kf.uuid)
		if (kf.selected) T.selected.safePush(kf)
	}
	try {
		updateKeyframeSelection()
	} catch (e) {
		console.warn('[anim_ux:multi-window] updateKeyframeSelection failed', e)
	}
}

function installKeyframeSelectionSync(access: ElectronAccess): () => void {
	const { ipcRenderer, remote } = access
	let applyingRemote = false
	let lastSent: string[] = []

	const receive = (_event: unknown, data: unknown): void => {
		if (!data || typeof data !== 'object') return
		const payload = data as { sender?: string; project?: string; uuids?: unknown }
		if (payload.sender === SENDER_ID) return
		if (isWrongProject(payload)) return
		if (!Array.isArray(payload.uuids)) return
		if (payload.uuids.length > 10000) return
		if (!payload.uuids.every((v): v is string => typeof v === 'string')) return
		const uuids = payload.uuids
		applyingRemote = true
		try {
			applyKeyframeSelection(uuids)
			lastSent = uuids.slice()
		} finally {
			applyingRemote = false
		}
	}

	const send = (): void => {
		if (applyingRemote) return
		try {
			const cur = snapshotKeyframeSelection()
			if (uuidSetsEqual(cur, lastSent)) return
			lastSent = cur.slice()
			broadcast(ipcRenderer, remote, CHANNEL_SELECTION, { uuids: cur })
		} catch {
			// silent (= 中頻度経路、 warn は控える)
		}
	}

	ipcRenderer.on(CHANNEL_SELECTION, receive)
	const Bb = typeof Blockbench !== 'undefined' ? Blockbench : undefined
	Bb?.on('update_keyframe_selection', send)

	return (): void => {
		try {
			ipcRenderer.removeListener(CHANNEL_SELECTION, receive)
		} catch {
			/* noop */
		}
		try {
			Bb?.removeListener('update_keyframe_selection', send)
		} catch {
			/* noop */
		}
	}
}

// --- Phase 3-A: Timeline.playing 同期 ---

function installTimelinePlayingSync(access: ElectronAccess): () => void {
	const { ipcRenderer, remote } = access
	let applyingRemote = false

	const receive = (_event: unknown, data: unknown): void => {
		if (!data || typeof data !== 'object') return
		const payload = data as { sender?: string; project?: string; playing?: boolean }
		if (payload.sender === SENDER_ID) return
		if (isWrongProject(payload)) return
		if (typeof payload.playing !== 'boolean') return
		const T = typeof Timeline !== 'undefined' ? Timeline : undefined
		if (!T) return
		if ((T.playing ?? false) === payload.playing) return
		applyingRemote = true
		try {
			if (payload.playing) T.start?.()
			else T.pause?.()
		} catch (e) {
			console.warn('[anim_ux:multi-window] apply remote playing failed', e)
		} finally {
			applyingRemote = false
		}
	}

	const sendPlay = (): void => {
		if (applyingRemote) return
		try {
			broadcast(ipcRenderer, remote, CHANNEL_PLAYING, { playing: true })
		} catch {
			/* silent */
		}
	}
	const sendPause = (): void => {
		if (applyingRemote) return
		try {
			broadcast(ipcRenderer, remote, CHANNEL_PLAYING, { playing: false })
		} catch {
			/* silent */
		}
	}

	ipcRenderer.on(CHANNEL_PLAYING, receive)
	const Bb = typeof Blockbench !== 'undefined' ? Blockbench : undefined
	Bb?.on('timeline_play', sendPlay)
	Bb?.on('timeline_pause', sendPause)

	return (): void => {
		try {
			ipcRenderer.removeListener(CHANNEL_PLAYING, receive)
		} catch {
			/* noop */
		}
		try {
			Bb?.removeListener('timeline_play', sendPlay)
		} catch {
			/* noop */
		}
		try {
			Bb?.removeListener('timeline_pause', sendPause)
		} catch {
			/* noop */
		}
	}
}

// --- Phase 3-B: OutlinerNode (bone) selection 同期 ---

function snapshotOutlinerSelection(): string[] {
	const Node = typeof OutlinerNode !== 'undefined' ? OutlinerNode : undefined
	const uuids = Node?.uuids
	if (!uuids) return []
	const out: string[] = []
	for (const u in uuids) {
		if (uuids[u]?.selected) out.push(u)
	}
	return out
}

function applyOutlinerSelection(uuids: string[]): void {
	const Node = typeof OutlinerNode !== 'undefined' ? OutlinerNode : undefined
	if (!Node?.uuids) return
	try {
		if (typeof unselectAllElements === 'function') unselectAllElements()
	} catch {
		/* noop, 続行 */
	}
	for (const u of uuids) {
		const node = Node.uuids[u]
		if (!node) continue
		try {
			if (typeof node.select === 'function') node.select()
			else node.selected = true
		} catch (e) {
			console.warn('[anim_ux:multi-window] outliner node select failed', u, e)
		}
	}
	try {
		if (typeof updateSelection === 'function') updateSelection()
	} catch (e) {
		console.warn('[anim_ux:multi-window] updateSelection failed', e)
	}
}

function installOutlinerSelectionSync(access: ElectronAccess): () => void {
	const { ipcRenderer, remote } = access
	let applyingRemote = false
	let lastSent: string[] = []

	const receive = (_event: unknown, data: unknown): void => {
		if (!data || typeof data !== 'object') return
		const payload = data as { sender?: string; project?: string; uuids?: unknown }
		if (payload.sender === SENDER_ID) return
		if (isWrongProject(payload)) return
		if (!Array.isArray(payload.uuids)) return
		if (payload.uuids.length > 10000) return
		if (!payload.uuids.every((v): v is string => typeof v === 'string')) return
		const uuids = payload.uuids
		applyingRemote = true
		try {
			applyOutlinerSelection(uuids)
			lastSent = uuids.slice()
		} finally {
			applyingRemote = false
		}
	}

	const send = (): void => {
		if (applyingRemote) return
		try {
			const cur = snapshotOutlinerSelection()
			if (uuidSetsEqual(cur, lastSent)) return
			lastSent = cur.slice()
			broadcast(ipcRenderer, remote, CHANNEL_OUTLINER, { uuids: cur })
		} catch {
			/* silent */
		}
	}

	ipcRenderer.on(CHANNEL_OUTLINER, receive)
	const Bb = typeof Blockbench !== 'undefined' ? Blockbench : undefined
	Bb?.on('update_selection', send)

	return (): void => {
		try {
			ipcRenderer.removeListener(CHANNEL_OUTLINER, receive)
		} catch {
			/* noop */
		}
		try {
			Bb?.removeListener('update_selection', send)
		} catch {
			/* noop */
		}
	}
}

// --- Phase 3-C: Animation 切替同期 ---

function installAnimationSelectionSync(access: ElectronAccess): () => void {
	const { ipcRenderer, remote } = access
	let applyingRemote = false

	const receive = (_event: unknown, data: unknown): void => {
		if (!data || typeof data !== 'object') return
		const payload = data as { sender?: string; project?: string; uuid?: unknown }
		if (payload.sender === SENDER_ID) return
		if (isWrongProject(payload)) return
		if (typeof payload.uuid !== 'string') return
		const A = typeof Animation !== 'undefined' ? Animation : undefined
		const target = A?.all?.find(a => a.uuid === payload.uuid)
		if (!target) return
		if (A?.selected?.uuid === payload.uuid) return
		applyingRemote = true
		try {
			target.select?.()
		} catch (e) {
			console.warn('[anim_ux:multi-window] animation select failed', e)
		} finally {
			applyingRemote = false
		}
	}

	const send = (): void => {
		if (applyingRemote) return
		try {
			const A = typeof Animation !== 'undefined' ? Animation : undefined
			const uuid = A?.selected?.uuid
			if (typeof uuid !== 'string') return
			broadcast(ipcRenderer, remote, CHANNEL_ANIMATION, { uuid })
		} catch {
			/* silent */
		}
	}

	ipcRenderer.on(CHANNEL_ANIMATION, receive)
	const Bb = typeof Blockbench !== 'undefined' ? Blockbench : undefined
	Bb?.on('select_animation', send)

	return (): void => {
		try {
			ipcRenderer.removeListener(CHANNEL_ANIMATION, receive)
		} catch {
			/* noop */
		}
		try {
			Bb?.removeListener('select_animation', send)
		} catch {
			/* noop */
		}
	}
}

// --- Phase 5: Keyframe edit 同期 (experimental、 default OFF) ---
//
// Keyframe.prototype.set を monkey patch して、 値変更を window 間で同期する。
//
// 仕様 (= Codex 確認済、 keyframe.js:118-131) :
//   - set(axis, value, data_point = 0) は副作用なしの直接代入 (= preview/selection は呼び出し側責務)
//   - 戻り値 = this
//   - 主要 edit 経路 = x/y/z 数値入力 / Molang editor / graph editor 値 drag / 数値 drag (= 全て set() 経由)
//   - カバー外 = round keyframe values / file / bind_to_actor の直代入経路、 keyframe time 変更 (= setter なし)
//
// 注意 (= experimental の理由) :
//   - monkey patch なので AJ 等の同種 hook と共存はしてもデバッグが面倒
//   - 同時編集の競合は同期粒度 1 op 単位 = 後勝ち、 lock なし
//   - 受信側で preview() を呼ばないと UI 反映遅延
//   - cleanup で original 復帰させる、 plugin unload 時もこれで原状回復
//
// Phase 4 toggle の default は false (= 明示 ON 必要)。

interface EditPayload {
	sender?: string
	op?: string
	uuid?: string
	animatorUuid?: string
	channel?: string
	axis?: string
	value?: number | string
	dataPoint?: number
}

function findKeyframe(
	uuid: string,
	animatorUuid: string | undefined,
	preferChannel: string | undefined,
): KeyframeLike | undefined {
	const A = typeof Animation !== 'undefined' ? Animation : undefined
	const animators = A?.selected?.animators
	if (!animators) return undefined
	for (const key in animators) {
		const an = animators[key]
		if (!an) continue
		if (animatorUuid && an.uuid && an.uuid !== animatorUuid) continue
		const list = an.keyframes ?? []
		for (const kf of list) {
			if (kf.uuid !== uuid) continue
			if (preferChannel && kf.channel && kf.channel !== preferChannel) continue
			return kf
		}
	}
	// animator scope に居なければ全 animator から uuid だけで再探索 (= fallback)
	for (const key in animators) {
		const an = animators[key]
		if (!an) continue
		const list = an.keyframes ?? []
		for (const kf of list) {
			if (kf.uuid === uuid) return kf
		}
	}
	return undefined
}

function installKeyframeEditSync(access: ElectronAccess): () => void {
	const { ipcRenderer, remote } = access
	const KF = typeof Keyframe !== 'undefined' ? Keyframe : undefined
	if (!KF?.prototype?.set) {
		console.warn('[anim_ux:multi-window] Keyframe.prototype.set unavailable, edit sync disabled')
		return () => {}
	}

	let applyingRemote = false
	const originalSet = KF.prototype.set

	// monkey patch : set 呼出を IPC 送信に乗せる。
	// patchedSet を識別子として保持し、 cleanup 時に他 plugin が後付けで patch した場合は復帰を skip する。
	const patchedSet = function (this: KeyframeLike, axis: string, value: number | string, dp?: number): unknown {
		const result = originalSet.call(this, axis, value, dp)
		if (!applyingRemote) {
			try {
				broadcast(ipcRenderer, remote, CHANNEL_EDIT, {
					op: 'set',
					uuid: this.uuid,
					animatorUuid: this.animator?.uuid,
					channel: this.channel,
					axis,
					value,
					dataPoint: typeof dp === 'number' ? dp : 0,
				})
			} catch {
				/* silent (= edit 経路は高頻度) */
			}
		}
		return result
	}
	KF.prototype.set = patchedSet

	const receive = (_event: unknown, data: unknown): void => {
		if (!data || typeof data !== 'object') return
		const payload = data as EditPayload
		if (payload.sender === SENDER_ID) return
		if (isWrongProject(payload)) return
		if (payload.op !== 'set') return
		if (typeof payload.uuid !== 'string') return
		if (typeof payload.axis !== 'string') return
		if (typeof payload.value !== 'number' && typeof payload.value !== 'string') return
		if (payload.animatorUuid !== undefined && typeof payload.animatorUuid !== 'string') return
		if (payload.channel !== undefined && typeof payload.channel !== 'string') return
		if (payload.dataPoint !== undefined) {
			if (typeof payload.dataPoint !== 'number' || !Number.isInteger(payload.dataPoint) || payload.dataPoint < 0) return
		}
		const kf = findKeyframe(payload.uuid, payload.animatorUuid, payload.channel)
		if (!kf?.set) return
		applyingRemote = true
		try {
			kf.set(payload.axis, payload.value, payload.dataPoint ?? 0)
			const A = typeof Animator !== 'undefined' ? Animator : undefined
			A?.preview?.()
		} catch (e) {
			console.warn('[anim_ux:multi-window] apply remote edit failed', e)
		} finally {
			applyingRemote = false
		}
	}

	ipcRenderer.on(CHANNEL_EDIT, receive)

	return (): void => {
		try {
			ipcRenderer.removeListener(CHANNEL_EDIT, receive)
		} catch {
			/* noop */
		}
		try {
			// 自分の patchedSet がまだ生きてる時のみ originalSet に戻す。 後付け patch を奪わない。
			if (KF.prototype.set === patchedSet) {
				KF.prototype.set = originalSet
			} else {
				console.warn(
					'[anim_ux:multi-window] Keyframe.prototype.set is patched by another module, skip revert',
				)
			}
		} catch {
			/* noop */
		}
	}
}

// --- Phase 4: Settings toggle で各 sync を個別 ON/OFF ---
//
// 各 sync に個別 Setting (boolean toggle) を作成、 BB Settings > General に表示。
// toggle ON 時は対応する install*Sync() で IPC listener + Blockbench event listener を attach、
// OFF 時は cleanup を呼んで全 detach。 plugin unload 時にも cleanup 走らせる。
//
// 設計の根拠 :
//   - 「片方の window で実験中に同期が邪魔」 シーンで toggle 切替が即効 (= plugin reload 不要)
//   - install / cleanup の対称性は selectionWatch の addSelectionListener と同パターン

interface SyncSpec {
	id: string
	name: string
	description: string
	defaultValue: boolean
	factory: (access: ElectronAccess) => () => void
}

interface SettingWithDelete extends Setting {
	delete?(): void
}

const SYNC_SPECS: SyncSpec[] = [
	{
		id: 'anim_ux_mw_time',
		name: 'Multi-window: Sync timeline time',
		description: '別 BB window と再生位置 (Timeline.time) を同期する',
		defaultValue: true,
		factory: installTimelineTimeSync,
	},
	{
		id: 'anim_ux_mw_kfsel',
		name: 'Multi-window: Sync keyframe selection',
		description: '別 BB window と選択中の keyframe を同期する',
		defaultValue: true,
		factory: installKeyframeSelectionSync,
	},
	{
		id: 'anim_ux_mw_playing',
		name: 'Multi-window: Sync play / pause',
		description: '別 BB window と再生 / 停止状態を同期する',
		defaultValue: true,
		factory: installTimelinePlayingSync,
	},
	{
		id: 'anim_ux_mw_outliner',
		name: 'Multi-window: Sync outliner selection',
		description: '別 BB window と 3D / outliner の選択状態を同期する',
		defaultValue: true,
		factory: installOutlinerSelectionSync,
	},
	{
		id: 'anim_ux_mw_anim',
		name: 'Multi-window: Sync animation switch',
		description: '別 BB window と選択中の animation を同期する',
		defaultValue: true,
		factory: installAnimationSelectionSync,
	},
	{
		id: 'anim_ux_mw_edit',
		name: 'Multi-window: Sync keyframe edit (experimental)',
		description:
			'⚠ 実験的。 Keyframe.prototype.set を monkey patch して値変更を同期。 同時編集の競合は後勝ち、 lock なし。 デバッグ困難時はまず OFF にして切り分け',
		defaultValue: false,
		factory: installKeyframeEditSync,
	},
]

function createSyncToggle(spec: SyncSpec, access: ElectronAccess): () => void {
	let cleanup: (() => void) | null = null

	const apply = (enabled: boolean): void => {
		if (enabled && !cleanup) {
			try {
				cleanup = spec.factory(access)
			} catch (e) {
				console.warn(`[anim_ux:multi-window] install ${spec.id} failed`, e)
				cleanup = null
			}
		} else if (!enabled && cleanup) {
			try {
				cleanup()
			} catch (e) {
				console.warn(`[anim_ux:multi-window] cleanup ${spec.id} failed`, e)
			}
			cleanup = null
		}
	}

	let setting: SettingWithDelete
	try {
		setting = new Setting(spec.id, {
			value: spec.defaultValue,
			category: 'general',
			name: spec.name,
			description: spec.description,
			type: 'boolean',
			onChange: (v: boolean) => apply(v),
		}) as SettingWithDelete
	} catch (e) {
		console.warn(`[anim_ux:multi-window] Setting ${spec.id} ctor failed, defaulting to ON`, e)
		apply(spec.defaultValue)
		return () => apply(false)
	}

	apply(setting.value)
	return (): void => {
		apply(false)
		// plugin unload 時、 Setting オブジェクトを破棄して onChange closure / UI 項目 / settings registry の残骸を防ぐ。
		// 古い BB version では delete() が無い (= silent fallback、 BB 更新時に自動的に活性化する形)。
		try {
			setting.delete?.()
		} catch {
			/* noop */
		}
	}
}

// --- Compose ---

export function installMultiWindow(): () => void {
	const access = tryLoadElectron()
	if (!access) return () => {}

	const cleanups: Array<() => void> = []
	for (const spec of SYNC_SPECS) {
		cleanups.push(createSyncToggle(spec, access))
	}

	return (): void => {
		for (const fn of cleanups) {
			try {
				fn()
			} catch (e) {
				console.warn('[anim_ux:multi-window] cleanup failed', e)
			}
		}
	}
}
