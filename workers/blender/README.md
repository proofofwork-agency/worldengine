# WorldEngine Blender worker

This optional Blender 5.1 worker is licensed separately under GPL-3.0-or-later. It is launched as an independent process and receives a validated JSON job containing only allowlisted operations. It never evaluates provider- or model-authored Python.

The Apache-2.0 TypeScript compiler communicates with the worker through files in a private temporary directory. It validates the mesh, fixes normals, normalizes materials/origin/ground contact, scales to the planned height, exports a GLB, and renders turntable plus depth/normal/instance evidence. Terrain support fitting remains a renderer-neutral height-field edit in the Apache core; this worker does not silently sculpt an absent terrain mesh.

Install Blender yourself and set `WORLDENGINE_BLENDER_EXECUTABLE` plus `WORLDENGINE_BLENDER_WORKER` on the compiler service.
