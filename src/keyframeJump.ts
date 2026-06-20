// blockbench-anim-ux — F: 矢印キーで keyframe ジャンプ
//
// 選択中 (= 複数可) animator の全 channel (= position / rotation / scale) を横断して、
// 現在の playhead 時刻より「次 / 前」 の最初の keyframe を見つけて Timeline.setTime() で移動する。
// keybind は Shift + → / Shift + ← (= 単体の矢印キーは BB 標準で frame 移動等に使用)。
//
// v0.2 (= F-multi) 変更点 :
//   - 単一 animator (= 最初に selected な 1 個) から、 selected な全 animator の union に拡張
//   - 同時に keyframe が立ってる time (= 複数 animator が同 frame に keyframe を持つ) は dedupe
//   - 単一選択時の挙動は v0.1 と同じ (= union が 1 個ぶんになるだけ)

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
	const times: number[] = []
	for (const a of timeline.animators) {
		if (!a.selected) continue
		for (const ch of [a.position, a.rotation, a.scale]) {
			if (!ch) continue
			for (const kf of ch) times.push(kf.time)
		}
	}
	if (times.length === 0) return []
	times.sort((a, b) => a - b)
	// 同 time に複数 animator が keyframe を持つケースを dedupe (= jumpTo の二分検索精度には影響しないが配列サイズ削減)
	const uniq: number[] = []
	let prev = Number.NEGATIVE_INFINITY
	for (const t of times) {
		if (t !== prev) {
			uniq.push(t)
			prev = t
		}
	}
	return uniq
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
