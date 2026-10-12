import assert from 'node:assert/strict'
import test from 'node:test'
import { installVertexSnapMidpoints } from '../dist-test/installVertexSnapMidpoints.mjs'

const CORNER_SIDES = [[1, 1, 1], [1, 1, 0], [1, 0, 1], [1, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 0], [0, 0, 1]]

class Geometry {
	attributes = {}
	setAttribute(name, attribute) { this.attributes[name] = attribute }
	computeBoundingSphere() {}
}

// Mirrors the parts of Blockbench's Vertexsnap that the plugin relies on, with identity transforms.
function setup() {
	class Cube {}
	const cube = Object.assign(new Cube(), { from: [0, 0, 0], to: [2, 4, 6], origin: [0, 0, 0], mesh: {} })
	const mode = { value: 'scale', get() { return this.value } }
	const calls = []
	const native = {
		step1: true,
		addVertices(element) {
			if (element.mesh.vertex_points) return
			const vertices = [...CORNER_SIDES.map(sides => sides.map((side, axis) => side ? element.to[axis] : element.from[axis])), [0, 0, 0]]
			const geometry = new Geometry()
			geometry.setAttribute('position', { array: new Float32Array(vertices.flat()) })
			element.mesh.vertex_points = { vertices, geometry }
		},
		canvasClick(data) {
			if (this.step1) {
				this.step1 = false
				this.vertex_pos = data.vertex
				this.vertex_index = data.vertex_index
			} else this.snap(data)
		},
		snap(data, options = 0, amended) {
			calls.push({ index: this.vertex_index, options, amended })
			const sides = CORNER_SIDES[this.vertex_index]
			if (mode.get() === 'scale') data.target.forEach((value, axis) => {
				if (options.ignore_axis?.['xyz'[axis]]) return
				const delta = value - this.vertex_pos[axis]
				if (sides[axis]) cube.to[axis] += delta
				else cube.from[axis] += delta
			})
			this.step1 = true
		},
		select() { this.selected = true },
	}
	const Vertexsnap = { ...native }
	Object.assign(globalThis, {
		THREE: { Float32BufferAttribute: class { constructor(array) { this.array = new Float32Array(array) } } },
		Cube, Vertexsnap, Toolbox: { selected: null }, gizmo_colors: { grid: { toArray: () => [1, 1, 1] } },
		BarItems: { vertex_snap_mode: mode, vertex_snap_tool: {} }, adjustFromAndToForInflateAndStretch() {},
	})
	return { cube, mode, calls, native, Vertexsnap }
}

function hit(element, index) {
	const points = element.mesh.vertex_points
	return { type: 'vertex', element, vertex: points.vertices[index], vertex_index: index, intersect: { object: points } }
}

function snapBetween(Vertexsnap, start, target) {
	Vertexsnap.canvasClick(start)
	Vertexsnap.canvasClick({ ...start, target })
}

test('cube vertex points gain the 12 edge midpoints after the native points', () => {
	const { cube, Vertexsnap } = setup()
	const cleanup = installVertexSnapMidpoints()
	try {
		Vertexsnap.addVertices(cube)
		const points = cube.mesh.vertex_points
		assert.equal(points.vertices.length, 9 + 12)
		assert.deepEqual(points.vertices[8], [0, 0, 0])
		assert.ok(points.vertices.slice(9).every(p => p.filter((v, axis) => v === [1, 2, 3][axis]).length === 1))
		assert.equal(points.geometry.attributes.position.array.length, 21 * 3)
		assert.equal(points.geometry.attributes.color.array.length, 21 * 3)
		Vertexsnap.addVertices(cube)
		assert.equal(points.vertices.length, 21)
		const other = { from: [0, 0, 0], to: [1, 1, 1], mesh: {} }
		Vertexsnap.addVertices(other)
		assert.equal(other.mesh.vertex_points.vertices.length, 9)
	} finally { cleanup() }
})

test('scale snap from a midpoint moves the faces at its edge and keeps the edge length', () => {
	const { cube, calls, Vertexsnap } = setup()
	const cleanup = installVertexSnapMidpoints()
	try {
		Vertexsnap.addVertices(cube)
		const index = cube.mesh.vertex_points.vertices.findIndex((p, i) => i > 8 && p.join() === '1,4,0')
		snapBetween(Vertexsnap, hit(cube, index), [5, 7, -2])
		assert.deepEqual(cube.from, [0, 0, -2])
		assert.deepEqual(cube.to, [2, 7, 6])
		assert.deepEqual(CORNER_SIDES[calls[0].index].slice(1), [1, 0])
		Vertexsnap.snap({ target: [5, 7, -2] }, { ignore_axis: { x: false, y: false, z: false } }, true)
		assert.deepEqual(calls[1].options.ignore_axis, { x: true, y: false, z: false })
	} finally { cleanup() }
})

test('native corner starts and non-scale modes are passed through unchanged', () => {
	const { cube, mode, calls, Vertexsnap } = setup()
	const cleanup = installVertexSnapMidpoints()
	try {
		Vertexsnap.addVertices(cube)
		snapBetween(Vertexsnap, hit(cube, 0), [3, 5, 7])
		assert.deepEqual(calls[0], { index: 0, options: 0, amended: undefined })
		assert.deepEqual(cube.to, [3, 5, 7])
		mode.value = 'move'
		snapBetween(Vertexsnap, hit(cube, 12), [0, 0, 0])
		assert.deepEqual(calls[1], { index: 12, options: 0, amended: undefined })
	} finally { cleanup() }
})

test('unloading restores native snapping and drops a pending midpoint start', () => {
	const { cube, native, Vertexsnap } = setup()
	const cleanup = installVertexSnapMidpoints()
	Vertexsnap.addVertices(cube)
	Vertexsnap.canvasClick(hit(cube, 10))
	assert.equal(Vertexsnap.step1, false)
	Toolbox.selected = BarItems.vertex_snap_tool
	cleanup()
	assert.equal(Vertexsnap.step1, true)
	assert.equal(Vertexsnap.selected, true)
	for (const name of ['addVertices', 'canvasClick', 'snap']) assert.equal(Vertexsnap[name], native[name])
	delete cube.mesh.vertex_points
	Vertexsnap.addVertices(cube)
	assert.equal(cube.mesh.vertex_points.vertices.length, 9)
	Vertexsnap.selected = false
	const reloaded = installVertexSnapMidpoints()
	assert.equal(Vertexsnap.selected, true, 'loading with the tool active rebuilds the shown points')
	reloaded()
})

test('a later plugin wrapper is kept on unload and no longer receives midpoints', () => {
	const { cube, Vertexsnap } = setup()
	const cleanup = installVertexSnapMidpoints()
	const installed = Vertexsnap.addVertices
	const later = function (element) { return installed.call(this, element) }
	Vertexsnap.addVertices = later
	cleanup()
	assert.equal(Vertexsnap.addVertices, later)
	Vertexsnap.addVertices(cube)
	assert.equal(cube.mesh.vertex_points.vertices.length, 9)
})
