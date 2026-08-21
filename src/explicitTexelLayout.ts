/**
 * Plan B: place one cube's six face UVs for an explicit physical texel size.
 *
 * The layout coordinates intentionally follow Blockbench's face-template net
 * (see `TextureGenerator.boxUVCubeTemplate`), while the requested dimensions
 * are physical texture cells rather than geometry units.
 */

export const EXPLICIT_TEXEL_FACES = [
	'east',
	'north',
	'west',
	'up',
	'down',
	'south',
] as const

export type ExplicitTexelFace = (typeof EXPLICIT_TEXEL_FACES)[number]
export type UVRect = readonly [number, number, number, number]

export interface TexelDimensions {
	x: number
	y: number
	z: number
}

export interface LayoutTexture {
	/** Physical image width in pixels. */
	pixelWidth: number
	/** Physical image height in pixels. */
	pixelHeight: number
	/** Blockbench UV width for the chosen texture. */
	uvWidth: number
	/** Blockbench UV height for the chosen texture. */
	uvHeight: number
}

export interface OccupiedUVRect {
	uv: UVRect
}

export interface PhysicalFaceRect {
	face: ExplicitTexelFace
	x: number
	y: number
	width: number
	height: number
}

export interface PlannedUVFace extends PhysicalFaceRect {
	uv: UVRect
}

export interface ExplicitTexelLayoutPlan {
	origin: { x: number; y: number }
	bounds: { width: number; height: number }
	dimensions: TexelDimensions
	faces: Record<ExplicitTexelFace, PlannedUVFace>
}

export type ExplicitTexelLayoutErrorCode = 'invalid-input' | 'no-space'

export class ExplicitTexelLayoutError extends Error {
	readonly code: ExplicitTexelLayoutErrorCode
	readonly noChange = true

	constructor(code: ExplicitTexelLayoutErrorCode, message: string) {
		super(message)
		this.name = 'ExplicitTexelLayoutError'
		this.code = code
	}
}

const EPSILON = 1e-9

function invalid(message: string): never {
	throw new ExplicitTexelLayoutError('invalid-input', message)
}

