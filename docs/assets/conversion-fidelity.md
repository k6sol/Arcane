# Static model conversion fidelity

Arcane retains the original managed GLB and creates a separate marked import
copy for Blender. The marked copy preserves the original binary prefix and
appends a host-generated vertex-ID stream for each selected primitive. It also
marks every selected hierarchy node, including empty leaves. Source metadata
cannot supply these correspondence markers.

The conversion request, source map, audit and retained manifest use schema 2.
Requests, maps and audits name the fixed `arcane-static-fidelity-v1` policy.
Callers cannot increase its limits. Prototype conversion records from schema 1
are rejected; original and adopted-model parent records retain their own schema.

| Comparison | Permitted representation error |
| --- | --- |
| Vertex position, in raw local, original source and world frames | 0.1 mm Euclidean distance in each frame |
| Normal and tangent direction, in the same three frames | 0.02 degrees in each frame |
| Tangent handedness | Exact |
| UV component, in every source UV set | 2^-20 |
| Linear RGBA component, including alpha | 1/65535 |
| Node-local translation | 0.01 mm Euclidean distance |
| Node-local linear transform | Relative Euclidean change of each column at most 2^-20 |
| Local and world linear-transform conditioning | Infinity-norm condition number at most 10,000 |

These are explicit precision limits, not a claim of bit-identical conversion.
The source-frame check reprojects an observed world sample through the original
source transform. Raw local checks and the complete node graph are also checked,
so baking or reparenting geometry cannot hide behind matching world positions.
Singular, nonfinite or unsupported transforms are refused.

Rendered face coverage, winding, multiplicity, source vertex IDs, material
assignment and node-parent relationships must match exactly. Cyclic corner
rotation and exported vertex splits are allowed; reversing a face, welding a UV
seam or assigning an attribute to a different source vertex is not. A primitive
may index only part of an accessor shared with another material. Unindexed
accessor storage is not a rendered face; the original bytes remain retained.

The worker measures actual imported, saved and reopened Blender data, and the
host independently reads the resulting GLB bytes. Actual measurement digests
remain separate from the source digest. A saved-scene reopen must retain its
exact measured rows. Export and reimport must independently meet the original
precision and correspondence requirements.

For supported non-interlaced 8-bit grayscale, grayscale-alpha, RGB and RGBA PNGs,
the host compares bounded, CRC-checked decoded pixels. Lossless re-encoding may
change the container bytes while preserving those pixels. JPEG and unsupported
PNG encodings require the original encoded bytes. Texture bindings, sampler
state and material values remain part of the independent comparison.

These checks establish conversion fidelity. Visual review, permission checks,
owned-worker closure and native Studio import validation remain separate gates.
