export type Vertex = [number, number, number]

declare function adjustFromAndToForInflateAndStretch(from: number[], to: number[], cube: any): void

/** Mesh-local `[from, to]` of a Cube, including inflate and stretch. */
export function cubeSnapBounds(cube: any): Float32Array {
	const from = cube.from.slice()
	const to = cube.to.slice()
	adjustFromAndToForInflateAndStretch(from, to, cube)
	// The renderer adds 0.001 to collapsed axes; snap to the actual Cube plane.
	return new Float32Array([...from, ...to].map((v, i) => v - cube.origin[i % 3]))
}

function extent(positions: ArrayLike<number>): { min: Vertex; max: Vertex } | undefined {
	if (positions.length === 0) return
	const min: Vertex = [Infinity, Infinity, Infinity]
	const max: Vertex = [-Infinity, -Infinity, -Infinity]
	for (let i = 0; i < positions.length; i++) {
		const axis = i % 3
		min[axis] = Math.min(min[axis], positions[i])
		max[axis] = Math.max(max[axis], positions[i])
	}
	return { min, max }
}

function unique(points: Vertex[]): Vertex[] {
	const seen = new Set<string>()
	return points.filter(point => {
		const key = point.join(',')
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}

/** Cube geometry is axis-aligned in mesh-local space; its parent owns rotation. */
export function cubeCorners(positions: ArrayLike<number>): Vertex[] {
	const box = extent(positions)
	if (!box) return []
	const { min, max } = box
	return unique([min[0], max[0]].flatMap(x => [min[1], max[1]].flatMap(y =>
		[min[2], max[2]].map((z): Vertex => [x, y, z]))))
}

export function cubeEdgeMidpoints(positions: ArrayLike<number>): Vertex[] {
	const box = extent(positions)
	if (!box) return []
	const { min, max } = box
	const points: Vertex[] = []
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
				points.push(point)
			}
		}
	}
	return unique(points)
}
