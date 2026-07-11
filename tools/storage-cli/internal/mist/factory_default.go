//go:build !mistlib_native

package mist

// NewClient returns the default storage client. Without the mistlib_native build
// tag the CLI uses the local sandbox-backed store, so it builds and runs without
// the native mistlib library.
func NewClient(storeRoot string) Client {
	return NewLocalClient(storeRoot)
}
