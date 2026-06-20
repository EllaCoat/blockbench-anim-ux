// blockbench-anim-ux — #19 A-B loop playback
//
// 役割 :
//   - timeline 上の [A, B] 時刻範囲を preview でループ再生する。
//   - 攻撃モーションの 0.5 秒区間だけ何度も見たい微調整用 (= After Effects / Premiere の A-B loop と同種)。
//
// 操作 :
//   - shortcut : Alt+Shift+A (= start set) / Alt+Shift+B (= end set) / Alt+Shift+L (= loop on/off) / Alt+Shift+X (= clear)
//   - filter bar の 4 つ目 toggle (= `loop` icon) でも on/off 可能、 視覚状態は toggle class で
//
// 設計判断 :
//   - 範囲はセッション内のみ (= AJ blueprint 汚染回避、 永続化したい場合は MCP 側に出す方が筋)
//   - 監視は rAF で常時走る、 制御は filterState.abLoop + loopStart/End の null チェックで分岐
//     (= 編集中の手動 setTime に追従されるのを防ぐため、 必ず Timeline.playing 中だけ巻き戻す)
//   - A > B の逆向き範囲は不正扱いで巻き戻さない (= ユーザーミスを silent fail させて事故を防ぐ)
//   - 視覚的な範囲マーカー (= timeline 縦線) は v0.2 では未実装、 v0.3 で追加検討

import { filterState } from './animatorPanelUI'
import { syncToggleVisuals } from './toggles'

declare const Timeline:
	| {
			time: number
			setTime(t: number): void
			playing?: boolean
	  }
	| undefined
declare const Action: new (id: string, opts: Record<string, unknown>) => { delete(): void }
declare const Keybind: new (opts: Record<string, unknown>) => unknown
declare const Modes: { animate: boolean } | undefined
declare const Animation: { selected?: unknown } | undefined
declare const Prop: { active_panel?: string } | undefined

let loopStart: number | undefined
let loopEnd: number | undefined
let watchHandle: number | undefined

function condition(): boolean {
	const modes = typeof Modes !== 'undefined' ? Modes : undefined
	const anim = typeof Animation !== 'undefined' ? Animation : undefined
	const prop = typeof Prop !== 'undefined' ? Prop : undefined
	return Boolean(modes?.animate && anim?.selected && prop?.active_panel === 'timeline')
}

function tick(): void {
	const timeline = typeof Timeline !== 'undefined' ? Timeline : undefined
	if (timeline) {
		const start = loopStart
		const end = loopEnd
		if (
			filterState.abLoop &&
			timeline.playing &&
			start !== undefined &&
			end !== undefined &&
			start < end &&
			timeline.time > end
		) {
			timeline.setTime(start)
		}
	}
	watchHandle = requestAnimationFrame(tick)
}

function startWatch(): void {
	if (watchHandle !== undefined) return
	watchHandle = requestAnimationFrame(tick)
}

function stopWatch(): void {
	if (watchHandle === undefined) return
	cancelAnimationFrame(watchHandle)
	watchHandle = undefined
}

let actions: Array<{ delete(): void }> = []

export function installAbLoop(): () => void {
	const KEY_A = 65
	const KEY_B = 66
	const KEY_L = 76
	const KEY_X = 88

	actions.push(
		new Action('anim_ux_set_loop_start', {
			name: 'Anim UX: Set A-B Loop Start at Current Time',
			icon: 'first_page',
			category: 'animation',
			keybind: new Keybind({ key: KEY_A, alt: true, shift: true }),
			condition,
			click() {
				const timeline = typeof Timeline !== 'undefined' ? Timeline : undefined
				if (timeline) loopStart = timeline.time
			},
		})
	)
	actions.push(
		new Action('anim_ux_set_loop_end', {
			name: 'Anim UX: Set A-B Loop End at Current Time',
			icon: 'last_page',
			category: 'animation',
			keybind: new Keybind({ key: KEY_B, alt: true, shift: true }),
			condition,
			click() {
				const timeline = typeof Timeline !== 'undefined' ? Timeline : undefined
				if (timeline) loopEnd = timeline.time
			},
		})
	)
	actions.push(
		new Action('anim_ux_toggle_ab_loop', {
			name: 'Anim UX: Toggle A-B Loop',
			icon: 'loop',
			category: 'animation',
			keybind: new Keybind({ key: KEY_L, alt: true, shift: true }),
			condition,
			click() {
				filterState.abLoop = !filterState.abLoop
				// shortcut 経由でも filter bar の class 状態を反映 (= toggles.ts の共通関数を流用)
				syncToggleVisuals()
			},
		})
	)
	actions.push(
		new Action('anim_ux_clear_loop_range', {
			name: 'Anim UX: Clear A-B Loop Range',
			icon: 'clear',
			category: 'animation',
			keybind: new Keybind({ key: KEY_X, alt: true, shift: true }),
			condition,
			click() {
				loopStart = undefined
				loopEnd = undefined
			},
		})
	)

	startWatch()

	return () => {
		for (const a of actions) {
			try {
				a.delete()
			} catch (e) {
				console.warn('[anim_ux] action delete failed', e)
			}
		}
		actions = []
		stopWatch()
		loopStart = undefined
		loopEnd = undefined
	}
}
