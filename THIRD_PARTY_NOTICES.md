# Third-Party Notices

WorldEngine is project-authored code. It depends on separately licensed open-source packages installed through pnpm. Their package distributions retain their own complete license and copyright files; this summary does not replace those terms.

| Component | Use | License |
| --- | --- | --- |
| [Three.js](https://github.com/mrdoob/three.js) | First renderer backend | MIT |
| [React](https://github.com/facebook/react) | Browser editor | MIT |
| [Zod](https://github.com/colinhacks/zod) | Runtime schemas and validation | MIT |
| [glTF Transform](https://github.com/donmccurdy/glTF-Transform) | GLB inspection and optimization | MIT |
| [meshoptimizer](https://github.com/zeux/meshoptimizer) | Mesh LOD/optimization support | MIT |
| [Sharp](https://github.com/lovell/sharp) | Compiler image processing | Apache-2.0 |
| [libvips](https://github.com/libvips/libvips) | Dynamically used by the separately installed Sharp binary package | LGPL-3.0-or-later |
| `ktx-parse` and `ktx2-encoder` | KTX2 parsing and offline encoding | MIT |
| Vite, Vitest, Playwright, and TypeScript | Development, build, and test tooling; not runtime services | MIT or Apache-2.0 as declared by each package |

The source repository and WorldEngine npm tarballs do not bundle `node_modules` or the Sharp/libvips platform binary. A deployed application that redistributes compiled bundles or platform binaries must preserve the applicable notices and independently satisfy those licenses.

WorldEngine's compiler depends on `ktx2-encoder` 0.6.0 (MIT) for offline texture processing. That package redistributes a precompiled Basis Universal encoder under Apache-2.0.

## Basis Universal

- Project: https://github.com/BinomialLLC/basis_universal
- Copyright © 2016–2026 Binomial LLC
- License: Apache License 2.0
- Upstream commit: `1b33fd5098c6e7b58324146b8f5518cbb4cdfb72`
- Emscripten toolchain: 4.0.15
- `basis_encoder.wasm` SHA-256: `9807719e87cf3d979b0d69ae7112eb88aec6a0e0206c0b2d00dc0bed0d581b80`

Basis Universal is a trademark of Binomial LLC. Redistributed and derivative works must retain the attribution notices provided by the upstream project. The encoder also links Zstandard (BSD-3-Clause) and MIT-licensed tinyexr, tiny_dds, and QOI loaders. Full license texts remain available in their respective installed packages and upstream repositories.

`ktx2-encoder` itself is Copyright © 2020 Hu Song and is distributed under the MIT License. See the installed dependency's `LICENSE` and `THIRD_PARTY_NOTICES.md` for the complete notices.

## Optional process workers

`workers/blender/worker.py` is project-authored and licensed GPL-3.0-or-later. It is not linked into the Apache TypeScript packages. Blender itself is not bundled; operators install it separately and must comply with Blender's GPL license.

`workers/sam2/worker.py` is project-authored under Apache-2.0, but Meta's SAM2 code and model checkpoints are not bundled. Operators must separately obtain an exact reviewed SAM2 distribution/checkpoint and comply with its current license and notices.

Tripo, Meshy, OpenAI, OpenRouter and WaveSpeed services and generated outputs are not redistributed by this repository. Their current terms and exact model licenses remain operator responsibilities enforced through the provider-policy gate.
