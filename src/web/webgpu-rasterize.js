// webgpu-rasterize.js
// WebGPU-based mesh rasterization (STL triangles → height map point cloud)

let device = null;
let isInitialized = false;

// Initialize WebGPU device
export async function initWebGPURasterizer() {
    if (isInitialized) return true;

    if (!navigator.gpu) {
        console.warn('WebGPU not supported');
        return false;
    }

    try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            console.warn('WebGPU adapter not available');
            return false;
        }

        device = await adapter.requestDevice();
        isInitialized = true;
        console.log('✅ WebGPU rasterizer initialized');
        return true;
    } catch (error) {
        console.error('Failed to initialize WebGPU:', error);
        return false;
    }
}

const rasterizeShaderCode = `
struct Uniforms {
    bounds_min_x: f32,
    bounds_min_y: f32,
    bounds_min_z: f32,
    bounds_max_x: f32,
    bounds_max_y: f32,
    bounds_max_z: f32,
    step_size: f32,
    grid_width: u32,
    grid_height: u32,
    triangle_count: u32,
    filter_mode: u32,  // 0 = UPWARD (terrain, keep highest), 1 = DOWNWARD (tool, keep lowest)
}

@group(0) @binding(0) var<storage, read> triangles: array<f32>;
@group(0) @binding(1) var<storage, read_write> output_points: array<f32>;
@group(0) @binding(2) var<storage, read_write> valid_mask: array<u32>;
@group(0) @binding(3) var<uniform> uniforms: Uniforms;

// Fast 2D bounding box check for XY plane
fn ray_hits_triangle_bbox_2d(ray_x: f32, ray_y: f32, v0: vec3<f32>, v1: vec3<f32>, v2: vec3<f32>) -> bool {
    let min_x = min(min(v0.x, v1.x), v2.x);
    let max_x = max(max(v0.x, v1.x), v2.x);
    let min_y = min(min(v0.y, v1.y), v2.y);
    let max_y = max(max(v0.y, v1.y), v2.y);

    return ray_x >= min_x && ray_x <= max_x && ray_y >= min_y && ray_y <= max_y;
}

// Ray-triangle intersection using Möller-Trumbore algorithm
// Returns true if intersection found, writes intersection_z
fn ray_triangle_intersect(
    ray_origin: vec3<f32>,
    ray_dir: vec3<f32>,
    v0: vec3<f32>,
    v1: vec3<f32>,
    v2: vec3<f32>
) -> vec2<f32> {  // Returns (hit: 0.0 or 1.0, z: intersection_z)
    let EPSILON = 0.0000001;

    // Early rejection using 2D bounding box (very cheap!)
    if (!ray_hits_triangle_bbox_2d(ray_origin.x, ray_origin.y, v0, v1, v2)) {
        return vec2<f32>(0.0, 0.0);
    }

    // Calculate edges
    let edge1 = v1 - v0;
    let edge2 = v2 - v0;

    // Cross product: ray_dir × edge2
    let h = cross(ray_dir, edge2);

    // Dot product: edge1 · h
    let a = dot(edge1, h);

    if (a > -EPSILON && a < EPSILON) {
        return vec2<f32>(0.0, 0.0); // Ray parallel to triangle
    }

    let f = 1.0 / a;

    // s = ray_origin - v0
    let s = ray_origin - v0;

    // u = f * (s · h)
    let u = f * dot(s, h);

    if (u < 0.0 || u > 1.0) {
        return vec2<f32>(0.0, 0.0);
    }

    // Cross product: s × edge1
    let q = cross(s, edge1);

    // v = f * (ray_dir · q)
    let v = f * dot(ray_dir, q);

    if (v < 0.0 || u + v > 1.0) {
        return vec2<f32>(0.0, 0.0);
    }

    // t = f * (edge2 · q)
    let t = f * dot(edge2, q);

    if (t > EPSILON) {
        // Intersection found - calculate Z coordinate
        let intersection_z = ray_origin.z + ray_dir.z * t;
        return vec2<f32>(1.0, intersection_z);
    }

    return vec2<f32>(0.0, 0.0);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let grid_x = global_id.x;
    let grid_y = global_id.y;

    if (grid_x >= uniforms.grid_width || grid_y >= uniforms.grid_height) {
        return;
    }

    // Calculate world position for this grid point
    let world_x = uniforms.bounds_min_x + f32(grid_x) * uniforms.step_size;
    let world_y = uniforms.bounds_min_y + f32(grid_y) * uniforms.step_size;

    // Ray from below mesh pointing up (+Z direction)
    let ray_origin = vec3<f32>(world_x, world_y, uniforms.bounds_min_z - 1.0);
    let ray_dir = vec3<f32>(0.0, 0.0, 1.0);

    // Initialize best_z based on filter mode
    var best_z: f32;
    if (uniforms.filter_mode == 0u) {
        best_z = -1e10;  // Terrain: keep highest Z
    } else {
        best_z = 1e10;   // Tool: keep lowest Z
    }

    var found = false;

    // Test all triangles
    for (var i = 0u; i < uniforms.triangle_count; i++) {
        let tri_base = i * 9u;
        let v0 = vec3<f32>(
            triangles[tri_base],
            triangles[tri_base + 1u],
            triangles[tri_base + 2u]
        );
        let v1 = vec3<f32>(
            triangles[tri_base + 3u],
            triangles[tri_base + 4u],
            triangles[tri_base + 5u]
        );
        let v2 = vec3<f32>(
            triangles[tri_base + 6u],
            triangles[tri_base + 7u],
            triangles[tri_base + 8u]
        );

        let result = ray_triangle_intersect(ray_origin, ray_dir, v0, v1, v2);
        let hit = result.x;
        let intersection_z = result.y;

        if (hit > 0.5) {
            if (uniforms.filter_mode == 0u) {
                // Terrain: keep highest
                if (intersection_z > best_z) {
                    best_z = intersection_z;
                    found = true;
                }
            } else {
                // Tool: keep lowest
                if (intersection_z < best_z) {
                    best_z = intersection_z;
                    found = true;
                }
            }
        }
    }

    // Write output
    let output_idx = grid_y * uniforms.grid_width + grid_x;
    output_points[output_idx * 3u] = world_x;
    output_points[output_idx * 3u + 1u] = world_y;
    output_points[output_idx * 3u + 2u] = best_z;

    if (found) {
        valid_mask[output_idx] = 1u;
    } else {
        valid_mask[output_idx] = 0u;
    }
}
`;

