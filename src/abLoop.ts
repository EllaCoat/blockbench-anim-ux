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
//   - rAF は filterState.abLoop = true の間だけ稼働 (= OFF 時は idle cost ゼロ)。
//     toggle / shortcut で abLoop を切替えた直後に syncAbLoopWatch() を呼んで start/stop を反映する。
//     ON 中の編集 (= Timeline.playing=false) でも rAF は回り続けるが、 tick 内で
//     timeline.playing 判定があるため巻き戻しは発生しない (= 計算は noop で 1 frame 数 µs)。
//   - A > B の逆向き範囲は不正扱いで巻き戻さない (= ユーザーミスを silent fail させて事故を防ぐ)
//   - v0.3 で視覚的な縦線マーカーを追加 (= #timeline_body_inner 内に absolute 配置で scroll 自動追従、
//     zoom 追従用に A/B のいずれかが set されてる間だけ別 rAF を回す = idle 時 0 cost)
//     left = head_width + time * size + 8 (= BB の keyframe 配置式と完全一致、 timeline.js:1775 参照)

import { filterState, registerRefreshCallback } from './animatorPanelUI'
import { findElementByIdInDocs, queryAllInDocs } from './popoutBus'
import { syncToggleVisuals } from './toggles'

declare const Timeline:
	| {
			time: number
			setTime(t: number): void
			playing?: boolean
			vue?: { _data?: { size?: number; head_width?: number }; size?: number; head_width?: number }
	  }
	| undefined
declare const Animation: { selected?: { snapping?: number } } | undefined
declare const Action: new (id: string, opts: Record<string, unknown>) => { delete(): void }
declare const Keybind: new (opts: Record<string, unknown>) => unknown

let loopStart: number | undefined
let loopEnd: number | undefined
let watchHandle: number | undefined
let markerWatchHandle: number | undefined
let markerA: HTMLElement | undefined
let markerB: HTMLElement | undefined
let markerStyle: HTMLStyleElement | undefined

const MARKER_STYLE_ID = 'anim-ux-ab-marker-style'
const MARKER_A_CLASS = 'anim-ux-ab-marker-a'
const MARKER_B_CLASS = 'anim-ux-ab-marker-b'
// 縦線の色は Onion Skin と同系統 (= past 青 / future 橙 と紛らわしくないように彩度多少落とす)。
// A = 開始 (= 緑系)、 B = 終了 (= 赤系) で「開始/終了」 のメタファに寄せる。
// 注 : CSS で display:none を default にして style.display='' で上書きしようとすると、
// inline style が空になった時に CSS の display:none が再評価で復活する古典的な罠。
// なので CSS には display 指定を入れず、 JS 側で常に 'block' / 'none' を明示する。
// z-index は li.animator (= 5、 panels.css:1759) より上にしないと隠れる、 100 で十分余裕。
const MARKER_CSS = `
.${MARKER_A_CLASS}, .${MARKER_B_CLASS} {
	position: absolute;
	top: 0;
	bottom: 0;
	width: 2px;
	pointer-events: none;
	z-index: 100;
}
.${MARKER_A_CLASS} { background-color: #66cc66; box-shadow: 0 0 4px rgba(102, 204, 102, 0.6); }
.${MARKER_B_CLASS} { background-color: #cc6666; box-shadow: 0 0 4px rgba(204, 102, 102, 0.6); }
`

// BB 正式仕様の condition object 形式 (= `Animate` モード時のみ発火)。
// v0.2 初版は function 渡し + Prop.active_panel === 'timeline' 判定だったが、
// 後者は再生中等で外れる可能性 + 実機検証で shortcut 反応せず、 modes 制約のみに簡素化。
const ACTION_CONDITION = { modes: ['animate'] }

// filter bar 右端の status span (= "A:0f B:20f") を現状で書き換える。
// shortcut 経由で値が変わった瞬間に呼んで即時反映 + refresh callback でも呼んで
// MutationObserver で bar が再 inject された後の state も追従する。
// 表示単位は frame (= Animation.snapping で取得した fps を時刻に掛けて整数化、 後置 `f`)。
// AJ blueprint は snapping=20、 vanilla は他値の可能性あるので動的取得。 フォールバックは 20fps。
function getFps(): number {
	const fps = (typeof Animation !== 'undefined' ? Animation : undefined)?.selected?.snapping
	return typeof fps === 'number' && fps > 0 ? fps : 20
}

function formatTime(t: number | undefined): string {
	if (t === undefined) return '—'
	return `${Math.round(t * getFps())}f`
}

