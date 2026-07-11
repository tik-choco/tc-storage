# Native mistlib library

The `mistlib_native` build links `libmistlib` from this directory.

To produce it, build the native crate in the mistlib-dev repo
(`enhance/peer-connection`) and copy the static archive here:

```sh
# in your mistlib-dev checkout
just build-native            # cargo build --release -p mistlib-native

# copy the artifact into this directory
cp target/release/libmistlib.a \
   <tc-storage>/tools/storage-cli/internal/mist/lib/
```

Then build the CLI with the tag:

```sh
go build -tags mistlib_native ./cmd/tc-storage
```

Without the tag the CLI uses the local sandbox store and needs no library.

`libmistlib.a` (and `.so`) are gitignored — they are build artifacts.
