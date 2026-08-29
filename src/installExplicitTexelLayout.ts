import {
	EXPLICIT_TEXEL_FACES,
	ExplicitTexelLayoutError,
	LayoutTexture,
	planExplicitTexelLayout,
	type ExplicitTexelFace,
	type ExplicitTexelLayoutPlan,
	type TexelDimensions,
} from './explicitTexelLayout'

interface TextureBearingFace {
	texture?: unknown
	getTexture?: () => unknown
	enabled?: boolean
}

interface BlockbenchFace extends TextureBearingFace {
	uv: [number, number, number, number]
	rotation?: number
}

interface BlockbenchElement {
	faces?: Record<string, TextureBearingFace | undefined>
}

interface BlockbenchCube {
	uuid?: string
	selected?: boolean
	faces?: Partial<Record<ExplicitTexelFace, BlockbenchFace>>
	autouv?: number
	box_uv?: boolean
	mirror_uv?: boolean
	[key: string]: unknown
}

interface BlockbenchTexture {
	uuid?: string
	id?: string
	name?: string
	width?: number
	height?: number
	frameCount?: number
	uv_width?: number
	uv_height?: number
	img?: { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number }
	canvas?: { width?: number; height?: number }
	getUVWidth?: () => number
	getUVHeight?: () => number
	[key: string]: unknown
}

export interface ExplicitTexelLayoutRequest {
	textureId: string
	dimensions: TexelDimensions
}

/**
 * The only host seam needed by the algorithm. Keeping Blockbench globals on
 * the other side makes atomicity testable without a renderer or Electron.
 */
export interface ExplicitTexelLayoutHost {
	selectedCubes(): readonly BlockbenchCube[]
	allCubes(): readonly BlockbenchCube[]
	nonCubeFaces(): readonly TextureBearingFace[]
	textures(): readonly BlockbenchTexture[]
	supportsFaceTextureAssignment(): boolean
	textureId(value: unknown): string | null
	textureLayout(texture: BlockbenchTexture): LayoutTexture
	beginUndo(cube: BlockbenchCube): void
	finishUndo(): void
	cancelUndo(): void
	refresh(cube: BlockbenchCube): void
}

declare const Action:
	| (new (id: string, options: Record<string, unknown>) => { delete(): void })
	| undefined
declare const Dialog:
	| (new (options: Record<string, unknown>) => { show(): void; hide?(): void })
	| undefined
declare const MenuBar:
	| {
			menus?: Record<string, { addAction(action: unknown): void; removeAction(action: unknown): void } | undefined>
	  }
	| undefined
declare const Cube: { selected?: BlockbenchCube[]; all?: BlockbenchCube[] } | undefined
declare const Texture: { all?: BlockbenchTexture[]; selected?: BlockbenchTexture } | undefined
declare const Project: { textures?: BlockbenchTexture[] } | undefined
declare const Outliner: { elements?: BlockbenchElement[] } | undefined
declare const Format: { single_texture?: boolean; per_group_texture?: boolean } | undefined
declare const Undo:
	| {
			initEdit(aspects: Record<string, unknown>): void
			finishEdit(message: string): void
			cancelEdit(revertChanges?: boolean): void
	  }
	| undefined
declare const Canvas:
	| {
			updateView?(options: Record<string, unknown>): void
			updateAll?(): void
	  }
	| undefined
declare const UVEditor: { loadData?(): void } | undefined
declare const Blockbench:
	| { showQuickMessage?(message: string, duration?: number): void }
	| undefined

function noChange(message: string): never {
	throw new ExplicitTexelLayoutError('invalid-input', message)
}

function asId(value: unknown): string | null {
	if (typeof value === 'string' && value.length > 0) return value
	if (!value || typeof value !== 'object') return null
	const record = value as { uuid?: unknown; id?: unknown }
	if (typeof record.uuid === 'string' && record.uuid.length > 0) return record.uuid
	if (typeof record.id === 'string' && record.id.length > 0) return record.id
	return null
}

function firstPositiveNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
	}
	return undefined
}

function blockbenchHost(): ExplicitTexelLayoutHost {
	return {
		selectedCubes: () =>
			(typeof Cube !== 'undefined' && Array.isArray(Cube?.selected) ? Cube.selected : []),
		allCubes: () =>
			(typeof Cube !== 'undefined' && Array.isArray(Cube?.all) ? Cube.all : []),
		nonCubeFaces: () => {
			const cubes = new Set(typeof Cube !== 'undefined' && Array.isArray(Cube?.all) ? Cube.all : [])
			const elements = typeof Outliner !== 'undefined' && Array.isArray(Outliner?.elements) ? Outliner.elements : []
			return elements
				.filter((element) => !cubes.has(element as BlockbenchCube))
				.flatMap((element) => Object.values(element.faces ?? {}).filter((face): face is TextureBearingFace => Boolean(face)))
		},
		textures: () => {
			const projectTextures = typeof Project !== 'undefined' ? Project?.textures : undefined
			if (Array.isArray(projectTextures)) return projectTextures
			return typeof Texture !== 'undefined' && Array.isArray(Texture?.all) ? Texture.all : []
		},
		supportsFaceTextureAssignment: () =>
			!(typeof Format !== 'undefined' && (Format?.single_texture || Format?.per_group_texture)),
		textureId: (value: unknown) => asId(value),
		textureLayout: (texture: BlockbenchTexture): LayoutTexture => {
			if (typeof texture.frameCount === 'number' && texture.frameCount > 1) {
				noChange('Animated textures are not supported by explicit texel UV layout.')
			}
			const pixelWidth = firstPositiveNumber(
				texture.img?.naturalWidth,
				texture.canvas?.width,
				texture.img?.width,
				texture.width,
			)
			const pixelHeight = firstPositiveNumber(
				texture.img?.naturalHeight,
				texture.canvas?.height,
				texture.img?.height,
				texture.height,
			)
			const uvWidth = firstPositiveNumber(
				typeof texture.getUVWidth === 'function' ? texture.getUVWidth() : undefined,
				texture.uv_width,
				texture.width,
			)
			const uvHeight = firstPositiveNumber(
				typeof texture.getUVHeight === 'function' ? texture.getUVHeight() : undefined,
				texture.uv_height,
				texture.height,
			)
		if (!pixelWidth || !pixelHeight || !uvWidth || !uvHeight) {
				noChange('The selected texture has no readable pixel and UV dimensions.')
			}
			return { pixelWidth, pixelHeight, uvWidth, uvHeight }
		},
		beginUndo: (cube: BlockbenchCube) => {
			if (typeof Undo === 'undefined' || !Undo) noChange('Blockbench Undo is unavailable.')
			Undo.initEdit({ elements: [cube], uv_only: true })
		},
		finishUndo: () => {
			if (typeof Undo === 'undefined' || !Undo) noChange('Blockbench Undo is unavailable.')
			Undo.finishEdit('Explicit texel UV layout')
		},
		cancelUndo: () => {
			if (typeof Undo !== 'undefined' && Undo) Undo.cancelEdit(true)
		},
		refresh: (cube: BlockbenchCube) => {
			try {
				const preview = cube.preview_controller as
					| { updateFaces?(value: BlockbenchCube): void; updateUV?(value: BlockbenchCube): void }
					| undefined
				preview?.updateFaces?.(cube)
				preview?.updateUV?.(cube)
				Canvas?.updateView?.({
					elements: [cube],
					element_aspects: { faces: true, uv: true, geometry: false },
				})
				Canvas?.updateAll?.()
				UVEditor?.loadData?.()
			} catch (error) {
				console.warn('[anim_ux] explicit texel UV refresh failed', error)
			}
		},
	}
}

