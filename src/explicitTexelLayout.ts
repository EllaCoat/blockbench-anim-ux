/**
 * Place the selected cube faces for an explicit physical texel size.
 *
 * Face orientation follows Blockbench's face-template net (see
 * `TextureGenerator.boxUVCubeTemplate`), while each face is packed as an
 * independent physical texture rectangle.
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
	faces: Partial<Record<ExplicitTexelFace, PlannedUVFace>>
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
	const make = (face: ExplicitTexelFace, width: number, height: number): PhysicalFaceRect => ({
		face,
		x: width < 0 ? -width : 0,
		y: height < 0 ? -height : 0,
		width,
		height,
	})
	return {
		east: make('east', z, y),
		north: make('north', x, y),
		west: make('west', z, y),
		up: make('up', -x, -z),
		down: make('down', -x, z),
		south: make('south', x, y),
	}
}

function isExplicitTexelFace(value: unknown): value is ExplicitTexelFace {
	return typeof value === 'string' && (EXPLICIT_TEXEL_FACES as readonly string[]).includes(value)
}

function activeFaceOrder(
	activeFaces: readonly ExplicitTexelFace[],
	faces: Record<ExplicitTexelFace, PhysicalFaceRect>,
): ExplicitTexelFace[] {
	const seen = new Set<ExplicitTexelFace>()
	for (const face of activeFaces) {
		if (!isExplicitTexelFace(face)) invalid(`Unknown cube face "${String(face)}".`)
		if (seen.has(face)) invalid(`Cube face "${face}" was specified more than once.`)
		seen.add(face)
	}
	if (activeFaces.length === 0) invalid('At least one cube face must be available for layout.')

	return [...activeFaces].sort(
		(left, right) =>
			Math.abs(faces[right].width * faces[right].height) -
				Math.abs(faces[left].width * faces[left].height) ||
			EXPLICIT_TEXEL_FACES.indexOf(left) - EXPLICIT_TEXEL_FACES.indexOf(right),
	)
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

function physicalRectFits(
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
	if (left < 0 || top < 0 || right > texture.pixelWidth || bottom > texture.pixelHeight) return false
	for (let pixelY = top; pixelY < bottom; pixelY += 1) {
		const row = pixelY * texture.pixelWidth
		for (let pixelX = left; pixelX < right; pixelX += 1) {
			if (occupiedCells[row + pixelX] !== 0) return false
		}
	}
	return true
}

function occupyPhysicalRect(
	occupiedCells: Uint8Array,
	texture: LayoutTexture,
	face: PhysicalFaceRect,
	originX: number,
	originY: number,
): void {
	const left = originX + Math.min(face.x, face.x + face.width)
	const right = originX + Math.max(face.x, face.x + face.width)
	const top = originY + Math.min(face.y, face.y + face.height)
	const bottom = originY + Math.max(face.y, face.y + face.height)
	for (let pixelY = top; pixelY < bottom; pixelY += 1) {
		const row = pixelY * texture.pixelWidth
		for (let pixelX = left; pixelX < right; pixelX += 1) {
			occupiedCells[row + pixelX] = 1
		}
	}
}

function makeUVRect(
	face: PhysicalFaceRect,
	originX: number,
	originY: number,
	texture: LayoutTexture,
): PlannedUVFace {
	const uvPerPixelX = texture.uvWidth / texture.pixelWidth
	const uvPerPixelY = texture.uvHeight / texture.pixelHeight
	const x = originX + face.x
	const y = originY + face.y
	return {
		...face,
		x,
		y,
		uv: [
			x * uvPerPixelX,
			y * uvPerPixelY,
			(x + face.width) * uvPerPixelX,
			(y + face.height) * uvPerPixelY,
		],
	}
}

function firstDiagonalFit(
	face: PhysicalFaceRect,
	occupiedCells: Uint8Array,
	texture: LayoutTexture,
): { x: number; y: number } | undefined {
	const width = Math.abs(face.width)
	const height = Math.abs(face.height)
	const maxOriginX = texture.pixelWidth - width
	const maxOriginY = texture.pixelHeight - height
	if (maxOriginX < 0 || maxOriginY < 0) return undefined

	// ponytail: fixed-texture diagonal scan; use an indexed packer only after measured UI latency on large textures.
	for (let line = 0; line <= Math.max(maxOriginX, maxOriginY); line += 1) {
		for (let space = 0; space <= line; space += 1) {
			if (space <= maxOriginX && line <= maxOriginY && physicalRectFits(
				occupiedCells,
				texture,
				face,
				space,
				line,
			)) {
				return { x: space, y: line }
			}
			if (space === line) continue
			if (line <= maxOriginX && space <= maxOriginY && physicalRectFits(
				occupiedCells,
				texture,
				face,
				line,
				space,
			)) {
				return { x: line, y: space }
			}
		}
	}
	return undefined
}

/**
 * Build a deterministic face plan without mutating Blockbench. The scan follows
 * Blockbench's diagonal first-fit order and marks every placed face before the
 * next face is considered.
 */
export function planExplicitTexelLayout(input: {
	dimensions: TexelDimensions
	texture: LayoutTexture
	occupied?: readonly OccupiedUVRect[]
	activeFaces?: readonly ExplicitTexelFace[]
}): ExplicitTexelLayoutPlan {
	if (!input || typeof input !== 'object') invalid('A layout request is required.')
	validateDimensions(input.dimensions)
	validateTexture(input.texture)
	const occupied = input.occupied ?? []
	validateOccupied(occupied)

	const faces = faceRects(input.dimensions)
	const requestedFaces = input.activeFaces ?? EXPLICIT_TEXEL_FACES
	if (!Array.isArray(requestedFaces)) invalid('Active cube faces must be an array.')
	const orderedFaces = activeFaceOrder(requestedFaces, faces)

	const occupiedCells = new Uint8Array(input.texture.pixelWidth * input.texture.pixelHeight)
	for (const entry of occupied) markUVRect(occupiedCells, input.texture, entry.uv)

	const plannedFaces: Partial<Record<ExplicitTexelFace, PlannedUVFace>> = {}
	for (const face of orderedFaces) {
		const physicalFace = faces[face]
		const placement = firstDiagonalFit(physicalFace, occupiedCells, input.texture)
		if (!placement) {
			throw new ExplicitTexelLayoutError(
				'no-space',
				`No free ${Math.abs(physicalFace.width)}x${Math.abs(physicalFace.height)} space is available for the ${face} face.`,
			)
		}
		plannedFaces[face] = makeUVRect(physicalFace, placement.x, placement.y, input.texture)
		occupyPhysicalRect(occupiedCells, input.texture, physicalFace, placement.x, placement.y)
	}

	const placedFaces = Object.values(plannedFaces) as PlannedUVFace[]
	const left = Math.min(...placedFaces.map((face) => Math.min(face.x, face.x + face.width)))
	const right = Math.max(...placedFaces.map((face) => Math.max(face.x, face.x + face.width)))
	const top = Math.min(...placedFaces.map((face) => Math.min(face.y, face.y + face.height)))
	const bottom = Math.max(...placedFaces.map((face) => Math.max(face.y, face.y + face.height)))
	return {
		origin: { x: left, y: top },
		bounds: { width: right - left, height: bottom - top },
		dimensions: { ...input.dimensions },
		faces: plannedFaces,
	}
}
