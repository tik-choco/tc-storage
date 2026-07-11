# TC Storage CLI

This is a Go TUI/CLI companion for TC Storage. It keeps user content inside a dedicated sandbox directory and stores encrypted TC Storage bundles through a small `mist.Client` interface.

The checked-in implementation includes a local sandbox backend so the CLI can be built and tested without the private mistlib native library. A native mistlib binding should implement `internal/mist.Client` with the same protocol methods:

- `Init(nodeID, config)`
- `JoinRoom(roomID)`
- `SendMessage(targetID, data, method)`
- `StorageAdd(name, data) -> cid`
- `StorageGet(cid) -> bytes`

## Commands

```sh
go test ./...
go run ./cmd/tc-storage --sandbox /tmp/tc-box tui
go run ./cmd/tc-storage --sandbox /tmp/tc-box sandbox-import ./example.txt
go run ./cmd/tc-storage --sandbox /tmp/tc-box put-file example.txt passphrase
go run ./cmd/tc-storage get-file local-... passphrase
```

## Compatibility

- Encrypted storage payloads use the web app format: `AES-GCM`, `PBKDF2-SHA256`, `210000` iterations, 16-byte salt, 12-byte IV.
- File bundles use the same JSON field names as `src/storage/domain.ts`.
- `tc-share` URLs are parsed with the same base64url JSON payload shape as `src/share/shareLinks.ts`.
- Share envelope signing payloads use deterministic key ordering matching `src/p2p/p2pEnvelope.ts`.

## Sandbox

All file reads for content operations go through `internal/sandbox`. Relative paths are resolved under the sandbox root and path traversal or absolute paths are rejected. Importing a file copies it into the sandbox first; storing content never reads directly from arbitrary filesystem locations.