function faceFor(cube: BlockbenchCube, face: ExplicitTexelFace): BlockbenchFace {
	const value = cube.faces?.[face]
	if (!value || !Array.isArray(value.uv) || value.uv.length !== 4) {
		noChange(`Selected cube is missing a valid ${face} face.`)
	}
	return value
}

function faceTextureValue(face: TextureBearingFace): unknown {
	if (typeof face.getTexture === 'function') return face.getTexture()
	return face.texture
}

function isActiveFace(face: TextureBearingFace | undefined): face is BlockbenchFace {
	return Boolean(face) && face.texture !== null && face.enabled !== false
}

function activeFaces(cube: BlockbenchCube): ExplicitTexelFace[] {
	const result: ExplicitTexelFace[] = []
	for (const face of EXPLICIT_TEXEL_FACES) {
		const value = cube.faces?.[face]
		if (!isActiveFace(value)) continue
		faceFor(cube, face)
		result.push(face)
	}
	if (result.length === 0) noChange('The selected cube has no available faces for explicit texel UV layout.')
	return result
}

function faceUsesTexture(
	host: ExplicitTexelLayoutHost,
	face: TextureBearingFace,
	texture: BlockbenchTexture,
	textureId: string,
): boolean {
	if (!isActiveFace(face)) return false
	const value = faceTextureValue(face)
	if (value === null || value === false || value === undefined) return false
	if (value === texture) return true
	const valueId = typeof value === 'string' ? value : host.textureId(value)
	return valueId === textureId
}

/**
 * Preflight and apply one complete active-face layout. All validation and
 * packing happen before `beginUndo`; the mutation section is one undo entry.
 */
export function applyExplicitTexelLayout(
	request: ExplicitTexelLayoutRequest,
	host: ExplicitTexelLayoutHost = blockbenchHost(),
): ExplicitTexelLayoutPlan {
	if (!request || typeof request.textureId !== 'string' || request.textureId.length === 0) {
		noChange('An existing texture must be selected explicitly.')
	}
	const selected = [...host.selectedCubes()]
	if (selected.length !== 1) {
		noChange('Select exactly one cube before creating an explicit texel layout.')
	}
	const cube = selected[0]
	const texture = host.textures().find((candidate) => host.textureId(candidate) === request.textureId)
	if (!texture) noChange(`Texture "${request.textureId}" was not found in the current project.`)
	const textureId = host.textureId(texture)
	if (!textureId) noChange('The selected texture has no stable Blockbench identifier.')
	if (!host.supportsFaceTextureAssignment()) {
		noChange('Explicit texel UV layout requires a format with per-face texture assignment.')
	}
	const targetFaces = activeFaces(cube)
	if (host.nonCubeFaces().some((face) => faceUsesTexture(host, face, texture, textureId))) {
		noChange('The selected texture is used by a non-cube element; its UV occupation cannot be changed safely.')
	}

	const occupied: Array<{ uv: [number, number, number, number] }> = []
	for (const otherCube of host.allCubes()) {
		if (otherCube === cube) continue
		for (const face of EXPLICIT_TEXEL_FACES) {
			const value = otherCube.faces?.[face]
			if (!isActiveFace(value)) continue
			if (!faceUsesTexture(host, value, texture, textureId)) continue
			const otherFace = faceFor(otherCube, face)
			occupied.push({ uv: [...otherFace.uv] as [number, number, number, number] })
		}
	}

	const plan = planExplicitTexelLayout({
		dimensions: request.dimensions,
		texture: host.textureLayout(texture),
		occupied,
		activeFaces: targetFaces,
	})

	let undoOpen = false
	try {
		host.beginUndo(cube)
		undoOpen = true
		cube.box_uv = false
		cube.autouv = 0
		for (const face of targetFaces) {
			const targetFace = faceFor(cube, face)
			targetFace.texture = textureId
			targetFace.uv = [...plan.faces[face].uv] as [number, number, number, number]
			targetFace.rotation = 0
		}
		host.finishUndo()
		undoOpen = false
	} catch (error) {
		if (undoOpen) {
			try {
				host.cancelUndo()
			} catch {
				// Preserve the original mutation error; the host owns rollback details.
			}
		}
		throw error
	}

	host.refresh(cube)
	return plan
}

