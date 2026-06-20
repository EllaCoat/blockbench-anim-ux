// blockbench-anim-ux — Animator panel への filter bar inject 基盤
//
// 役割 :
//   - Panels.timeline.node 内の #timeline_body_inner を MutationObserver で監視
//   - filter bar (= search input + toggle 4 個 = keyframesOnly / onlySelected / abLoop / onionSkin)
//     を 1 回だけ inject、 unload 時に remove
//   - applyFilter() で全 <li class="animator"> に CSS display toggle を当てる
//   - filter state は module level に保持し、 後続の search / toggles ファイルから書き換えて再描画
//   - abLoop / onionSkin は filter ではなく動作系 toggle、 同じ state に乗せて UI を統一

declare const Panels: { timeline?: { node?: HTMLElement } } | undefined
// OutlinerNode.uuids は Group / NullObject / Locator / VanillaItemDisplay 等を含む全 outliner node の uuid → node map
// (= Group.all は Group 型のみで、 AJ 拡張型を拾いたいときは OutlinerNode 経由が筋)
declare const OutlinerNode:
	| { uuids: Record<string, { selected?: boolean } | undefined> }
	| undefined
declare const Timeline:
	| {
			animators: Array<{
				uuid: string
				position?: unknown[]
				rotation?: unknown[]
				scale?: unknown[]
			}>
	  }
	| undefined

// filter bar 上の toggle 群の状態。 純粋なフィルタリング (= keyframesOnly / onlySelected) に加え、
// 動作系 toggle (= abLoop / onionSkin) も同じ state に乗せて UI ロジックを単純化している。
export interface FilterState {
	query: string
	keyframesOnly: boolean
	onlySelected: boolean
	abLoop: boolean
	onionSkin: boolean
}

const STYLE_ID = 'anim-ux-style'
const BAR_CLASS = 'anim-ux-bar'
const SEARCH_CLASS = 'anim-ux-search'
const TOGGLE_CLASS = 'anim-ux-toggle'
const AB_STATUS_CLASS = 'anim-ux-ab-status'

const CSS = `
.${BAR_CLASS} {
	display: flex;
	gap: 4px;
	padding: 4px 6px;
	border-bottom: 1px solid var(--color-border);
	background: var(--color-back);
	align-items: center;
	position: sticky;
	top: 0;
	z-index: 5;
}
.${SEARCH_CLASS} {
	flex: 1;
	min-width: 80px;
	padding: 2px 6px;
	background: var(--color-button);
	color: var(--color-text);
	border: 1px solid var(--color-border);
	border-radius: 2px;
	font-size: 12px;
}
.${TOGGLE_CLASS} {
	display: flex;
	align-items: center;
	justify-content: center;
	/* BB の setup.css は素の <button> に min-width:100px / padding-left/right:16px / box-shadow を
	   付けてくるので、 class specificity で勝っても width 指定が min-width に負けて 100px 表示になる。
	   ここで明示的に打ち消す。 height は class > element specificity で 24px が効いてる。 */
	width: 24px;
	height: 24px;
	min-width: 0;
	/* min-width:0 で BB の min-width:100 は打ち消せるが、 副作用として flex shrink が
	   発動して timeline 横幅が狭い時 24px 未満に潰れる可能性。 flex 固定で予防 (= Codex 後段 fix 反映)。 */
	flex: 0 0 24px;
	padding: 0;
	box-shadow: none;
	background: transparent;
	color: var(--color-text);
	border: 1px solid transparent;
	border-radius: 2px;
	cursor: pointer;
}
.${TOGGLE_CLASS}:hover {
	background: var(--color-button);
}
.${TOGGLE_CLASS}.active {
	background: var(--color-accent);
	color: var(--color-accent_text, white);
}
.${TOGGLE_CLASS} i {
	font-size: 16px;
	/* setup.css の "button > i" rule の margin-right:4px を打ち消し (= 余白 4px 残ると button 幅が広がる) */
	margin: 0;
}

/* breadcrumb tooltip — span 自身の pointer-events を復活させて、 mouseover を JS 側で拾えるようにする。
   BB の panels.css 内 ".channel_head span.timeline_animator_name { pointer-events: none; }"
   が hover event 自体を全て無効化していたため、 これを auto で上書き。
   tooltip 表示自体は breadcrumb.ts 側で document.body 直下に position: fixed で行う
   (= timeline panel 内の stacking context を回避して、 他 panel の裏にも回り込まないように)。 */
.timeline_animator_name[data-anim-ux-breadcrumb] {
	pointer-events: auto !important;
}

/* A-B loop status — filter bar 右端に「A:0f B:20f」 を muted text で frame 表記表示。
   loopStart / loopEnd が undefined のときは "—" (= ダッシュ) を表示。 abLoop.ts 側で更新。 */
.${AB_STATUS_CLASS} {
	font-size: 11px;
	color: var(--color-subtle_text, #888);
	white-space: nowrap;
	margin-left: 4px;
	font-family: var(--font-code, monospace);
}
`

