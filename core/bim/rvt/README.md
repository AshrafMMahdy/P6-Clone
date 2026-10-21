# rvt-rs, WebAssembly build (Revit files for 4D)

rvt-rs (https://github.com/DrunkOnJava/rvt-rs, Apache-2.0: LICENSE, NOTICE), a clean-room reader for Revit `.rvt` /
`.rfa` files, used unmodified to turn a Revit model into IFC4 when it is opened (`../rvtWorker.mjs`).

Built from commit `b6086d4` (rvt 0.6.1, 2026-10-21) with:

```
rustup toolchain install stable-x86_64-pc-windows-gnu --profile minimal   # rustc 1.99.1
rustup target add wasm32-unknown-unknown --toolchain stable-x86_64-pc-windows-gnu
cargo +stable-x86_64-pc-windows-gnu build -p rvt-wasm --release --target wasm32-unknown-unknown --locked
wasm-bindgen --target web --out-name rvt --out-dir <here> target/wasm32-unknown-unknown/release/rvt_wasm.wasm
```

wasm-bindgen 0.2.118 (the version in rvt-rs's Cargo.lock), from its GitHub release
`wasm-bindgen-0.2.118-x86_64-pc-windows-msvc.tar.gz` (sha256 075902fd...19d5a08, checked against the release's sum).

| File | sha256 |
|---|---|
| rvt_bg.wasm | 383b358fe1e8d0e709b4f458dd3a96bd8f7fcb60f1321217d1c1fe3db2126d67 |
| rvt.js | 6c6370622bb77416c3d77741af8d82eabd9516aa07bde288c4aaa49f044febb1 |

To update: build the same way from a newer commit, replace both files and this table, and run
`node --test tests/rvt.test.ts`.
