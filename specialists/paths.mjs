import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Everything the specialists keep on disk. .local/ stays out of git. A test points this elsewhere.
const BASE = process.env.SPECIALISTS_DIR ?? fileURLToPath(new URL('../.local/specialists/', import.meta.url));

export const REGISTRATION_PATH = join(BASE, 'registration.json');
export const TOKEN_PATH = join(BASE, 'mps-runtime.env');
export const ALLOWLIST_PATH = join(BASE, 'allowlist.json');
export const jobsDir = (profileId) => join(BASE, 'jobs', profileId);
export const lockPath = (profileId) => join(BASE, 'locks', `${profileId}.lock`);