function isFinitePositive(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function validateDimensions(dimensions: TexelDimensions): void {
	if (!dimensions || typeof dimensions !== 'object') {
		invalid('Texel dimensions are required.')
	}
	for (const axis of ['x', 'y', 'z'] as const) {
		const value = dimensions[axis]
		if (!Number.isInteger(value) || value <= 0) {
			invalid(`Texel dimension ${axis} must be a positive integer.`)
		}
	}
}

function validateTexture(texture: LayoutTexture): void {
	if (!texture || typeof texture !== 'object') {
		invalid('Texture dimensions are required.')
	}
	if (!Number.isInteger(texture.pixelWidth) || texture.pixelWidth <= 0) {
		invalid('Texture pixel width must be a positive integer.')
	}
	if (!Number.isInteger(texture.pixelHeight) || texture.pixelHeight <= 0) {
		invalid('Texture pixel height must be a positive integer.')
	}
	if (!isFinitePositive(texture.uvWidth) || !isFinitePositive(texture.uvHeight)) {
		invalid('Texture UV dimensions must be finite positive numbers.')
	}
}

function validateOccupied(occupied: readonly OccupiedUVRect[]): void {
	if (!Array.isArray(occupied)) invalid('Occupied UV rectangles must be an array.')
	for (const entry of occupied) {
		if (!entry || !Array.isArray(entry.uv) || entry.uv.length !== 4) {
			invalid('Every occupied UV rectangle must contain four coordinates.')
		}
		if (entry.uv.some((value) => !Number.isFinite(value))) {
			invalid('Occupied UV rectangles must contain finite coordinates.')
		}
	}
}

function faceRects(dimensions: TexelDimensions): Record<ExplicitTexelFace, PhysicalFaceRect> {
	const { x, y, z } = dimensions
	return {
		east: { face: 'east', x: 0, y: z, width: z, height: y },
		north: { face: 'north', x: z, y: z, width: x, height: y },
		west: { face: 'west', x: z + x, y: z, width: z, height: y },
		up: { face: 'up', x: z + x, y: z, width: -x, height: -z },
		down: { face: 'down', x: z + x * 2, y: 0, width: -x, height: z },
		south: { face: 'south', x: z * 2 + x, y: z, width: x, height: y },
	}
}

function markUVRect(
	occupiedCells: Uint8Array,
	texture: LayoutTexture,
	uv: UVRect,
): void {
	const minU = Math.min(uv[0], uv[2]) * texture.pixelWidth / texture.uvWidth
	const maxU = Math.max(uv[0], uv[2]) * texture.pixelWidth / texture.uvWidth
	const minV = Math.min(uv[1], uv[3]) * texture.pixelHeight / texture.uvHeight
	const maxV = Math.max(uv[1], uv[3]) * texture.pixelHeight / texture.uvHeight
	if (maxU - minU <= EPSILON || maxV - minV <= EPSILON) return

	const startX = Math.max(0, Math.floor(minU + EPSILON))
	const endX = Math.min(texture.pixelWidth - 1, Math.ceil(maxU - EPSILON) - 1)
	const startY = Math.max(0, Math.floor(minV + EPSILON))
	const endY = Math.min(texture.pixelHeight - 1, Math.ceil(maxV - EPSILON) - 1)
	if (startX > endX || startY > endY) return

	for (let pixelY = startY; pixelY <= endY; pixelY += 1) {
		const row = pixelY * texture.pixelWidth
		for (let pixelX = startX; pixelX <= endX; pixelX += 1) {
			occupiedCells[row + pixelX] = 1
		}
	}
}

function markPhysicalRect(
	occupiedCells: Uint8Array,
	texture: LayoutTexture,
	face: PhysicalFaceRect,
	originX: number,
	originY: number,
): boolean {
	const left = originX + Math.min(face.x, face.x + face.width)
	const right = originX + Math.max(face.x, face.x + face.width)
	const top = originY + Math.min(face.y, face.y + face.height)
	const bottom = originY + Math.max(face.y, face.y + face.height)
	for (let pixelY = top; pixelY < bottom; pixelY += 1) {
		const row = pixelY * texture.pixelWidth
		for (let pixelX = left; pixelX < right; pixelX += 1) {
			if (occupiedCells[row + pixelX] !== 0) return false
		}
	}
	return true
}

function makeUVRect(
	face: PhysicalFaceRect,
	originX: number,
	originY: number,
	texture: LayoutTexture,
): PlannedUVFace {
	const uvPerPixelX = texture.uvWidth / texture.pixelWidth
	const uvPerPixelY = texture.uvHeight / texture.pixelHeight
	const left = originX + face.x
	const top = originY + face.y
	return {
		...face,
		uv: [
			left * uvPerPixelX,
			top * uvPerPixelY,
			(left + face.width) * uvPerPixelX,
			(top + face.height) * uvPerPixelY,
		],
	}
}

/**
 * Build a complete, deterministic six-face plan without mutating Blockbench.
 * The scan follows Blockbench's diagonal first-fit order to make repeated runs
 * stable for the same texture and occupied-face input.
 */
export function planExplicitTexelLayout(input: {
	dimensions: TexelDimensions
	texture: LayoutTexture
	occupied?: readonly OccupiedUVRect[]
}): ExplicitTexelLayoutPlan {
	if (!input || typeof input !== 'object') invalid('A layout request is required.')
	validateDimensions(input.dimensions)
	validateTexture(input.texture)
	const occupied = input.occupied ?? []
	validateOccupied(occupied)

	const faces = faceRects(input.dimensions)
	const bounds = {
		width: 2 * (input.dimensions.x + input.dimensions.z),
		height: input.dimensions.y + input.dimensions.z,
	}
	if (bounds.width > input.texture.pixelWidth || bounds.height > input.texture.pixelHeight) {
		throw new ExplicitTexelLayoutError(
			'no-space',
			`The ${bounds.width}x${bounds.height} cube net does not fit in the ${input.texture.pixelWidth}x${input.texture.pixelHeight} texture.`,
		)
	}

	const occupiedCells = new Uint8Array(input.texture.pixelWidth * input.texture.pixelHeight)
	for (const entry of occupied) markUVRect(occupiedCells, input.texture, entry.uv)

	const maxOriginX = input.texture.pixelWidth - bounds.width
	const maxOriginY = input.texture.pixelHeight - bounds.height
	// ponytail: fixed-texture diagonal scan; use an indexed packer only after measured UI latency on large textures.
	const tryOrigin = (originX: number, originY: number): ExplicitTexelLayoutPlan | undefined => {
		if (originX > maxOriginX || originY > maxOriginY) return undefined
			const fits = EXPLICIT_TEXEL_FACES.every((face) =>
				markPhysicalRect(occupiedCells, input.texture, faces[face], originX, originY),
			)
			if (!fits) return undefined

			const plannedFaces = {} as Record<ExplicitTexelFace, PlannedUVFace>
			for (const face of EXPLICIT_TEXEL_FACES) {
				plannedFaces[face] = makeUVRect(faces[face], originX, originY, input.texture)
			}
			return {
				origin: { x: originX, y: originY },
				bounds,
				dimensions: { ...input.dimensions },
				faces: plannedFaces,
			}
	}
	for (let line = 0; line <= Math.max(maxOriginX, maxOriginY); line += 1) {
		for (let space = 0; space <= line; space += 1) {
			const vertical = tryOrigin(space, line)
			if (vertical) return vertical
			if (space === line) continue
			const horizontal = tryOrigin(line, space)
			if (horizontal) return horizontal
		}
	}

	throw new ExplicitTexelLayoutError(
		'no-space',
		`No free ${bounds.width}x${bounds.height} cube net is available in the selected texture.`,
	)
}
