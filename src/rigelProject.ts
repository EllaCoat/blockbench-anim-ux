declare const Format: { id?: string } | false | undefined

// The rigel-anim plugin has its own animator filters, breadcrumbs, keyframe jump, A-B loop and onion skin for its
// projects, aware of its variant track and its ticks, so this plugin's versions of them stay out of those projects.
export function inRigelProject(): boolean {
	const format = typeof Format !== 'undefined' ? Format : undefined
	return !!format && format.id === 'rigel'
}
