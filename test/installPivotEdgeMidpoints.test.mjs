import assert from 'node:assert/strict'
import test from 'node:test'
import { installPivotEdgeMidpoints } from '../dist-test/installPivotEdgeMidpoints.mjs'

class Events {
	listeners = new Map()
	on(name, listener) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]) }
	removeListener(name, listener) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(l => l !== listener)) }
	emit(name, data) { for (const listener of this.listeners.get(name) ?? []) listener(data) }
	get count() { return [...this.listeners.values()].flat().length }
}
class Geometry {
	attributes = {}
	setAttribute(name, attribute) { this.attributes[name] = attribute }
	computeBoundingSphere() {}
	dispose() { this.disposed = true }
}
class Material {
	depthTest = true
	copy() { return this }
	dispose() { this.disposed = true }
}
class Points {
	constructor(geometry, material) { this.geometry = geometry; this.material = material }
	removeFromParent() { this.parent.children = this.parent.children.filter(child => child !== this) }
}

function setup() {
	class Cube {}
	const mesh = { geometry: {}, visible: true, children: [], add(points) { this.children.push(points); points.parent = this } }
	const cube = Object.assign(new Cube(), { uuid: 'cube', from: [0, 0, 0], to: [2, 4, 6], origin: [0, 0, 0], mesh })
	const tool = { onSelect() {}, onUnselect() {}, onCanvasClick() {} }
	const original = { ...tool, raycast() { return this.hit } }
	const blockbench = new Events()
	const controller = new Events()
	class Preview { raycast(...args) { return original.raycast.apply(this, args) } }
	const nativeRaycast = Preview.prototype.raycast
	Object.assign(globalThis, {
		THREE: { Points, BufferGeometry: Geometry, PointsMaterial: Material, Float32BufferAttribute: class {
			constructor(array) { this.array = new Float32Array(array) }
			setXYZ(index,x,y,z) { this.array.set([x,y,z],index*3) }
		} },
		Cube: Object.assign(Cube, { selected: [cube], preview_controller: controller }), Group: class {},
		Modes: { edit: true }, Toolbox: { selected: tool }, BarItems: { pivot_tool: tool },
		Preview, Canvas: { meshVertexMaterial: {} }, Blockbench: blockbench,
		Interface: { preview: new EventTarget() },
		gizmo_colors: { grid: { r:1,g:1,b:1,toArray: () => [1, 1, 1] }, outline: { r:0,g:0,b:1,toArray: () => [0, 0, 1] } },
		getPivotObjects: () => [cube], adjustFromAndToForInflateAndStretch() {},
	})
	return { cube, mesh, tool, original, blockbench, controller, Preview, nativeRaycast }
}

test('markers refresh with geometry, route only their own hits, and restore lifecycle state', () => {
	const { cube, mesh, tool, original, blockbench, controller, Preview, nativeRaycast } = setup()
	const previous = { name: 'prior marker owner' }
	mesh.vertex_points = previous
	const cleanup = installPivotEdgeMidpoints()
	const points = mesh.vertex_points
	assert.equal(points.vertices.length, 12)
	assert.equal(points.no_export, true)
	const preview = new Preview()
	preview.hit = { type: 'vertex', element: cube, intersect: { object: points } }
	assert.equal(preview.raycast({}).type, 'animux_pivot_midpoint')
	preview.hit = { type: 'vertex', element: cube, intersect: { object: previous } }
	assert.equal(preview.raycast({}).type, 'vertex')
	cube.to[2] = cube.from[2]
	controller.emit('update_geometry', { element: cube })
	assert.equal(points.vertices.length, 4)
	cleanup()
	assert.equal(mesh.vertex_points, previous)
	assert.ok(points.geometry.disposed && points.material.disposed)
	assert.equal(blockbench.count, 0)
	assert.equal(controller.count, 0)
	assert.equal(Preview.prototype.raycast, nativeRaycast)
	assert.equal(tool.onSelect, original.onSelect)
	assert.equal(tool.onUnselect, original.onUnselect)
	assert.equal(tool.onCanvasClick, original.onCanvasClick)
})

test('project closure clears points and chained callbacks cannot revive an unloaded plugin', () => {
	const { mesh, tool, blockbench } = setup()
	const cleanup = installPivotEdgeMidpoints()
	blockbench.emit('close_project')
	assert.equal(mesh.vertex_points, undefined)
	blockbench.emit('select_project')
	assert.equal(mesh.vertex_points.vertices.length, 12)
	const installedSelect = tool.onSelect
	const laterPluginSelect = (...args) => installedSelect(...args)
	tool.onSelect = laterPluginSelect
	cleanup()
	assert.equal(tool.onSelect, laterPluginSelect)
	tool.onSelect()
	assert.equal(mesh.vertex_points, undefined)
})

