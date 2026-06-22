// blockbench-anim-ux — Timeline panel pop-out (案 C 実験、 experiment/timeline-popout)
//
// 狙い :
//   - BB 本体の TIMELINE パネルを「別モニターの独立ウィンドウ」に切り出す (= イーラ君の本命要求)
//   - BB の new_window は別プロセス / 別 DOM で DOM 移植不可。 そこで plugin が独自に window.open する
//
// PoC で確認済 (= risky_eval、 2026-06-21) :
//   - window.open の子窓は openerIsSelf=true = 同一プロセス / 同一 JS context
//   - 親の DOM ノードを子 document に adoptNode できる + 親 JS から子 DOM を操作できる
//   - → Vue インスタンスを親に残したまま、 TIMELINE の DOM だけ子窓へ引っ越せる見込み
//
// ⚠ 実機未検証 (= 検証は手元で目視) :
//   - 引っ越し後に Vue のリアクティビティ / イベントが生き続けるか
//   - 子窓を別モニターに移動できるか
//   - 戻したとき TIMELINE が原状回復するか
//
// 安全設計 (= TIMELINE を引っこ抜くので、 戻せないと本体 UI が壊れる) :
//   - 元の parent / nextSibling を記憶して確実に戻す
//   - 子窓 beforeunload (= 手動で閉じた) で親に戻す
//   - plugin unload でも必ず戻す
//
// 使い方 (PoC) : console から ajPopoutTimeline() / ajRestoreTimeline() を呼ぶ。

import { bindPopoutChild } from './popoutBus'

declare const Panels:
	| Record<
			string,
			| {
					node?: HTMLElement
					container?: HTMLElement
					vue?: { _data?: { size?: number } } | unknown
					update?: () => void
					width?: number
					height?: number
			  }
			| undefined
	  >
	| undefined

declare const Timeline: { updateSize?: () => void } | undefined

declare const Action: new (id: string, opts: Record<string, unknown>) => { delete(): void }
declare const MenuBar:
	| {
			menus: Record<
				string,
				{ addAction(action: unknown): void; removeAction(action: unknown): void } | undefined
			>
	  }
	| undefined

interface JQueryLike {
	(selector: unknown, context?: unknown): unknown
	fn?: unknown
	[k: string]: unknown
}

let popoutWin: Window | null = null
let restoreFn: (() => void) | null = null

// Document.prototype.getElementById を popout 中だけ hook して、 `timeline_*` 系 id がメインに無いとき
// 子窓 document の要素を返す。 BB は `document.getElementById('timeline_body' / 'timeline_vue' / 'timeline_time' / 'timeline_body_inner')` 等を
// 直叩きする箇所が timeline.js / timeline_animators.js / keyframe.js / interface.js に集中、 他で `timeline_*` id を使ってる箇所は無いと
// Codex がソース読みで確認済。 副作用範囲は限定。
// 安全策: 対象 id を `timeline_` / `resizer_timeline_` prefix に限定 (= 他 UI への波及を遮断)。
function installGetElementByIdFallback(childWin: Window): () => void {
	const proto = Document.prototype
	const original = proto.getElementById
	const SAFE_PREFIX = /^(timeline_|resizer_timeline_)/
	const patched = function (this: Document, id: string): HTMLElement | null {
		// 親 document 以外 (= 子窓 document) からの呼び出しは素通し (= 再帰防止)。
		// 子窓 fallback ブランチで `childWin.document.getElementById(id)` を呼ぶと、
		// patched 自身が呼ばれて見つからない時に再帰してスタック爆発する潜在パスを断つ。
		if (this !== document) return original.call(this, id)
		const found = original.call(this, id)
		if (found) return found
		// メインに無い、 かつ「timeline 系 id」 のときだけ子窓 fallback (上の guard で再帰しない)
		if (!SAFE_PREFIX.test(id)) return null
		if (childWin.closed) return null
		try {
			return childWin.document.getElementById(id)
		} catch {
			return null
		}
	}
	proto.getElementById = patched
	return (): void => {
		// 自分の patch がまだ生きてる時のみ original に戻す。
		if (proto.getElementById === patched) {
			proto.getElementById = original
		} else {
			console.warn('[anim_ux:popout] Document.prototype.getElementById は他で上書きされてる、 revert skip')
		}
	}
}

