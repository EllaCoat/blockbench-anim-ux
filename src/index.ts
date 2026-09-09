// blockbench-anim-ux — Blockbench plugin
// Animator panel 検索 / フィルタ / 3D 選択連動 / keyframe ジャンプの集約。
// 大型モデル (= ボーン 100+ 等) でのアニメーション作成効率化を目的とする。

import { installAbLoop } from './abLoop'
import { installAnimatorPanel } from './animatorPanel'
import { installBreadcrumbs } from './breadcrumb'
import { installKeyframeJump } from './keyframeJump'
import { installExplicitTexelLayout } from './installExplicitTexelLayout'
import { installPivotEdgeMidpoints } from './installPivotEdgeMidpoints'
import { installOnionSkin } from './onionSkin'
import { installTimelineWindow, timelineWindowService } from './timelineWindow'

declare const Plugin: { register(id: string, opts: Record<string, unknown>): void }
declare const Blockbench:
	| { dispatchEvent(event: string, data: unknown): void }
	| undefined

const PLUGIN_ID = 'anim_ux'
const PLUGIN_VERSION = '0.8.0'

let cleanups: Array<() => void> = []

// Companion plugin が load 順序に依存せず親/子 document の現在値を購読できるよう、
// discovery point と ready event だけを global に公開する。窓の状態は timelineWindowService が所有する。
interface AnimUxTimelineExternalAPI {
	subscribeDocuments(listener: (documents: readonly Document[]) => void): () => void
}

interface AnimUxExternalAPI {
	version: string
	timeline: AnimUxTimelineExternalAPI
}

function installExternalAPI(): () => void {
	const holder = window as unknown as { AnimUX?: AnimUxExternalAPI }
	const api: AnimUxExternalAPI = {
		version: PLUGIN_VERSION,
		timeline: {
			subscribeDocuments: listener => timelineWindowService.subscribeDocuments(listener),
		},
	}
	holder.AnimUX = api
	Blockbench?.dispatchEvent('animux:ready', { api })
	return (): void => {
		if (holder.AnimUX === api) {
			try {
				delete holder.AnimUX
			} catch {
				holder.AnimUX = undefined
			}
		}
	}
}

Plugin.register(PLUGIN_ID, {
	title: 'Animation UX',
	author: 'EllaCoat',
	description:
		'Animator workflow, detachable Timeline, cube edge midpoint pivots, explicit-texel UV layout, keyframe navigation, A-B loop, and onion skin.',
	icon: 'search',
	variant: 'desktop',
	version: PLUGIN_VERSION,
	onload() {
		const installed: Array<() => void> = []
		try {
			installed.push(installExternalAPI())
			installed.push(installAnimatorPanel())
			installed.push(installBreadcrumbs())
			installed.push(installKeyframeJump())
			installed.push(installAbLoop())
			installed.push(installOnionSkin())
			installed.push(installTimelineWindow())
			installed.push(installExplicitTexelLayout())
			installed.push(installPivotEdgeMidpoints())
			cleanups = installed
		} catch (error) {
			for (const cleanup of installed.reverse()) {
				try { cleanup() } catch { /* preserve the installation error */ }
			}
			throw error
		}
	},
	onunload() {
		for (const fn of cleanups.reverse()) {
			try {
				fn()
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] cleanup failed`, e)
			}
		}
		cleanups = []
	},
})
