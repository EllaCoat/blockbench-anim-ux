// blockbench-anim-ux — Animator panel への filter bar inject 基盤
//
// 役割 :
//   - Panels.timeline.node 内の #timeline_body_inner を MutationObserver で監視
//   - filter bar (= search input + toggle 2 個) を 1 回だけ inject、 unload 時に remove
//   - applyFilter() で全 <li class="animator"> に CSS display toggle を当てる
//   - filter state は module level に保持し、 後続の search / toggles ファイルから書き換えて再描画

declare const Panels: { timeline?: { node?: HTMLElement } } | undefined

export interface FilterState {
	query: string
	keyframesOnly: boolean
	onlySelected: boolean
}

const STYLE_ID = 'anim-ux-style'
const BAR_CLASS = 'anim-ux-bar'
const SEARCH_CLASS = 'anim-ux-search'
const TOGGLE_CLASS = 'anim-ux-toggle'

// BB 標準の CSS 変数を流用して theme 追従させる。 element の見た目は最小限に。
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

let installedBar: HTMLElement | undefined
let observer: MutationObserver | undefined

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

function ensureBarInPlace(): void {
	const list = findAnimatorList()
	if (!list) return
	if (installedBar && list.firstChild === installedBar) return
	if (!installedBar) installedBar = buildBar()
	list.prepend(installedBar)
}

// state を読んで全 animator row に display を当て直す。
// search / toggles / selection sync から呼ばれる。 段階 1 では query のみ評価。
export function applyFilter(): void {
	const list = findAnimatorList()
	if (!list) return
	const q = filterState.query.trim().toLowerCase()
	const rows = list.querySelectorAll<HTMLElement>('li.animator')
	for (const row of rows) {
		const nameEl = row.querySelector<HTMLElement>('.timeline_animator_name')
		const name = nameEl?.textContent?.trim().toLowerCase() ?? ''
		let visible = true
		if (q && !name.includes(q)) visible = false
		// keyframesOnly / onlySelected は後段ファイルで実装、 ここでは未評価
		row.style.display = visible ? '' : 'none'
	}
}

// filter bar 本体を取り出すヘルパー (= search / toggles からイベント attach 用)
export function getInstalledBar(): HTMLElement | undefined {
	return installedBar
}

export function installAnimatorPanelUI(): () => void {
	injectStyleOnce()
	ensureBarInPlace()

	// timeline panel は Vue の再描画 / Project 切替で再生成され得る。
	// document.body 全体を観察するが、 動作は ensureBarInPlace のべき等チェックで重複 inject を防ぐ。
	// 再描画後の新規 row にも filter を再適用するため applyFilter も呼ぶ (= state は維持される)。
	observer = new MutationObserver(() => {
		ensureBarInPlace()
		applyFilter()
	})
	observer.observe(document.body, { childList: true, subtree: true })

	return () => {
		observer?.disconnect()
		observer = undefined
		installedBar?.remove()
		installedBar = undefined
		document.getElementById(STYLE_ID)?.remove()
	}
}
