import { cubeEdgeMidpoints, cubeSnapBounds, type Vertex } from './cubeSnapPoints'

declare const THREE: any
declare const Cube: any
declare const Vertexsnap: any
declare const BarItems: any
declare const Toolbox: any
declare const gizmo_colors: any

// Index → axes ('1' moves `to`, '0' moves `from`), as in the scale branch of Blockbench's Vertexsnap.snap.
const SCALE_CORNERS = ['111', '110', '101', '100', '010', '011', '000', '001']
const AXES = ['x', 'y', 'z'] as const

type ScaleStart = { corner: number; axis: typeof AXES[number] }

/** Scaling from an edge midpoint moves the two faces that meet at the edge and keeps its length. */
function scaleStart(bounds: Float32Array, point: Vertex): ScaleStart {
	let axis = 0
	let sides = ''
	for (let i = 0; i < 3; i++) {
		if (point[i] !== bounds[i] && point[i] !== bounds[i + 3]) axis = i
		sides += point[i] === bounds[i + 3] ? '1' : '0'
	}
	return { corner: SCALE_CORNERS.indexOf(sides), axis: AXES[axis] }
}

export function installVertexSnapMidpoints(): () => void {
	const { addVertices: originalAdd, canvasClick: originalClick, snap: originalSnap } = Vertexsnap
	const midpoints = new WeakMap<object, { first: number; starts: ScaleStart[] }>()
	let pendingStart: ScaleStart | undefined
	let installed = true

	function appendMidpoints(cube: any, points: any) {
		const bounds = cubeSnapBounds(cube)
		const added = cubeEdgeMidpoints(bounds)
		midpoints.set(points, { first: points.vertices.length, starts: added.map(point => scaleStart(bounds, point)) })
		points.vertices.push(...added)
		points.geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.vertices.flat(), 3))
		points.geometry.setAttribute('color', new THREE.Float32BufferAttribute(
			points.vertices.flatMap(() => gizmo_colors.grid.toArray()), 3))
		points.geometry.computeBoundingSphere()
	}

	function addVertices(this: any, element: any) {
		const fresh = installed && element instanceof Cube && !element.mesh?.vertex_points
		const result = originalAdd.call(this, element)
		const points = element.mesh?.vertex_points
		if (fresh && points) appendMidpoints(element, points)
		return result
	}
	function canvasClick(this: any, data: any) {
		const starting = installed && Vertexsnap.step1
		const info = starting ? midpoints.get(data?.intersect?.object) : undefined
		const start = info?.starts[data.vertex_index - info.first]
		const result = originalClick.call(this, data)
		if (starting && !Vertexsnap.step1) pendingStart = start
		return result
	}
	function snap(this: any, data: any, options?: any, amended?: boolean) {
		if (installed && pendingStart && BarItems.vertex_snap_mode.get() === 'scale') {
			Vertexsnap.vertex_index = pendingStart.corner
			options = { ...options, ignore_axis: { ...options?.ignore_axis, [pendingStart.axis]: true } }
		}
		return originalSnap.call(this, data, options, amended)
	}

	Vertexsnap.addVertices = addVertices
	Vertexsnap.canvasClick = canvasClick
	Vertexsnap.snap = snap
	if (Toolbox.selected === BarItems.vertex_snap_tool) Vertexsnap.select()
	return () => {
		installed = false
		if (Vertexsnap.addVertices === addVertices) Vertexsnap.addVertices = originalAdd
		if (Vertexsnap.canvasClick === canvasClick) Vertexsnap.canvasClick = originalClick
		if (Vertexsnap.snap === snap) Vertexsnap.snap = originalSnap
		// Native scale snapping has no corner for a midpoint index, so drop a pending midpoint start.
		if (pendingStart && !Vertexsnap.step1) Vertexsnap.step1 = true
		if (Toolbox.selected === BarItems.vertex_snap_tool) Vertexsnap.select()
	}
}
