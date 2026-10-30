// Decodes a bech32 string, as Cardano addresses are written, and checks its checksum (BIP-173).
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATORS = Object.freeze([0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]);
const CHECKSUM_LENGTH = 6;
const WORD_BITS = 5;
const BYTE_BITS = 8;

function polymod(values) {
  let check = 1;
  for (const value of values) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    GENERATORS.forEach((generator, index) => {
      if ((top >>> index) & 1) check ^= generator;
    });
  }
  return check >>> 0;
}

const expandedPrefix = (prefix) => {
  const codes = [...prefix].map((character) => character.charCodeAt(0));
  return [...codes.map((code) => code >> 5), 0, ...codes.map((code) => code & 31)];
};

function bytesFromWords(words) {
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const word of words) {
    buffer = (buffer << WORD_BITS) | word;
    bits += WORD_BITS;
    if (bits >= BYTE_BITS) {
      bits -= BYTE_BITS;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits >= WORD_BITS || buffer !== 0) throw new Error('bech32: bad padding');
  return Buffer.from(bytes);
}

export function decodeBech32(text) {
  if (typeof text !== 'string' || text !== text.toLowerCase()) throw new Error('bech32: must be lowercase text');
  const separator = text.lastIndexOf('1');
  if (separator < 1 || separator + CHECKSUM_LENGTH + 1 > text.length) throw new Error('bech32: no data part');
  const prefix = text.slice(0, separator);
  const words = [...text.slice(separator + 1)].map((character) => CHARSET.indexOf(character));
  if (words.includes(-1)) throw new Error('bech32: bad character');
  if (polymod([...expandedPrefix(prefix), ...words]) !== 1) throw new Error('bech32: bad checksum');
  return {prefix, bytes: bytesFromWords(words.slice(0, -CHECKSUM_LENGTH))};
}
