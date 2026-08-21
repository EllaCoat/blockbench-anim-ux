import assert from 'node:assert/strict'
import test from 'node:test'

import {
	ExplicitTexelLayoutError,
	planExplicitTexelLayout,
} from '../dist-test/explicitTexelLayout.mjs'
import { applyExplicitTexelLayout } from '../dist-test/installExplicitTexelLayout.mjs'

const texture = (pixelWidth = 32, pixelHeight = 32, uvWidth = pixelWidth, uvHeight = pixelHeight) => ({
	pixelWidth,
	pixelHeight,
	uvWidth,
	uvHeight,
})

const dimensions = (x, y, z) => ({ x, y, z })

test('places a 5 texel cube independently of 5.5 geometry units', () => {
	const plan = planExplicitTexelLayout({
		// The extra geometry value documents the contract: it is intentionally not
		// used when the physical texel dimensions are explicit.
		geometry: [5.5, 5.5, 5.5],
		dimensions: dimensions(5, 5, 5),
		texture: texture(32, 32),
	})

	assert.deepEqual(plan.origin, { x: 0, y: 0 })
	assert.deepEqual(plan.bounds, { width: 20, height: 10 })
	assert.deepEqual(plan.faces.up.uv, [10, 5, 5, 0])
	assert.deepEqual(plan.faces.down.uv, [15, 0, 10, 5])
})

test('places a 2 texel cube independently of 3.7 geometry units', () => {
	const plan = planExplicitTexelLayout({
		geometry: [3.7, 3.7, 3.7],
		dimensions: dimensions(2, 2, 2),
		texture: texture(16, 16),
	})

	assert.deepEqual(plan.bounds, { width: 8, height: 4 })
	assert.deepEqual(plan.faces.north.uv, [2, 2, 4, 4])
})

test('uses the Blockbench six-face net and preserves up/down flips', () => {
	const plan = planExplicitTexelLayout({
		dimensions: dimensions(2, 3, 4),
		texture: texture(32, 32),
	})

	assert.deepEqual(plan.faces.east.uv, [0, 4, 4, 7])
	assert.deepEqual(plan.faces.north.uv, [4, 4, 6, 7])
	assert.deepEqual(plan.faces.west.uv, [6, 4, 10, 7])
	assert.deepEqual(plan.faces.south.uv, [10, 4, 12, 7])
	assert.deepEqual(plan.faces.up.uv, [6, 4, 4, 0])
	assert.deepEqual(plan.faces.down.uv, [8, 0, 6, 4])
})

test('converts physical pixels to non-1:1 Blockbench UV units', () => {
	const plan = planExplicitTexelLayout({
		dimensions: dimensions(2, 1, 3),
		texture: texture(32, 16, 16, 8),
	})

	assert.deepEqual(plan.faces.east.uv, [0, 1.5, 1.5, 2])
	assert.deepEqual(plan.faces.north.uv, [1.5, 1.5, 2.5, 2])
	assert.deepEqual(plan.faces.up.uv, [2.5, 1.5, 1.5, 0])
})

test('avoids occupied rectangles from existing faces in physical pixel space', () => {
	const plan = planExplicitTexelLayout({
		dimensions: dimensions(1, 1, 1),
		texture: texture(8, 4),
		occupied: [{ uv: [0, 1, 1, 2] }],
	})

	assert.deepEqual(plan.origin, { x: 0, y: 1 })
})

test('uses Blockbench diagonal first-fit order', () => {
	const plan = planExplicitTexelLayout({
		dimensions: dimensions(1, 1, 1),
		texture: texture(8, 4),
		occupied: [{ uv: [1, 0, 2, 1] }],
	})

	assert.deepEqual(plan.origin, { x: 0, y: 1 })
})

test('handles reversed occupied UV rectangles and keeps the candidate in bounds', () => {
	const plan = planExplicitTexelLayout({
		dimensions: dimensions(1, 1, 1),
		texture: texture(8, 4),
		occupied: [{ uv: [1, 2, 0, 1] }],
	})

	assert.deepEqual(plan.origin, { x: 0, y: 1 })
	for (const face of Object.values(plan.faces)) {
		for (const value of face.uv) assert.ok(value >= 0 && value <= 8)
	}
})

test('fits exactly at the texture boundary', () => {
	const plan = planExplicitTexelLayout({
		dimensions: dimensions(1, 1, 1),
		texture: texture(4, 2),
	})

	assert.deepEqual(plan.origin, { x: 0, y: 0 })
	assert.deepEqual(plan.faces.south.uv, [3, 1, 4, 2])
})

test('reports no space without returning a partial plan', () => {
	assert.throws(
		() => planExplicitTexelLayout({ dimensions: dimensions(1, 1, 1), texture: texture(3, 2) }),
		(error) => error instanceof ExplicitTexelLayoutError && error.code === 'no-space' && error.noChange,
	)

	assert.throws(
		() => planExplicitTexelLayout({
			dimensions: dimensions(1, 1, 1),
			texture: texture(4, 2),
			occupied: [{ uv: [0, 0, 4, 2] }],
		}),
		(error) => error instanceof ExplicitTexelLayoutError && error.code === 'no-space' && error.noChange,
	)
})

test('rejects zero, fractional, and non-finite input dimensions', () => {
	for (const invalid of [
		dimensions(0, 1, 1),
		dimensions(1.5, 1, 1),
		dimensions(1, Number.NaN, 1),
		dimensions(1, 1, Number.POSITIVE_INFINITY),
	]) {
		assert.throws(
			() => planExplicitTexelLayout({ dimensions: invalid, texture: texture() }),
			(error) => error instanceof ExplicitTexelLayoutError && error.code === 'invalid-input' && error.noChange,
		)
	}
})

