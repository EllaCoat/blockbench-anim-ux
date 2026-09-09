import { inspect } from 'node:util'

export default async function* report(events) {
	let summary
	let executedTests = 0
	for await (const { type, data } of events) {
		if (type === 'test:stderr') {
			yield data.message
		} else if (type === 'test:fail') {
			yield `FAIL ${data.name} (${data.file ?? ''}:${data.line ?? ''})\n${inspect(data.details.error, { depth: 6, colors: false })}\n`
		} else if (type === 'test:summary') {
			if (data.file) executedTests += data.counts.tests - data.counts.skipped - data.counts.todo
			else summary = data
		}
	}
	if (!summary || executedTests === 0) {
		process.exitCode = 1
		yield 'NO TESTS EXECUTED: no completed test summary.\n'
	} else {
		const { tests, passed, failed, cancelled, skipped, todo } = summary.counts
		yield `Tests: ${tests}; passed: ${passed}; failed: ${failed}; cancelled: ${cancelled}; skipped: ${skipped}; todo: ${todo}.\n`
	}
}
