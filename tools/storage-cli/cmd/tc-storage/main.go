package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"tc-storage-cli/internal/app"
	"tc-storage-cli/internal/identity"
	"tc-storage-cli/internal/mist"
	"tc-storage-cli/internal/protocol"
)

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	defaultRoot, err := app.DefaultDataDir()
	if err != nil {
		return err
	}

	flags := flag.NewFlagSet("tc-storage", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	sandboxRoot := flags.String("sandbox", filepath.Join(defaultRoot, "sandbox"), "content sandbox directory")
	storeRoot := flags.String("store", filepath.Join(defaultRoot, "mist-store"), "local mist-compatible store directory")
	roomID := flags.String("room", "tc-storage-cli", "mist room id")
	nodeID := flags.String("node", "", "local did:key node id")
	verbose := flags.Bool("v", false, "print mistlib logs and peer events to stderr")
	if err := flags.Parse(args); err != nil {
		return err
	}

	id, err := identity.LoadOrCreate(filepath.Join(defaultRoot, "identity.json"))
	if err != nil {
		return err
	}

	client := mist.NewClient(*storeRoot)
	if *verbose {
		client.SetLogCallback(func(level uint32, message string) {
			if message == "" {
				return
			}
			fmt.Fprintf(os.Stderr, "[mist L%d] %s\n", level, message)
		})
	}

	rt, err := app.NewRuntime(app.Config{
		SandboxRoot: *sandboxRoot,
		StoreRoot:   *storeRoot,
		StatePath:   filepath.Join(defaultRoot, "state.json"),
		RoomID:      *roomID,
		NodeID:      *nodeID,
		Mist:        client,
		Identity:    id,
	})
	if err != nil {
		return err
	}
	if *verbose {
		rt.SetEventLogger(func(env protocol.ShareEnvelope) {
			fmt.Fprintf(os.Stderr, "[envelope type=%s from=%s folder=%s req=%s]\n",
				env.Type, protocol.Short(env.From), env.FolderID, env.RequestID)
		})
	}

	command := "tui"
	if flags.NArg() > 0 {
		command = flags.Arg(0)
	}

	switch command {
	case "tui":
		return runTUI(ctx, rt)
	case "put-file":
		if flags.NArg() < 3 {
			return fmt.Errorf("usage: tc-storage put-file <path-in-sandbox> <passphrase>")
		}
		cid, err := rt.PutFile(ctx, flags.Arg(1), flags.Arg(2))
		if err != nil {
			return err
		}
		fmt.Println(cid)
		return nil
	case "get-file":
		if flags.NArg() < 3 {
			return fmt.Errorf("usage: tc-storage get-file <cid> <passphrase>")
		}
		file, err := rt.GetFile(ctx, flags.Arg(1), flags.Arg(2))
		if err != nil {
			return err
		}
		fmt.Printf("%s\t%d bytes\t%s\n", file.Name, file.Size, file.Checksum)
		return nil
	case "connect":
		if err := rt.Connect(ctx); err != nil {
			return err
		}
		peers := rt.ConnectedPeers(ctx)
		fmt.Printf("node=%s room=%s peers=%d\n", rt.NodeID(), rt.RoomID(), len(peers))
		for _, peer := range peers {
			fmt.Println("peer", peer)
		}
		if len(peers) == 0 {
			return fmt.Errorf("no peers connected")
		}
		return nil
	case "folder-get":
		if flags.NArg() < 2 {
			return fmt.Errorf("usage: tc-storage folder-get <share-url>")
		}
		result, err := rt.FetchFolderShare(ctx, flags.Arg(1), func(line string) {
			fmt.Fprintln(os.Stderr, "…", line)
		})
		if err != nil {
			return err
		}
		fmt.Printf("folder: %s\nsaved %d file(s):\n", result.FolderName, len(result.Files))
		for _, f := range result.Files {
			fmt.Println("  " + f)
		}
		for _, s := range result.Skipped {
			fmt.Fprintln(os.Stderr, "  skipped:", s)
		}
		return nil
	case "parse-link":
		if flags.NArg() < 2 {
			return fmt.Errorf("usage: tc-storage parse-link <share-url-or-hash>")
		}
		linked, err := app.ParseShareLink(flags.Arg(1))
		if err != nil {
			return err
		}
		fmt.Printf("type=%s room=%s folder=%s file=%s cid=%s\n", linked.Share.Type, linked.Share.RoomID, linked.Share.FolderID, linked.Share.FileID, linked.Share.CID)
		return nil
	case "sandbox-import":
		if flags.NArg() < 2 {
			return fmt.Errorf("usage: tc-storage sandbox-import <source-path>")
		}
		imported, err := rt.Sandbox.ImportFile(flags.Arg(1))
		if err != nil {
			return err
		}
		fmt.Println(imported)
		return nil
	case "sandbox-list":
		entries, err := rt.Sandbox.List()
		if err != nil {
			return err
		}
		for _, entry := range entries {
			fmt.Println(entry)
		}
		return nil
	default:
		return fmt.Errorf("unknown command %q", command)
	}
}

// runTUI lives in tui.go (Bubble Tea implementation).
