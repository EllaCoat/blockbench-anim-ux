// blockbench-anim-ux — Blockbench plugin
// Animator panel 検索 / フィルタ / 3D 選択連動 / keyframe ジャンプの集約。
// 大型モデル (= ボーン 100+ 等) でのアニメーション作成効率化を目的とする。

import { installAbLoop } from './abLoop'
import { installAnimatorPanelUI } from './animatorPanelUI'
import { installBreadcrumbs } from './breadcrumb'
import { installKeyframeJump } from './keyframeJump'
import { installOnionSkin } from './onionSkin'
import { addDocumentListener, getActivePopoutDocument } from './popoutBus'
import { installSearchHandler } from './search'
import { installTimelinePopout } from './timelinePopout'
import { installTogglesHandler } from './toggles'

declare const Plugin: { register(id: string, opts: Record<string, unknown>): void }

const PLUGIN_ID = 'anim_ux'
const PLUGIN_VERSION = '0.5.0'

let cleanups: Array<() => void> = []

// AJ 本体 / 他 plugin が popout 子窓を意識せずに listener / mount 先を取れるよう、
// 安定 API として window.AnimUX を公開する。 anim_ux 未 install でも害なく optional 依存できる形にする。
// API は popoutBus 上の機能を薄くラップするだけ (= 既存実装の再公開)。
interface AnimUxExternalAPI {
	version: string
	addDocumentListener(
		type: string,
		fn: EventListenerOrEventListenerObject,
		opts?: boolean | AddEventListenerOptions,
	): () => void
	getActivePopoutDocument(): Document | null
}

function installExternalAPI(): () => void {
	const holder = window as unknown as { AnimUX?: AnimUxExternalAPI }
	const api: AnimUxExternalAPI = {
		version: PLUGIN_VERSION,
		addDocumentListener,
		getActivePopoutDocument,
	}
	holder.AnimUX = api
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
		'Animator panel search, filter, 3D-selection sync, keyframe-jump shortcuts, A-B loop playback with timeline markers, onion skin with adjustable range, and multi-window state sync.',
	icon: 'search',
	variant: 'desktop',
	version: PLUGIN_VERSION,
	onload() {
		cleanups.push(installExternalAPI())
		cleanups.push(installAnimatorPanelUI())
		cleanups.push(installSearchHandler())
		cleanups.push(installTogglesHandler())
		cleanups.push(installBreadcrumbs())
		cleanups.push(installKeyframeJump())
		cleanups.push(installAbLoop())
		cleanups.push(installOnionSkin())
		cleanups.push(installTimelinePopout())
	},
	onunload() {
		for (const fn of cleanups) {
			try {
				fn()
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] cleanup failed`, e)
			}
		}
		cleanups = []
	},
})