// Calculate bounding box from triangle vertices
function calculateBounds(triangles) {
    let min_x = Infinity, min_y = Infinity, min_z = Infinity;
    let max_x = -Infinity, max_y = -Infinity, max_z = -Infinity;

    for (let i = 0; i < triangles.length; i += 3) {
        const x = triangles[i];
        const y = triangles[i + 1];
        const z = triangles[i + 2];

        if (x < min_x) min_x = x;
        if (y < min_y) min_y = y;
        if (z < min_z) min_z = z;
        if (x > max_x) max_x = x;
        if (y > max_y) max_y = y;
        if (z > max_z) max_z = z;
    }

    return {
        min: { x: min_x, y: min_y, z: min_z },
        max: { x: max_x, y: max_y, z: max_z }
    };
}

// Main rasterization function
// filterMode: 0 = UPWARD_FACING (terrain, keep highest), 1 = DOWNWARD_FACING (tool, keep lowest)
export async function rasterizeMeshWebGPU(triangles, stepSize, filterMode = 0) {
    const startTime = performance.now();

    if (!isInitialized) {
        const success = await initWebGPURasterizer();
        if (!success) {
            throw new Error('WebGPU not available');
        }
    }

    console.log(`🎮 [WebGPU Rasterize] Starting (${triangles.length / 9} triangles, step ${stepSize}mm, mode ${filterMode})...`);

    // Calculate bounds
    const t0 = performance.now();
    const bounds = calculateBounds(triangles);
    console.log(`🎮 [WebGPU Rasterize] Bounds: X[${bounds.min.x.toFixed(2)}, ${bounds.max.x.toFixed(2)}] Y[${bounds.min.y.toFixed(2)}, ${bounds.max.y.toFixed(2)}] Z[${bounds.min.z.toFixed(2)}, ${bounds.max.z.toFixed(2)}]`);

    // Calculate grid dimensions
    const gridWidth = Math.ceil((bounds.max.x - bounds.min.x) / stepSize) + 1;
    const gridHeight = Math.ceil((bounds.max.y - bounds.min.y) / stepSize) + 1;
    const totalGridPoints = gridWidth * gridHeight;

    console.log(`🎮 [WebGPU Rasterize] Grid: ${gridWidth}x${gridHeight} = ${totalGridPoints} points`);
    const t1 = performance.now();
    console.log(`🎮 [WebGPU Rasterize] ⏱️  Bounds calc: ${(t1 - t0).toFixed(1)}ms`);

    // Create buffers
    const triangleBuffer = device.createBuffer({
        size: triangles.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(triangleBuffer, 0, triangles);

    const outputSize = totalGridPoints * 3 * 4; // 3 floats per point
    const outputBuffer = device.createBuffer({
        size: outputSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const validMaskBuffer = device.createBuffer({
        size: totalGridPoints * 4, // 1 uint32 per point
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // Uniforms
    const uniformData = new Float32Array([
        bounds.min.x,
        bounds.min.y,
        bounds.min.z,
        bounds.max.x,
        bounds.max.y,
        bounds.max.z,
        stepSize,
        0, 0, 0, 0 // padding for alignment
    ]);
    const uniformDataU32 = new Uint32Array(uniformData.buffer);
    uniformDataU32[7] = gridWidth;
    uniformDataU32[8] = gridHeight;
    uniformDataU32[9] = triangles.length / 9; // triangle count
    uniformDataU32[10] = filterMode;

    const uniformBuffer = device.createBuffer({
        size: uniformData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const t2 = performance.now();
    console.log(`🎮 [WebGPU Rasterize] ⏱️  Buffer setup: ${(t2 - t1).toFixed(1)}ms`);

    // Create shader and pipeline
    const shaderModule = device.createShaderModule({ code: rasterizeShaderCode });
    const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: shaderModule, entryPoint: 'main' },
    });

    const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: triangleBuffer } },
            { binding: 1, resource: { buffer: outputBuffer } },
            { binding: 2, resource: { buffer: validMaskBuffer } },
            { binding: 3, resource: { buffer: uniformBuffer } },
        ],
    });

    const t3 = performance.now();
    console.log(`🎮 [WebGPU Rasterize] ⏱️  Pipeline setup: ${(t3 - t2).toFixed(1)}ms`);

    // Dispatch compute shader
    const commandEncoder = device.createCommandEncoder();
    const passEncoder = commandEncoder.beginComputePass();
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);

    const workgroupsX = Math.ceil(gridWidth / 16);
    const workgroupsY = Math.ceil(gridHeight / 16);
    passEncoder.dispatchWorkgroups(workgroupsX, workgroupsY);
    passEncoder.end();

    // Create staging buffers for readback
    const stagingOutputBuffer = device.createBuffer({
        size: outputSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const stagingValidMaskBuffer = device.createBuffer({
        size: totalGridPoints * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    commandEncoder.copyBufferToBuffer(outputBuffer, 0, stagingOutputBuffer, 0, outputSize);
    commandEncoder.copyBufferToBuffer(validMaskBuffer, 0, stagingValidMaskBuffer, 0, totalGridPoints * 4);

    device.queue.submit([commandEncoder.finish()]);

    // CRITICAL: Wait for GPU to finish all work before reading back
    await device.queue.onSubmittedWorkDone();

    const t4 = performance.now();
    console.log(`🎮 [WebGPU Rasterize] ⏱️  Dispatch + GPU execution: ${(t4 - t3).toFixed(1)}ms`);

    // Read back results
    await stagingOutputBuffer.mapAsync(GPUMapMode.READ);
    await stagingValidMaskBuffer.mapAsync(GPUMapMode.READ);

    const outputData = new Float32Array(stagingOutputBuffer.getMappedRange());
    const validMaskData = new Uint32Array(stagingValidMaskBuffer.getMappedRange());

    const t5 = performance.now();
    console.log(`🎮 [WebGPU Rasterize] ⏱️  Readback: ${(t5 - t4).toFixed(1)}ms`);

    // Compact output - remove invalid points
    const validPoints = [];
    for (let i = 0; i < totalGridPoints; i++) {
        if (validMaskData[i] === 1) {
            validPoints.push(
                outputData[i * 3],
                outputData[i * 3 + 1],
                outputData[i * 3 + 2]
            );
        }
    }

    stagingOutputBuffer.unmap();
    stagingValidMaskBuffer.unmap();

    // Cleanup
    triangleBuffer.destroy();
    outputBuffer.destroy();
    validMaskBuffer.destroy();
    uniformBuffer.destroy();
    stagingOutputBuffer.destroy();
    stagingValidMaskBuffer.destroy();

    const result = new Float32Array(validPoints);
    const pointCount = validPoints.length / 3;

    const endTime = performance.now();
    console.log(`🎮 [WebGPU Rasterize] ⏱️  Compaction: ${(endTime - t5).toFixed(1)}ms`);
    console.log(`🎮 [WebGPU Rasterize] ✅ Complete: ${pointCount} points in ${(endTime - startTime).toFixed(1)}ms`);

    return {
        positions: result,
        pointCount: pointCount,
        bounds: bounds
    };
}
