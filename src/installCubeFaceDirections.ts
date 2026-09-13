declare const THREE: any
declare const Cube: any
declare const Modes: any
declare const Toolbox: any
declare const BarItems: any
declare const Preview: any
declare const Blockbench: any
declare const Project: any

const directions = [
	{ letter: 'N', face: 'north', axis: 'z' },
	{ letter: 'E', face: 'east', axis: 'x' },
	{ letter: 'S', face: 'south', axis: 'z' },
	{ letter: 'W', face: 'west', axis: 'x' },
	{ letter: 'U', face: 'up', axis: 'y' },
	{ letter: 'D', face: 'down', axis: 'y' },
] as const

type Overlay = { node: HTMLDivElement; labels: Map<any, HTMLSpanElement[]> }

export function installCubeFaceDirections(): () => void {
	const originalRender = Preview.prototype.render
	const overlays = new Map<any, Overlay>()
	let installed = true
	const center = new THREE.Vector3()
	const projectedCenter = new THREE.Vector3()
	const point = new THREE.Vector3()

	function clear() {
		for (const { node } of overlays.values()) node.remove()
		overlays.clear()
	}

	function update(preview: any) {
		if (!installed) return
		if (!Project || !Modes.edit || Toolbox.selected !== BarItems.move_tool) {
			clear()
			return
		}
		// Detached/media previews are not editor viewports.
		if (!preview.canvas.isConnected || preview.offscreen) return
		let overlay = overlays.get(preview)
		const selected = new Set(Cube.selected.filter((cube: any) => {
			if (cube.visibility === false || cube.locked || !cube.mesh?.geometry?.boundingBox) return false
			for (let mesh = cube.mesh; mesh; mesh = mesh.parent) if (!mesh.visible) return false
			return true
		}))
		if (!selected.size) {
			overlay?.node.remove()
			overlays.delete(preview)
			return
		}
		if (!overlay) {
			const node = document.createElement('div')
			node.className = 'animux-face-directions'
			node.setAttribute('aria-hidden', 'true')
			node.style.cssText = 'position:absolute;overflow:hidden;pointer-events:none;'
			preview.node.append(node)
			overlay = { node, labels: new Map() }
			overlays.set(preview, overlay)
		}
		// Fixed-aspect viewports letterbox the canvas inside the preview node.
		overlay.node.style.left = `${preview.canvas.offsetLeft}px`
		overlay.node.style.top = `${preview.canvas.offsetTop}px`
		overlay.node.style.width = `${preview.width}px`
		overlay.node.style.height = `${preview.height}px`
		for (const [cube, labels] of overlay.labels) {
			if (selected.has(cube)) continue
			for (const label of labels) label.remove()
			overlay.labels.delete(cube)
		}
		for (const cube of selected as Set<any>) {
			let labels = overlay.labels.get(cube)
			if (!labels) {
				labels = directions.map(({ letter }) => {
					const label = document.createElement('span')
					label.textContent = letter
					label.style.cssText = 'position:absolute;transform:translate(-50%,-50%);font:11px sans-serif;line-height:14px;color:var(--color-text);opacity:0.65;text-shadow:0 0 2px var(--color-back);pointer-events:none;'
					overlay!.node.append(label)
					return label
				})
				overlay.labels.set(cube, labels)
			}
			const bounds = cube.mesh.geometry.boundingBox
			bounds.getCenter(center)
			projectedCenter.copy(center).applyMatrix4(cube.mesh.matrixWorld).project(preview.camera)
			const padding = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z) * 0.12
			directions.forEach(({ face, axis }, index) => {
				// Bounding boxes reorder inverted bounds; native face vertices retain face identity.
				point.fromBufferAttribute(cube.mesh.geometry.attributes.position, cube.faces[face].getVertexIndices()[0])
				const boundary = point[axis]
				const sign = Math.sign(boundary - center[axis])
				point.copy(center)
				point[axis] = boundary + sign * padding
				point.applyMatrix4(cube.mesh.matrixWorld).project(preview.camera)
				const label = labels![index]
				label.hidden = !Number.isFinite(point.x + point.y + point.z) || point.z < -1 || point.z > 1
				if (label.hidden) return
				const dx = (point.x - projectedCenter.x) * preview.width / 2
				const dy = (projectedCenter.y - point.y) * preview.height / 2
				const length = Math.hypot(dx, dy)
				// Looking straight down an axis projects both letters onto the same pixel.
				const offsetX = length < 1 ? sign * 8 : dx / length * 20
				const offsetY = length < 1 ? 0 : dy / length * 20
				label.style.left = `${(point.x + 1) * preview.width / 2 + offsetX}px`
				label.style.top = `${(1 - point.y) * preview.height / 2 + offsetY}px`
			})
		}
	}

	function render(this: any, ...args: any[]) {
		const result = originalRender.apply(this, args)
		// The native render updates camera and model matrices before projection.
		update(this)
		return result
	}
	Preview.prototype.render = render
	const events = ['unselect_project', 'close_project', 'select_mode', 'update_selection']
	for (const event of events) Blockbench.on(event, clear)
	return () => {
		installed = false
		clear()
		for (const event of events) Blockbench.removeListener(event, clear)
		if (Preview.prototype.render === render) Preview.prototype.render = originalRender
	}
}