// 子窓で発生した mouse / touch の continuation event を親 document に転送する。
// 理由 : BB の drag handler (= playhead / keyframe / endbracket / selector) は開始 mousedown を子 DOM で拾ってから、
//        継続 mousemove / mouseup を `親 document.addEventListener` で待ち受ける (timeline.js:1422 等)。
//        子窓で mouse 動かしても親 document には event が来ないので drag 不能 (= Codex 確認)。
// 設計 :
//   - 子窓座標 (= e.clientX) のまま親 document に dispatchEvent (= jQuery hook と組で $().offset() も子窓基準で揃う)
//   - target は弄らない (= 親 document 経由になる、 だが継続 handler は target を見ないので OK = Codex 確認)
//   - 全 mousemove を proxy すると親 UI の hover 等に副作用、 drag 中のフラグ (Timeline.dragging_*) 検知で限定
function installEventProxy(childWin: Window): () => void {
	const proxyMouse = (type: 'mousemove' | 'mouseup'): ((e: MouseEvent) => void) => (e: MouseEvent): void => {
		// MouseEvent をクローンして親に dispatch。 button / clientX / clientY 等の主要属性を維持
		try {
			const cloned = new MouseEvent(type, {
				bubbles: true,
				cancelable: true,
				button: e.button,
				buttons: e.buttons,
				clientX: e.clientX,
				clientY: e.clientY,
				ctrlKey: e.ctrlKey,
				shiftKey: e.shiftKey,
				altKey: e.altKey,
				metaKey: e.metaKey,
				screenX: e.screenX,
				screenY: e.screenY,
			})
			document.dispatchEvent(cloned)
		} catch (err) {
			// 高頻度経路、 silent
			void err
		}
	}
	const proxyTouch = (type: 'touchmove' | 'touchend'): ((e: TouchEvent) => void) => (e: TouchEvent): void => {
		try {
			// TouchEvent コンストラクタは Electron / Chromium で実装あり (= Chromium 49+)。
			// 失敗したら no-op (= 仮想 touch を捏造するより安全)
			const Ctor = (window as unknown as { TouchEvent?: typeof TouchEvent }).TouchEvent
			if (!Ctor) return
			const cloned = new Ctor(type, {
				bubbles: true,
				cancelable: true,
				touches: Array.from(e.touches),
				targetTouches: Array.from(e.targetTouches),
				changedTouches: Array.from(e.changedTouches),
			})
			document.dispatchEvent(cloned)
		} catch (err) {
			void err
		}
	}

	const mm = proxyMouse('mousemove')
	const mu = proxyMouse('mouseup')
	const tm = proxyTouch('touchmove')
	const te = proxyTouch('touchend')

	// keyboard event の proxy : BB の global keydown handler (= Undo / 全 Keybind 含む) は親 document に登録されてる。
	// 子窓で押した key を親 document にも届ける (= Undo ショートカット + anim_ux 独自 Keybind の救済)。
	//
	// 注意点 :
	//   - BB の handler (keyboard.js:655) は冒頭で `if (e.which < 4) return`、 `Keybind.isTriggered()` は
	//     `this.key == event.which` を見る。 KeyboardEvent コンストラクタは which/keyCode/charCode を
	//     **指定できない** 仕様 (= MDN: legacy / readonly) なので、 そのまま dispatch すると which=0 で
	//     ショートカットがほぼ全部落ちる。 → Object.defineProperty で legacy property を被せて互換回復。
	//   - 子窓 text input にフォーカス中の plain key (= 修飾なし) を親に投げると BB の global
	//     shortcut (= Space で再生 / Delete で keyframe 削除 等) が誤発火する。 BB 本家
	//     getFocusedTextInput と同じ判定で抑制、 ただし Ctrl/Meta 付きは Undo/Save/Copy 等の
	//     global shortcut なので通す (= text input 中の Ctrl+Z は global Undo に倒す方が直感的)。
	const isChildTextInputFocused = (): boolean => {
		const active = childWin.document.activeElement as HTMLElement | null
		if (!active) return false
		if (active.nodeName === 'TEXTAREA') return true
		if (active.nodeName === 'INPUT') {
			const t = (active as HTMLInputElement).type
			return t === 'number' || t === 'text' || t === 'search'
		}
		return active.isContentEditable === true
	}
	// 子窓 text input フォーカス中でも親に流したい「global shortcut」 key の whitelist。
	// (= Undo/Redo/Save/Copy/Paste/Cut/SelectAll/Find などの修飾キー組合せ)
	// それ以外の Ctrl/Meta 付きキー (= Ctrl+Arrow / Ctrl+Backspace / Ctrl+Home 等の input 編集系) は
	// 親 document に流すと BB / AJ の shortcut が誤発火するため、 子窓 input にとどめる。
	const TEXT_INPUT_PASSTHROUGH_KEYS = new Set([
		'z', 'Z', 'y', 'Y', 's', 'S', 'c', 'C', 'v', 'V', 'x', 'X', 'a', 'A', 'f', 'F',
	])
	const proxyKey = (type: 'keydown' | 'keyup'): ((e: KeyboardEvent) => void) => (e: KeyboardEvent): void => {
		try {
			// IME 変換中 (= 日本語入力 / 中国語入力 等) の key event は親に投げない。
			// 変換確定の Enter / 候補選択の矢印キーが BB global shortcut として誤爆するのを防ぐ。
			// `isComposing` は KeyboardEvent 標準プロパティ (= Chromium 全 version 対応)。
			if (e.isComposing) return
			const hasGlobalModifier = e.ctrlKey || e.metaKey
			if (isChildTextInputFocused()) {
				// 修飾キーなしは proxy 不要 (= 子窓 input の標準入力)
				if (!hasGlobalModifier) return
				// Ctrl/Meta 付きでも、 input 編集系 shortcut は親に漏らさない (= Ctrl+Arrow / Ctrl+Backspace 等)
				if (!TEXT_INPUT_PASSTHROUGH_KEYS.has(e.key)) return
			}
			const cloned = new KeyboardEvent(type, {
				bubbles: true,
				cancelable: true,
				key: e.key,
				code: e.code,
				ctrlKey: e.ctrlKey,
				shiftKey: e.shiftKey,
				altKey: e.altKey,
				metaKey: e.metaKey,
				repeat: e.repeat,
				location: e.location,
			})
			const which = e.which || e.keyCode || 0
			Object.defineProperties(cloned, {
				which: { get: () => which, configurable: true },
				keyCode: { get: () => which, configurable: true },
				charCode: { get: () => e.charCode || 0, configurable: true },
			})
			document.dispatchEvent(cloned)
		} catch (err) {
			void err
		}
	}
	const kd = proxyKey('keydown')
	const ku = proxyKey('keyup')

	// Ctrl + wheel zoom の救済 (= 子窓 timeline 上で Ctrl+wheel しても zoom 不発の bug 修正、 v0.5)。
	//
	// BB の TIMELINE wheel handler (= timeline.js:558-587) は
	//   is_zoom_gesture = event.ctrlKey && !Pressing.ctrl
	// で zoom 判定し、 `addEventListeners(timeline_vue, 'mousewheel scroll', ...)` で **`mousewheel`** event に
	// bind する (= 標準 `wheel` ではなく legacy event 名)。 子窓で Ctrl 押下 → keyboard proxy で親 document にも
	// keydown 届く → keyboard.js:664/922 が Pressing.ctrl=true に倒す → ctrlKey=true でも is_zoom_gesture=false で
	// zoom 不発、 通常 scroll に倒れる。
	//
	// 対策 = 子窓 `wheel` + `mousewheel` 両方の capture phase で Pressing.ctrl を一時 false に退避、 bubble phase で
	//        復元する sandwich。 Chromium は両 event を発火する (= 順序は wheel → mousewheel)、 どちらが BB handler を
	//        起こすかは event 名次第なので両方張る。 pressingPatched flag で連続発火時の二重 save (= false を save する
	//        bug) を防止、 microtask 復元で AJ hover popup 等の stopImmediatePropagation 被弾を保険する。
	const pressingHolder = window as unknown as { Pressing?: { ctrl?: boolean } }
	let pressingPatched = false
	let savedPressingCtrl = false
	const restorePressing = (): void => {
		if (!pressingPatched) return
		const P = pressingHolder.Pressing
		if (P) P.ctrl = savedPressingCtrl
		pressingPatched = false
	}
	// wheel → mousewheel bridge (= v0.5 致命対応)。
	// Chromium は子窓 document で legacy `mousewheel` event を発火させない (= 親 document では発火するが、
	// adoptNode 移植後の子窓では起こらないことが実機 log で確定)。 BB の TIMELINE wheel handler は
	// `addEventListeners(timeline_vue, 'mousewheel scroll', ...)` で **mousewheel** listener、 子窓では起動しない。
	// 対策 = 子窓 wheel event 発火時に、 timeline_vue 配下が target なら mousewheel event を同期再 dispatch、
	//        BB の既存 handler を起こす。 same document realm なので Event ctor 問題 (= cross-realm) は無い。
	// loop 防止 = dispatch した event に mark を打ち、 wheelCapture で見たら再 dispatch しない。
	const BRIDGE_MARK = '_ajPopoutBridged'
	const bridgeWheelToMousewheel = (e: WheelEvent): void => {
		if ((e as unknown as Record<string, unknown>)[BRIDGE_MARK]) return
		const target = e.target as Element | null
		const timelineVue = childWin.document.getElementById('timeline_vue')
		if (!target || !timelineVue || !timelineVue.contains(target)) return
		const WEvCtor = (childWin as unknown as { WheelEvent?: typeof WheelEvent }).WheelEvent
		if (!WEvCtor) return
		try {
			// 元 wheel の browser default scroll を止めて、 BB の独自 scroll 計算に委ねる
			e.preventDefault()
			const cloned = new WEvCtor('mousewheel', {
				bubbles: true,
				cancelable: true,
				deltaX: e.deltaX,
				deltaY: e.deltaY,
				deltaZ: e.deltaZ,
				deltaMode: e.deltaMode,
				clientX: e.clientX,
				clientY: e.clientY,
				screenX: e.screenX,
				screenY: e.screenY,
				button: e.button,
				buttons: e.buttons,
				ctrlKey: e.ctrlKey,
				shiftKey: e.shiftKey,
				altKey: e.altKey,
				metaKey: e.metaKey,
				view: childWin,
			})
			Object.defineProperty(cloned, BRIDGE_MARK, { value: true, configurable: true })
			timelineVue.dispatchEvent(cloned)
		} catch (err) {
			console.warn('[anim_ux:popout] wheel→mousewheel bridge failed', err)
		}
	}
	const wheelCapture = (e: Event): void => {
		const we = e as WheelEvent
		const isCtrlZoom = we.ctrlKey && !we.shiftKey
		// shift+wheel は BB が水平 scroll に倒すので zoom 対象外、 触らない
		if (!isCtrlZoom) {
			// Ctrl 無し wheel も BB の onMouseWheel に届ける必要がある (= 縦 scroll / shift 横 scroll 等)
			if (e.type === 'wheel') bridgeWheelToMousewheel(we)
			return
		}
		const P = pressingHolder.Pressing
		if (P) {
			// 既に patched 中なら save 上書きしない (= wheel と mousewheel 連発時に false を save する事故防止)
			if (!pressingPatched) {
				savedPressingCtrl = P.ctrl ?? false
				pressingPatched = true
			}
			P.ctrl = false
		}
		// sandwich の最中 (= Pressing.ctrl=false 状態) に bridge を起こして BB handler を呼ぶ
		if (e.type === 'wheel') bridgeWheelToMousewheel(we)
		// AJ hover popup 等が capture phase で stopImmediatePropagation すると bubble 復元が
		// 飛ぶので、 microtask でも復元する保険を張る (= 同期処理終了後に必ず走る、 二重復元は no-op)。
		queueMicrotask(restorePressing)
	}
	const wheelBubble = (_e: Event): void => {
		restorePressing()
	}

	// capture: true で他リスナーより先に走らせる (= BB の Vue handler 等が止める前に親に届ける)
	childWin.document.addEventListener('mousemove', mm, true)
	childWin.document.addEventListener('mouseup', mu, true)
	childWin.document.addEventListener('touchmove', tm, true)
	childWin.document.addEventListener('touchend', te, true)
	childWin.document.addEventListener('keydown', kd, true)
	childWin.document.addEventListener('keyup', ku, true)
	childWin.document.addEventListener('wheel', wheelCapture, true)
	childWin.document.addEventListener('wheel', wheelBubble, false)
	// BB は legacy `mousewheel` event 名で bind するので、 こちらにも同じ sandwich を張る (= zoom 修正の本命)
	childWin.document.addEventListener('mousewheel', wheelCapture, true)
	childWin.document.addEventListener('mousewheel', wheelBubble, false)

	return (): void => {
		try { childWin.document.removeEventListener('mousemove', mm, true) } catch { /* noop */ }
		try { childWin.document.removeEventListener('mouseup', mu, true) } catch { /* noop */ }
		try { childWin.document.removeEventListener('touchmove', tm, true) } catch { /* noop */ }
		try { childWin.document.removeEventListener('touchend', te, true) } catch { /* noop */ }
		try { childWin.document.removeEventListener('keydown', kd, true) } catch { /* noop */ }
		try { childWin.document.removeEventListener('keyup', ku, true) } catch { /* noop */ }
		try { childWin.document.removeEventListener('wheel', wheelCapture, true) } catch { /* noop */ }
		try { childWin.document.removeEventListener('wheel', wheelBubble, false) } catch { /* noop */ }
		try { childWin.document.removeEventListener('mousewheel', wheelCapture, true) } catch { /* noop */ }
		try { childWin.document.removeEventListener('mousewheel', wheelBubble, false) } catch { /* noop */ }
		// cleanup 中に sandwich の途中で抜けた場合に備え、 ctrl 状態を戻す保険
		restorePressing()
	}
}