function notify(message: string): void {
	if (typeof Blockbench !== 'undefined' && Blockbench?.showQuickMessage) {
		Blockbench.showQuickMessage(message, 4000)
	} else {
		console.warn(`[anim_ux] ${message}`)
	}
}

let openDialog: { hide?(): void } | undefined

export function openExplicitTexelLayoutDialog(): void {
	if (typeof Dialog === 'undefined' || !Dialog) return
	const textures = blockbenchHost().textures().filter((texture) => asId(texture))
	if (typeof Cube === 'undefined' || !Cube || Cube.selected?.length !== 1) {
		notify('Select exactly one cube before opening explicit texel UV layout.')
		return
	}
	if (textures.length === 0) {
		notify('Create or load an existing texture before opening explicit texel UV layout.')
		return
	}
	const options: Record<string, string> = {}
	for (const texture of textures) {
		const id = asId(texture)
		if (id) options[id] = texture.name || id
	}
	const selectedTexture = typeof Texture !== 'undefined' ? Texture?.selected : undefined
	const defaultTextureId = asId(selectedTexture) && options[asId(selectedTexture)!]
		? asId(selectedTexture)!
		: Object.keys(options)[0]

	const dialog = new Dialog({
		id: 'anim_ux_explicit_texel_layout',
		title: 'Anim UX: Explicit Texel UV Layout',
		form: {
			texture: {
				type: 'select',
				label: 'Existing texture',
				options,
				value: defaultTextureId,
			},
			x: { type: 'number', label: 'X texels', value: 1, min: 1, step: 1 },
			y: { type: 'number', label: 'Y texels', value: 1, min: 1, step: 1 },
			z: { type: 'number', label: 'Z texels', value: 1, min: 1, step: 1 },
		},
		onConfirm(result: { texture: string; x: number; y: number; z: number }) {
			try {
				const plan = applyExplicitTexelLayout({
					textureId: result.texture,
					dimensions: { x: Number(result.x), y: Number(result.y), z: Number(result.z) },
				})
				const count = Object.keys(plan.faces).length
				const label = count === 1 ? 'UV face' : 'UV faces'
				notify(`Placed ${count} ${label} in unused texture space.`)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				notify(message)
			}
		},
	})
	openDialog = dialog
	dialog.show()
}

/** Install the UV action and return the complete plugin cleanup function. */
export function installExplicitTexelLayout(): () => void {
	let action: { delete(): void } | undefined
	if (typeof Action !== 'undefined' && Action) {
		action = new Action('anim_ux_explicit_texel_layout', {
			name: 'Anim UX: Explicit Texel UV Layout...',
			description: 'Place one selected cube on an existing texture using explicit texel dimensions.',
			icon: 'grid_on',
			category: 'uv',
			condition: { modes: ['edit'] },
			click: openExplicitTexelLayoutDialog,
		})
		const uvMenu = typeof MenuBar !== 'undefined' ? MenuBar?.menus?.uv : undefined
		uvMenu?.addAction(action)
	}

	return () => {
		try {
			openDialog?.hide?.()
		} catch {
			// Dialog cleanup is best effort during plugin unload.
		}
		openDialog = undefined
		if (action) {
			const uvMenu = typeof MenuBar !== 'undefined' ? MenuBar?.menus?.uv : undefined
			try {
				uvMenu?.removeAction(action)
			} catch {
				// The menu may already be gone while Blockbench is shutting down.
			}
			try {
				action.delete()
			} catch (error) {
				console.warn('[anim_ux] explicit texel UV action cleanup failed', error)
			}
		}
	}
}
