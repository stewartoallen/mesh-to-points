# Radial Toolpath Optimization Strategies

## Current Performance (Baseline)
- Test case: 48 triangle cylinder, 12 rotations (30° steps)
- **Total time: 44ms**
- Breakdown:
  - Strip rasterization: 12 × 3.5ms = **42ms** (95% of time)
  - Scanline extraction: <1ms per rotation (negligible)
  - Processing: Sequential (blocks on each rotation)

## Bottlenecks Identified
1. **Multiple GPU passes**: 12 separate rasterization calls
2. **Sequential execution**: Rotations processed one at a time
3. **Unnecessary 2D rasterization**: Full strip (41×21) when we only need centerline (41×1)
4. **CPU triangle rotation overhead**: Rotating geometry on CPU before each GPU pass

---

## Optimization Strategy 1: Reduce Strip Height (Quick Win)
**Concept**: Only rasterize the centerline, not full strip

### Current
```
Strip bounds: Y = [-toolRadius, +toolRadius]
Grid: 41 (X) × 21 (Y) = 861 points
We extract: centerline at Y=0 (41 points)
Waste: 820 points rasterized but unused
```

### Optimized
```
Strip bounds: Y = [-gridStep/2, +gridStep/2]  // Single row
Grid: 41 (X) × 1-3 (Y) = 41-123 points
We extract: centerline (41 points)
Waste: Minimal
```

**Pros:**
- Very simple to implement (just change strip bounds)
- **Expected speedup: 7-20x on rasterization** (861 → 41-123 points)
- No algorithm changes needed

**Cons:**
- Tool collision detection needs full strip width for accuracy
- May miss edge cases where tool touches terrain outside centerline

**Status**: ⚠️ **INCORRECT** - Tool convolution requires full strip width

---

## Optimization Strategy 2: Parallel Multi-Worker Processing
**Concept**: Process multiple rotations simultaneously using multiple WebGPU workers

### Implementation
```javascript
// Split rotations across workers
Worker 1: Rotations 0°, 30°, 60°, 90°    (4 rotations)
Worker 2: Rotations 120°, 150°, 180°, 210°  (4 rotations)
Worker 3: Rotations 240°, 270°, 300°, 330°  (4 rotations)
```

**Pros:**
- **Expected speedup: 3-4x** (near-linear with worker count)
- No algorithm changes
- Works with existing pipeline

**Cons:**
- More complex: Need to manage multiple WebGPU devices
- Memory overhead: Multiple workers = multiple GPU contexts
- Limited by number of GPU queues/devices
- Coordination overhead for gathering results

**Complexity**: Medium-High

---

## Optimization Strategy 3: GPU-Accelerated Rotation + Batch Rasterization
**Concept**: Rotate triangles in GPU shader, rasterize all angles in one pass

### Implementation
```wgsl
// Shader rotates triangle around X-axis for given angle
fn rotateAroundX(pos: vec3f, angleDeg: f32) -> vec3f {
    let rad = angleDeg * PI / 180.0;
    let c = cos(rad);
    let s = sin(rad);
    return vec3f(
        pos.x,
        pos.y * c - pos.z * s,
        pos.y * s + pos.z * c
    );
}

// Rasterize into 3D volume: [X, Y, Angle]
// Each angle slice is one rotation's strip
```

### Data Flow
```
Current:  CPU rotate → GPU rasterize (×12) → CPU scanline (×12)
Optimized: GPU rotate + rasterize (×1) → CPU scanline (×12)
```

**Pros:**
- **Expected speedup: 5-10x** (1 GPU pass instead of 12)
- Eliminates CPU rotation overhead
- Eliminates data transfer overhead
- Single GPU dispatch

**Cons:**
- Complex shader: 3D rasterization logic
- Memory: Need 3D output buffer (X × Y × angles)
- Requires significant shader rewrite

**Complexity**: High

---

## Optimization Strategy 4: Direct 1D Scanline Rasterization (Best)
**Concept**: Skip 2D strip entirely - rasterize directly to 1D scanlines in GPU

### Implementation
```wgsl
// For each X position and angle:
// 1. Rotate triangle in shader
// 2. Check if rotated triangle intersects Y=0 plane
// 3. Perform tool convolution at that X position
// 4. Output Z value directly to scanline[angle][x]
```

### Data Flow
```
Current:  CPU rotate → GPU rasterize 2D strip → CPU extract 1D scanline (×12)
Optimized: GPU rotate + rasterize to 1D scanline (×1)
```

**Pros:**
- **Expected speedup: 10-20x** (optimal algorithm)
- No wasted 2D rasterization
- Single GPU pass
- Minimal memory usage (output is 1D per angle)
- Most efficient use of GPU

**Cons:**
- Requires complete shader rewrite
- Complex: Must implement tool convolution in shader
- Harder to debug

**Complexity**: Very High

---

## Optimization Strategy 5: Hybrid - GPU Rotation + Optimized Strip
**Concept**: Keep current architecture but optimize key parts

### Implementation
1. Pass all triangles + all angles to GPU once
2. GPU shader:
   - Rotates triangles for each angle
   - Rasterizes narrow strips (3-5 rows for tool convolution)
   - Outputs 2D array: [angle × X × Y]
3. CPU: Extract scanlines (fast)

**Pros:**
- **Expected speedup: 5-8x**
- Moderate complexity
- Reuses existing CPU scanline extraction logic
- GPU handles heavy lifting (rotation + rasterization)

**Cons:**
- Still does 2D rasterization (but narrower strips)
- Requires shader modifications

**Complexity**: Medium

---

## Recommendation

**Phase 1: Quick Win - Parallel Workers** (Strategy 2)
- Implement first for immediate 3-4x speedup
- Lower risk, works with existing code
- Establishes parallelization infrastructure

**Phase 2: GPU Optimization** (Strategy 5 - Hybrid)
- After parallel workers proven
- 5-8x speedup on top of parallelization
- Combined: **15-30x total speedup**

**Future: Ultimate Optimization** (Strategy 4)
- If performance still critical
- Complete GPU pipeline
- Maximum theoretical speedup

---

## Performance Targets

Current: 44ms for 12 rotations
- After Strategy 2: **~12ms** (3-4x faster)
- After Strategy 5: **~2-3ms** (15-20x faster)
- After Strategy 4: **~1-2ms** (20-40x faster)

Planar mode comparison: Similar-sized planar toolpath ~5-10ms
**Goal: Match or beat planar mode performance**
