import { Buffer } from "node:buffer";

export const QUBIC_TOKEN_ADDRESS = new Uint8Array(32);

export const QSB_CONTRACT_INDEX = 27;
export const QUBIC_CONTRACT_ADDRESS_BYTES = (() => {
  const addr = new Uint8Array(32);
  addr[0] = QSB_CONTRACT_INDEX & 0xff;
  addr[1] = (QSB_CONTRACT_INDEX >> 8) & 0xff;
  return addr;
})();

const QUBIC_ID_ALPHABET = /^[A-Za-z]+$/;
const HEX_PATTERN = /^[0-9a-fA-F]*$/;
const ADDRESS_HEX_LENGTH = 64;
const CHAR_A = "A".charCodeAt(0);

export function isQubicId(s: string): boolean {
  return (
    s.length >= 48 &&
    s.length <= 60 &&
    s.length % 4 === 0 &&
    QUBIC_ID_ALPHABET.test(s)
  );
}

function normalizeHex(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

/** Hex (64 chars) or Qubic ID (48-60 chars) -> 32 bytes. */
export function qubicAddressToBytes(value: string): Uint8Array {
  const s = value.trim();
  const hexCandidate = normalizeHex(s.replace(/\s/g, ""));
  if (hexCandidate.length === ADDRESS_HEX_LENGTH && HEX_PATTERN.test(hexCandidate)) {
    return new Uint8Array(Buffer.from(hexCandidate, "hex"));
  }
  if (isQubicId(s)) {
    return qubicIdToBytes(s);
  }
  throw new Error(`invalid Qubic address: ${value}`);
}

export function qubicIdToBytes(s: string): Uint8Array {
  const str = s.toUpperCase();
  const len = str.length;
  // Standard 60-char identities: 4 × 14 data chars + 4 checksum chars (ignored).
  // Shorter identities (48/52/56): no checksum, all chars are data.
  const segmentLength = len === 60 ? 14 : len / 4;
  const publicKeyBytes = new Uint8Array(32);
  const view = new DataView(publicKeyBytes.buffer, 0);
  for (let i = 0; i < 4; i++) {
    view.setBigUint64(i * 8, 0n, true);
    for (let j = segmentLength - 1; j >= 0; j--) {
      const idx = i * segmentLength + j;
      const code = str.charCodeAt(idx) - CHAR_A;
      view.setBigUint64(
        i * 8,
        view.getBigUint64(i * 8, true) * 26n + BigInt(code),
        true,
      );
    }
  }
  return publicKeyBytes;
}
