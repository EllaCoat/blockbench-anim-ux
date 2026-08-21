// Blockbench の Timeline を子 window へ移したときだけ必要な互換処理。

interface JQueryLike {
	(selector: unknown, context?: unknown): unknown
	fn?: unknown
	[k: string]: unknown
}

function installGetElementByIdFallback(childWindow: Window): () => void {
	const prototype = Document.prototype
	const original = prototype.getElementById
	const safeId = /^(timeline_|resizer_timeline_)/
	const patched = function (this: Document, id: string): HTMLElement | null {
		if (this !== document) return original.call(this, id)
		const found = original.call(this, id)
		if (found || !safeId.test(id) || childWindow.closed) return found
		try {
			return childWindow.document.getElementById(id)
		} catch {
			return null
		}
	}
	prototype.getElementById = patched
	return () => {
		if (prototype.getElementById === patched) prototype.getElementById = original
	}
}

function installJqueryFallback(childWindow: Window): () => void {
	const root = window as unknown as { $?: JQueryLike; jQuery?: JQueryLike }
	const original = root.$
	if (typeof original !== 'function') return () => {}
	const nativeGetById = Document.prototype.getElementById
	const patched = function (selector: unknown, context?: unknown): unknown {
		if (typeof selector === 'string' && selector.startsWith('#') && context === undefined) {
			const id = selector.slice(1).split(' ', 1)[0]
			if (!nativeGetById.call(document, id) && !childWindow.closed && nativeGetById.call(childWindow.document, id)) {
				return original(selector, childWindow.document)
			}
		}
		return original(selector, context)
	} as unknown as JQueryLike
	for (const key in original) patched[key] = original[key]
	patched.fn = original.fn
	root.$ = patched
	root.jQuery = patched
	return () => {
		if (root.$ === patched) {
			root.$ = original
			root.jQuery = original
		}
	}
}

