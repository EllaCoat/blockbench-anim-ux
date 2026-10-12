import { build } from 'esbuild'

await build({
	entryPoints: ['src/explicitTexelLayout.ts', 'src/installExplicitTexelLayout.ts', 'src/cubeSnapPoints.ts', 'src/installPivotSnapPoints.ts', 'src/installVertexSnapMidpoints.ts', 'src/installCubeFaceDirections.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outdir: 'dist-test',
	outExtension: { '.js': '.mjs' },
})
