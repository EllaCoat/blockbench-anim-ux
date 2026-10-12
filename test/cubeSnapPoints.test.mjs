import assert from 'node:assert/strict'
import test from 'node:test'
import { cubeCorners, cubeEdgeMidpoints, cubeSnapBounds } from '../dist-test/cubeSnapPoints.mjs'

function box(min, max) {
	return new Float32Array([min[0], max[0]].flatMap(x =>
		[min[1], max[1]].flatMap(y => [min[2], max[2]].flatMap(z => [x, y, z]))))
}

test('cuboid supplies exactly its 12 edge midpoints without face or volume centers', () => {
	const points = cubeEdgeMidpoints(box([2, -4, 6], [8, 10, 20]))
	assert.equal(points.length, 12)
	assert.equal(new Set(points.map(p => p.join(','))).size, 12)
	for (const point of points) {
		assert.equal(point.filter((value, axis) => value === [5, 3, 13][axis]).length, 1)
		assert.ok(point.every((value, axis) => [[2, 5, 8], [-4, 3, 10], [6, 13, 20]][axis].includes(value)))
	}
})

test('flat cubes expose four distinct perimeter midpoints in each plane', () => {
	for (let flatAxis = 0; flatAxis < 3; flatAxis++) {
		const min = [-3, 2, 5]
		const max = [7, 14, 21]
		max[flatAxis] = min[flatAxis]
		const points = cubeEdgeMidpoints(box(min, max))
		assert.equal(points.length, 4)
		assert.ok(points.every(p => p[flatAxis] === min[flatAxis]))
	}
})

test('line cubes expose one midpoint and collapsed cubes expose no edges', () => {
	assert.deepEqual(cubeEdgeMidpoints(box([3, 2, -5], [3, 12, -5])), [[3, 7, -5]])
	assert.deepEqual(cubeEdgeMidpoints(box([3, 2, -5], [3, 2, -5])), [])
	assert.deepEqual(cubeEdgeMidpoints([]), [])
})

test('cuboid corners are its 8 distinct bound combinations', () => {
	const points = cubeCorners(box([2, -4, 6], [8, 10, 20]))
	assert.equal(points.length, 8)
	assert.equal(new Set(points.map(p => p.join(','))).size, 8)
	assert.ok(points.every(p => p.every((value, axis) => [[2, 8], [-4, 10], [6, 20]][axis].includes(value))))
})

test('collapsed axes merge corners instead of duplicating them', () => {
	assert.equal(cubeCorners(box([-3, 2, 5], [7, 2, 21])).length, 4)
	assert.deepEqual(cubeCorners(box([3, 2, -5], [3, 12, -5])), [[3, 2, -5], [3, 12, -5]])
	assert.deepEqual(cubeCorners(box([3, 2, -5], [3, 2, -5])), [[3, 2, -5]])
	assert.deepEqual(cubeCorners([]), [])
})

test('snap bounds are origin-relative, inflated, and keep collapsed axes flat', () => {
	globalThis.adjustFromAndToForInflateAndStretch = (from, to) => {
		for (let axis = 0; axis < 3; axis++) { from[axis] -= 0.5; to[axis] += 0.5 }
	}
	const cube = { from: [1, 2, 3], to: [4, 2, 9], origin: [1, 1, 1] }
	assert.deepEqual([...cubeSnapBounds(cube)], [-0.5, 0.5, 1.5, 3.5, 1.5, 8.5])
	assert.deepEqual(cube.from, [1, 2, 3])
	globalThis.adjustFromAndToForInflateAndStretch = () => {}
	assert.deepEqual([...cubeSnapBounds({ from: [0, 5, 0], to: [2, 5, 2], origin: [0, 0, 0] })], [0, 5, 0, 2, 5, 2])
})

test('midpoint coordinates match the Float32 geometry used for rendering', () => {
	const points = cubeEdgeMidpoints(box([0.1, 0.2, 0.3], [0.6, 0.8, 0.9]))
	assert.ok(points.flat().every(value => value === Math.fround(value)))
})