// jQuery selector を popout 中だけ hook して、 id selector がメインに無いとき子窓 document も探す。
// 理由 : BB の timeline.js は `$('#timeline_*').offset()` を 24 箇所で使ってる。
//        DOM は子窓に引っ越したが jQuery (= document.getElementById) はメイン document しか見ないので、
//        $().offset() が undefined → .left でクラッシュ (timeline.js:380 等)。
// hook の限定 : selector が文字列で先頭が `#` のときだけ。 通常パターンは素通り。
function installJqueryFallback(childWin: Window): () => void {
	const w = window as unknown as { $?: JQueryLike; jQuery?: JQueryLike }
	const original = w.$
	if (!original || typeof original !== 'function') {
		console.warn('[anim_ux:popout] jQuery が見つからない、 fallback hook skip')
		return () => {}
	}
	// `installGetElementByIdFallback` を後で install すると Document.prototype.getElementById が
	// patched 版になり、 「親に無く子窓にある id」 を truthy で返してしまう → 下の `if (document.getElementById(id))`
	// が常に truthy になり child fallback ブランチ (= original(selector, childWin.document)) に到達できない。
	// Codex 指摘の hook 干渉。 ここで **install 前の native** をキャプチャして使い分岐を確定させる。
	const nativeGetById = Document.prototype.getElementById
	const patched = function (selector: unknown, context?: unknown): unknown {
		// 文字列 id selector + context 未指定のときだけ介入
		if (typeof selector === 'string' && selector.length > 1 && selector[0] === '#' && context === undefined) {
			// id 内のスペースは含まないので安全に substring (= '#xxx .yyy' のような複合 selector でも先頭 token のみ判定)
			const space = selector.indexOf(' ')
			const idPart = space >= 0 ? selector.substring(0, space) : selector
			const id = idPart.substring(1)
			// メイン document に居るならそのまま委譲 (= 通常パターン素通り)
			if (nativeGetById.call(document, id)) return original(selector, context)
			// メインに無い、 かつ子窓に居るなら子窓 document scope で再 query
			if (childWin && !childWin.closed && nativeGetById.call(childWin.document, id)) {
				return original(selector, childWin.document)
			}
		}
		return original(selector, context)
	} as unknown as JQueryLike
	// fn / Event / 他の static method を継承 (= jQuery API 全部を維持)
	for (const k in original) patched[k] = original[k]
	patched.fn = original.fn
	w.$ = patched
	w.jQuery = patched
	return (): void => {
		// 自分の patch がまだ生きてる時のみ original に戻す。
		if (w.$ === patched) {
			w.$ = original
			w.jQuery = original
		} else {
			console.warn('[anim_ux:popout] $ は他で上書きされてる、 revert skip')
		}
	}
}