export const filterState: FilterState = {
	query: '',
	keyframesOnly: false,
	onlySelected: false,
	abLoop: false,
	onionSkin: false,
}

const FILTER_DEFAULTS: FilterState = {
	query: '',
	keyframesOnly: false,
	onlySelected: false,
	abLoop: false,
	onionSkin: false,
}

let installedBar: HTMLElement | undefined
let observer: MutationObserver | undefined
let pendingRefreshHandle: number | undefined

const refreshCallbacks: Array<() => void> = []

export function registerRefreshCallback(cb: () => void): () => void {
	refreshCallbacks.push(cb)
	return () => {
		const i = refreshCallbacks.indexOf(cb)
		if (i >= 0) refreshCallbacks.splice(i, 1)
	}
}

function injectStyleOnce(): void {
	if (document.getElementById(STYLE_ID)) return
	const style = document.createElement('style')
	style.id = STYLE_ID
	style.textContent = CSS
	document.head.appendChild(style)
}

function buildBar(): HTMLElement {
	const bar = document.createElement('div')
	bar.className = BAR_CLASS

	const search = document.createElement('input')
	search.type = 'text'
	search.className = SEARCH_CLASS
	search.placeholder = 'Search animators...'
	search.value = filterState.query
	search.dataset.role = 'search'
	bar.appendChild(search)

	const toggles: Array<[keyof FilterState, string, string]> = [
		['keyframesOnly', 'filter_alt', 'Show only animators with keyframes in this animation'],
		['onlySelected', 'link', 'Sync with 3D selection'],
		['abLoop', 'loop', 'A-B loop playback (Alt+Shift+A/B set, Alt+Shift+L toggle, Alt+Shift+X clear)'],
		['onionSkin', 'layers', 'Onion Skin: show selected group ±1 frame ghosts'],
	]
	for (const [key, icon, title] of toggles) {
		const btn = document.createElement('button')
		btn.className = TOGGLE_CLASS
		btn.title = title
		btn.dataset.key = key
		if (filterState[key]) btn.classList.add('active')
		btn.innerHTML = `<i class="material-icons">${icon}</i>`
		bar.appendChild(btn)
	}

	// A-B loop の current state 表示用 span (= 内容は abLoop.ts 側から更新)。
	// 最初は "—" のダッシュ表示、 set されたら "A:0f B:20f" 形式 (= frame 後置) に書き換わる。
	const abStatus = document.createElement('span')
	abStatus.className = AB_STATUS_CLASS
	abStatus.textContent = '—'
	bar.appendChild(abStatus)

	return bar
}

export function findAnimatorList(): HTMLElement | undefined {
	const node = (typeof Panels !== 'undefined' ? Panels : undefined)?.timeline?.node
	if (!node) return undefined
	return (node.querySelector('#timeline_body_inner') as HTMLElement | null) ?? undefined
}

// filter bar は `#timeline_vue` の直前 (= panel body 最上部、 timecode より上、 横スクロール対象外)
// に挿入する。 #timeline_body_inner 内に置くと横スクロールに巻き込まれて toggle が画面外に追い出される。
function findBarInsertionPoint(): { container: HTMLElement; before: Element } | undefined {
	const node = (typeof Panels !== 'undefined' ? Panels : undefined)?.timeline?.node
	if (!node) return undefined
	const timelineVue = node.querySelector<HTMLElement>('#timeline_vue')
	if (!timelineVue?.parentElement) return undefined
	return { container: timelineVue.parentElement, before: timelineVue }
}

