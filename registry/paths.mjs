import {fileURLToPath} from 'node:url';

export const OWNER_PINS_PATH = fileURLToPath(new URL('../.local/owner-pins.json', import.meta.url));
