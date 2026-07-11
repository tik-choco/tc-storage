//go:build mistlib_native

package mist

// NewClient returns the native mistlib-backed client. Built with the
// mistlib_native tag, the CLI links libmistlib (see internal/mist/lib) and talks
// to the real P2P network instead of the local store.
func NewClient(_ string) Client {
	return NewNativeClient()
}