test('rejects invalid texture dimensions and occupied UV input', () => {
	assert.throws(
		() => planExplicitTexelLayout({ dimensions: dimensions(1, 1, 1), texture: texture(0, 4) }),
		(error) => error instanceof ExplicitTexelLayoutError && error.code === 'invalid-input',
	)
	assert.throws(
		() => planExplicitTexelLayout({
			dimensions: dimensions(1, 1, 1),
			texture: texture(),
			occupied: [{ uv: [0, 0, Number.NaN, 1] }],
		}),
		(error) => error instanceof ExplicitTexelLayoutError && error.code === 'invalid-input',
	)
})

test('returns the same result deterministically', () => {
	const input = {
		dimensions: dimensions(2, 2, 1),
		texture: texture(16, 16),
		occupied: [{ uv: [0, 0, 2, 2] }, { uv: [8, 3, 10, 8] }],
	}
	assert.deepEqual(planExplicitTexelLayout(input), planExplicitTexelLayout(input))
})

function cube(name = 'target') {
	return {
		name,
		from: [0.25, 1.5, 2.75],
		to: [5.75, 7, 8.25],
		box_uv: true,
		autouv: 1,
		mirror_uv: true,
		faces: Object.fromEntries(['east', 'north', 'west', 'up', 'down', 'south'].map(face => [face, {
			uv: [0, 0, 1, 1],
			texture: 'old-texture',
			rotation: 90,
			tint: 3,
			enabled: true,
		}])),
	}
}

function hostFor(target, {
	allCubes = [target],
	failOnFace,
	layout = texture(16, 16),
	nonCubeFaces = [],
	supportsFaceTextureAssignment = true,
} = {}) {
	const chosenTexture = { uuid: 'chosen-texture' }
	const calls = []
	let before
	const host = {
		selectedCubes: () => [target],
		allCubes: () => allCubes,
		nonCubeFaces: () => nonCubeFaces,
		textures: () => [chosenTexture],
		supportsFaceTextureAssignment: () => supportsFaceTextureAssignment,
		textureId: value => typeof value === 'string' ? value : value?.uuid ?? null,
		textureLayout: () => layout,
		beginUndo: () => {
			calls.push('begin')
			before = structuredClone(target)
			if (failOnFace) {
				Object.defineProperty(target.faces[failOnFace], 'uv', {
					configurable: true,
					get: () => before.faces[failOnFace].uv,
					set: () => { throw new Error('host mutation failed') },
				})
			}
		},
		finishUndo: () => calls.push('finish'),
		cancelUndo: () => {
			calls.push('cancel')
			for (const key of Object.keys(before)) target[key] = structuredClone(before[key])
		},
		refresh: () => calls.push('refresh'),
	}
	return { host, calls }
}

test('applies six faces as one Undo while preserving geometry and non-UV face properties', () => {
	const target = cube()
	const geometryBefore = { from: [...target.from], to: [...target.to] }
	const { host, calls } = hostFor(target)

	applyExplicitTexelLayout({
		textureId: 'chosen-texture',
		dimensions: dimensions(2, 3, 1),
	}, host)

	assert.deepEqual(calls, ['begin', 'finish', 'refresh'])
	assert.deepEqual({ from: target.from, to: target.to }, geometryBefore)
	assert.equal(target.box_uv, false)
	assert.equal(target.autouv, 0)
	assert.equal(target.mirror_uv, true)
	for (const face of Object.values(target.faces)) {
		assert.equal(face.texture, 'chosen-texture')
		assert.equal(face.rotation, 0)
		assert.equal(face.tint, 3)
		assert.equal(face.enabled, true)
	}
})

test('preflight failure opens no Undo entry and leaves the cube unchanged', () => {
	const target = cube()
	const before = structuredClone(target)
	const { host, calls } = hostFor(target, { layout: texture(3, 2) })

	assert.throws(
		() => applyExplicitTexelLayout({ textureId: 'chosen-texture', dimensions: dimensions(1, 1, 1) }, host),
		(error) => error?.code === 'no-space' && error?.noChange === true,
	)
	assert.deepEqual(calls, [])
	assert.deepEqual(target, before)
})

test('rejects a texture used by a non-cube element before opening Undo', () => {
	const target = cube()
	const before = structuredClone(target)
	const { host, calls } = hostFor(target, {
		nonCubeFaces: [{ texture: 'chosen-texture' }],
	})

	assert.throws(
		() => applyExplicitTexelLayout({ textureId: 'chosen-texture', dimensions: dimensions(1, 1, 1) }, host),
		(error) => error?.code === 'invalid-input' && error?.noChange === true,
	)
	assert.deepEqual(calls, [])
	assert.deepEqual(target, before)
})

test('rejects formats that override per-face texture assignment before opening Undo', () => {
	const target = cube()
	const before = structuredClone(target)
	const { host, calls } = hostFor(target, {
		supportsFaceTextureAssignment: false,
	})

	assert.throws(
		() => applyExplicitTexelLayout({ textureId: 'chosen-texture', dimensions: dimensions(1, 1, 1) }, host),
		(error) => error?.code === 'invalid-input' && error?.noChange === true,
	)
	assert.deepEqual(calls, [])
	assert.deepEqual(target, before)
})

test('host mutation failure invokes rollback and does not finish the Undo entry', () => {
	const target = cube()
	const before = structuredClone(target)
	const { host, calls } = hostFor(target, { failOnFace: 'west' })

	assert.throws(
		() => applyExplicitTexelLayout({ textureId: 'chosen-texture', dimensions: dimensions(1, 1, 1) }, host),
		/host mutation failed/,
	)
	assert.deepEqual(calls, ['begin', 'cancel'])
	assert.deepEqual(target, before)
})