// 親の <style> / <link rel=stylesheet> を子 document.head に複製する。
// (= 子窓は別 document なので親の CSS が一切効かない。 BB は style 54 + link 11 個)
function copyStyles(target: Document): void {
	for (const styleEl of Array.from(document.querySelectorAll('style'))) {
		const clone = target.createElement('style')
		clone.textContent = styleEl.textContent
		target.head.appendChild(clone)
	}
	for (const link of Array.from(document.querySelectorAll('link[rel="stylesheet"]'))) {
		const href = (link as HTMLLinkElement).href
		if (!href) continue
		const clone = target.createElement('link')
		clone.rel = 'stylesheet'
		clone.href = href
		target.head.appendChild(clone)
	}
}

export function popoutTimeline(): void {
	if (popoutWin && !popoutWin.closed) {
		popoutWin.focus()
		return
	}
	const P = typeof Panels !== 'undefined' ? Panels?.timeline : undefined
	// container = .panel_container (= panel_timeline の親 + tab_bar 含む)。
	// node 単体ではなく container ごと移す (= Panels.timeline.update() の `container.append(node)` 経路で
	// 親に巻き戻る事故を防ぐ、 Codex 確認済 panels.ts:1064)。
	const node = P?.container ?? P?.node
	if (!node) {
		console.warn('[anim_ux:popout] Panels.timeline.container/node が見つからない')
		return
	}

	// 元位置を記憶 (= 確実に戻すため)
	const originParent = node.parentElement
	const originNext = node.nextSibling

	const win = window.open('about:blank', 'anim_ux_timeline_popout', 'width=1000,height=340')
	if (!win) {
		console.warn('[anim_ux:popout] window.open が blocked / null')
		return
	}
	popoutWin = win

	// 子 document の最小初期化 (= about:blank が body を持たない場合に備える)
	if (!win.document.body) {
		win.document.write('<!DOCTYPE html><html><head></head><body></body></html>')
		win.document.close()
	}
	win.document.title = 'Blockbench Timeline'
	// BB の theme CSS 変数は body の class に紐づくので移植
	win.document.body.className = document.body.className
	win.document.body.style.margin = '0'
	win.document.body.style.overflow = 'hidden'
	// BB の panel は flex で grow する前提。 子窓 body を flex container にして自然サイズで伸ばす。
	// (= 旧版で panelNode.style.width に clientWidth を直書きしてたが、 about:blank 直後の
	//    clientWidth が不安定で width=0px になる事故あり。 CSS に任せる)
	win.document.body.style.display = 'flex'
	win.document.body.style.flexDirection = 'column'
	win.document.body.style.height = '100vh'
	win.document.body.style.width = '100vw'
	copyStyles(win.document)

	// TIMELINE DOM を子窓へ引っ越し (= Vue インスタンスは親に残る)
	try {
		const adopted = win.document.adoptNode(node)
		win.document.body.appendChild(adopted)
	} catch (e) {
		console.warn('[anim_ux:popout] adoptNode failed', e)
		try { win.close() } catch { /* noop */ }
		popoutWin = null
		return
	}

	// 3 段重ね hack で BB 本体の DOM 検索 + drag handler を子窓に届かせる :
	//   1. $('#timeline_*') hook
	//   2. document.getElementById('timeline_*') hook
	//   3. mouse/touch/keyboard continuation event を子窓 → 親 document に proxy
	const revertJquery = installJqueryFallback(win)
	const revertGetById = installGetElementByIdFallback(win)
	const revertProxy = installEventProxy(win)
	// 4 段目 = anim_ux 独自 listener (= toggles / breadcrumb / search) も子窓 document に複製 attach。
	//          (= 各 module は addDocumentListener 経由で登録済、 ここで child 切替えるだけで透過的に拾える)
	bindPopoutChild(win.document)

	// 子窓 resize で TIMELINE container と中身 (= timeline_vue 等) を子窓サイズに追従させる。
	//
	// 真因 : BB の Panel.update() (= panels.ts:983-986、 slot == 'bottom') は
	//   `Interface.work_screen.clientWidth - left_bar_width - right_bar_width` を計算して
	//   `container.style.width` に **inline で書き込む**。 popout 中は親 BB の幅に倒され、
	//   子窓 innerWidth に追従しない (= ヘッダー / filter bar が中央で切れる症状)。
	// 対処 : panel.update() を呼ばず、 container 自身の inline style に popout 子窓の
	//   innerWidth/Height を直接書き込む。 同時に Panel.width / Panel.height (= 内部 state)
	//   も合わせ、 Timeline.updateSize() で vue 内部 (= timeline_vue の timecodes) を reflow させる。
	//
	// 加えて、 BB は親 window resize / sidebar 操作 / Vue reactive 経由で勝手に Panel.update() を
	// 呼ぶことがあり、 そのたびに container.style.width が親 BB 幅で上書きされる。 child resize
	// event だけでは worst case を救えないので、 MutationObserver で container の style 属性を
	// 監視 → 外部書き換えに即反応して再 applyPopoutSize() する保険を張る。 自分自身の mutation は
	// takeRecords() で捨てて無限ループを防止 (= Codex + GLM 並列指摘の race condition 対策)。
	let styleGuard: MutationObserver | null = null
	const applyPopoutSize = (): void => {
		if (popoutWin?.closed !== false) return
		if (P?.container) {
			P.container.style.width = popoutWin.innerWidth + 'px'
			P.container.style.height = popoutWin.innerHeight + 'px'
			P.width = popoutWin.innerWidth
			P.height = popoutWin.innerHeight
			// 自分の書き込みで MutationObserver が再 fire するのを抑える (= 無限ループ防止)
			styleGuard?.takeRecords()
		}
		try {
			(typeof Timeline !== 'undefined' ? Timeline : undefined)?.updateSize?.()
		} catch (e) {
			console.warn('[anim_ux:popout] Timeline.updateSize on resize failed', e)
		}
	}
	const onChildResize = (): void => applyPopoutSize()
	win.addEventListener('resize', onChildResize)
	// container.style 監視 = 親 BB 経路の上書きを即時打ち消す保険 (= styleGuard で前置)
	styleGuard = new MutationObserver(() => applyPopoutSize())
	if (P?.container) {
		styleGuard.observe(P.container, { attributes: true, attributeFilter: ['style'] })
	}
	// popout 直後の初回 sync (= adoptNode 完了後の dimensions を子窓サイズに揃える)
	applyPopoutSize()

	let restored = false
	restoreFn = (): void => {
		if (restored) return
		restored = true
		// anim_ux 独自 listener を子窓から detach (= 親への登録は保持、 popout 終了で透過的に戻る)
		try { bindPopoutChild(null) } catch { /* noop */ }
		// close polling を止める (= restoreFn が同経路から呼ばれることもあるので idempotent)
		stopClosePoll()
		try { win.removeEventListener('resize', onChildResize) } catch { /* noop */ }
		// container.style 監視 observer も解除 (= restore 中の最終 update() で発火するのを防ぐ)
		try { styleGuard?.disconnect() } catch { /* noop */ }
		styleGuard = null
		try { revertProxy() } catch { /* noop */ }
		try { revertGetById() } catch { /* noop */ }
		try {
			revertJquery()
		} catch { /* noop */ }
		try {
			const back = document.adoptNode(node)
			if (originParent) {
				if (originNext && originNext.parentNode === originParent) {
					originParent.insertBefore(back, originNext)
				} else {
					originParent.appendChild(back)
				}
			} else {
				document.body.appendChild(back)
			}
		} catch (e) {
			console.warn('[anim_ux:popout] restore failed', e)
		}
		// popout 中に container に書き込んだ子窓 dimensions を解除して、
		// 親 BB の Panel.update() に再計算させる (= work_screen 幅で再 sizing)。
		try {
			if (P?.container) {
				P.container.style.width = ''
				P.container.style.height = ''
			}
			P?.update?.()
		} catch (e) {
			console.warn('[anim_ux:popout] panel reflow on restore failed', e)
		}
		popoutWin = null
		restoreFn = null
	}

	// 子窓が手動で閉じられたら親に戻す (= 戻さないと TIMELINE が消失する)
	win.addEventListener('beforeunload', () => {
		if (restoreFn) restoreFn()
	})

	// beforeunload は renderer crash / 強制破棄 / 別タブ経由の close では発火しない。
	// 1s 間隔で popoutWin.closed を polling して、 漏れた close を拾って restoreFn() を呼ぶ保険。
	// restoreFn 内で clearInterval するので、 通常 close では即停止する (= idle cost ほぼゼロ)。
	const closePollHandle = setInterval((): void => {
		if (!popoutWin || popoutWin.closed) {
			clearInterval(closePollHandle)
			if (restoreFn) restoreFn()
		}
	}, 1000)
	const stopClosePoll = (): void => {
		try { clearInterval(closePollHandle) } catch { /* noop */ }
	}

	console.log('[anim_ux:popout] timeline popped out (call ajRestoreTimeline() to bring it back)')
}

