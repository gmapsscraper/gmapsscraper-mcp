#!/usr/bin/env node
import { main } from './src/index.js';

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
