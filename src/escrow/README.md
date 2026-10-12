portable core copied verbatim from tc-linkai src/escrow @ ad7e330; keep byte-identical, vector tests must pass
Joining an app room with the same ID as an escrow room is a misconfiguration: the controller reports the collision and Custom mode warns. The broker retires escrow membership before acquiring app membership and quarantines its peers until app membership is verified.

Drive-index CID format: `tc-storage/drive-index/encrypted/1`. CID bytes are JSON containing the AES-256-GCM envelope from `encryptJson` (HKDF-SHA-256 key derivation); the decrypted payload is the existing `DriveIndexMeta` v1 schema. The random `indexKey`, format, count and updatedAt are carried only in the same-origin `drive-index` shared-bus metadata. File passphrases never appear in plaintext CID bytes.

Deploy the updated tc-travel reader (decrypt-before-parse and HKDF support) **before tc-storage** in this rollout. Old tc-travel builds cannot read this encrypted index; this compatibility break is accepted by the orchestrator. Do not restore plaintext key publication.