export function restoreTimeline(): void {
	if (popoutWin && !popoutWin.closed) {
		try {
			popoutWin.close()
		} catch {
			/* noop */
		}
	}
	if (restoreFn) restoreFn()
}

// popout 中なら restore、 そうでなければ popout。 Action からも console からも同じ口で叩ける。
function togglePopoutTimeline(): void {
	if (popoutWin && !popoutWin.closed) restoreTimeline()
	else popoutTimeline()
}

export function installTimelinePopout(): () => void {
	// console からも呼べるよう global に出す (= デバッグ用、 メニュー Action 登場後も維持)
	const g = window as unknown as { ajPopoutTimeline?: () => void; ajRestoreTimeline?: () => void }
	g.ajPopoutTimeline = popoutTimeline
	g.ajRestoreTimeline = restoreTimeline

	// Animation menu に「Anim UX: Detach Timeline」 を追加。 同 Action で popout / restore を切替える。
	// onionSkin の登録パターン踏襲、 shortcut は付けない (= 操作頻度が低いので衝突回避)。
	let toggleAction: { delete(): void } | undefined
	if (typeof Action !== 'undefined') {
		toggleAction = new Action('anim_ux_toggle_timeline_popout', {
			name: 'Anim UX: Detach Timeline',
			description: 'Move the TIMELINE panel into a separate window (toggle to restore)',
			icon: 'open_in_new',
			category: 'animation',
			click: togglePopoutTimeline,
		})
		const animationMenu = (typeof MenuBar !== 'undefined' ? MenuBar : undefined)?.menus?.animation
		animationMenu?.addAction(toggleAction)
	}

	return (): void => {
		// plugin unload 時は必ず TIMELINE を親に戻す (= 引っ越したまま消えるのを防ぐ)
		restoreTimeline()
		if (toggleAction) {
			const animationMenu = (typeof MenuBar !== 'undefined' ? MenuBar : undefined)?.menus?.animation
			try { animationMenu?.removeAction(toggleAction) } catch { /* noop */ }
			try { toggleAction.delete() } catch (e) {
				console.warn('[anim_ux:popout] toggle action delete failed', e)
			}
		}
		try {
			delete g.ajPopoutTimeline
			delete g.ajRestoreTimeline
		} catch {
			/* noop */
		}
	}
}