function updateAbLoopStatus(): void {
	// popout 中は span が子窓に居る (= filter bar 諸共 TIMELINE container 内)。
	// queryAllInDocs で親 + 子窓両方を更新 (= 通常は片方にしか居ないが、 復帰タイミング過渡期も含めて安全に)。
	const spans = queryAllInDocs<HTMLElement>('.anim-ux-ab-status')
	if (!spans.length) return
	const text =
		loopStart === undefined && loopEnd === undefined
			? '—'
			: `A:${formatTime(loopStart)} B:${formatTime(loopEnd)}`
	for (const span of spans) span.textContent = text
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

// filterState.abLoop を見て rAF watch を start/stop する。
// toggle (= toggles.ts) と shortcut (= 下の toggle action) の両経路から呼ばれる。
// ON → 未稼働なら start、 OFF → 稼働中なら stop、 それ以外 (= 状態一致) は noop。
export function syncAbLoopWatch(): void {
	if (filterState.abLoop) startWatch()
	else stopWatch()
}

// Timeline.vue の動的データから size (= px/sec) と head_width を取得。
// `_data` 経路 (= Vue 2 internal) と素直な経路を順に試して、 BB version 差を吸収。
function getTimelineSize(): number {
	const v = (typeof Timeline !== 'undefined' ? Timeline : undefined)?.vue
	return v?._data?.size ?? v?.size ?? 100
}
function getTimelineHeadWidth(): number {
	const v = (typeof Timeline !== 'undefined' ? Timeline : undefined)?.vue
	return v?._data?.head_width ?? v?.head_width ?? 0
}

// CSS を 1 回だけ inject (= plugin unload で remove)。 marker 用のスタイル。
function ensureMarkerStyle(): void {
	if (markerStyle) return
	const style = document.createElement('style')
	style.id = MARKER_STYLE_ID
	style.textContent = MARKER_CSS
	document.head.appendChild(style)
	markerStyle = style
}

// #timeline_body_inner 内に A / B 縦線 div を attach (= 既に同じ親にあれば再利用)。
// 親が再 render で消える / 切替えられたケースを毎呼出 で吸収 (= filter bar と同じ思想)。
// popout 中は TIMELINE 諸共 inner が子窓に居るので popoutBus 経由で検索 (= getElementById hook で
// メイン経路の document.getElementById も子窓 fallback されるが、 明示経路の方が意図が読める)。
function ensureMarkers(): void {
	const inner = findElementByIdInDocs('timeline_body_inner')
	if (!inner) return
	if (!markerA || markerA.parentElement !== inner) {
		if (markerA?.parentElement) markerA.remove()
		markerA = document.createElement('div')
		markerA.className = MARKER_A_CLASS
		inner.appendChild(markerA)
	}
	if (!markerB || markerB.parentElement !== inner) {
		if (markerB?.parentElement) markerB.remove()
		markerB = document.createElement('div')
		markerB.className = MARKER_B_CLASS
		inner.appendChild(markerB)
	}
}

// loopStart / loopEnd の現値を読んで left を計算 + display を on/off。
// 値計算式は BB keyframe と完全一致 (= head_width + time * size + 8)、 これで scroll/zoom 両方追従。
// display は 'block' を明示 (= '' にすると CSS class の display:none 等が再評価で復活する罠)。
function updateMarkers(): void {
	if (!markerA && !markerB) return
	const size = getTimelineSize()
	const headWidth = getTimelineHeadWidth()
	if (markerA) {
		if (loopStart === undefined) {
			markerA.style.display = 'none'
		} else {
			markerA.style.display = 'block'
			markerA.style.left = `${headWidth + loopStart * size + 8}px`
		}
	}
	if (markerB) {
		if (loopEnd === undefined) {
			markerB.style.display = 'none'
		} else {
			markerB.style.display = 'block'
			markerB.style.left = `${headWidth + loopEnd * size + 8}px`
		}
	}
}

// A or B が set されてる間だけ rAF を回して zoom 追従。 何も set されてないときは停止 (= idle 0 cost)。
// scroll 追従は inner の absolute 配置で自動 = ここでは不要、 zoom (= size 変動) のみ rAF で拾う。
function tickMarkers(): void {
	ensureMarkers()
	updateMarkers()
	if (loopStart !== undefined || loopEnd !== undefined) {
		markerWatchHandle = requestAnimationFrame(tickMarkers)
	} else {
		markerWatchHandle = undefined
	}
}

function syncMarkerWatch(): void {
	if (loopStart !== undefined || loopEnd !== undefined) {
		if (markerWatchHandle === undefined) {
			markerWatchHandle = requestAnimationFrame(tickMarkers)
		}
	} else {
		if (markerWatchHandle !== undefined) {
			cancelAnimationFrame(markerWatchHandle)
			markerWatchHandle = undefined
		}
		// 即時に線を隠す (= 次 tick まで待たない)
		if (markerA) markerA.style.display = 'none'
		if (markerB) markerB.style.display = 'none'
	}
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
				syncMarkerWatch()
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
				syncMarkerWatch()
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
				// rAF を on/off 同期 (= toggle 経路の sync と同経路、 idle cost ゼロを維持)
				syncAbLoopWatch()
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
				syncMarkerWatch()
			},
		})
	)

	// MutationObserver で bar が再 inject された後の状態追従 (= 新しい span に再描画)。
	// marker も ensureMarkers() で同じく再 attach 経路を持つので、 refresh callback で 1 回叩く。
	const unregisterRefresh = registerRefreshCallback(() => {
		updateAbLoopStatus()
		ensureMarkers()
		updateMarkers()
	})

	// marker CSS を 1 回 inject (= timeline_body_inner への attach 自体は ensureMarkers() で遅延作業)
	ensureMarkerStyle()

	// plugin load 直後は abLoop=false かつ loopStart/End=undefined なので、 rAF は両方とも停止状態。
	// toggle / shortcut で ON にされた時点で syncAbLoopWatch() / syncMarkerWatch() が走って start する。

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
		if (markerWatchHandle !== undefined) {
			cancelAnimationFrame(markerWatchHandle)
			markerWatchHandle = undefined
		}
		markerA?.remove()
		markerA = undefined
		markerB?.remove()
		markerB = undefined
		markerStyle?.remove()
		markerStyle = undefined
		loopStart = undefined
		loopEnd = undefined
	}
}
