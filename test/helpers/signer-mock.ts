import type { SignerService } from "../../src/plugins/app/signer/signer.service.js";

export function createMockSignerService(): SignerService {
  let callCount = 0;
  const sign = async () => {
    callCount++;
    return Buffer.from(`mock-sig-${callCount}`).toString("base64");
  };
  return {
    signLockOrderForSolana: sign,
    signQubicToSolanaOrder: sign,
  };
}
