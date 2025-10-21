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
| v0.3 - Grid | Uniform grid acceleration | TODO | TODO | Target: 10-50× | Spatial partitioning needed |

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

### v0.3 - Uniform Grid Acceleration
- **Optimization**: Partition triangles into 3D grid cells, only test rays against triangles in intersected cells
- **Expected speedup**: 10-100× (depends on model complexity and grid resolution)
- **Complexity**: O(n × (k + t_cell)) where k = cells traversed, t_cell = avg triangles per cell
- **Memory overhead**: Grid structure + triangle-to-cell mapping

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

## Next Optimizations to Consider

1. **BVH (Bounding Volume Hierarchy)** - Better than uniform grid for complex geometry, O(n × log(m))
2. **Early ray termination** - Stop at first hit (if only surface needed)
3. **SIMD operations** - Vectorize intersection tests (4× theoretical speedup)
4. **Multi-threading** - Split rays across Web Workers (N× cores speedup)
5. **Adaptive grid** - Finer cells where triangles are dense

## Profiling Notes

The Möller–Trumbore intersection test is:
- 1 cross product (6 ops)
- 3 dot products (9 ops)
- Multiple multiplies/divides (~10 ops)
- **~25 FP operations per test**

At 4.36B tests × 25 ops = **109 billion FP operations** for baseline!
