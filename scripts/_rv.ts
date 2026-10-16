import { readFileSync } from 'node:fs';
import { parseXer } from '../core/xer/parse.ts';
import { reviewSchedule, reviewText } from '../core/query/review.ts';
console.log(reviewText(reviewSchedule(parseXer(readFileSync(process.argv[2])).db)));
