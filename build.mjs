import esbuild from 'esbuild'

const dev = process.argv.includes('--dev')

await esbuild.build({
	entryPoints: ['src/index.ts'],
	// 出力ファイル名は Plugin.register の id (anim_ux) と一致させる
	// (= BB はローカル plugin を {plugin_id}.js として読み込むため)
	outfile: 'dist/anim_ux.js',
	bundle: true,
	platform: 'browser',
	format: 'iife',
	target: 'es2020',
	legalComments: 'none',
	minify: !dev,
	sourcemap: dev ? 'inline' : false,
})

console.log('built dist/anim_ux.js')
