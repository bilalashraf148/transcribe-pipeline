/**
 * Loads `.env` from the working directory before any module reads process.env.
 *
 * Imported FIRST by server.js. ESM evaluates imports depth-first in
 * declaration order, and config.js snapshots process.env at module load, so
 * anything that reads config must be imported after this file.
 *
 * dotenv never overwrites variables that already exist, so a real environment
 * variable — or a test that sets process.env before importing — always wins.
 */
import { config } from 'dotenv';

config({ quiet: true });
