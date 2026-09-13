import assert from 'node:assert/strict'
import test from 'node:test'
import { installCubeFaceDirections } from '../dist-test/installCubeFaceDirections.mjs'

class Element {
	children = []
	style = {}
	attributes = {}
	setAttribute(name, value) { this.attributes[name] = value }
	append(child) { this.children.push(child); child.parent = this }
	remove() { this.parent.children = this.parent.children.filter(child => child !== this) }
}
class Vector {
	constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }) }
	copy({ x, y, z }) { Object.assign(this, { x, y, z }); return this }
	fromBufferAttribute(attribute, index) { return this.copy(attribute[index]) }
	applyMatrix4(matrix) { return this.copy(matrix(this)) }
	project(camera) { return this.copy(camera.project(this)) }
}
function cube() {
	const faces = Object.fromEntries(['north', 'east', 'south', 'west', 'up', 'down']
		.map((name, index) => [name, { getVertexIndices: () => [index] }]))
	const position = [{ x: 0, y: 0, z: -1 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 },
		{ x: -1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }]
	return { faces, mesh: { visible: true, matrixWorld: v => v, geometry: { attributes: { position }, boundingBox: {
		min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 },
		getCenter(out) { return out.copy({ x: 0, y: 0, z: 0 }) },
	} } } }
}
function setup(t) {
	const listeners = new Map()
	const selected = cube()
	class Preview {
		node = new Element()
		canvas = { isConnected: true, offsetLeft: 0, offsetTop: 0 }
		width = 400
		height = 200
		camera = { project: ({ x, y, z }) => ({ x: (x + z * 0.5) / 4, y: (y + z * 0.5) / 4, z: z / 10 }) }
		render(...args) { this.beforeRender?.(); return args }
	}
	const preview = new Preview()
	Preview.all = [preview]
	const tool = {}
	Object.assign(globalThis, {
		THREE: { Vector3: Vector }, Cube: { selected: [selected] }, Modes: { edit: true },
		Toolbox: { selected: tool }, BarItems: { move_tool: tool }, Preview, Project: {},
		document: { createElement: () => new Element() },
		Blockbench: {
			on(event, listener) { listeners.set(event, listener) },
			removeListener(event, listener) { if (listeners.get(event) === listener) listeners.delete(event) },
		},
	})
	const original = Preview.prototype.render
	const cleanup = installCubeFaceDirections()
	t.after(cleanup)
	const labels = () => preview.node.children[0]?.children ?? []
	return { preview, selected, labels, listeners, cleanup, original, Preview }
}

test('six faint non-interactive face labels appear after native rendering with correct local directions', t => {
	const { preview, labels } = setup(t)
	let rendered = false
	preview.beforeRender = () => { rendered = true; assert.equal(labels().length, 0) }
	assert.deepEqual(preview.render('native argument'), ['native argument'])
	assert.ok(rendered)
	const list = labels()
	assert.deepEqual(list.map(label => label.textContent), ['N', 'E', 'S', 'W', 'U', 'D'])
	const [n, e, s, w, u, d] = list.map(label => [parseFloat(label.style.left), parseFloat(label.style.top)])
	assert.ok(n[0] < 200 && n[1] > 100)
	assert.ok(s[0] > 200 && s[1] < 100)
	assert.ok(e[0] > 200 && w[0] < 200 && u[1] < 100 && d[1] > 100)
	assert.ok(list.every(label => /font:11px/.test(label.style.cssText) && /opacity:0.65/.test(label.style.cssText)))
	assert.match(preview.node.children[0].style.cssText, /pointer-events:none/)
	assert.equal(preview.node.children[0].attributes['aria-hidden'], 'true')
})

test('labels reuse nodes and follow the current mesh transform, camera, and viewport size without editing data', t => {
	const { preview, selected, labels } = setup(t)
	preview.render()
	const list = labels()
	const before = list.map(label => label.style.left)
	selected.mesh.matrixWorld = ({ x, y, z }) => ({ x: -x, y, z: -z })
	const state = JSON.stringify(selected)
	preview.render()
	assert.deepEqual(labels(), list)
	assert.ok(parseFloat(list[1].style.left) < 200)
	assert.notDeepEqual(list.map(label => label.style.left), before)
	preview.width = 800
	preview.camera.project = ({ x, y, z }) => ({ x: x / 8, y: y / 8, z: z / 10 })
	preview.render()
	assert.equal(JSON.stringify(selected), state)
	assert.notEqual(list[0].style.left, list[2].style.left, 'axis-aligned labels must not coincide')
})

