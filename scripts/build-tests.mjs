import { build } from 'esbuild'

await build({
	entryPoints: ['src/explicitTexelLayout.ts', 'src/installExplicitTexelLayout.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outdir: 'dist-test',
	outExtension: { '.js': '.mjs' },
})
