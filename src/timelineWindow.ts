import { copyTimelineStyles, installTimelineWindowBridge } from './timelineWindowBridge'

declare const Panels:
	| {
			timeline?: {
				node?: HTMLElement
				container?: HTMLElement
				update?: () => void
				width?: number
				height?: number
			}
	  }
	| undefined
declare const Timeline: { updateSize?: () => void } | undefined
declare const Blockbench:
	| { on(event: string, callback: () => void): void; removeListener(event: string, callback: () => void): void }
	| undefined
declare const Action: new (id: string, options: Record<string, unknown>) => { delete(): void }
declare const MenuBar:
	| { menus: Record<string, { addAction(action: unknown): void; removeAction(action: unknown): void } | undefined> }
	| undefined

export type DocumentsListener = (documents: readonly Document[]) => void

interface RegisteredDocumentListener {
	type: string
	listener: EventListenerOrEventListenerObject
	options?: boolean | AddEventListenerOptions
}

interface TimelineSession {
	childWindow: Window
	node: HTMLElement
	panel: NonNullable<NonNullable<typeof Panels>['timeline']>
	originParent: Node | null
	originNext: Node | null
	bridgeCleanup: () => void
	styleGuard?: MutationObserver
	stopClosePoll: () => void
	restore: () => void
	restored: boolean
}

export interface TimelineWindowService {
	subscribeDocuments(listener: DocumentsListener): () => void
	getDocuments(): readonly Document[]
	addDocumentListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions,
	): () => void
	popoutTimeline(): void
	restoreTimeline(): void
	install(): () => void
	dispose(): void
}

class TimelineWindowController implements TimelineWindowService {
	private readonly parentDocument = document
	private readonly documentListeners = new Set<RegisteredDocumentListener>()
	private readonly documentSubscribers = new Set<DocumentsListener>()
	private childDocument: Document | null = null
	private session: TimelineSession | null = null
	private installed = false
	private disposed = false
	private toggleAction: { delete(): void } | undefined
	private readonly projectEvents = ['unselect_project', 'reset_project']
	private readonly restoreForProject = (): void => this.restoreTimeline()

	private snapshotDocuments(): readonly Document[] {
		const documents: Document[] = [this.parentDocument]
		if (this.childDocument) {
			const childWindow = this.childDocument.defaultView
			if (childWindow && !childWindow.closed) documents.push(this.childDocument)
		}
		return Object.freeze(documents)
	}

	private notifyDocuments(): void {
		const documents = this.snapshotDocuments()
		for (const listener of this.documentSubscribers) {
			try {
				listener(documents)
			} catch (error) {
				console.warn('[anim_ux] document subscriber failed', error)
			}
		}
	}

	private attachDocumentListener(entry: RegisteredDocumentListener, target: Document): void {
		try {
			target.addEventListener(entry.type, entry.listener, entry.options)
		} catch (error) {
			console.warn(`[anim_ux] addEventListener(${entry.type}) failed`, error)
		}
	}

	private detachDocumentListener(entry: RegisteredDocumentListener, target: Document): void {
		try {
			target.removeEventListener(entry.type, entry.listener, entry.options)
		} catch {
			// The child renderer can disappear while cleanup is running.
		}
	}

	private setChildDocument(documentForChild: Document | null): void {
		if (this.childDocument === documentForChild) return
		const previous = this.childDocument
		if (previous) {
			for (const entry of this.documentListeners) this.detachDocumentListener(entry, previous)
		}
		this.childDocument = documentForChild
		if (documentForChild) {
			for (const entry of this.documentListeners) this.attachDocumentListener(entry, documentForChild)
		}
		this.notifyDocuments()
	}

	subscribeDocuments(listener: DocumentsListener): () => void {
		this.documentSubscribers.add(listener)
		try {
			listener(this.snapshotDocuments())
		} catch (error) {
			console.warn('[anim_ux] document subscriber failed during subscribe', error)
		}
		return () => {
			this.documentSubscribers.delete(listener)
		}
	}

	getDocuments(): readonly Document[] {
		if (this.childDocument) {
			const childWindow = this.childDocument.defaultView
			if (!childWindow || childWindow.closed) this.restoreTimeline()
		}
		return this.snapshotDocuments()
	}

	addDocumentListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions,
	): () => void {
		const entry: RegisteredDocumentListener = { type, listener, options }
		this.documentListeners.add(entry)
		this.attachDocumentListener(entry, this.parentDocument)
		if (this.childDocument) this.attachDocumentListener(entry, this.childDocument)
		return () => {
			if (!this.documentListeners.delete(entry)) return
			this.detachDocumentListener(entry, this.parentDocument)
			if (this.childDocument) this.detachDocumentListener(entry, this.childDocument)
		}
	}

	private updatePopoutSize(session: TimelineSession): void {
		if (session.restored || session.childWindow.closed) return
		const panel = session.panel
		const width = `${session.childWindow.innerWidth}px`
		const height = `${session.childWindow.innerHeight}px`
		const container = panel.container ?? session.node
		container.style.width = width
		container.style.height = height
		if (panel.container) {
			panel.width = session.childWindow.innerWidth
			panel.height = session.childWindow.innerHeight
		}
		session.styleGuard?.takeRecords()
		try {
			Timeline?.updateSize?.()
		} catch (error) {
			console.warn('[anim_ux] Timeline.updateSize failed', error)
		}
	}

	private createSession(
		childWindow: Window,
		node: HTMLElement,
		panel: NonNullable<NonNullable<typeof Panels>['timeline']>,
		originParent: Node | null,
		originNext: Node | null,
		bridgeCleanup: () => void,
	): TimelineSession {
		let closePollHandle = 0
		let styleGuard: MutationObserver | undefined
		const onResize = (): void => this.updatePopoutSize(session)
		const onBeforeUnload = (): void => session.restore()
		const session: TimelineSession = {
			childWindow,
			node,
			panel,
			originParent,
			originNext,
			bridgeCleanup,
			restored: false,
			stopClosePoll: () => {
				if (closePollHandle) window.clearInterval(closePollHandle)
				closePollHandle = 0
			},
			restore: () => {
				if (session.restored) return
				session.restored = true
				session.stopClosePoll()
				childWindow.removeEventListener('beforeunload', onBeforeUnload)
				childWindow.removeEventListener('resize', onResize)
				styleGuard?.disconnect()
				if (this.session === session) this.setChildDocument(null)
				try { session.bridgeCleanup() } catch { /* best effort */ }
				try {
					const restoredNode = this.parentDocument.adoptNode(session.node)
					if (session.originParent) {
						if (session.originNext?.parentNode === session.originParent) {
							session.originParent.insertBefore(restoredNode, session.originNext)
						} else {
							session.originParent.appendChild(restoredNode)
						}
					} else {
						this.parentDocument.body.appendChild(restoredNode)
					}
				} catch (error) {
					console.warn('[anim_ux] Timeline restore failed', error)
				}
				try {
					const container = panel.container ?? session.node
					container.style.width = ''
					container.style.height = ''
					panel.update?.()
				} catch (error) {
					console.warn('[anim_ux] panel reflow on restore failed', error)
				}
				if (this.session === session) this.session = null
			},
		}
		try {
			childWindow.addEventListener('resize', onResize)
			childWindow.addEventListener('beforeunload', onBeforeUnload)
			styleGuard = new MutationObserver(() => this.updatePopoutSize(session))
			styleGuard.observe(panel.container ?? node, { attributes: true, attributeFilter: ['style'] })
			session.styleGuard = styleGuard
			closePollHandle = window.setInterval(() => {
				if (childWindow.closed) session.restore()
			}, 1000)
		} catch (error) {
			session.restore()
			throw error
		}
		return session
	}

	popoutTimeline(): void {
		if (this.disposed) return
		const current = this.session
		if (current && !current.childWindow.closed) {
			current.childWindow.focus()
			return
		}
		current?.restore()
		const panel = Panels?.timeline
		const node = panel?.container ?? panel?.node
		if (!panel || !node) {
			console.warn('[anim_ux] Timeline panel is not available')
			return
		}
		const originParent = node.parentNode
		const originNext = node.nextSibling
		const childWindow = window.open('about:blank', 'anim_ux_timeline_popout', 'width=1000,height=340')
		if (!childWindow) {
			console.warn('[anim_ux] Timeline popout was blocked')
			return
		}
		try {
			if (!childWindow.document.body) {
				childWindow.document.write('<!doctype html><html><head></head><body></body></html>')
				childWindow.document.close()
			}
			childWindow.document.title = 'Blockbench Timeline'
			childWindow.document.body.className = document.body.className
			childWindow.document.body.style.margin = '0'
			childWindow.document.body.style.overflow = 'hidden'
			childWindow.document.body.style.display = 'flex'
			childWindow.document.body.style.flexDirection = 'column'
			childWindow.document.body.style.width = '100vw'
			childWindow.document.body.style.height = '100vh'
			copyTimelineStyles(document, childWindow.document)
			const adopted = childWindow.document.adoptNode(node)
			childWindow.document.body.appendChild(adopted)
			const bridgeCleanup = installTimelineWindowBridge(childWindow)
			const session = this.createSession(childWindow, node, panel, originParent, originNext, bridgeCleanup)
			this.session = session
			this.setChildDocument(childWindow.document)
			this.updatePopoutSize(session)
		} catch (error) {
			console.warn('[anim_ux] Timeline popout failed', error)
			try {
				this.parentDocument.adoptNode(node)
				if (originParent) originParent.insertBefore(node, originNext)
			} catch {
				// The original parent is retained by the caller for the next reflow attempt.
			}
			try { childWindow.close() } catch { /* noop */ }
		}
	}

	restoreTimeline(): void {
		const session = this.session
		if (!session) return
		try { session.childWindow.close() } catch { /* noop */ }
		session.restore()
	}

	install(): () => void {
		if (this.installed) return () => this.dispose()
		this.installed = true
		this.disposed = false
		try {
			for (const event of this.projectEvents) Blockbench?.on(event, this.restoreForProject)
			if (typeof Action !== 'undefined') {
				this.toggleAction = new Action('anim_ux_toggle_timeline_popout', {
					name: 'Anim UX: Detach Timeline',
					description: 'Move the TIMELINE panel into a separate window (toggle to restore)',
					icon: 'open_in_new',
					category: 'animation',
					click: () => (this.session ? this.restoreTimeline() : this.popoutTimeline()),
				})
				MenuBar?.menus?.animation?.addAction(this.toggleAction)
			}
		} catch (error) {
			this.dispose()
			throw error
		}
		return () => this.dispose()
	}

	dispose(): void {
		const hadChildDocument = this.childDocument !== null
		if (this.disposed && !this.installed) {
			if (this.childDocument) this.setChildDocument(null)
			else this.notifyDocuments()
			return
		}
		this.restoreTimeline()
		for (const entry of this.documentListeners) {
			this.detachDocumentListener(entry, this.parentDocument)
			if (this.childDocument) this.detachDocumentListener(entry, this.childDocument)
		}
		this.documentListeners.clear()
		for (const event of this.projectEvents) Blockbench?.removeListener(event, this.restoreForProject)
		const animationMenu = MenuBar?.menus?.animation
		if (this.toggleAction) {
			try { animationMenu?.removeAction(this.toggleAction) } catch { /* noop */ }
			try { this.toggleAction.delete() } catch { /* noop */ }
			this.toggleAction = undefined
		}
		this.installed = false
		this.disposed = true
		if (this.childDocument) this.setChildDocument(null)
		else if (!hadChildDocument) this.notifyDocuments()
	}
}

export const timelineWindowService: TimelineWindowService = new TimelineWindowController()

export function installTimelineWindow(): () => void {
	return timelineWindowService.install()
}

export function popoutTimeline(): void {
	timelineWindowService.popoutTimeline()
}

export function restoreTimeline(): void {
	timelineWindowService.restoreTimeline()
}

export function getTimelineDocuments(): readonly Document[] {
	return timelineWindowService.getDocuments()
}

export function addTimelineDocumentListener(
	type: string,
	listener: EventListenerOrEventListenerObject,
	options?: boolean | AddEventListenerOptions,
): () => void {
	return timelineWindowService.addDocumentListener(type, listener, options)
}

export function queryTimelineDocuments<T extends Element = HTMLElement>(selector: string): T[] {
	const elements: T[] = []
	for (const ownerDocument of timelineWindowService.getDocuments()) {
		elements.push(...Array.from(ownerDocument.querySelectorAll<T>(selector)))
	}
	return elements
}

export function findTimelineElementById(id: string): HTMLElement | null {
	for (const ownerDocument of timelineWindowService.getDocuments()) {
		const element = ownerDocument.getElementById(id)
		if (element) return element
	}
	return null
}
