// blockbench-anim-ux — Multi-window 同期 (v0.4、 Phase 1〜3 実装)
//
// 役割 :
//   - BB の「File > Open in New Window」 で起動された別 window 間で state をリアルタイム同期
//   - Phase 1 = Timeline.time (= 再生位置、 channel = 'anim_ux:timeline:time')
//   - Phase 2 = Keyframe selection (= 選択中 keyframe、 channel = 'anim_ux:timeline:selection')
//   - Phase 3 = Timeline.playing (= 再生状態) + OutlinerNode selection (= bone 選択) + Animation 切替
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
//   - 共通基盤 = tryLoadElectron + SENDER_ID + getOtherWindowIds (= ファイル先頭)
//   - 各 sync は独立した install*Sync() 関数、 cleanup 関数を返す
//   - installMultiWindow() が複数 sync を compose して plugin の onload から呼ばれる
//   - 各 sync は自身の applyingRemote flag で「受信→反映→自分発の event→再 send」 ループを防止
//   - 各 sync は payload に sender id を埋め、 自 window 由来 msg を破棄
//   - Animation 切替と OutlinerNode 選択が同時に変わる場合は Animation→OutlinerNode の順に適用 (= animation.select() が
//     unselectAllElements() を呼ぶため、 OutlinerNode 反映が先だと吹き飛ぶ)
//
// Phase 4+ で edit 同期 / Settings UI / 同期粒度 toggle を追加予定。

declare const Blockbench:
	| { on(event: string, cb: () => void): void; removeListener(event: string, cb: () => void): void }
	| undefined
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
				animators?: Record<string, { keyframes?: Array<{ uuid: string; selected?: boolean }> } | undefined>
			}
			all?: Array<{ uuid: string; select?(): void }>
	  }
	| undefined
declare const OutlinerNode:
	| { uuids: Record<string, { uuid: string; selected?: boolean; select?(): void } | undefined> }
	| undefined
declare function updateKeyframeSelection(): void
declare function updateSelection(): void
declare function unselectAllElements(): void

interface IpcRenderer {
	on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
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

function broadcast(
	ipcRenderer: IpcRenderer,
	remote: ElectronRemote,
	channel: string,
	payload: Record<string, unknown>,
): void {
	const others = getOtherWindowIds(remote)
	if (others.length === 0) return
	const wrapped = { sender: SENDER_ID, ...payload }
	for (const id of others) {
		ipcRenderer.sendTo(id, channel, wrapped)
	}
}

// --- Phase 1: Timeline.time 同期 ---

function installTimelineTimeSync(access: ElectronAccess): () => void {
	const { ipcRenderer, remote } = access
	let applyingRemote = false

	const receive = (_event: unknown, data: unknown): void => {
		if (!data || typeof data !== 'object') return
		const payload = data as { sender?: string; time?: number }
		if (payload.sender === SENDER_ID) return
		if (typeof payload.time !== 'number' || !Number.isFinite(payload.time)) return
		applyingRemote = true
		try {
			const T = typeof Timeline !== 'undefined' ? Timeline : undefined
			// 正規 API setTime() で playhead UI も同期反映 (= 直代入だと playhead 位置が遅延更新になる)
			if (T?.setTime) T.setTime(payload.time, true)
			else if (T) T.time = payload.time
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
			ipcRenderer.removeAllListeners(CHANNEL_TIME)
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

function getAllKeyframes(): Array<{ uuid: string; selected?: boolean }> {
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
		const payload = data as { sender?: string; uuids?: unknown }
		if (payload.sender === SENDER_ID) return
		if (!Array.isArray(payload.uuids)) return
		const uuids = payload.uuids.filter((v): v is string => typeof v === 'string')
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
			ipcRenderer.removeAllListeners(CHANNEL_SELECTION)
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
		const payload = data as { sender?: string; playing?: boolean }
		if (payload.sender === SENDER_ID) return
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
			ipcRenderer.removeAllListeners(CHANNEL_PLAYING)
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
		const payload = data as { sender?: string; uuids?: unknown }
		if (payload.sender === SENDER_ID) return
		if (!Array.isArray(payload.uuids)) return
		const uuids = payload.uuids.filter((v): v is string => typeof v === 'string')
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
			ipcRenderer.removeAllListeners(CHANNEL_OUTLINER)
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
		const payload = data as { sender?: string; uuid?: unknown }
		if (payload.sender === SENDER_ID) return
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
			ipcRenderer.removeAllListeners(CHANNEL_ANIMATION)
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

// --- Compose ---

export function installMultiWindow(): () => void {
	const access = tryLoadElectron()
	if (!access) return () => {}

	const cleanups: Array<() => void> = []
	cleanups.push(installTimelineTimeSync(access))
	cleanups.push(installKeyframeSelectionSync(access))
	cleanups.push(installTimelinePlayingSync(access))
	cleanups.push(installOutlinerSelectionSync(access))
	cleanups.push(installAnimationSelectionSync(access))

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
