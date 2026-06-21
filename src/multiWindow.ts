// blockbench-anim-ux — Multi-window 同期 (v0.4、 Phase 1 + Phase 2 実装)
//
// 役割 :
//   - BB の「File > Open in New Window」 で起動された別 window 間で state をリアルタイム同期
//   - Phase 1 = Timeline.time (= 再生位置、 channel = 'anim_ux:timeline:time')
//   - Phase 2 = Keyframe selection (= 選択中 keyframe、 channel = 'anim_ux:timeline:selection')
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
//   - 各 sync は独立した install*Sync() 関数で実装、 cleanup 関数を返す
//   - installMultiWindow() が複数 sync を compose して plugin の onload から呼ばれる
//   - 各 sync は自身の applyingRemote flag で「受信→反映→自分発の event→再 send」 ループを防止
//   - 各 sync は payload に sender id を埋め、 自 window 由来 msg を破棄
//
// Phase 3+ で edit 同期 / settings UI / 同期粒度 toggle を追加予定。

declare const Blockbench:
	| { on(event: string, cb: () => void): void; removeListener(event: string, cb: () => void): void }
	| undefined
declare const Timeline:
	| {
			time?: number
			selected?: Array<{ uuid: string; selected?: boolean }> & { empty(): void; safePush(item: unknown): void }
	  }
	| undefined
declare const Animator: { preview?: () => void } | undefined
declare const Animation:
	| {
			selected?: {
				animators?: Record<string, { keyframes?: Array<{ uuid: string; selected?: boolean }> } | undefined>
			}
	  }
	| undefined
declare function updateKeyframeSelection(): void

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
			if (T) T.time = payload.time
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

function snapshotSelection(): string[] {
	const T = typeof Timeline !== 'undefined' ? Timeline : undefined
	const sel = T?.selected
	if (!sel) return []
	const out: string[] = []
	for (const kf of sel) out.push(kf.uuid)
	return out
}

function setsEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false
	const set = new Set(a)
	for (const v of b) if (!set.has(v)) return false
	return true
}

function applySelection(uuids: string[]): void {
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
			applySelection(uuids)
			// 受信反映後の snapshot を lastSent に同期しておく (= 直後の update_keyframe_selection で再 send しないため)
			lastSent = uuids.slice()
		} finally {
			applyingRemote = false
		}
	}

	const send = (): void => {
		if (applyingRemote) return
		try {
			const cur = snapshotSelection()
			if (setsEqual(cur, lastSent)) return
			lastSent = cur.slice()
			broadcast(ipcRenderer, remote, CHANNEL_SELECTION, { uuids: cur })
		} catch {
			// silent (= 高頻度経路ではないが warn は控える)
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

// --- Compose ---

export function installMultiWindow(): () => void {
	const access = tryLoadElectron()
	if (!access) return () => {}

	const cleanups: Array<() => void> = []
	cleanups.push(installTimelineTimeSync(access))
	cleanups.push(installKeyframeSelectionSync(access))

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