test('each editor viewport and selected cube owns labels, while hidden/locked cubes and media previews are excluded', t => {
	const { preview, selected, labels, Preview } = setup(t)
	const second = cube()
	Cube.selected.push(second)
	const split = new Preview()
	Preview.all.push(split)
	preview.render(); split.render()
	assert.equal(labels().length, 12)
	assert.equal(split.node.children[0].children.length, 12)
	second.mesh.parent = { visible: false }
	preview.render()
	assert.equal(labels().length, 6)
	selected.locked = true
	preview.render()
	assert.equal(labels().length, 0)
	selected.locked = false
	selected.visibility = false
	preview.render()
	assert.equal(labels().length, 0)
	const media = new Preview()
	media.offscreen = true
	Preview.all.push(media)
	media.render()
	assert.equal(media.node.children.length, 0)
	preview.canvas.isConnected = false
	selected.visibility = true
	preview.render()
	assert.equal(labels().length, 0)
})

test('selection, mode, tool and project changes clear overlays, with no labels outside Edit Move', t => {
	const { preview, selected, labels, listeners } = setup(t)
	for (const event of ['unselect_project', 'close_project', 'select_mode', 'update_selection']) {
		preview.render()
		assert.equal(labels().length, 6)
		listeners.get(event)()
		assert.equal(labels().length, 0)
	}
	Cube.selected = []; preview.render(); assert.equal(labels().length, 0)
	Cube.selected = [selected]
	Modes.edit = false; preview.render(); assert.equal(labels().length, 0)
	Modes.edit = true
	Toolbox.selected = {}; preview.render(); assert.equal(labels().length, 0)
	Toolbox.selected = BarItems.move_tool
	Project = null; preview.render(); assert.equal(labels().length, 0)
})

test('out-of-depth and non-finite projections are hidden', t => {
	const { preview, labels } = setup(t)
	for (const depth of [-2, 2, Infinity, NaN]) {
		preview.camera.project = ({ x, y }) => ({ x, y, z: depth })
		preview.render()
		assert.ok(labels().every(label => label.hidden))
	}
})

test('inverted cube bounds follow native face identity rather than bounding-box order', t => {
	const { preview, selected, labels } = setup(t)
	selected.mesh.geometry.attributes.position[1].x = -1
	selected.mesh.geometry.attributes.position[3].x = 1
	preview.render()
	assert.ok(parseFloat(labels()[1].style.left) < 200, 'East follows its native negative-X face')
	assert.ok(parseFloat(labels()[3].style.left) > 200, 'West follows its native positive-X face')
})

test('overlay bounds follow a fixed-aspect canvas offset and size', t => {
	const { preview } = setup(t)
	preview.canvas.offsetLeft = 30
	preview.canvas.offsetTop = 80
	preview.width = 200
	preview.height = 200
	preview.render()
	const style = preview.node.children[0].style
	assert.equal(style.left, '30px')
	assert.equal(style.top, '80px')
	assert.equal(style.width, '200px')
	assert.equal(style.height, '200px')
})

test('unload removes labels/listeners and safely restores or chains the native renderer', t => {
	const { preview, labels, cleanup, original, listeners, Preview } = setup(t)
	preview.render()
	cleanup()
	assert.equal(labels().length, 0)
	assert.equal(listeners.size, 0)
	assert.equal(Preview.prototype.render, original)
	const cleanupAgain = installCubeFaceDirections()
	const installedRender = Preview.prototype.render
	const laterRender = function (...args) { return installedRender.apply(this, args) }
	Preview.prototype.render = laterRender
	cleanupAgain()
	assert.equal(Preview.prototype.render, laterRender)
	preview.render()
	assert.equal(labels().length, 0)
})
