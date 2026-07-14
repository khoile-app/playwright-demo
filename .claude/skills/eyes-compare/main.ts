#!/usr/bin/env npx tsx

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { runCompare } from './sdk-utils';
import { parseArgs } from './parse-args';

let dir = process.cwd();
while (true) {
  const envPath = path.join(dir, '.env');
  if (fs.existsSync(envPath)) { dotenv.config({ path: envPath }); break; }
  const parent = path.dirname(dir);
  if (parent === dir) break;
  dir = parent;
}

const result = parseArgs(process.argv.slice(2));
if (result.error) {
  console.error(result.error);
  process.exit(1);
}

const { matchLevel, url1, url2, browsers } = result;

const apiKey = process.env.APPLITOOLS_API_KEY;
if (!apiKey) {
  console.error(
    'Error: APPLITOOLS_API_KEY is not set.\n\n' +
    'Set it in .env or as an environment variable:\n' +
    '  APPLITOOLS_API_KEY=your_api_key_here'
  );
  process.exit(1);
}

runCompare({ url1, url2, browsers, matchLevel, apiKey, projectRoot: process.cwd() });
