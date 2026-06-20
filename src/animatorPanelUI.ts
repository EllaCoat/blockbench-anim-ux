// blockbench-anim-ux — Animator panel への filter bar inject 基盤
//
// 役割 :
//   - Panels.timeline.node 内の #timeline_body_inner を MutationObserver で監視
//   - filter bar (= search input + toggle 2 個) を 1 回だけ inject、 unload 時に remove
//   - applyFilter() で全 <li class="animator"> に CSS display toggle を当てる
//   - filter state は module level に保持し、 後続の search / toggles ファイルから書き換えて再描画

declare const Panels: { timeline?: { node?: HTMLElement } } | undefined
declare const Group: { all: Array<{ uuid: string; selected: boolean }> } | undefined
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

export interface FilterState {
	query: string
	keyframesOnly: boolean
	onlySelected: boolean
}

const STYLE_ID = 'anim-ux-style'
const BAR_CLASS = 'anim-ux-bar'
const SEARCH_CLASS = 'anim-ux-search'
const TOGGLE_CLASS = 'anim-ux-toggle'

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
	width: 24px;
	height: 24px;
	background: transparent;
	color: var(--color-text);
	border: 1px solid transparent;
	border-radius: 2px;
	cursor: pointer;
	padding: 0;
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
}
`

export const filterState: FilterState = {
	query: '',
	keyframesOnly: false,
	onlySelected: false,
}

const FILTER_DEFAULTS: FilterState = {
	query: '',
	keyframesOnly: false,
	onlySelected: false,
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

function collectSelectedGroupUuids(): Set<string> {
	const set = new Set<string>()
	const all = (typeof Group !== 'undefined' ? Group : undefined)?.all
	if (!all) return set
	for (const g of all) {
		if (g.selected) set.add(g.uuid)
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
	const selectedUuids = filterState.onlySelected ? collectSelectedGroupUuids() : undefined

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

// filter bar 本体を取り出すヘルパー (= search / toggles からイベント attach 用)
export function getInstalledBar(): HTMLElement | undefined {
	return installedBar
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

		installedBar?.remove()
		installedBar = undefined
		document.getElementById(STYLE_ID)?.remove()
	}
}
