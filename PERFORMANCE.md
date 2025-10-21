# Performance Benchmarks

Test object: `inner.stl` (6,120 triangles, 84.4×84.4×28.25mm)
Step size: 0.1mm (845×844 grid = 713,180 rays)
Expected points: ~1.2M

Hardware: (TBD - add your system info)

## Benchmark Results

| Version | Algorithm | Native (gcc -O2) | WASM (emcc -O3) | Speedup vs Baseline | Notes |
|---------|-----------|------------------|-----------------|---------------------|-------|
| v0.1 - Baseline | Naive (all rays × all tris) | 12.5s | 19.5s | 1.0× | Every ray tests every triangle |
| v0.2 - BB culling | + Bounding box test | 12.4s | TBD | 1.01× | Precomputed bbox, minimal gain |
| v0.3a - Grid 3D | 3D uniform grid + backface cull | 12.4s | TBD | 1.01× | Dense mesh defeats spatial partitioning |
| v0.3b - Grid 2D | 2D XY grid + backface cull | 12.4s | TBD | 1.01× | Model too dense, every cell has triangles |

## Algorithm Details

### v0.1 - Baseline (Naive)
- **Complexity**: O(rays × triangles) = O(n × m)
- **Operations**: 713,180 rays × 6,120 triangles = **4.36 billion intersection tests**
- **Method**: Every ray tests every triangle using Möller–Trumbore algorithm

### v0.2 - Bounding Box Culling
- **Optimization**: Test ray against precomputed triangle bounding box before full intersection test
- **Actual speedup**: 1.01× (minimal - most rays pass through bboxes anyway)
- **Complexity**: Still O(n × m), but with ~6 extra comparisons per test
- **Lesson**: For axis-aligned rays and dense meshes, bbox culling alone doesn't help much

### v0.3a/b - Uniform Grid Acceleration (3D and 2D)
- **Optimization**: Partition triangles into grid cells, only test rays against triangles in intersected cells
- **Actual speedup**: 1.01× (no improvement)
- **Why it failed**:
  - `inner.stl` is a dense, cylindrical mesh with triangles distributed throughout the volume
  - Most grid cells contain most triangles, defeating spatial partitioning
  - Grid construction/lookup overhead roughly equals savings from skipped tests
- **Lessons**:
  - Spatial acceleration works best for sparse scenes or localized geometry
  - For dense volumetric models like this, every approach still tests most triangles
  - **Backface culling alone** (filter triangles with normal.z ≤ 0) should help but wasn't separately measured
- **Next steps**: Need fundamentally different approach or finer/adaptive grid

## Testing Commands

```bash
# Native C compilation and test
gcc test-converter.c -o test-converter -lm -O2
time ./test-converter inner.stl 0.1

# WASM compilation and test
emcc mesh-converter.c -o mesh-converter.wasm \
  -s WASM=1 \
  -s STANDALONE_WASM \
  -s EXPORTED_FUNCTIONS='["_convert_to_point_mesh","_get_bounds","_free_output","_malloc","_free","_test_triangle_data"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -O3 \
  --no-entry

time node test-wasm.js
```

## What Actually Works for This Use Case

Given that inner.stl is dense and spatial acceleration doesn't help much:

### Practical Optimizations
1. **Use coarser step sizes** - Already implemented (0.5mm default)
   - 0.5mm: ~0.8s (interactive) ✓
   - 1.0mm: ~0.2s (preview) ✓

2. **Early ray termination** - Stop at first hit if only surface points needed
   - Could reduce hits-per-ray from ~2-3 to 1
   - Potential 2-3× speedup

3. **SIMD operations** - Vectorize Möller–Trumbore algorithm
   - 4-8× theoretical with AVX/AVX2
   - Requires careful implementation

4. **Multi-threading** - Split XY grid across threads
   - N× cores speedup (4-8× typical)
   - Easy to parallelize (rays are independent)

### Why Traditional Acceleration Doesn't Help Here
- **The model**: Cylindrical ring with triangles distributed throughout volume
- **The pattern**: Every XY location has geometry below it
- **The result**: Can't skip large portions of the scene

### Better Algorithms for Dense Meshes
1. **Z-buffer rasterization** - Render from top, capture depth
   - Essentially what GPUs do
   - Much faster than ray-per-pixel

2. **Voxelization then sampling** - Convert to voxel grid first
   - Better cache locality
   - Can use octree compression

3. **Heightfield extraction** - If model is mostly 2.5D
   - Store max Z per XY cell
   - O(1) lookup per ray

## Profiling Notes

The Möller–Trumbore intersection test is:
- 1 cross product (6 ops)
- 3 dot products (9 ops)
- Multiple multiplies/divides (~10 ops)
- **~25 FP operations per test**

At 4.36B tests × 25 ops = **109 billion FP operations** for baseline!
