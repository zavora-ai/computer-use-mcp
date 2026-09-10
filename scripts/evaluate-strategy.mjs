import { readFileSync } from 'node:fs'
import { compareEvaluations } from '../dist/evaluation.js'
if (process.argv.length !== 4) throw new Error('Usage: node scripts/evaluate-strategy.mjs baseline.json candidate.json')
const [baseline, candidate] = process.argv.slice(2).map(path => JSON.parse(readFileSync(path, 'utf8')))
console.log(JSON.stringify(compareEvaluations(baseline, candidate), null, 2))
