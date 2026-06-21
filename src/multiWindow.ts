// blockbench-anim-ux — Multi-window 同期 (v0.4 Phase 1: Timeline.time PoC)
//
// 役割 :
//   - BB の「File > Open in New Window」 で起動された別 window 間で Timeline.time を同期
//   - 自 window で再生 / scrub すると他 window の再生位置も追従 (= 再生は自走しない、 値を反映するだけ)
//   - sender id でループ防止 (= 自分が send した msg を自分が受信して再 send しない)
//   - feature detect = window.require が無ければ silent 無効化 (= plugin として死なずに他機能は活きたまま)
//
// IPC 経路 (= 非公式 / 抜け道、 詳細記録は [[aj-blockbench-anim-ux-v04]] 予定) :
//   - BB の renderer は nodeIntegration: true, contextIsolation: false, enableRemoteModule: true
//   - plugin loader の whitelist (= requireNativeModule) を window.require で回避
//   - `window.require('electron').ipcRenderer` + `window.require('@electron/remote').BrowserWindow`
//   - 公式 API ではないので BB / Electron 更新で壊れる可能性、 try/catch で fallback 必須
//   - 参考実装 : EaseCation/blockbench-multi-window (MIT)、 アプローチのみ参考 (= コード直接 copy なし)
//
// 同期対象 (= Phase 1、 最小セット) :
//   - Timeline.time (= 再生位置)、 channel = 'anim_ux:timeline:time'
//   - 受信時 Animator.preview() で 3D view 反映 trigger
//
// Phase 2+ で selected_keyframes / edit / settings UI / 同期粒度 toggle を追加予定。

declare const Blockbench:
	| { on(event: string, cb: () => void): void; removeListener(event: string, cb: () => void): void }
	| undefined
declare const Timeline: { time?: number } | undefined
declare const Animator: { preview?: () => void } | undefined

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

const CHANNEL_TIME = 'anim_ux:timeline:time'
// 自 window 由来 msg を識別するための sender id。 plugin load ごとに新規発行 (= reload で更新される)。
const SENDER_ID = `anim_ux-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`

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

export function installMultiWindow(): () => void {
	const access = tryLoadElectron()
	if (!access) return () => {}
	const { ipcRenderer, remote } = access

	// applyingRemote = 受信から自 window 更新中フラグ。 受信中の preview() が
	// display_animation_frame を再 trigger して自分が再 send → 他 window ループ、 を防ぐ。
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

	const broadcast = (): void => {
		if (applyingRemote) return
		try {
			const T = typeof Timeline !== 'undefined' ? Timeline : undefined
			const time = T?.time
			if (typeof time !== 'number' || !Number.isFinite(time)) return
			const others = getOtherWindowIds(remote)
			if (others.length === 0) return
			const payload = { sender: SENDER_ID, time }
			for (const id of others) {
				ipcRenderer.sendTo(id, CHANNEL_TIME, payload)
			}
		} catch {
			// 毎 frame 発火経路、 warn は spam になるので silent
		}
	}

	ipcRenderer.on(CHANNEL_TIME, receive)
	const Bb = typeof Blockbench !== 'undefined' ? Blockbench : undefined
	Bb?.on('display_animation_frame', broadcast)

	return (): void => {
		try { ipcRenderer.removeAllListeners(CHANNEL_TIME) } catch { /* noop */ }
		try { Bb?.removeListener('display_animation_frame', broadcast) } catch { /* noop */ }
	}
}
