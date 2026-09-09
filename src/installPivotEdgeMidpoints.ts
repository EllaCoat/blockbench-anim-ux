import { cubeEdgeMidpoints, type Vertex } from './cubeEdgeMidpoints'

declare const THREE: any
declare const Cube: any
declare const Group: any
declare const Outliner: any
declare const Format: any
declare const Modes: any
declare const Toolbox: any
declare const BarItems: any
declare const Preview: any
declare const Canvas: any
declare const Blockbench: any
declare const Undo: any
declare const Interface: any
declare const gizmo_colors: any
declare const settings: any
declare function getPivotObjects(): any[] | undefined
declare function adjustFromAndToForInflateAndStretch(from: number[], to: number[], cube: any): void

type Marker = { cube: any; mesh: any; points: any; previous: any }

export function installPivotEdgeMidpoints(): () => void {
	const tool = BarItems.pivot_tool
	const originalSelect = tool.onSelect
	const originalUnselect = tool.onUnselect
	const originalClick = tool.onCanvasClick
	const originalRaycast = Preview.prototype.raycast
	const markers = new Map<any, Marker>()
	let installed = true
	let hovered = ''
	const active = () => installed && Toolbox.selected === tool && Modes.edit

	function clear() {
		hovered = ''
		for (const { mesh, points, previous } of markers.values()) {
			points.removeFromParent()
			points.geometry.dispose()
			points.material.dispose()
			if (mesh.vertex_points === points) {
				if (previous) mesh.vertex_points = previous
				else delete mesh.vertex_points
			}
		}
		markers.clear()
	}

	function setVertices(marker: Marker) {
		hovered = ''
		const from = marker.cube.from.slice()
		const to = marker.cube.to.slice()
		adjustFromAndToForInflateAndStretch(from, to, marker.cube)
		// The renderer adds 0.001 to collapsed axes; snap to the actual Cube plane.
		const bounds = new Float32Array([...from, ...to].map((v, i) => v - marker.cube.origin[i % 3]))
		const vertices = cubeEdgeMidpoints(bounds)
		marker.points.vertices = vertices
		marker.points.geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices.flat(), 3))
		marker.points.geometry.setAttribute('color', new THREE.Float32BufferAttribute(
			vertices.flatMap(() => gizmo_colors.grid.toArray()), 3))
		marker.points.geometry.computeBoundingSphere()
	}

	function refresh() {
		clear()
		if (!active() || !getPivotObjects()?.length) return
		for (const cube of Cube.selected) {
			const mesh = cube.mesh
			if (!mesh?.geometry || cube.visibility === false || cube.locked || !mesh.visible) continue
			const points = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial().copy(Canvas.meshVertexMaterial))
			points.name = 'animux_pivot_midpoints'
			points.no_export = true
			points.element_uuid = cube.uuid
			points.renderOrder = 900
			points.material.transparent = true
			const marker = { cube, mesh, points, previous: mesh.vertex_points }
			setVertices(marker)
			mesh.add(points)
			mesh.vertex_points = points
			markers.set(cube, marker)
		}
	}

	function geometryChanged({ element }: { element: any }) {
		const marker = markers.get(element)
		if (marker) setVertices(marker)
	}

	function select(this: any, ...args: any[]) {
		originalSelect?.apply(this, args)
		refresh()
	}
	function unselect(this: any, ...args: any[]) {
		clear()
		return originalUnselect?.apply(this, args)
	}
	function raycast(this: any, ...args: any[]) {
		const hit = originalRaycast.apply(this, args)
		if (active() && hit && markers.get(hit.element)?.points === hit.intersect?.object) {
			// Preview's ordinary vertex branch edits Mesh vertex selection, not pivots.
			hit.type = 'animux_pivot_midpoint'
		}
		return hit
	}
	function click(this: any, data: any) {
		if (!active() || data.type !== 'animux_pivot_midpoint') return originalClick?.call(this, data)
		const targets = getPivotObjects() ?? []
		if (targets.length === 0) return
		const world = data.element.mesh.localToWorld(new THREE.Vector3().fromArray(data.vertex as Vertex))
		function targetOrigin(target: any) {
			const position = target.mesh.parent.worldToLocal(world.clone())
			if (Format.bone_rig && target.parent instanceof Group) {
				position.add(new THREE.Vector3().fromArray(target.parent.origin))
			}
			return position
		}
		const cubeChanges = new Map<any, { origin: number[]; from: number[]; to: number[] }>()
		for (const target of targets) {
			if (!(target instanceof Cube)) continue
			const position = targetOrigin(target)
			// Include scale, and compute the final geometry before a native move could clamp it.
			const offset = new THREE.Vector3().fromArray(target.origin).sub(position)
			const shift = offset.clone().applyQuaternion(target.mesh.quaternion.clone().invert())
				.divide(target.mesh.scale).sub(offset).toArray()
			cubeChanges.set(target, {
				origin: position.toArray(),
				from: target.from.map((value: number, axis: number) => value + shift[axis]),
				to: target.to.map((value: number, axis: number) => value + shift[axis]),
			})
		}
		const limiter = Format.cube_size_limiter
		// World-space limits are unchanged because the visible geometry stays fixed.
		if (limiter && !limiter.rotation_affected && !settings.deactivate_size_limit.value &&
			[...cubeChanges].some(([cube, change]) => limiter.test(cube, change))) {
			Blockbench.showQuickMessage('This midpoint exceeds the format coordinate limits; no pivots were moved.', 4000)
			return
		}
		const elements = new Set(Outliner.selected)
		const groups = targets.filter(target => target instanceof Group)
		const affectedGroups = new Set(groups)
		for (const group of groups) group.forEachChild((child: any) => {
			if (child instanceof Group) affectedGroups.add(child)
			else elements.add(child)
		})
		Undo.initEdit({ elements: [...elements], groups: [...affectedGroups] })
		for (const target of targets) {
			const change = cubeChanges.get(target)
			if (change) {
				target.from.splice(0, 3, ...change.from)
				target.to.splice(0, 3, ...change.to)
				target.origin.splice(0, 3, ...change.origin)
			} else {
				target.transferOrigin(targetOrigin(target).toArray())
			}
		}
		Canvas.updateView({
			elements: [...elements], element_aspects: { transform: true, geometry: true },
			groups: [...affectedGroups], group_aspects: { transform: true }, selection: true,
		})
		Undo.finishEdit('Move pivot to edge midpoint')
	}
	function hover(event: MouseEvent) {
		if (!active() || markers.size === 0) return
		const hit = Canvas.raycast(event)
		const isMidpoint = hit?.type === 'animux_pivot_midpoint'
		const key = `${hit?.element?.uuid ?? ''}:${isMidpoint ? hit.vertex_index : ''}`
		if (key === hovered) return
		hovered = key
		for (const { cube, points } of markers.values()) {
			points.material.depthTest = hit?.element !== cube
			const colors = points.geometry.attributes.color
			for (let index = 0; index < points.vertices.length; index++) {
				const color = isMidpoint && hit.intersect.object === points && hit.vertex_index === index
					? gizmo_colors.outline : gizmo_colors.grid
				colors.setXYZ(index, color.r, color.g, color.b)
			}
			colors.needsUpdate = true
		}
	}

	tool.onSelect = select
	tool.onUnselect = unselect
	tool.onCanvasClick = click
	Preview.prototype.raycast = raycast
	const events = ['update_selection', 'select_project', 'select_mode', 'undo', 'redo']
	for (const event of events) Blockbench.on(event, refresh)
	for (const event of ['unselect_project', 'close_project']) Blockbench.on(event, clear)
	Cube.preview_controller.on('update_geometry', geometryChanged)
	Interface.preview.addEventListener('mousemove', hover)
	refresh()
	return () => {
		installed = false
		clear()
		for (const event of events) Blockbench.removeListener(event, refresh)
		for (const event of ['unselect_project', 'close_project']) Blockbench.removeListener(event, clear)
		Cube.preview_controller.removeListener('update_geometry', geometryChanged)
		Interface.preview.removeEventListener('mousemove', hover)
		if (tool.onSelect === select) tool.onSelect = originalSelect
		if (tool.onUnselect === unselect) tool.onUnselect = originalUnselect
		if (tool.onCanvasClick === click) tool.onCanvasClick = originalClick
		if (Preview.prototype.raycast === raycast) Preview.prototype.raycast = originalRaycast
	}
}