function installEventProxy(childWindow: Window): () => void {
	const proxyMouse = (type: 'mousemove' | 'mouseup') => (event: MouseEvent): void => {
		try {
			document.dispatchEvent(new MouseEvent(type, {
				bubbles: true,
				cancelable: true,
				button: event.button,
				buttons: event.buttons,
				clientX: event.clientX,
				clientY: event.clientY,
				ctrlKey: event.ctrlKey,
				shiftKey: event.shiftKey,
				altKey: event.altKey,
				metaKey: event.metaKey,
				screenX: event.screenX,
				screenY: event.screenY,
			}))
		} catch {
			// Electron の renderer が閉じる途中は event の複製に失敗し得る。
		}
	}
	const proxyTouch = (type: 'touchmove' | 'touchend') => (event: TouchEvent): void => {
		try {
			const TouchEventCtor = (window as unknown as { TouchEvent?: typeof TouchEvent }).TouchEvent
			if (!TouchEventCtor) return
			document.dispatchEvent(new TouchEventCtor(type, {
				bubbles: true,
				cancelable: true,
				touches: Array.from(event.touches),
				targetTouches: Array.from(event.targetTouches),
				changedTouches: Array.from(event.changedTouches),
			}))
		} catch {
			// TouchEvent の cross-document 変換は Chromium build により失敗し得る。
		}
	}

	const textInputFocused = (): boolean => {
		const active = childWindow.document.activeElement as HTMLElement | null
		if (!active) return false
		if (active.nodeName === 'TEXTAREA') return true
		if (active.nodeName === 'INPUT') return ['number', 'text', 'search'].includes((active as HTMLInputElement).type)
		return active.isContentEditable === true
	}
	const textInputGlobalKeys = new Set(['z', 'Z', 'y', 'Y', 's', 'S', 'c', 'C', 'v', 'V', 'x', 'X', 'a', 'A', 'f', 'F'])
	const proxyKey = (type: 'keydown' | 'keyup') => (event: KeyboardEvent): void => {
		if (event.isComposing) return
		const modified = event.ctrlKey || event.metaKey
		if (textInputFocused() && (!modified || !textInputGlobalKeys.has(event.key))) return
		try {
			const cloned = new KeyboardEvent(type, {
				bubbles: true,
				cancelable: true,
				key: event.key,
				code: event.code,
				ctrlKey: event.ctrlKey,
				shiftKey: event.shiftKey,
				altKey: event.altKey,
				metaKey: event.metaKey,
				repeat: event.repeat,
				location: event.location,
			})
			const which = event.which || event.keyCode || 0
			Object.defineProperties(cloned, {
				which: { configurable: true, get: () => which },
				keyCode: { configurable: true, get: () => which },
				charCode: { configurable: true, get: () => event.charCode || 0 },
			})
			document.dispatchEvent(cloned)
		} catch {
			// Window close can invalidate the target document between the guard and dispatch.
		}
	}

	const pressing = window as unknown as { Pressing?: { ctrl?: boolean } }
	let pressingPatched = false
	let savedPressingCtrl = false
	const restorePressing = (): void => {
		if (!pressingPatched) return
		if (pressing.Pressing) pressing.Pressing.ctrl = savedPressingCtrl
		pressingPatched = false
	}
	const bridgeMark = '_animUxBridgedWheel'
	const bridgeWheel = (event: WheelEvent): void => {
		if ((event as unknown as Record<string, unknown>)[bridgeMark]) return
		const target = event.target as Element | null
		const timelineVue = childWindow.document.getElementById('timeline_vue')
		if (!target || !timelineVue?.contains(target)) return
		const WheelEventCtor = (childWindow as unknown as { WheelEvent?: typeof WheelEvent }).WheelEvent
		if (!WheelEventCtor) return
		try {
			event.preventDefault()
			const cloned = new WheelEventCtor('mousewheel', {
				bubbles: true,
				cancelable: true,
				deltaX: event.deltaX,
				deltaY: event.deltaY,
				deltaZ: event.deltaZ,
				deltaMode: event.deltaMode,
				clientX: event.clientX,
				clientY: event.clientY,
				ctrlKey: event.ctrlKey,
				shiftKey: event.shiftKey,
				altKey: event.altKey,
				metaKey: event.metaKey,
				view: childWindow,
			})
			Object.defineProperty(cloned, bridgeMark, { configurable: true, value: true })
			timelineVue.dispatchEvent(cloned)
		} catch {
			// The native wheel path remains available if the legacy event cannot be cloned.
		}
	}
	const wheelCapture = (event: Event): void => {
		const wheel = event as WheelEvent
		if (wheel.ctrlKey && !wheel.shiftKey && pressing.Pressing) {
			if (!pressingPatched) {
				savedPressingCtrl = pressing.Pressing.ctrl ?? false
				pressingPatched = true
			}
			pressing.Pressing.ctrl = false
		}
		if (event.type === 'wheel') bridgeWheel(wheel)
		queueMicrotask(restorePressing)
	}
	const wheelBubble = (): void => restorePressing()

	const mousemove = proxyMouse('mousemove')
	const mouseup = proxyMouse('mouseup')
	const touchmove = proxyTouch('touchmove')
	const touchend = proxyTouch('touchend')
	const keydown = proxyKey('keydown')
	const keyup = proxyKey('keyup')
	childWindow.document.addEventListener('mousemove', mousemove, true)
	childWindow.document.addEventListener('mouseup', mouseup, true)
	childWindow.document.addEventListener('touchmove', touchmove, true)
	childWindow.document.addEventListener('touchend', touchend, true)
	childWindow.document.addEventListener('keydown', keydown, true)
	childWindow.document.addEventListener('keyup', keyup, true)
	childWindow.document.addEventListener('wheel', wheelCapture, true)
	childWindow.document.addEventListener('wheel', wheelBubble)
	childWindow.document.addEventListener('mousewheel', wheelCapture, true)
	childWindow.document.addEventListener('mousewheel', wheelBubble)

	return () => {
		childWindow.document.removeEventListener('mousemove', mousemove, true)
		childWindow.document.removeEventListener('mouseup', mouseup, true)
		childWindow.document.removeEventListener('touchmove', touchmove, true)
		childWindow.document.removeEventListener('touchend', touchend, true)
		childWindow.document.removeEventListener('keydown', keydown, true)
		childWindow.document.removeEventListener('keyup', keyup, true)
		childWindow.document.removeEventListener('wheel', wheelCapture, true)
		childWindow.document.removeEventListener('wheel', wheelBubble)
		childWindow.document.removeEventListener('mousewheel', wheelCapture, true)
		childWindow.document.removeEventListener('mousewheel', wheelBubble)
		restorePressing()
	}
}

export function installTimelineWindowBridge(childWindow: Window): () => void {
	const cleanups: Array<() => void> = []
	try {
		cleanups.push(installJqueryFallback(childWindow))
		cleanups.push(installGetElementByIdFallback(childWindow))
		cleanups.push(installEventProxy(childWindow))
	} catch (error) {
		for (const cleanup of cleanups.reverse()) {
			try { cleanup() } catch { /* best effort during failed install */ }
		}
		throw error
	}
	return () => {
		for (const cleanup of cleanups.reverse()) {
			try { cleanup() } catch { /* best effort during restore */ }
		}
	}
}

export function copyTimelineStyles(source: Document, target: Document): void {
	for (const style of Array.from(source.querySelectorAll('style'))) {
		const clone = target.createElement('style')
		clone.textContent = style.textContent
		target.head.appendChild(clone)
	}
	for (const link of Array.from(source.querySelectorAll('link[rel="stylesheet"]'))) {
		const href = (link as HTMLLinkElement).href
		if (!href) continue
		const clone = target.createElement('link')
		clone.rel = 'stylesheet'
		clone.href = href
		target.head.appendChild(clone)
	}
}
