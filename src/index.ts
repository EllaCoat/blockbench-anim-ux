// blockbench-anim-ux — Blockbench plugin
// Animator panel 検索 / フィルタ / 3D 選択連動 / keyframe ジャンプの集約。
// 大型モデル (= ボーン 100+ 等) でのアニメーション作成効率化を目的とする。

import { installAbLoop } from './abLoop'
import { installAnimatorPanelUI } from './animatorPanelUI'
import { installBreadcrumbs } from './breadcrumb'
import { installKeyframeJump } from './keyframeJump'
import { installOnionSkin } from './onionSkin'
import { installSearchHandler } from './search'
import { installTogglesHandler } from './toggles'

declare const Plugin: { register(id: string, opts: Record<string, unknown>): void }

const PLUGIN_ID = 'anim_ux'

let cleanups: Array<() => void> = []

Plugin.register(PLUGIN_ID, {
	title: 'Animation UX',
	author: 'EllaCoat',
	description:
		'Animator panel search, filter, 3D-selection sync, keyframe-jump shortcuts, A-B loop playback with timeline markers, and onion skin with adjustable range (Animation menu).',
	icon: 'search',
	variant: 'desktop',
	version: '0.3.0',
	onload() {
		cleanups.push(installAnimatorPanelUI())
		cleanups.push(installSearchHandler())
		cleanups.push(installTogglesHandler())
		cleanups.push(installBreadcrumbs())
		cleanups.push(installKeyframeJump())
		cleanups.push(installAbLoop())
		cleanups.push(installOnionSkin())
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