test('hover reveals midpoint candidates through geometry and reuses their color buffer', () => {
	const {cube,mesh} = setup()
	const cleanup = installPivotEdgeMidpoints()
	try {
		const points = mesh.vertex_points
		const colors = points.geometry.attributes.color
		assert.equal(points.material.depthTest,true)
		Canvas.raycast = () => ({type:'animux_pivot_midpoint',element:cube,vertex_index:0,intersect:{object:points}})
		Interface.preview.dispatchEvent(new Event('mousemove'))
		assert.equal(points.material.depthTest,false)
		assert.equal(points.geometry.attributes.color,colors)
		assert.deepEqual([...colors.array.slice(0,3)],[0,0,1])
		Canvas.raycast = () => false
		Interface.preview.dispatchEvent(new Event('mousemove'))
		assert.equal(points.material.depthTest,true)
		assert.equal(points.geometry.attributes.color,colors)
		assert.deepEqual([...colors.array.slice(0,3)],[1,1,1])
	} finally { cleanup() }
})

test('bone pivot edits include nested bones in the Undo snapshot', () => {
	const { cube, mesh, tool } = setup()
	class Vector {
		fromArray(values) { this.values = [...values]; return this }
		clone() { return new Vector().fromArray(this.values) }
		toArray() { return [...this.values] }
	}
	THREE.Vector3 = Vector
	mesh.localToWorld = vector => vector
	const parent = new Group()
	const nested = new Group()
	parent.mesh = { parent: { worldToLocal: vector => vector } }
	parent.forEachChild = visitor => { visitor(nested); visitor(cube) }
	parent.transferOrigin = () => {}
	let saved
	Object.assign(globalThis, {
		getPivotObjects: () => [parent], Outliner: { selected: [cube] },
		Format: { bone_rig: true },
		Undo: { initEdit: aspects => { saved = aspects }, finishEdit() {} },
	})
	Canvas.updateView = () => {}
	const cleanup = installPivotEdgeMidpoints()
	try {
		tool.onCanvasClick({ type: 'animux_pivot_midpoint', element: cube, vertex: [1, 2, 3] })
		assert.deepEqual(saved.groups, [parent, nested])
		assert.deepEqual(saved.elements, [cube])
	} finally { cleanup() }
})

function setupRotatedCube() {
	const { cube, mesh, tool } = setup()
	class Vector {
		fromArray(values) { this.values = [...values]; return this }
		clone() { return new Vector().fromArray(this.values) }
		toArray(array = []) { array.splice(0, 3, ...this.values); return array }
		sub(other) { this.values = this.values.map((v, i) => v - other.values[i]); return this }
		divide(other) { this.values = this.values.map((v, i) => v / other.values[i]); return this }
		applyQuaternion() { const [x,y,z] = this.values; this.values = [y,-x,z]; return this }
	}
	THREE.Vector3 = Vector
	Object.assign(mesh, {
		localToWorld: vector => vector,
		parent: { worldToLocal: vector => vector },
		quaternion: { clone: () => ({ invert: () => ({}) }) },
		scale: new Vector().fromArray([2, 1, 1]),
	})
	cube.rescale = true
	cube.moveVector = () => assert.fail('intermediate geometry must not be clamped')
	cube.transferOrigin = () => assert.fail('rotation-only compensation must not run')
	cube.preview_controller = { updateTransform() {}, updateGeometry() {} }
	Object.assign(globalThis, {
		Outliner: { selected: [cube] }, Format: { bone_rig: true },
		Undo: { initEdit() {}, finishEdit() {} },
	})
	Canvas.updateView = () => {}
	return {cube,tool}
}

test('rescaled pivot compensation includes inverse rotation and scale', () => {
	const {cube,tool} = setupRotatedCube()
	const cleanup = installPivotEdgeMidpoints()
	try {
		tool.onCanvasClick({ type: 'animux_pivot_midpoint', element: cube, vertex: [1, 2, 3] })
		assert.deepEqual(cube.from, [0, 3, 0])
		assert.deepEqual(cube.to, [2, 7, 6])
		assert.deepEqual(cube.origin, [1, 2, 3])
	} finally { cleanup() }
})

test('a coordinate limit violation aborts every target before starting Undo', () => {
	const {cube,tool} = setupRotatedCube()
	const other = Object.assign(new Cube(), { from:[0,0,0],to:[2,4,6],origin:[0,0,0],mesh:cube.mesh })
	getPivotObjects = () => [cube,other]
	Format.cube_size_limiter = { test: target => target === other }
	globalThis.settings = { deactivate_size_limit: { value: false } }
	let message
	Blockbench.showQuickMessage = text => { message = text }
	Undo.initEdit = () => assert.fail('Undo must not start for an invalid operation')
	const cleanup = installPivotEdgeMidpoints()
	try {
		tool.onCanvasClick({type:'animux_pivot_midpoint',element:cube,vertex:[1,2,3]})
		for (const target of [cube,other]) {
			assert.deepEqual(target.from,[0,0,0])
			assert.deepEqual(target.to,[2,4,6])
			assert.deepEqual(target.origin,[0,0,0])
		}
		assert.match(message,/coordinate limits/)
	} finally { cleanup() }
})
