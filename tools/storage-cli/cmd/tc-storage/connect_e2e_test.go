//go:build mistlib_native

package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestCLIToCLIConnects launches two native CLI instances in the same room (with
// distinct node ids) and asserts each establishes a connected peer — the exact
// connect/position path that web<->CLI relies on.
//
// It exercises real signaling and is therefore opt-in:
//
//	go build -tags mistlib_native -o /tmp/tc-storage ./cmd/tc-storage
//	TC_STORAGE_E2E=1 TC_STORAGE_BIN=/tmp/tc-storage \
//	  go test -tags mistlib_native -run TestCLIToCLIConnects -v ./cmd/tc-storage
func TestCLIToCLIConnects(t *testing.T) {
	if os.Getenv("TC_STORAGE_E2E") != "1" {
		t.Skip("set TC_STORAGE_E2E=1 (and TC_STORAGE_BIN) to run the live connectivity E2E")
	}
	bin := os.Getenv("TC_STORAGE_BIN")
	if bin == "" {
		t.Fatal("TC_STORAGE_BIN must point to a native-built tc-storage binary")
	}

	room := fmt.Sprintf("tc-storage-e2e-%d", time.Now().UnixNano())
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	var wg sync.WaitGroup
	results := make([]error, 2)
	for i, node := range []string{"did:key:tc-e2e-a", "did:key:tc-e2e-b"} {
		wg.Add(1)
		go func(idx int, nodeID string) {
			defer wg.Done()
			results[idx] = runConnect(ctx, t, bin, room, nodeID)
		}(i, node)
	}
	wg.Wait()

	for i, err := range results {
		if err != nil {
			t.Errorf("node %d failed to connect: %v", i, err)
		}
	}
}

func runConnect(ctx context.Context, t *testing.T, bin, room, node string) error {
	store := t.TempDir()
	cmd := exec.CommandContext(ctx, bin,
		"--sandbox", t.TempDir(),
		"--store", store,
		"--room", room,
		"--node", node,
		"connect",
	)
	out, err := cmd.CombinedOutput()
	t.Logf("node %s output:\n%s", node, out)
	if err != nil {
		return fmt.Errorf("%w", err)
	}
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "node=") && strings.Contains(line, "peers=") {
			if strings.Contains(line, "peers=0") {
				return fmt.Errorf("no peers connected: %q", line)
			}
			return nil
		}
	}
	return fmt.Errorf("no peer summary line in output")
}
