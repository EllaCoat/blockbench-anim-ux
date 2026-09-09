import assert from 'node:assert/strict'
import test from 'node:test'
import { cubeEdgeMidpoints } from '../dist-test/cubeEdgeMidpoints.mjs'

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

test('midpoint coordinates match the Float32 geometry used for rendering', () => {
	const points = cubeEdgeMidpoints(box([0.1, 0.2, 0.3], [0.6, 0.8, 0.9]))
	assert.ok(points.flat().every(value => value === Math.fround(value)))
})
