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

import { filterState, registerRefreshCallback } from './animatorPanelUI'
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

let loopStart: number | undefined
let loopEnd: number | undefined
let watchHandle: number | undefined

// BB 正式仕様の condition object 形式 (= `Animate` モード時のみ発火)。
// v0.2 初版は function 渡し + Prop.active_panel === 'timeline' 判定だったが、
// 後者は再生中等で外れる可能性 + 実機検証で shortcut 反応せず、 modes 制約のみに簡素化。
const ACTION_CONDITION = { modes: ['animate'] }

// filter bar 右端の status span (= "A: 1.23s B: 2.45s") を現状で書き換える。
// shortcut 経由で値が変わった瞬間に呼んで即時反映 + refresh callback でも呼んで
// MutationObserver で bar が再 inject された後の state も追従する。
function formatTime(t: number | undefined): string {
	if (t === undefined) return '—'
	return `${t.toFixed(2)}s`
}

function updateAbLoopStatus(): void {
	const span = document.querySelector<HTMLElement>('.anim-ux-ab-status')
	if (!span) return
	if (loopStart === undefined && loopEnd === undefined) {
		span.textContent = '—'
		return
	}
	span.textContent = `A:${formatTime(loopStart)} B:${formatTime(loopEnd)}`
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
	// keybind は BB 標準スタイルの **文字列指定** (= 内部で `key.toUpperCase().charCodeAt(0)` 変換)。
	// 初版は numeric keyCode (= 65 等) を渡してたが、 v0.1 の arrow key (= 37/39) と挙動が
	// 違って alphabet では fire しないケースがあったため、 BB 例 (= bbmodel.js:872 等) に揃えて string に。
	actions.push(
		new Action('anim_ux_set_loop_start', {
			name: 'Anim UX: Set A-B Loop Start at Current Time',
			icon: 'first_page',
			category: 'animation',
			keybind: new Keybind({ key: 'a', alt: true, shift: true }),
			condition: ACTION_CONDITION,
			click() {
				const timeline = typeof Timeline !== 'undefined' ? Timeline : undefined
				if (timeline) loopStart = timeline.time
				updateAbLoopStatus()
			},
		})
	)
	actions.push(
		new Action('anim_ux_set_loop_end', {
			name: 'Anim UX: Set A-B Loop End at Current Time',
			icon: 'last_page',
			category: 'animation',
			keybind: new Keybind({ key: 'b', alt: true, shift: true }),
			condition: ACTION_CONDITION,
			click() {
				const timeline = typeof Timeline !== 'undefined' ? Timeline : undefined
				if (timeline) loopEnd = timeline.time
				updateAbLoopStatus()
			},
		})
	)
	actions.push(
		new Action('anim_ux_toggle_ab_loop', {
			name: 'Anim UX: Toggle A-B Loop',
			icon: 'loop',
			category: 'animation',
			keybind: new Keybind({ key: 'l', alt: true, shift: true }),
			condition: ACTION_CONDITION,
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
			keybind: new Keybind({ key: 'x', alt: true, shift: true }),
			condition: ACTION_CONDITION,
			click() {
				loopStart = undefined
				loopEnd = undefined
				updateAbLoopStatus()
			},
		})
	)

	// MutationObserver で bar が再 inject された後の状態追従 (= 新しい span に再描画)
	const unregisterRefresh = registerRefreshCallback(updateAbLoopStatus)

	startWatch()

	return () => {
		unregisterRefresh()
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
