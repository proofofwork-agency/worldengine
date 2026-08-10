# Third-Party Notices

This package uses separately installed dependencies whose distributions retain their own license files:

- `@gltf-transform/core`, `@gltf-transform/extensions`, and `@gltf-transform/functions` — MIT;
- `meshoptimizer` — MIT;
- `sharp` — Apache-2.0;
- the platform-specific libvips binary used dynamically by Sharp — LGPL-3.0-or-later;
- `ktx-parse` and `ktx2-encoder` — MIT.

The `@worldengine/compiler` tarball does not bundle `node_modules` or a Sharp/libvips platform binary. Applications that redistribute an installed binary distribution must preserve the dependency notices and satisfy their applicable licenses.

`@worldengine/compiler` depends on `ktx2-encoder` 0.6.0 (MIT), which redistributes the Basis Universal encoder under Apache-2.0.

## Basis Universal

- Project: https://github.com/BinomialLLC/basis_universal
- Copyright © 2016–2026 Binomial LLC
- License: Apache License 2.0
- Upstream commit: `1b33fd5098c6e7b58324146b8f5518cbb4cdfb72`
- Emscripten toolchain: 4.0.15
- `basis_encoder.wasm` SHA-256: `9807719e87cf3d979b0d69ae7112eb88aec6a0e0206c0b2d00dc0bed0d581b80`

Basis Universal is a trademark of Binomial LLC. Redistributed and derivative works must retain the attribution notices provided by the upstream project. The encoder also links Zstandard (BSD-3-Clause) and MIT-licensed tinyexr, tiny_dds, and QOI loaders. Full license texts remain available in their respective installed packages and upstream repositories.

`ktx2-encoder` itself is Copyright © 2020 Hu Song and is distributed under the MIT License. See that dependency's `LICENSE` and `THIRD_PARTY_NOTICES.md` for the complete notices.
