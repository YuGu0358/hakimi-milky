// Models often wrap JSON in a code fence even when told not to.
export const stripFence = (text) =>
  text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
