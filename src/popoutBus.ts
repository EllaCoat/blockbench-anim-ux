// blockbench-anim-ux — popout-aware document listener helper
//
// 役割 :
//   - 親 document に登録した event listener を、 popout 中 (= TIMELINE が別 window に居る間) は子窓 document にも自動で attach する
//   - 各機能 module (toggles / breadcrumb / search 等) は addDocumentListener を呼ぶだけ、 popout の存在を意識しない
//
// 背景 :
//   - timelinePopout で TIMELINE container を子窓に adoptNode 移植している
//   - anim_ux 自身の click / mouseover / input handler は親 document に capture 登録 (= toggles.ts:72 等)
//   - 子窓でトグルクリックしても親には click event 来ない → 子窓内では handler 発火せず無反応
//   - 個別 module を popout 認識にする代わりに、 listener 登録 helper に集約して透過的に解決
//
// 設計 :
//   - addDocumentListener(type, fn, opts) は親 document に登録、 popout 中なら子窓にも attach、 cleanup 関数を返す
//   - bindPopoutChild(doc) で「現在の子窓 document」 を差し替え、 登録済 listener を旧子窓から detach + 新子窓に attach
//   - bindPopoutChild(null) で全て親に戻す (= popout 終了時)

interface Listener {
	type: string
	fn: EventListenerOrEventListenerObject
	opts?: boolean | AddEventListenerOptions
}

const listeners = new Set<Listener>()
let childDoc: Document | null = null

// popout 中は親 + 子窓の両方を、 そうでなければ親のみを返す。
// query / id lookup を「popout の存在を意識しない側」 から透過的に使うための土台。
// 異常系 (= 子窓 crash / 強制 close で bindPopoutChild(null) が呼ばれない) に対する保険として、
// 呼び出し時に childDoc の owner window が closed なら自動で null に倒す (= Codex 指摘の stale childDoc 対策)。
export function getDocuments(): Document[] {
	if (childDoc) {
		const win = childDoc.defaultView
		if (win == null || win.closed) {
			childDoc = null
			return [document]
		}
		return [document, childDoc]
	}
	return [document]
}

// 親 + 子窓を横断して querySelectorAll した結果を配列化して返す。
// (= toggles の active 反映や、 anim_ux UI 全般の「現在表示されている全要素」 を拾う用途)
export function queryAllInDocs<T extends Element = HTMLElement>(selector: string): T[] {
	const out: T[] = []
	for (const doc of getDocuments()) {
		for (const el of Array.from(doc.querySelectorAll<T>(selector))) out.push(el)
	}
	return out
}

// 親 → 子窓の順に getElementById で探して、 最初に見つかったものを返す。
// timeline 系の DOM (= `timeline_body_inner` 等) は同 id を片方にしか持たない前提なので、
// queryAll するより first-hit の方が意図に合う (= マーカー attach 先の取得用)。
export function findElementByIdInDocs(id: string): HTMLElement | null {
	for (const doc of getDocuments()) {
		const el = doc.getElementById(id)
		if (el) return el
	}
	return null
}

export function addDocumentListener(
	type: string,
	fn: EventListenerOrEventListenerObject,
	opts?: boolean | AddEventListenerOptions,
): () => void {
	document.addEventListener(type, fn, opts)
	if (childDoc) {
		try {
			childDoc.addEventListener(type, fn, opts)
		} catch (e) {
			console.warn(`[anim_ux:popoutBus] child addEventListener(${type}) failed`, e)
		}
	}
	const entry: Listener = { type, fn, opts }
	listeners.add(entry)
	return (): void => {
		try {
			document.removeEventListener(type, fn, opts)
		} catch {
			/* noop */
		}
		if (childDoc) {
			try {
				childDoc.removeEventListener(type, fn, opts)
			} catch {
				/* noop */
			}
		}
		listeners.delete(entry)
	}
}

export function bindPopoutChild(doc: Document | null): void {
	// 旧子窓があれば全 listener を detach (= popout 状態遷移、 リソースリーク防止)
	if (childDoc && childDoc !== doc) {
		for (const l of listeners) {
			try {
				childDoc.removeEventListener(l.type, l.fn, l.opts)
			} catch {
				/* noop */
			}
		}
	}
	childDoc = doc
	// 新子窓があれば全登録済 listener を attach (= popout 中に登録された分も popout 前に登録された分も両方拾う)
	if (doc) {
		for (const l of listeners) {
			try {
				doc.addEventListener(l.type, l.fn, l.opts)
			} catch (e) {
				console.warn(`[anim_ux:popoutBus] bind child(${l.type}) failed`, e)
			}
		}
	}
}
