# rvt-rs, WebAssembly build (Revit files for 4D)

rvt-rs (https://github.com/DrunkOnJava/rvt-rs, Apache-2.0: LICENSE, NOTICE), a clean-room reader for Revit `.rvt` /
`.rfa` files, used to turn a Revit model into IFC4 when it is opened (`../rvtWorker.mjs`), with the clone's changes in
`p6clone.patch` (each changed place is marked "P6 Clone"). They change what memory a read takes, not what it reads:
the IFC it writes is the same text, byte for byte, as the unmodified build's (checked on three projects):

- `rvtToIfcStream(bytes, mode)`: the model is exported and written as IFC4 to `globalThis.__rvtIfcSink` a piece at a
  time (8 MiB), the file and its caches let go first; the model never crosses into JavaScript and back
  (`openRvtBytesWithDiagnosticsMode` then `modelToIfcStep` held it three times over).
- An inflated partition is built in one buffer of its exact size (two passes, the first measuring) instead of every
  member and then their concatenation.
- The partition's string records are scanned through an 8 MiB window over the concatenation instead of a second copy
  of the whole partition (`p6WindowedSelfCheck()` checks the window against the whole scan).

Measured (Node 24.14.0, the whole process at its peak): 384 -> 281 MB for a 19 MB project, 273 -> 214 MB for 12 MB;
WebAssembly memory 236 -> 147 MB for the 19 MB one. What is left is the file and its element partition unpacked (about
5x the file), which rvt-rs scans as a whole: reading tops out near 450 MB of `.rvt` (WebAssembly's 4 GB).

Built from commit `b6086d4` (rvt 0.6.1, 2026-10-21) with `p6clone.patch` applied:

```
git clone https://github.com/DrunkOnJava/rvt-rs && cd rvt-rs && git checkout b6086d4 && git apply <here>/p6clone.patch
rustup toolchain install stable-x86_64-pc-windows-gnu --profile minimal   # rustc 1.99.1
rustup target add wasm32-unknown-unknown --toolchain stable-x86_64-pc-windows-gnu
cargo +stable-x86_64-pc-windows-gnu build -p rvt-wasm --release --target wasm32-unknown-unknown --locked
wasm-bindgen --target web --out-name rvt --out-dir <here> target/wasm32-unknown-unknown/release/rvt_wasm.wasm
```

wasm-bindgen 0.2.118 (the version in rvt-rs's Cargo.lock), from its GitHub release
`wasm-bindgen-0.2.118-x86_64-pc-windows-msvc.tar.gz` (sha256 075902fd...19d5a08, checked against the release's sum).

| File | sha256 |
|---|---|
| rvt_bg.wasm | 1d5ba43ee70a8916dcc72e2f7e7a25fba2f3462877eee477fd2f56d460e0330 |
| rvt.js | 8c17d3e6e333232f768bdde0f4d6bec683589d5da020af0b1760377b8c42871 |

To update: build the same way from a newer commit (the patch brought onto it), replace both files, the patch and this
table, and run
`node --test tests/rvt.test.ts`.
