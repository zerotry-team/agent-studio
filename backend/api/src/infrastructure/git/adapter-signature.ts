import { createPublicKey, verify } from "node:crypto";
import { canonicalJson } from "@agent-studio/contracts";

export type AdapterAttestation = {
  source_commit: string;
  descriptor_hash: string;
  contract_hash: string;
  image_digest: string;
  sbom_digest: string;
};

export function adapterAttestationPayload(value: AdapterAttestation): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

export function validatePackageSigningPublicKey(pem: string): void {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Adapter package署名鍵はEd25519公開鍵である必要があります");
}

export function verifyAdapterPackageSignature(publicKey: string, attestation: AdapterAttestation, signature: string): boolean {
  try {
    validatePackageSigningPublicKey(publicKey);
    const decoded = Buffer.from(signature, "base64");
    return decoded.length === 64 && verify(null, adapterAttestationPayload(attestation), publicKey, decoded);
  } catch {
    return false;
  }
}
