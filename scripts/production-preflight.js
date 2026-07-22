#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { formatPreflightReport, runProductionPreflight } = require('../services/production-preflight');

if (process.argv.slice(2).some((argument) => !['--help', '-h'].includes(argument))) {
  console.error('Usage: npm run preflight');
  process.exitCode = 2;
} else if (process.argv.slice(2).length > 0) {
  console.log('Usage: npm run preflight\nRuns local-only production readiness checks; never connects to WhatsApp or the network.');
} else {
  const result = runProductionPreflight({ env: process.env });
  console.log(formatPreflightReport(result, { env: process.env }));
  if (!result.ready) process.exitCode = 1;
}
