# rvt-rs, WebAssembly build (Revit files for 4D)

rvt-rs (https://github.com/DrunkOnJava/rvt-rs, Apache-2.0: LICENSE, NOTICE), a clean-room reader for Revit `.rvt` /
`.rfa` files, used to turn a Revit model into IFC4 when it is opened (`../rvtWorker.mjs`), with the clone's changes in
`p6clone.patch` (each changed place is marked "P6 Clone"). They change what memory a read takes, not what it reads:
the IFC it writes is the same text, byte for byte, as the unmodified build's (checked on three projects):

- `rvtToIfcStream(bytes, mode, revitPropertySets)`: the model is exported and written as IFC4 to
  `globalThis.__rvtIfcSink` a piece at a time (8 MiB), the file and its caches let go first; the model never crosses
  into JavaScript and back (`openRvtBytesWithDiagnosticsMode` then `modelToIfcStep` held it three times over). With
  `revitPropertySets`, Revit's own property sets from the parameters the file saves are added first (as
  `rvt-ifc --revit-property-sets`; Revit 2023 and later). `--saved-meshes` is left out: on a 2023 project it took 3x
  the memory and 7x the time.
- An inflated partition is built in one buffer of its exact size (two passes, the first measuring) instead of every
  member and then their concatenation.
- The partition's string records are scanned through an 8 MiB window over the concatenation instead of a second copy
  of the whole partition (`p6WindowedSelfCheck()` checks the window against the whole scan).

Measured (Node 24.14.0, the whole process at its peak), on 0.6.1: 384 -> 281 MB for a 19 MB project, 273 -> 214 MB for
12 MB; 0.10.0 with the patch: 173, 225 and 264 MB for the 7, 12 and 19 MB projects (its base quantities cost a little);
WebAssembly memory 236 -> 147 MB for the 19 MB one. What is left is the file and its element partition unpacked (about
5x the file), which rvt-rs scans as a whole: reading tops out near 450 MB of `.rvt` (WebAssembly's 4 GB).

Built from tag `v0.10.0` (commit `0cd60b7`, rvt 0.10.0, 2026-10-27) with `p6clone.patch` applied:

```
git clone https://github.com/DrunkOnJava/rvt-rs && cd rvt-rs && git checkout v0.10.0 && git apply <here>/p6clone.patch
rustup toolchain install stable-x86_64-pc-windows-gnu --profile minimal   # rustc 1.99.1
rustup target add wasm32-unknown-unknown --toolchain stable-x86_64-pc-windows-gnu
cargo +stable-x86_64-pc-windows-gnu build -p rvt-wasm --release --target wasm32-unknown-unknown --locked
wasm-bindgen --target web --out-name rvt --out-dir <here> target/wasm32-unknown-unknown/release/rvt_wasm.wasm
```

wasm-bindgen 0.2.118 (the version in rvt-rs's Cargo.lock), from its GitHub release
`wasm-bindgen-0.2.118-x86_64-pc-windows-msvc.tar.gz` (sha256 075902fd...19d5a08, checked against the release's sum).

| File | sha256 |
|---|---|
| rvt_bg.wasm | 2d04b09e64e7081bd1c50809858fc1102387cd467e9904923da69be49327a0af |
| rvt.js | 43102e69efcf7820cb50fed453e3b4e17ad6c6ee5a76338f7058eb5ac8495b16 |

To update: build the same way from a newer commit (the patch brought onto it), replace both files, the patch and this
table, and run
`node --test tests/rvt.test.ts`.
