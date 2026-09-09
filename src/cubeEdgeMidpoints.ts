export type Vertex = [number, number, number]

/** Cube geometry is axis-aligned in mesh-local space; its parent owns rotation. */
export function cubeEdgeMidpoints(positions: ArrayLike<number>): Vertex[] {
	if (positions.length === 0) return []
	const min: Vertex = [Infinity, Infinity, Infinity]
	const max: Vertex = [-Infinity, -Infinity, -Infinity]
	for (let i = 0; i < positions.length; i++) {
		const axis = i % 3
		min[axis] = Math.min(min[axis], positions[i])
		max[axis] = Math.max(max[axis], positions[i])
	}
	const points: Vertex[] = []
	const seen = new Set<string>()
	for (let axis = 0; axis < 3; axis++) {
		if (min[axis] === max[axis]) continue
		const a = (axis + 1) % 3
		const b = (axis + 2) % 3
		for (const edgeA of [min[a], max[a]]) {
			for (const edgeB of [min[b], max[b]]) {
				const point: Vertex = [0, 0, 0]
				point[axis] = Math.fround((min[axis] + max[axis]) / 2)
				point[a] = edgeA
				point[b] = edgeB
				const key = point.join(',')
				if (seen.has(key)) continue
				seen.add(key)
				points.push(point)
			}
		}
	}
	return points
}