function ensureBarInPlace(): void {
	const ip = findBarInsertionPoint()
	if (!ip) return
	if (installedBar && installedBar.parentElement === ip.container && installedBar.nextSibling === ip.before) {
		return
	}
	if (!installedBar) installedBar = buildBar()
	ip.container.insertBefore(installedBar, ip.before)
}

function collectSelectedNodeUuids(): Set<string> {
	const set = new Set<string>()
	const uuids = (typeof OutlinerNode !== 'undefined' ? OutlinerNode : undefined)?.uuids
	if (!uuids) return set
	for (const uuid in uuids) {
		if (uuids[uuid]?.selected) set.add(uuid)
	}
	return set
}

// state を読んで全 animator row に display を当て直す。
// search / toggles / selection sync から呼ばれる。
// keyframesOnly 時の lookup は事前に Map をビルドして O(rows + animators) に。
export function applyFilter(): void {
	const list = findAnimatorList()
	if (!list) return
	const q = filterState.query.trim().toLowerCase()
	const selectedUuids = filterState.onlySelected ? collectSelectedNodeUuids() : undefined

	let keyframeMap: Map<string, boolean> | undefined
	if (filterState.keyframesOnly) {
		keyframeMap = new Map()
		const all = (typeof Timeline !== 'undefined' ? Timeline : undefined)?.animators ?? []
		for (const a of all) {
			const has =
				((a.position?.length ?? 0) + (a.rotation?.length ?? 0) + (a.scale?.length ?? 0)) > 0
			keyframeMap.set(a.uuid, has)
		}
	}

	const rows = list.querySelectorAll<HTMLElement>('li.animator')
	for (const row of rows) {
		const nameEl = row.querySelector<HTMLElement>('.timeline_animator_name')
		const name = nameEl?.textContent?.trim().toLowerCase() ?? ''
		const uuid = row.getAttribute('uuid') ?? ''

		let visible = true
		if (q && !name.includes(q)) visible = false
		if (keyframeMap && !keyframeMap.get(uuid)) visible = false
		if (selectedUuids && !selectedUuids.has(uuid)) visible = false

		row.style.display = visible ? '' : 'none'
	}
}

// MutationObserver の発火連発を rAF に集約 (= 60 fps 上限)。
// handle を保持して cleanup 時に cancelAnimationFrame できるようにする
// (= unload 後に queued frame が走って bar を復活させるのを防ぐ)。
function scheduleRefresh(): void {
	if (pendingRefreshHandle !== undefined) return
	pendingRefreshHandle = requestAnimationFrame(() => {
		pendingRefreshHandle = undefined
		ensureBarInPlace()
		applyFilter()
		for (const cb of refreshCallbacks) {
			try {
				cb()
			} catch (e) {
				console.warn('[anim_ux] refresh callback failed', e)
			}
		}
	})
}

export function installAnimatorPanelUI(): () => void {
	injectStyleOnce()
	ensureBarInPlace()

	observer = new MutationObserver(() => scheduleRefresh())
	observer.observe(document.body, { childList: true, subtree: true })

	return () => {
		observer?.disconnect()
		observer = undefined

		// queued rAF を確実に止める (= cleanup 後に bar / 装飾が復活するのを防ぐ)
		if (pendingRefreshHandle !== undefined) {
			cancelAnimationFrame(pendingRefreshHandle)
			pendingRefreshHandle = undefined
		}

		// hidden 残留を防ぐため、 全 row の display を初期化してから bar を抜く。
		const list = findAnimatorList()
		if (list) {
			const rows = list.querySelectorAll<HTMLElement>('li.animator')
			for (const row of rows) row.style.display = ''
		}

		// filter state も初期値に戻す (= disable → enable で古い state が復活しないように)
		filterState.query = FILTER_DEFAULTS.query
		filterState.keyframesOnly = FILTER_DEFAULTS.keyframesOnly
		filterState.onlySelected = FILTER_DEFAULTS.onlySelected
		filterState.abLoop = FILTER_DEFAULTS.abLoop
		filterState.onionSkin = FILTER_DEFAULTS.onionSkin

		installedBar?.remove()
		installedBar = undefined
		document.getElementById(STYLE_ID)?.remove()
	}
}
