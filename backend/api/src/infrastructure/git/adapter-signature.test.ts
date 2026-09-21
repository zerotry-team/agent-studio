import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { adapterAttestationPayload, validatePackageSigningPublicKey, verifyAdapterPackageSignature } from "./adapter-signature.js";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const attestation = {
  source_commit: "a".repeat(40),
  descriptor_hash: "b".repeat(64),
  contract_hash: "c".repeat(64),
  image_digest: `sha256:${"d".repeat(64)}`,
  sbom_digest: `sha256:${"e".repeat(64)}`,
};

describe("Adapter package signature", () => {
  it("Connectionに固定したEd25519鍵でattestation全体を検証する", () => {
    validatePackageSigningPublicKey(publicKey);
    const signature = sign(null, adapterAttestationPayload(attestation), keys.privateKey).toString("base64");
    expect(verifyAdapterPackageSignature(publicKey, attestation, signature)).toBe(true);
    expect(verifyAdapterPackageSignature(publicKey, { ...attestation, image_digest: `sha256:${"f".repeat(64)}` }, signature)).toBe(false);
  });

  it("Ed25519以外の鍵を拒否する", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => validatePackageSigningPublicKey(rsa)).toThrow("Ed25519");
  });
});
