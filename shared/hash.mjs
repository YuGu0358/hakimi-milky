// The hash rules are the starter's. Reusing them keeps G3 and A1 identical to what sellers compute.
import {sha256} from '../frontdesk/standard-hash.mjs';

export {inputHash, resultHash, sha256} from '../frontdesk/standard-hash.mjs';

// The same rule for any input fields, as outside agents hash theirs. For {prompt} it equals inputHash.
export const inputDataHash = (inputData, nonce) => sha256(`${nonce};${JSON.stringify(inputData)}`);
