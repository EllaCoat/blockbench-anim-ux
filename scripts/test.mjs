import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { constants, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const logs = mkdtempSync(join(tmpdir(), 'anim-ux-test-'))
const requested = process.argv.slice(2)
const files = requested.length ? requested : readdirSync(join(root, 'test'))
	.filter(name => name.endsWith('.test.mjs')).sort().map(name => `test/${name}`)

function showOutput(path, output = readFileSync(path, 'utf8')) {
	if (output.length <= 8000) process.stdout.write(output)
	else {
		process.stdout.write(output.slice(0, 6000))
		console.log(`\n... ${output.length - 8000} characters omitted; complete output: ${path}`)
		process.stdout.write(output.slice(-2000))
	}
}

function runStage(label, args, timeout) {
	const path = join(logs, `${label}.log`)
	const fd = openSync(path, 'wx')
	let result
	try {
		result = spawnSync(process.execPath, args, { cwd: root, stdio: ['ignore', fd, fd], timeout })
	} finally {
		closeSync(fd)
	}
	const timedOut = result.error?.code === 'ETIMEDOUT'
	let exitCode = timedOut ? 124 : result.status ?? (result.signal ? 128 + (constants.signals[result.signal] ?? 1) : 1)
	if (label === 'tests' && exitCode === 0) {
		const output = readFileSync(path, 'utf8')
		const summary = output.match(/^Tests: \d+; passed: \d+; failed: \d+; cancelled: \d+; skipped: \d+; todo: \d+\.$/m)
		if (summary) console.log(summary[0])
		else {
			console.error('NO TESTS EXECUTED: test runner returned no summary.')
			exitCode = 1
		}
	}
	if (exitCode !== 0) showOutput(path)
	if (exitCode !== 0) {
		console.error(`${label}: ${timedOut ? 'TIMEOUT' : result.signal ? `SIGNAL ${result.signal}` : 'FAILED'}; exit ${exitCode}.`)
		if (result.error) console.error(result.error.message)
		console.error(`Logs: ${logs}`)
	}
	return exitCode
}

if (files.length === 0) {
	console.error('NO TESTS EXECUTED: no test files selected.')
	process.exitCode = 1
} else {
	console.log(`Scope: ${files.join(', ')}`)
	process.exitCode = runStage('build', ['scripts/build-tests.mjs'], 60_000)
	if (process.exitCode === 0) {
		process.exitCode = runStage('tests', [
			'--test', '--test-timeout=30000',
			'--test-reporter=spec', `--test-reporter-destination=${join(logs, 'details.log')}`,
			'--test-reporter=./scripts/test-reporter.mjs', '--test-reporter-destination=stdout',
			...files,
		], 120_000)
		console.log(`Result: exit ${process.exitCode}; full test log: ${join(logs, 'details.log')}`)
	} else {
		console.error('NO TESTS EXECUTED: build did not complete successfully.')
	}
}
