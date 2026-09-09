import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))

function runFixture(source) {
	const directory = mkdtempSync(join(tmpdir(), 'anim-ux-wrapper-fixture-'))
	const file = join(directory, 'case.mjs')
	writeFileSync(file, source, { flag: 'wx' })
	const result = spawnSync(process.execPath, ['scripts/test.mjs', file], {
		cwd: root, encoding: 'utf8', timeout: 15_000,
		env: { ...process.env, NODE_TEST_CONTEXT: undefined },
	})
	assert.equal(result.error, undefined)
	return { ...result, output: result.stdout + result.stderr }
}

test('wrapper reports counts while retaining successful test output in the full log', () => {
	const result = runFixture("import test from 'node:test'; test('fixture passed', () => console.log('fixture diagnostic'))")
	assert.equal(result.status, 0)
	assert.match(result.output, /Tests: 1; passed: 1; failed: 0/)
	assert.doesNotMatch(result.output, /fixture diagnostic|fixture passed/)
	const log = result.output.match(/full test log: (.+)/)[1].trim()
	assert.match(readFileSync(log, 'utf8'), /fixture diagnostic/)
})

test('wrapper retains failed assertion details and a nonzero exit', () => {
	const result = runFixture("import test from 'node:test'; import assert from 'node:assert/strict'; test('fixture failed', () => assert.equal(2, 3))")
	assert.equal(result.status, 1)
	assert.match(result.output, /FAIL fixture failed/)
	assert.match(result.output, /actual: 2/)
	assert.match(result.output, /expected: 3/)
})

test('wrapper rejects a file that executes no tests', () => {
	const result = runFixture('export const empty = true')
	assert.equal(result.status, 1)
	assert.match(result.output, /NO TESTS EXECUTED/)
})

test('wrapper rejects an entirely skipped run', () => {
	const result = runFixture("import test from 'node:test'; test.skip('not executed', () => {})")
	assert.equal(result.status, 1)
	assert.match(result.output, /NO TESTS EXECUTED/)
})

test('wrapper reports module-load errors without claiming success', () => {
	const result = runFixture("import './does-not-exist.mjs'")
	assert.equal(result.status, 1)
	assert.match(result.output, /FAIL|FAILED/)
	assert.match(result.output, /ERR_MODULE_NOT_FOUND/)
	const log = result.output.match(/full test log: (.+)/)[1].trim()
	assert.match(readFileSync(log, 'utf8'), /ERR_MODULE_NOT_FOUND/)
})

test('wrapper preserves timeout failures from the test runner', () => {
	const result = runFixture("import test from 'node:test'; test('fixture timeout', { timeout: 20 }, async () => new Promise(resolve => setTimeout(resolve, 100)))")
	assert.equal(result.status, 1)
	assert.match(result.output, /fixture timeout|timed out/)
	assert.match(result.output, /cancelled: 1/)
})

test('wrapper keeps abrupt worker exits as failures', () => {
	const result = runFixture('process.exit(7)')
	assert.equal(result.status, 1)
	assert.match(result.output, /exitCode: 7/)
})

test('wrapper reports worker termination as failure', () => {
	const result = runFixture("process.kill(process.pid, 'SIGTERM')")
	assert.equal(result.status, 1)
	assert.match(result.output, /FAIL|FAILED/)
})

test('wrapper stops at a failed build and reports that tests did not execute', () => {
	const directory = mkdtempSync(join(tmpdir(), 'anim-ux-build-failure-'))
	const scripts = join(directory, 'scripts')
	mkdirSync(scripts)
	for (const file of ['test.mjs', 'build-tests.mjs', 'test-reporter.mjs']) {
		copyFileSync(join(root, 'scripts', file), join(scripts, file))
	}
	const result = spawnSync(process.execPath, [join(scripts, 'test.mjs'), join(directory, 'unreachable.mjs')], {
		encoding: 'utf8', timeout: 15_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined },
	})
	assert.equal(result.error, undefined)
	assert.equal(result.status, 1)
	assert.match(result.stdout + result.stderr, /NO TESTS EXECUTED: build did not complete successfully/)
	assert.match(result.stdout + result.stderr, /ERR_MODULE_NOT_FOUND/)
	assert.doesNotMatch(result.stdout, /Tests: \d+; passed:/)
})

test('wrapper bounds large failure output and keeps complete diagnostics', () => {
	const result = runFixture("import test from 'node:test'; for (let i = 0; i < 80; i++) test('large failure ' + i, () => { throw new Error('diagnostic ' + 'x'.repeat(100)) })")
	assert.equal(result.status, 1)
	assert.ok(result.output.length < 9500)
	assert.match(result.output, /characters omitted/)
	assert.match(result.output, /failed: 80/)
	const log = result.output.match(/full test log: (.+)/)[1].trim()
	assert.match(readFileSync(log, 'utf8'), /large failure 79/)
})
