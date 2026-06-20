// blockbench-anim-ux — F: 矢印キーで keyframe ジャンプ
//
// 選択中 animator の全 channel (= position / rotation / scale) を横断して、
// 現在の playhead 時刻より「次 / 前」 の最初の keyframe を見つけて Timeline.setTime() で移動する。
// keybind は Shift + → / Shift + ← (= 単体の矢印キーは BB 標準で frame 移動等に使用)。

declare const Action: new (id: string, opts: Record<string, unknown>) => { delete(): void }
declare const Keybind: new (opts: Record<string, unknown>) => unknown
declare const Timeline:
	| {
			time: number
			setTime(t: number): void
			animators: Array<{
				uuid: string
				selected?: boolean
				position?: Array<{ time: number }>
				rotation?: Array<{ time: number }>
				scale?: Array<{ time: number }>
			}>
	  }
	| undefined
declare const Modes: { animate: boolean } | undefined
declare const Animation: { selected?: unknown } | undefined
declare const Prop: { active_panel?: string } | undefined

function gatherSortedKeyframeTimes(): number[] {
	const timeline = typeof Timeline !== 'undefined' ? Timeline : undefined
	if (!timeline) return []
	const animator = timeline.animators.find(a => a.selected)
	if (!animator) return []
	const times: number[] = []
	for (const ch of [animator.position, animator.rotation, animator.scale]) {
		if (!ch) continue
		for (const kf of ch) times.push(kf.time)
	}
	times.sort((a, b) => a - b)
	return times
}

function jumpTo(direction: 1 | -1): void {
	const timeline = typeof Timeline !== 'undefined' ? Timeline : undefined
	if (!timeline) return
	const times = gatherSortedKeyframeTimes()
	if (times.length === 0) return
	const cur = timeline.time
	const eps = 1e-6
	let target: number | undefined
	if (direction === 1) {
		target = times.find(t => t > cur + eps)
	} else {
		for (let i = times.length - 1; i >= 0; i--) {
			if (times[i] < cur - eps) {
				target = times[i]
				break
			}
		}
	}
	if (target === undefined) return
	timeline.setTime(target)
}

function condition(): boolean {
	const modes = typeof Modes !== 'undefined' ? Modes : undefined
	const anim = typeof Animation !== 'undefined' ? Animation : undefined
	const prop = typeof Prop !== 'undefined' ? Prop : undefined
	if (!modes?.animate) return false
	if (!anim?.selected) return false
	// timeline panel が active なときに限り発火 (= 既存 BB shortcut との衝突回避)
	if (prop?.active_panel !== 'timeline') return false
	return true
}

let actions: Array<{ delete(): void }> = []

export function installKeyframeJump(): () => void {
	const ARROW_LEFT = 37
	const ARROW_RIGHT = 39

	actions.push(
		new Action('anim_ux_next_keyframe', {
			name: 'Anim UX: Jump to Next Keyframe',
			icon: 'skip_next',
			category: 'animation',
			keybind: new Keybind({ key: ARROW_RIGHT, shift: true }),
			condition,
			click() {
				jumpTo(1)
			},
		})
	)
	actions.push(
		new Action('anim_ux_prev_keyframe', {
			name: 'Anim UX: Jump to Previous Keyframe',
			icon: 'skip_previous',
			category: 'animation',
			keybind: new Keybind({ key: ARROW_LEFT, shift: true }),
			condition,
			click() {
				jumpTo(-1)
			},
		})
	)

	return () => {
		for (const a of actions) {
			try {
				a.delete()
			} catch (e) {
				console.warn('[anim_ux] action delete failed', e)
			}
		}
		actions = []
	}
}
