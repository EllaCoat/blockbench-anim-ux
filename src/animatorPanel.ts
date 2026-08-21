import { forceRefreshOnionSkin } from './onionSkin'
import {
	addTimelineDocumentListener,
	getTimelineDocuments,
	queryTimelineDocuments,
} from './timelineWindow'

declare const Panels: { timeline?: { node?: HTMLElement } } | undefined
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
declare const Blockbench:
	| { on(event: string, callback: () => void): void; removeListener(event: string, callback: () => void): void }
	| undefined

export interface FilterState {
	query: string
	keyframesOnly: boolean
	onlySelected: boolean
	abLoop: boolean
	onionSkin: boolean
}

export const filterState: FilterState = {
	query: '',
	keyframesOnly: false,
	onlySelected: false,
	abLoop: false,
	onionSkin: false,
}

const FILTER_DEFAULTS: FilterState = { ...filterState }
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
 width: 24px;
 height: 24px;
 min-width: 0;
 flex: 0 0 24px;
 padding: 0;
 box-shadow: none;
 background: transparent;
 color: var(--color-text);
 border: 1px solid transparent;
 border-radius: 2px;
 cursor: pointer;
}
.${TOGGLE_CLASS}:hover { background: var(--color-button); }
.${TOGGLE_CLASS}.active {
 background: var(--color-accent);
 color: var(--color-accent_text, white);
}
.${TOGGLE_CLASS} i { font-size: 16px; margin: 0; }
.timeline_animator_name[data-anim-ux-breadcrumb] { pointer-events: auto !important; }
.${AB_STATUS_CLASS} {
 font-size: 11px;
 color: var(--color-subtle_text, #888);
 white-space: nowrap;
 margin-left: 4px;
 font-family: var(--font-code, monospace);
}
`

type ToggleKey = Exclude<keyof FilterState, 'query'>
const TOGGLE_KEYS: ToggleKey[] = ['keyframesOnly', 'onlySelected', 'abLoop', 'onionSkin']
const refreshCallbacks = new Set<() => void>()
const toggleEffects = new Map<ToggleKey, Set<(enabled: boolean) => void>>()

let installedBar: HTMLElement | undefined
let observer: MutationObserver | undefined
let pendingRefreshHandle: number | undefined
let selectionAttached = false
let installed = false

const onSelectionChanged = (): void => applyFilter()

function startSelectionWatch(): void {
	if (selectionAttached) return
	Blockbench?.on('update_selection', onSelectionChanged)
	selectionAttached = true
}

function stopSelectionWatch(): void {
	if (!selectionAttached) return
	Blockbench?.removeListener('update_selection', onSelectionChanged)
	selectionAttached = false
}

function timelineNode(): HTMLElement | undefined {
	return (typeof Panels !== 'undefined' ? Panels : undefined)?.timeline?.node
}

export function registerRefreshCallback(callback: () => void): () => void {
	refreshCallbacks.add(callback)
	return () => refreshCallbacks.delete(callback)
}

export function registerToggleEffect(key: ToggleKey, effect: (enabled: boolean) => void): () => void {
	let effects = toggleEffects.get(key)
	if (!effects) {
		effects = new Set()
		toggleEffects.set(key, effects)
	}
	effects.add(effect)
	return () => {
		effects?.delete(effect)
		if (effects?.size === 0) toggleEffects.delete(key)
	}
}

function notifyToggleEffects(key: ToggleKey, enabled: boolean): void {
	for (const effect of toggleEffects.get(key) ?? []) {
		try { effect(enabled) } catch (error) { console.warn(`[anim_ux] ${key} effect failed`, error) }
	}
}

function injectStyle(documentForStyle: Document): void {
	if (documentForStyle.getElementById(STYLE_ID)) return
	const style = documentForStyle.createElement('style')
	style.id = STYLE_ID
	style.textContent = CSS
	documentForStyle.head.appendChild(style)
}

function buildBar(documentForBar: Document): HTMLElement {
	const bar = documentForBar.createElement('div')
	bar.className = BAR_CLASS
	const search = documentForBar.createElement('input')
	search.type = 'text'
	search.className = SEARCH_CLASS
	search.placeholder = 'Search animators...'
	search.value = filterState.query
	search.dataset.role = 'search'
	bar.appendChild(search)
	const toggles: Array<[ToggleKey, string, string]> = [
		['keyframesOnly', 'filter_alt', 'Show only animators with keyframes in this animation'],
		['onlySelected', 'link', 'Sync with 3D selection'],
		['abLoop', 'loop', 'A-B loop playback (Alt+Shift+A/B set, Alt+Shift+L toggle, Alt+Shift+X clear)'],
		['onionSkin', 'layers', 'Onion Skin: show selected group ±1 frame ghosts'],
	]
	for (const [key, icon, title] of toggles) {
		const button = documentForBar.createElement('button')
		button.className = TOGGLE_CLASS
		button.title = title
		button.dataset.key = key
		button.innerHTML = `<i class="material-icons">${icon}</i>`
		bar.appendChild(button)
	}
	const status = documentForBar.createElement('span')
	status.className = AB_STATUS_CLASS
	status.textContent = '—'
	bar.appendChild(status)
	return bar
}

export function findAnimatorList(): HTMLElement | undefined {
	return timelineNode()?.querySelector<HTMLElement>('#timeline_body_inner') ?? undefined
}

function findBarInsertionPoint(): { container: HTMLElement; before: Element } | undefined {
	const node = timelineNode()
	const timelineVue = node?.querySelector<HTMLElement>('#timeline_vue')
	if (!timelineVue?.parentElement) return undefined
	return { container: timelineVue.parentElement, before: timelineVue }
}

function ensureBarInPlace(): void {
	const insertionPoint = findBarInsertionPoint()
	if (!insertionPoint) return
	if (installedBar && installedBar.parentElement === insertionPoint.container && installedBar.nextSibling === insertionPoint.before) return
	if (!installedBar) installedBar = buildBar(insertionPoint.container.ownerDocument)
	insertionPoint.container.insertBefore(installedBar, insertionPoint.before)
}

function selectedNodeUuids(): Set<string> {
	const selected = new Set<string>()
	const uuids = (typeof OutlinerNode !== 'undefined' ? OutlinerNode : undefined)?.uuids
	if (!uuids) return selected
	for (const uuid in uuids) if (uuids[uuid]?.selected) selected.add(uuid)
	return selected
}

export function applyFilter(): void {
	const list = findAnimatorList()
	if (!list) return
	const query = filterState.query.trim().toLowerCase()
	const selected = filterState.onlySelected ? selectedNodeUuids() : undefined
	let keyframes: Map<string, boolean> | undefined
	if (filterState.keyframesOnly) {
		keyframes = new Map()
		for (const animator of (typeof Timeline !== 'undefined' ? Timeline : undefined)?.animators ?? []) {
			keyframes.set(animator.uuid, (animator.position?.length ?? 0) + (animator.rotation?.length ?? 0) + (animator.scale?.length ?? 0) > 0)
		}
	}
	for (const row of list.querySelectorAll<HTMLElement>('li.animator')) {
		const name = row.querySelector<HTMLElement>('.timeline_animator_name')?.textContent?.trim().toLowerCase() ?? ''
		const uuid = row.getAttribute('uuid') ?? ''
		const visible = (!query || name.includes(query)) && (!keyframes || keyframes.get(uuid) === true) && (!selected || selected.has(uuid))
		row.style.display = visible ? '' : 'none'
	}
}

export function syncToggleVisuals(): void {
	for (const button of queryTimelineDocuments<HTMLElement>(`.${TOGGLE_CLASS}`)) {
		const key = button.dataset.key as ToggleKey | undefined
		if (key && TOGGLE_KEYS.includes(key)) button.classList.toggle('active', filterState[key])
	}
}

function scheduleRefresh(): void {
	if (pendingRefreshHandle !== undefined) return
	pendingRefreshHandle = requestAnimationFrame(() => {
		pendingRefreshHandle = undefined
		ensureBarInPlace()
		applyFilter()
		syncToggleVisuals()
		for (const callback of refreshCallbacks) {
			try { callback() } catch (error) { console.warn('[anim_ux] refresh callback failed', error) }
		}
	})
}

function installPanelUI(): () => void {
	const node = timelineNode()
	const documents = getTimelineDocuments()
	for (const documentForStyle of documents) injectStyle(documentForStyle)
	if (node) {
		injectStyle(node.ownerDocument)
		ensureBarInPlace()
		observer = new MutationObserver(scheduleRefresh)
		observer.observe(node, { childList: true, subtree: true })
	}
	return () => {
		observer?.disconnect()
		observer = undefined
		if (pendingRefreshHandle !== undefined) {
			cancelAnimationFrame(pendingRefreshHandle)
			pendingRefreshHandle = undefined
		}
		const list = findAnimatorList()
		for (const row of list?.querySelectorAll<HTMLElement>('li.animator') ?? []) row.style.display = ''
		Object.assign(filterState, FILTER_DEFAULTS)
		installedBar?.remove()
		installedBar = undefined
		for (const documentForStyle of getTimelineDocuments()) documentForStyle.getElementById(STYLE_ID)?.remove()
	}
}

function installSearch(): () => void {
	const remove = addTimelineDocumentListener('input', (event: Event) => {
		const target = event.target as HTMLInputElement | null
		if (!target?.matches(`.${SEARCH_CLASS}`)) return
		filterState.query = target.value
		applyFilter()
	}, true)
	return remove
}

function installToggles(): () => void {
	const remove = addTimelineDocumentListener('click', (event: Event) => {
		const target = (event.target as HTMLElement | null)?.closest(`.${TOGGLE_CLASS}`) as HTMLElement | null
		const key = target?.dataset.key as ToggleKey | undefined
		if (!key || !TOGGLE_KEYS.includes(key)) return
		const next = !filterState[key]
		filterState[key] = next
		if (key === 'onlySelected') {
			if (next) startSelectionWatch()
			else stopSelectionWatch()
		}
		if (key === 'onionSkin') forceRefreshOnionSkin()
		notifyToggleEffects(key, next)
		syncToggleVisuals()
		applyFilter()
	}, true)
	return () => {
		remove()
		stopSelectionWatch()
	}
}

export function installAnimatorPanelUI(): () => void {
	return installPanelUI()
}

export function installSearchHandler(): () => void {
	return installSearch()
}

export function installTogglesHandler(): () => void {
	return installToggles()
}

export function installAnimatorPanel(): () => void {
	if (installed) return () => {}
	installed = true
	const cleanups: Array<() => void> = []
	try {
		cleanups.push(installPanelUI())
		cleanups.push(installSearch())
		cleanups.push(installToggles())
	} catch (error) {
		for (const cleanup of cleanups.reverse()) cleanup()
		installed = false
		throw error
	}
	return () => {
		for (const cleanup of cleanups.reverse()) cleanup()
		installed = false
	}
}
