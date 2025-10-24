// webgpu-worker.js
// WebGPU worker for compute-only rasterization and toolpath generation
// Runs all GPU operations off the main thread to prevent UI blocking

let device = null;
let isInitialized = false;
let cachedRasterizePipeline = null;
let cachedRasterizeShaderModule = null;
let cachedToolpathPipeline = null;
let cachedToolpathShaderModule = null;
let config = null;
let deviceCapabilities = null;

// Initialize WebGPU device in worker context
async function initWebGPU() {
    if (isInitialized) return true;

    if (!navigator.gpu) {
        console.warn('[WebGPU Worker] WebGPU not supported');
        return false;
    }

    try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            console.warn('[WebGPU Worker] WebGPU adapter not available');
            return false;
        }

        // Request device with higher limits for large meshes
        const adapterLimits = adapter.limits;
        console.log('[WebGPU Worker] Adapter limits:', {
            maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize,
            maxBufferSize: adapterLimits.maxBufferSize
        });

        device = await adapter.requestDevice({
            requiredLimits: {
                maxStorageBufferBindingSize: Math.min(
                    adapterLimits.maxStorageBufferBindingSize,
                    1024 * 1024 * 1024 // Request up to 1GB
                ),
                maxBufferSize: Math.min(
                    adapterLimits.maxBufferSize,
                    1024 * 1024 * 1024 // Request up to 1GB
                )
            }
        });

        // Pre-compile rasterize shader module (expensive operation)
        cachedRasterizeShaderModule = device.createShaderModule({ code: rasterizeShaderCode });

        // Pre-create rasterize pipeline (very expensive operation)
        cachedRasterizePipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module: cachedRasterizeShaderModule, entryPoint: 'main' },
        });

        // Pre-compile toolpath shader module
        cachedToolpathShaderModule = device.createShaderModule({ code: toolpathShaderCode });

        // Pre-create toolpath pipeline
        cachedToolpathPipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module: cachedToolpathShaderModule, entryPoint: 'main' },
        });

        // Store device capabilities
        deviceCapabilities = {
            maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
            maxBufferSize: device.limits.maxBufferSize,
            maxComputeWorkgroupSizeX: device.limits.maxComputeWorkgroupSizeX,
            maxComputeWorkgroupSizeY: device.limits.maxComputeWorkgroupSizeY,
        };

        isInitialized = true;
        console.log('[WebGPU Worker] ✅ Initialized (pipelines cached)');
        return true;
    } catch (error) {
        console.error('[WebGPU Worker] Failed to initialize:', error);
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
    spatial_grid_width: u32,
    spatial_grid_height: u32,
    spatial_cell_size: f32,
}

@group(0) @binding(0) var<storage, read> triangles: array<f32>;
@group(0) @binding(1) var<storage, read_write> output_points: array<f32>;
@group(0) @binding(2) var<storage, read_write> valid_mask: array<u32>;
@group(0) @binding(3) var<uniform> uniforms: Uniforms;
@group(0) @binding(4) var<storage, read> spatial_cell_offsets: array<u32>;
@group(0) @binding(5) var<storage, read> spatial_triangle_indices: array<u32>;

// Fast 2D bounding box check for XY plane
fn ray_hits_triangle_bbox_2d(ray_x: f32, ray_y: f32, v0: vec3<f32>, v1: vec3<f32>, v2: vec3<f32>) -> bool {
    let min_x = min(min(v0.x, v1.x), v2.x);
    let max_x = max(max(v0.x, v1.x), v2.x);
    let min_y = min(min(v0.y, v1.y), v2.y);
    let max_y = max(max(v0.y, v1.y), v2.y);

    return ray_x >= min_x && ray_x <= max_x && ray_y >= min_y && ray_y <= max_y;
}

// Ray-triangle intersection using Möller-Trumbore algorithm
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

    // Find which spatial grid cell this ray belongs to
    let spatial_cell_x = u32((world_x - uniforms.bounds_min_x) / uniforms.spatial_cell_size);
    let spatial_cell_y = u32((world_y - uniforms.bounds_min_y) / uniforms.spatial_cell_size);

    // Clamp to spatial grid bounds
    let clamped_cx = min(spatial_cell_x, uniforms.spatial_grid_width - 1u);
    let clamped_cy = min(spatial_cell_y, uniforms.spatial_grid_height - 1u);

    let spatial_cell_idx = clamped_cy * uniforms.spatial_grid_width + clamped_cx;

    // Get triangle range for this cell
    let start_idx = spatial_cell_offsets[spatial_cell_idx];
    let end_idx = spatial_cell_offsets[spatial_cell_idx + 1u];

    // Test only triangles in this spatial cell
    for (var idx = start_idx; idx < end_idx; idx++) {
        let tri_idx = spatial_triangle_indices[idx];
        let tri_base = tri_idx * 9u;

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

    // Write output (X/Y as grid indices, not world coordinates)
    let output_idx = grid_y * uniforms.grid_width + grid_x;
    output_points[output_idx * 3u] = f32(grid_x);
    output_points[output_idx * 3u + 1u] = f32(grid_y);
    output_points[output_idx * 3u + 2u] = best_z;

    if (found) {
        valid_mask[output_idx] = 1u;
    } else {
        valid_mask[output_idx] = 0u;
    }
}
`;

const toolpathShaderCode = `
struct SparseToolPoint {
    x_offset: i32,
    y_offset: i32,
    z_value: f32,
    padding: f32,
}

struct Uniforms {
    terrain_width: u32,
    terrain_height: u32,
    tool_count: u32,
    x_step: u32,
    y_step: u32,
    oob_z: f32,
    points_per_line: u32,
    num_scanlines: u32,
}

@group(0) @binding(0) var<storage, read> terrain_map: array<f32>;
@group(0) @binding(1) var<storage, read> sparse_tool: array<SparseToolPoint>;
@group(0) @binding(2) var<storage, read_write> output_path: array<f32>;
@group(0) @binding(3) var<uniform> uniforms: Uniforms;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let scanline = global_id.y;
    let point_idx = global_id.x;

    if (scanline >= uniforms.num_scanlines || point_idx >= uniforms.points_per_line) {
        return;
    }

    let tool_center_x = i32(point_idx * uniforms.x_step);
    let tool_center_y = i32(scanline * uniforms.y_step);

    var min_delta = 3.402823466e+38;

    for (var i = 0u; i < uniforms.tool_count; i++) {
        let tool_point = sparse_tool[i];
        let terrain_x = tool_center_x + tool_point.x_offset;
        let terrain_y = tool_center_y + tool_point.y_offset;

        if (terrain_x < 0 || terrain_y < 0 ||
            terrain_x >= i32(uniforms.terrain_width) ||
            terrain_y >= i32(uniforms.terrain_height)) {
            continue;
        }

        let terrain_idx = u32(terrain_y) * uniforms.terrain_width + u32(terrain_x);
        let terrain_z = terrain_map[terrain_idx];

        if (terrain_z == terrain_z) {
            let delta = tool_point.z_value - terrain_z;
            min_delta = min(min_delta, delta);
        }
    }

    var output_z = uniforms.oob_z;
    if (min_delta < 3.402823466e+38) {
        output_z = -min_delta;
    }

    let output_idx = scanline * uniforms.points_per_line + point_idx;
    output_path[output_idx] = output_z;
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

// Build spatial grid for efficient triangle culling
function buildSpatialGrid(triangles, bounds, cellSize = 5.0) {
    const gridWidth = Math.max(1, Math.ceil((bounds.max.x - bounds.min.x) / cellSize));
    const gridHeight = Math.max(1, Math.ceil((bounds.max.y - bounds.min.y) / cellSize));
    const totalCells = gridWidth * gridHeight;

    console.log(`[WebGPU Worker] Building spatial grid ${gridWidth}x${gridHeight} (${cellSize}mm cells)`);

    const grid = new Array(totalCells);
    for (let i = 0; i < totalCells; i++) {
        grid[i] = [];
    }

    const triangleCount = triangles.length / 9;
    for (let t = 0; t < triangleCount; t++) {
        const base = t * 9;

        const v0x = triangles[base], v0y = triangles[base + 1];
        const v1x = triangles[base + 3], v1y = triangles[base + 4];
        const v2x = triangles[base + 6], v2y = triangles[base + 7];

        const minX = Math.min(v0x, v1x, v2x);
        const maxX = Math.max(v0x, v1x, v2x);
        const minY = Math.min(v0y, v1y, v2y);
        const maxY = Math.max(v0y, v1y, v2y);

        let minCellX = Math.floor((minX - bounds.min.x) / cellSize);
        let maxCellX = Math.floor((maxX - bounds.min.x) / cellSize);
        let minCellY = Math.floor((minY - bounds.min.y) / cellSize);
        let maxCellY = Math.floor((maxY - bounds.min.y) / cellSize);

        minCellX = Math.max(0, Math.min(gridWidth - 1, minCellX));
        maxCellX = Math.max(0, Math.min(gridWidth - 1, maxCellX));
        minCellY = Math.max(0, Math.min(gridHeight - 1, minCellY));
        maxCellY = Math.max(0, Math.min(gridHeight - 1, maxCellY));

        for (let cy = minCellY; cy <= maxCellY; cy++) {
            for (let cx = minCellX; cx <= maxCellX; cx++) {
                const cellIdx = cy * gridWidth + cx;
                grid[cellIdx].push(t);
            }
        }
    }

    let totalTriangleRefs = 0;
    for (let i = 0; i < totalCells; i++) {
        totalTriangleRefs += grid[i].length;
    }

    const cellOffsets = new Uint32Array(totalCells + 1);
    const triangleIndices = new Uint32Array(totalTriangleRefs);

    let currentOffset = 0;
    for (let i = 0; i < totalCells; i++) {
        cellOffsets[i] = currentOffset;
        for (let j = 0; j < grid[i].length; j++) {
            triangleIndices[currentOffset++] = grid[i][j];
        }
    }
    cellOffsets[totalCells] = currentOffset;

    const avgPerCell = totalTriangleRefs / totalCells;
    console.log(`[WebGPU Worker] Spatial grid: ${totalTriangleRefs} refs (avg ${avgPerCell.toFixed(1)} per cell)`);

    return {
        gridWidth,
        gridHeight,
        cellSize,
        cellOffsets,
        triangleIndices,
        avgTrianglesPerCell: avgPerCell
    };
}

// Rasterize mesh to point cloud
// Internal function - rasterize without tiling (do not modify this function!)
async function rasterizeMeshSingle(triangles, stepSize, filterMode, boundsOverride = null) {
    const startTime = performance.now();

    if (!isInitialized) {
        const initStart = performance.now();
        const success = await initWebGPU();
        if (!success) {
            throw new Error('WebGPU not available');
        }
        const initEnd = performance.now();
        console.log(`[WebGPU Worker] First-time init: ${(initEnd - initStart).toFixed(1)}ms`);
    }

    console.log(`[WebGPU Worker] Rasterizing ${triangles.length / 9} triangles (step ${stepSize}mm, mode ${filterMode})...`);

    // Use bounds override if provided, otherwise calculate from triangles
    const bounds = boundsOverride || calculateBounds(triangles);

    if (boundsOverride) {
        console.log(`[WebGPU Worker] Using bounds override: min(${bounds.min.x.toFixed(2)}, ${bounds.min.y.toFixed(2)}, ${bounds.min.z.toFixed(2)}) max(${bounds.max.x.toFixed(2)}, ${bounds.max.y.toFixed(2)}, ${bounds.max.z.toFixed(2)})`);

        // Validate bounds
        if (bounds.min.x >= bounds.max.x || bounds.min.y >= bounds.max.y || bounds.min.z >= bounds.max.z) {
            throw new Error(`Invalid bounds: min must be less than max. Got min(${bounds.min.x}, ${bounds.min.y}, ${bounds.min.z}) max(${bounds.max.x}, ${bounds.max.y}, ${bounds.max.z})`);
        }
    }

    const gridWidth = Math.ceil((bounds.max.x - bounds.min.x) / stepSize) + 1;
    const gridHeight = Math.ceil((bounds.max.y - bounds.min.y) / stepSize) + 1;
    const totalGridPoints = gridWidth * gridHeight;

    console.log(`[WebGPU Worker] Grid: ${gridWidth}x${gridHeight} = ${totalGridPoints.toLocaleString()} points`);

    // Check for WebGPU limits
    const outputSize = totalGridPoints * 3 * 4;
    const maxBufferSize = device.limits.maxBufferSize || 268435456; // 256MB default
    console.log(`[WebGPU Worker] Output buffer size: ${(outputSize / 1024 / 1024).toFixed(2)} MB (max: ${(maxBufferSize / 1024 / 1024).toFixed(2)} MB)`);

    if (outputSize > maxBufferSize) {
        throw new Error(`Output buffer too large: ${(outputSize / 1024 / 1024).toFixed(2)} MB exceeds device limit of ${(maxBufferSize / 1024 / 1024).toFixed(2)} MB. Try a larger step size.`);
    }

    const spatialGrid = buildSpatialGrid(triangles, bounds);

    // Create buffers
    const triangleBuffer = device.createBuffer({
        size: triangles.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(triangleBuffer, 0, triangles);
    const outputBuffer = device.createBuffer({
        size: outputSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const validMaskBuffer = device.createBuffer({
        size: totalGridPoints * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const spatialCellOffsetsBuffer = device.createBuffer({
        size: spatialGrid.cellOffsets.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(spatialCellOffsetsBuffer, 0, spatialGrid.cellOffsets);

    const spatialTriangleIndicesBuffer = device.createBuffer({
        size: spatialGrid.triangleIndices.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(spatialTriangleIndicesBuffer, 0, spatialGrid.triangleIndices);

    // Uniforms
    const uniformData = new Float32Array([
        bounds.min.x, bounds.min.y, bounds.min.z,
        bounds.max.x, bounds.max.y, bounds.max.z,
        stepSize,
        0, 0, 0, 0, 0, 0, 0, 0
    ]);
    const uniformDataU32 = new Uint32Array(uniformData.buffer);
    uniformDataU32[7] = gridWidth;
    uniformDataU32[8] = gridHeight;
    uniformDataU32[9] = triangles.length / 9;
    uniformDataU32[10] = filterMode;
    uniformDataU32[11] = spatialGrid.gridWidth;
    uniformDataU32[12] = spatialGrid.gridHeight;
    const uniformDataF32 = new Float32Array(uniformData.buffer);
    uniformDataF32[13] = spatialGrid.cellSize;

    // Check for u32 overflow
    const maxU32 = 4294967295;
    if (gridWidth > maxU32 || gridHeight > maxU32) {
        throw new Error(`Grid dimensions exceed u32 max: ${gridWidth}x${gridHeight}`);
    }

    console.log(`[WebGPU Worker] Uniforms: gridWidth=${gridWidth}, gridHeight=${gridHeight}, triangles=${triangles.length / 9}`);

    const uniformBuffer = device.createBuffer({
        size: uniformData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    // Use cached pipeline
    const bindGroup = device.createBindGroup({
        layout: cachedRasterizePipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: triangleBuffer } },
            { binding: 1, resource: { buffer: outputBuffer } },
            { binding: 2, resource: { buffer: validMaskBuffer } },
            { binding: 3, resource: { buffer: uniformBuffer } },
            { binding: 4, resource: { buffer: spatialCellOffsetsBuffer } },
            { binding: 5, resource: { buffer: spatialTriangleIndicesBuffer } },
        ],
    });

    // Dispatch compute shader
    const commandEncoder = device.createCommandEncoder();
    const passEncoder = commandEncoder.beginComputePass();
    passEncoder.setPipeline(cachedRasterizePipeline);
    passEncoder.setBindGroup(0, bindGroup);

    const workgroupsX = Math.ceil(gridWidth / 16);
    const workgroupsY = Math.ceil(gridHeight / 16);

    // Check dispatch limits
    const maxWorkgroupsPerDim = device.limits.maxComputeWorkgroupsPerDimension || 65535;
    console.log(`[WebGPU Worker] Dispatching ${workgroupsX}x${workgroupsY} workgroups (max per dim: ${maxWorkgroupsPerDim})`);

    if (workgroupsX > maxWorkgroupsPerDim || workgroupsY > maxWorkgroupsPerDim) {
        throw new Error(`Workgroup dispatch too large: ${workgroupsX}x${workgroupsY} exceeds limit of ${maxWorkgroupsPerDim}. Try a larger step size.`);
    }

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

    // Wait for GPU to finish
    await device.queue.onSubmittedWorkDone();

    // Read back results
    await stagingOutputBuffer.mapAsync(GPUMapMode.READ);
    await stagingValidMaskBuffer.mapAsync(GPUMapMode.READ);

    const outputData = new Float32Array(stagingOutputBuffer.getMappedRange());
    const validMaskData = new Uint32Array(stagingValidMaskBuffer.getMappedRange());

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
    spatialCellOffsetsBuffer.destroy();
    spatialTriangleIndicesBuffer.destroy();
    stagingOutputBuffer.destroy();
    stagingValidMaskBuffer.destroy();

    const result = new Float32Array(validPoints);
    const pointCount = validPoints.length / 3;

    const endTime = performance.now();
    const conversionTime = endTime - startTime;
    console.log(`[WebGPU Worker] ✅ Rasterize complete: ${pointCount} points in ${conversionTime.toFixed(1)}ms`);
    console.log(`[WebGPU Worker] Bounds: min(${bounds.min.x.toFixed(2)}, ${bounds.min.y.toFixed(2)}, ${bounds.min.z.toFixed(2)}) max(${bounds.max.x.toFixed(2)}, ${bounds.max.y.toFixed(2)}, ${bounds.max.z.toFixed(2)})`);

    // Verify result data integrity
    if (result.length > 0) {
        const firstPoint = `(${result[0].toFixed(3)}, ${result[1].toFixed(3)}, ${result[2].toFixed(3)})`;
        const lastIdx = result.length - 3;
        const lastPoint = `(${result[lastIdx].toFixed(3)}, ${result[lastIdx+1].toFixed(3)}, ${result[lastIdx+2].toFixed(3)})`;
        console.log(`[WebGPU Worker] First point: ${firstPoint}, Last point: ${lastPoint}`);
    }

    return {
        positions: result,
        pointCount: pointCount,
        bounds: bounds,
        conversionTime: conversionTime
    };
}

// Create tiles for tiled rasterization
function createTiles(bounds, stepSize, maxMemoryBytes) {
    const width = bounds.max.x - bounds.min.x;
    const height = bounds.max.y - bounds.min.y;

    // Binary search for optimal tile dimension
    let low = config.minTileSize;
    let high = Math.max(width, height);
    let bestTileDim = high;

    while (low <= high) {
        const mid = (low + high) / 2;
        const gridW = Math.ceil(mid / stepSize);
        const gridH = Math.ceil(mid / stepSize);
        const memoryNeeded = gridW * gridH * 4 * 4; // output + mask

        if (memoryNeeded <= maxMemoryBytes) {
            bestTileDim = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    const tilesX = Math.ceil(width / bestTileDim);
    const tilesY = Math.ceil(height / bestTileDim);
    const actualTileWidth = width / tilesX;
    const actualTileHeight = height / tilesY;

    console.log(`[WebGPU Worker] Creating ${tilesX}x${tilesY} = ${tilesX * tilesY} tiles (${actualTileWidth.toFixed(2)}mm × ${actualTileHeight.toFixed(2)}mm each)`);

    const tiles = [];
    const overlap = stepSize * 2; // Overlap by 2 grid cells to ensure no gaps

    for (let ty = 0; ty < tilesY; ty++) {
        for (let tx = 0; tx < tilesX; tx++) {
            // Calculate base tile bounds
            let tileMinX = bounds.min.x + (tx * actualTileWidth);
            let tileMinY = bounds.min.y + (ty * actualTileHeight);
            let tileMaxX = Math.min(bounds.max.x, tileMinX + actualTileWidth);
            let tileMaxY = Math.min(bounds.max.y, tileMinY + actualTileHeight);

            // Extend bounds by overlap (except at outer edges)
            if (tx > 0) tileMinX -= overlap;
            if (ty > 0) tileMinY -= overlap;
            if (tx < tilesX - 1) tileMaxX += overlap;
            if (ty < tilesY - 1) tileMaxY += overlap;

            tiles.push({
                id: `tile_${tx}_${ty}`,
                bounds: {
                    min: { x: tileMinX, y: tileMinY, z: bounds.min.z },
                    max: { x: tileMaxX, y: tileMaxY, z: bounds.max.z }
                }
            });
        }
    }

    return { tiles, tilesX, tilesY };
}

// Stitch point clouds from multiple tiles
function stitchTiles(tileResults, fullBounds) {
    if (tileResults.length === 0) {
        throw new Error('No tile results to stitch');
    }

    if (tileResults.length === 1) {
        return tileResults[0];
    }

    // Calculate total points
    let totalPoints = 0;
    for (const result of tileResults) {
        totalPoints += result.pointCount;
    }

    console.log(`[WebGPU Worker] Stitching ${tileResults.length} tiles with ${totalPoints} total points`);

    // Combine all points
    const allPositions = new Float32Array(totalPoints * 3);
    let offset = 0;

    for (const result of tileResults) {
        allPositions.set(result.positions, offset);
        offset += result.positions.length;
    }

    return {
        positions: allPositions,
        pointCount: totalPoints,
        bounds: fullBounds,
        conversionTime: tileResults.reduce((sum, r) => sum + (r.conversionTime || 0), 0),
        tileCount: tileResults.length
    };
}

// Check if tiling is needed
function shouldUseTiling(bounds, stepSize) {
    if (!config || !config.autoTiling) return false;
    if (!deviceCapabilities) return false;

    const gridWidth = Math.ceil((bounds.max.x - bounds.min.x) / stepSize) + 1;
    const gridHeight = Math.ceil((bounds.max.y - bounds.min.y) / stepSize) + 1;
    const totalPoints = gridWidth * gridHeight;

    const gpuOutputBuffer = totalPoints * 3 * 4;
    const gpuMaskBuffer = totalPoints * 4;
    const totalGPUMemory = gpuOutputBuffer + gpuMaskBuffer;

    // Use the smaller of configured limit or device capability
    const configuredLimit = config.maxGPUMemoryMB * 1024 * 1024;
    const deviceLimit = deviceCapabilities.maxStorageBufferBindingSize;
    const maxSafeSize = Math.min(configuredLimit, deviceLimit) * config.gpuMemorySafetyMargin;

    return totalGPUMemory > maxSafeSize;
}

// Rasterize mesh - wrapper that will be used for potential tiling at toolpath stage
async function rasterizeMesh(triangles, stepSize, filterMode, boundsOverride = null) {
    // Just use single-pass for now - tiling happens at toolpath generation stage
    return await rasterizeMeshSingle(triangles, stepSize, filterMode, boundsOverride);
}

// Helper: Create height map from point cloud
// Points come from GPU as [gridX, gridY, Z] - grid indices for X/Y
function createHeightMapFromPoints(points, gridStep, bounds = null) {
    // Calculate grid dimensions from bounds
    let width, height, minX, minY, minZ, maxX, maxY, maxZ;

    if (bounds) {
        // Use provided bounds to calculate grid dimensions
        minX = bounds.min.x;
        minY = bounds.min.y;
        minZ = bounds.min.z;
        maxX = bounds.max.x;
        maxY = bounds.max.y;
        maxZ = bounds.max.z;
        width = Math.ceil((maxX - minX) / gridStep) + 1;
        height = Math.ceil((maxY - minY) / gridStep) + 1;
    } else {
        // Calculate bounds from points (points are grid indices for X/Y)
        if (!points || points.length === 0) {
            throw new Error('No points provided and no bounds specified');
        }

        let minGridX = Infinity, minGridY = Infinity;
        let maxGridX = -Infinity, maxGridY = -Infinity;
        minZ = Infinity;
        maxZ = -Infinity;

        for (let i = 0; i < points.length; i += 3) {
            minGridX = Math.min(minGridX, points[i]);
            maxGridX = Math.max(maxGridX, points[i]);
            minGridY = Math.min(minGridY, points[i + 1]);
            maxGridY = Math.max(maxGridY, points[i + 1]);
            minZ = Math.min(minZ, points[i + 2]);
            maxZ = Math.max(maxZ, points[i + 2]);
        }

        width = Math.floor(maxGridX) + 1;
        height = Math.floor(maxGridY) + 1;
        // For bounds reporting (convert back to world coords)
        minX = 0; maxX = (width - 1) * gridStep;
        minY = 0; maxY = (height - 1) * gridStep;
    }

    const grid = new Float32Array(width * height);
    grid.fill(NaN); // Initialize with NaN

    // Fill grid with point data (points are [gridX, gridY, Z])
    if (points && points.length > 0) {
        for (let i = 0; i < points.length; i += 3) {
            const gridX = Math.floor(points[i]);      // Grid index
            const gridY = Math.floor(points[i + 1]);  // Grid index
            const z = points[i + 2];

            // Bounds check
            if (gridX >= 0 && gridX < width && gridY >= 0 && gridY < height) {
                const idx = gridY * width + gridX;

                // Keep max Z value for each cell (terrain surface)
                if (isNaN(grid[idx]) || z > grid[idx]) {
                    grid[idx] = z;
                }
            }
        }
    }

    return {
        grid,
        width,
        height,
        minX,
        minY,
        minZ,
        maxX,
        maxY,
        maxZ
    };
}

// Helper: Create sparse tool representation
// Points come from GPU as [gridX, gridY, Z] - pure integer grid coordinates for X/Y
function createSparseToolFromPoints(points, gridStep) {
    if (!points || points.length === 0) {
        throw new Error('No tool points provided');
    }

    // Points are [gridX, gridY, Z] where gridX/gridY are grid indices (floats but integer values)
    // Find bounds in grid space and tool tip Z
    let minGridX = Infinity, minGridY = Infinity, minZ = Infinity;
    let maxGridX = -Infinity, maxGridY = -Infinity;

    for (let i = 0; i < points.length; i += 3) {
        const gridX = points[i];      // Already a grid index
        const gridY = points[i + 1];  // Already a grid index
        const z = points[i + 2];

        minGridX = Math.min(minGridX, gridX);
        maxGridX = Math.max(maxGridX, gridX);
        minGridY = Math.min(minGridY, gridY);
        maxGridY = Math.max(maxGridY, gridY);
        minZ = Math.min(minZ, z);
    }

    // Calculate tool center in grid coordinates (pure integer)
    const width = Math.floor(maxGridX - minGridX) + 1;
    const height = Math.floor(maxGridY - minGridY) + 1;
    const centerX = Math.floor(minGridX) + Math.floor(width / 2);
    const centerY = Math.floor(minGridY) + Math.floor(height / 2);

    // Convert each point to offset from center (integer arithmetic only)
    const xOffsets = [];
    const yOffsets = [];
    const zValues = [];

    for (let i = 0; i < points.length; i += 3) {
        const gridX = Math.floor(points[i]);      // Grid index (ensure integer)
        const gridY = Math.floor(points[i + 1]);  // Grid index (ensure integer)
        const z = points[i + 2];

        // Calculate offset from tool center (pure integer arithmetic)
        const xOffset = gridX - centerX;
        const yOffset = gridY - centerY;
        const zValue = z - minZ; // Z relative to tool tip

        xOffsets.push(xOffset);
        yOffsets.push(yOffset);
        zValues.push(zValue);
    }

    return {
        count: xOffsets.length,
        xOffsets: new Int32Array(xOffsets),
        yOffsets: new Int32Array(yOffsets),
        zValues: new Float32Array(zValues),
        referenceZ: minZ
    };
}

// Generate toolpath for a single region (internal)
async function generateToolpathSingle(terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep, terrainBounds = null) {
    const startTime = performance.now();
    console.log('[WebGPU Worker] Generating toolpath...');
    console.log(`[WebGPU Worker] Input: terrain ${terrainPoints.length/3} points, tool ${toolPoints.length/3} points, steps (${xStep}, ${yStep}), oobZ ${oobZ}, gridStep ${gridStep}`);

    if (terrainBounds) {
        console.log(`[WebGPU Worker] Using terrain bounds: min(${terrainBounds.min.x.toFixed(2)}, ${terrainBounds.min.y.toFixed(2)}, ${terrainBounds.min.z.toFixed(2)}) max(${terrainBounds.max.x.toFixed(2)}, ${terrainBounds.max.y.toFixed(2)}, ${terrainBounds.max.z.toFixed(2)})`);
    }

    try {
        // Create height map from terrain points (use terrain bounds if provided)
        const terrainMapData = createHeightMapFromPoints(terrainPoints, gridStep, terrainBounds);
        console.log(`[WebGPU Worker] Created terrain map: ${terrainMapData.width}x${terrainMapData.height}`);

        // Create sparse tool representation
        const sparseToolData = createSparseToolFromPoints(toolPoints, gridStep);
        console.log(`[WebGPU Worker] Created sparse tool: ${sparseToolData.count} points`);

        // Run WebGPU compute
        const result = await runToolpathCompute(
            terrainMapData, sparseToolData, xStep, yStep, oobZ, startTime
        );

        return result;
    } catch (error) {
        console.error('[WebGPU Worker] Error generating toolpath:', error);
        throw error;
    }
}

async function runToolpathCompute(terrainMapData, sparseToolData, xStep, yStep, oobZ, startTime) {
    if (!isInitialized) {
        const success = await initWebGPU();
        if (!success) {
            throw new Error('WebGPU not available');
        }
    }

    // Use WASM-generated terrain grid
    const terrainBuffer = device.createBuffer({
        size: terrainMapData.grid.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(terrainBuffer, 0, terrainMapData.grid);

    // Use WASM-generated sparse tool
    const toolBufferData = new ArrayBuffer(sparseToolData.count * 16);
    const toolBufferI32 = new Int32Array(toolBufferData);
    const toolBufferF32 = new Float32Array(toolBufferData);

    for (let i = 0; i < sparseToolData.count; i++) {
        toolBufferI32[i * 4 + 0] = sparseToolData.xOffsets[i];
        toolBufferI32[i * 4 + 1] = sparseToolData.yOffsets[i];
        toolBufferF32[i * 4 + 2] = sparseToolData.zValues[i];
        toolBufferF32[i * 4 + 3] = 0;
    }

    const toolBuffer = device.createBuffer({
        size: toolBufferData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(toolBuffer, 0, toolBufferData);

    // Calculate output dimensions
    const pointsPerLine = Math.ceil(terrainMapData.width / xStep);
    const numScanlines = Math.ceil(terrainMapData.height / yStep);
    const outputSize = pointsPerLine * numScanlines;

    console.log(`[WebGPU Worker] Output: ${pointsPerLine}x${numScanlines} = ${outputSize} points`);

    const outputBuffer = device.createBuffer({
        size: outputSize * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const uniformData = new Uint32Array([
        terrainMapData.width,
        terrainMapData.height,
        sparseToolData.count,
        xStep,
        yStep,
        0,
        pointsPerLine,
        numScanlines,
    ]);
    const uniformDataFloat = new Float32Array(uniformData.buffer);
    uniformDataFloat[5] = oobZ;

    const uniformBuffer = device.createBuffer({
        size: uniformData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    // Use cached pipeline
    const bindGroup = device.createBindGroup({
        layout: cachedToolpathPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: terrainBuffer } },
            { binding: 1, resource: { buffer: toolBuffer } },
            { binding: 2, resource: { buffer: outputBuffer } },
            { binding: 3, resource: { buffer: uniformBuffer } },
        ],
    });

    const commandEncoder = device.createCommandEncoder();
    const passEncoder = commandEncoder.beginComputePass();
    passEncoder.setPipeline(cachedToolpathPipeline);
    passEncoder.setBindGroup(0, bindGroup);

    const workgroupsX = Math.ceil(pointsPerLine / 16);
    const workgroupsY = Math.ceil(numScanlines / 16);
    passEncoder.dispatchWorkgroups(workgroupsX, workgroupsY);
    passEncoder.end();

    const stagingBuffer = device.createBuffer({
        size: outputSize * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    commandEncoder.copyBufferToBuffer(outputBuffer, 0, stagingBuffer, 0, outputSize * 4);

    device.queue.submit([commandEncoder.finish()]);
    await stagingBuffer.mapAsync(GPUMapMode.READ);

    const outputData = new Float32Array(stagingBuffer.getMappedRange());
    const result = new Float32Array(outputData);
    stagingBuffer.unmap();

    terrainBuffer.destroy();
    toolBuffer.destroy();
    outputBuffer.destroy();
    uniformBuffer.destroy();
    stagingBuffer.destroy();

    const endTime = performance.now();
    console.log(`[WebGPU Worker] ✅ Toolpath complete in ${(endTime - startTime).toFixed(1)}ms`);
    console.log(`[WebGPU Worker] Output: ${result.length} values (${numScanlines} scanlines × ${pointsPerLine} points)`);

    // Log sample of output for debugging
    const sampleSize = Math.min(10, result.length);
    console.log(`[WebGPU Worker] First ${sampleSize} values:`, Array.from(result.slice(0, sampleSize)));

    return {
        pathData: result,
        numScanlines,
        pointsPerLine,
        generationTime: endTime - startTime
    };
}

// Generate toolpath with tiling support (public API)
async function generateToolpath(terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep, terrainBounds = null) {
    // Calculate bounds if not provided
    if (!terrainBounds) {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < terrainPoints.length; i += 3) {
            minX = Math.min(minX, terrainPoints[i]);
            maxX = Math.max(maxX, terrainPoints[i]);
            minY = Math.min(minY, terrainPoints[i + 1]);
            maxY = Math.max(maxY, terrainPoints[i + 1]);
            minZ = Math.min(minZ, terrainPoints[i + 2]);
            maxZ = Math.max(maxZ, terrainPoints[i + 2]);
        }
        terrainBounds = {
            min: { x: minX, y: minY, z: minZ },
            max: { x: maxX, y: maxY, z: maxZ }
        };
    }

    // Calculate tool dimensions for overlap
    let toolMinX = Infinity, toolMaxX = -Infinity;
    let toolMinY = Infinity, toolMaxY = -Infinity;
    for (let i = 0; i < toolPoints.length; i += 3) {
        toolMinX = Math.min(toolMinX, toolPoints[i]);
        toolMaxX = Math.max(toolMaxX, toolPoints[i]);
        toolMinY = Math.min(toolMinY, toolPoints[i + 1]);
        toolMaxY = Math.max(toolMaxY, toolPoints[i + 1]);
    }
    const toolWidth = toolMaxX - toolMinX;
    const toolHeight = toolMaxY - toolMinY;

    // Check if tiling is needed based on output grid size
    const outputWidth = Math.ceil((terrainBounds.max.x - terrainBounds.min.x) / gridStep) + 1;
    const outputHeight = Math.ceil((terrainBounds.max.y - terrainBounds.min.y) / gridStep) + 1;
    const outputPoints = Math.ceil(outputWidth / xStep) * Math.ceil(outputHeight / yStep);
    const outputMemory = outputPoints * 4; // 4 bytes per float

    const configuredLimit = config.maxGPUMemoryMB * 1024 * 1024;
    const deviceLimit = deviceCapabilities.maxStorageBufferBindingSize;
    const maxSafeSize = Math.min(configuredLimit, deviceLimit) * config.gpuMemorySafetyMargin;

    if (outputMemory <= maxSafeSize) {
        // No tiling needed
        return await generateToolpathSingle(terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep, terrainBounds);
    }

    // Tiling needed
    console.log('[WebGPU Worker] 🔲 Using tiled toolpath generation');
    console.log(`[WebGPU Worker] Tool dimensions: ${toolWidth.toFixed(2)}mm × ${toolHeight.toFixed(2)}mm`);

    // Create tiles with tool-size overlap
    const tiles = createToolpathTiles(terrainBounds, gridStep, xStep, yStep, toolWidth, toolHeight, maxSafeSize);
    console.log(`[WebGPU Worker] Created ${tiles.length} tiles`);

    // Process each tile
    const tileResults = [];
    for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i];
        console.log(`[WebGPU Worker] Processing tile ${i + 1}/${tiles.length}...`);

        // Filter terrain points to this tile's bounds
        const tileTerrainPoints = [];
        for (let j = 0; j < terrainPoints.length; j += 3) {
            const x = terrainPoints[j];
            const y = terrainPoints[j + 1];
            const z = terrainPoints[j + 2];
            if (x >= tile.bounds.min.x && x <= tile.bounds.max.x &&
                y >= tile.bounds.min.y && y <= tile.bounds.max.y) {
                tileTerrainPoints.push(x, y, z);
            }
        }

        // Generate toolpath for this tile
        const tileToolpathResult = await generateToolpathSingle(
            new Float32Array(tileTerrainPoints),
            toolPoints,
            xStep,
            yStep,
            oobZ,
            gridStep,
            tile.bounds
        );

        tileResults.push({
            pathData: tileToolpathResult.pathData,
            numScanlines: tileToolpathResult.numScanlines,
            pointsPerLine: tileToolpathResult.pointsPerLine,
            tile: tile
        });

        console.log(`[WebGPU Worker] Tile ${i + 1}/${tiles.length} complete: ${tileToolpathResult.numScanlines}×${tileToolpathResult.pointsPerLine}`);
    }

    // Stitch tiles together, dropping overlap regions
    const stitchedResult = stitchToolpathTiles(tileResults, terrainBounds, gridStep, xStep, yStep);
    console.log(`[WebGPU Worker] ✅ Tiled toolpath complete: ${stitchedResult.numScanlines}×${stitchedResult.pointsPerLine}`);

    return stitchedResult;
}

// Create tiles for toolpath generation with overlap (using integer grid coordinates)
function createToolpathTiles(bounds, gridStep, xStep, yStep, toolWidth, toolHeight, maxMemoryBytes) {
    // Calculate global grid dimensions
    const globalGridWidth = Math.ceil((bounds.max.x - bounds.min.x) / gridStep) + 1;
    const globalGridHeight = Math.ceil((bounds.max.y - bounds.min.y) / gridStep) + 1;

    // Calculate tool overlap in grid cells
    const toolOverlapX = Math.ceil(toolWidth / gridStep);
    const toolOverlapY = Math.ceil(toolHeight / gridStep);

    // Binary search for optimal tile size in grid cells
    let low = Math.max(toolOverlapX, toolOverlapY) * 2; // At least 2x tool size
    let high = Math.max(globalGridWidth, globalGridHeight);
    let bestTileGridSize = high;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const outputW = Math.ceil(mid / xStep);
        const outputH = Math.ceil(mid / yStep);
        const memoryNeeded = outputW * outputH * 4;

        if (memoryNeeded <= maxMemoryBytes) {
            bestTileGridSize = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    const tilesX = Math.ceil(globalGridWidth / bestTileGridSize);
    const tilesY = Math.ceil(globalGridHeight / bestTileGridSize);
    const coreGridWidth = Math.ceil(globalGridWidth / tilesX);
    const coreGridHeight = Math.ceil(globalGridHeight / tilesY);

    console.log(`[WebGPU Worker] Creating ${tilesX}×${tilesY} tiles (${coreGridWidth}×${coreGridHeight} cells core + ${toolOverlapX}×${toolOverlapY} cells overlap)`);

    const tiles = [];
    for (let ty = 0; ty < tilesY; ty++) {
        for (let tx = 0; tx < tilesX; tx++) {
            // Core tile in grid coordinates
            const coreGridStartX = tx * coreGridWidth;
            const coreGridStartY = ty * coreGridHeight;
            const coreGridEndX = Math.min((tx + 1) * coreGridWidth, globalGridWidth) - 1;
            const coreGridEndY = Math.min((ty + 1) * coreGridHeight, globalGridHeight) - 1;

            // Extended tile with overlap in grid coordinates
            let extGridStartX = coreGridStartX;
            let extGridStartY = coreGridStartY;
            let extGridEndX = coreGridEndX;
            let extGridEndY = coreGridEndY;

            // Add overlap on sides that aren't at global boundary
            if (tx > 0) extGridStartX -= toolOverlapX;
            if (ty > 0) extGridStartY -= toolOverlapY;
            if (tx < tilesX - 1) extGridEndX += toolOverlapX;
            if (ty < tilesY - 1) extGridEndY += toolOverlapY;

            // Clamp to global bounds
            extGridStartX = Math.max(0, extGridStartX);
            extGridStartY = Math.max(0, extGridStartY);
            extGridEndX = Math.min(globalGridWidth - 1, extGridEndX);
            extGridEndY = Math.min(globalGridHeight - 1, extGridEndY);

            // Convert grid coordinates to world coordinates
            const extMinX = bounds.min.x + extGridStartX * gridStep;
            const extMinY = bounds.min.y + extGridStartY * gridStep;
            const extMaxX = bounds.min.x + extGridEndX * gridStep;
            const extMaxY = bounds.min.y + extGridEndY * gridStep;

            const coreMinX = bounds.min.x + coreGridStartX * gridStep;
            const coreMinY = bounds.min.y + coreGridStartY * gridStep;
            const coreMaxX = bounds.min.x + coreGridEndX * gridStep;
            const coreMaxY = bounds.min.y + coreGridEndY * gridStep;

            tiles.push({
                id: `tile_${tx}_${ty}`,
                tx, ty,
                tilesX, tilesY,
                bounds: {
                    min: { x: extMinX, y: extMinY, z: bounds.min.z },
                    max: { x: extMaxX, y: extMaxY, z: bounds.max.z }
                },
                core: {
                    gridStart: { x: coreGridStartX, y: coreGridStartY },
                    gridEnd: { x: coreGridEndX, y: coreGridEndY },
                    min: { x: coreMinX, y: coreMinY },
                    max: { x: coreMaxX, y: coreMaxY }
                }
            });
        }
    }

    return tiles;
}

// Stitch toolpath tiles together, dropping overlap regions (using integer grid coordinates)
function stitchToolpathTiles(tileResults, globalBounds, gridStep, xStep, yStep) {
    // Calculate global output dimensions
    const globalWidth = Math.ceil((globalBounds.max.x - globalBounds.min.x) / gridStep) + 1;
    const globalHeight = Math.ceil((globalBounds.max.y - globalBounds.min.y) / gridStep) + 1;
    const globalPointsPerLine = Math.ceil(globalWidth / xStep);
    const globalNumScanlines = Math.ceil(globalHeight / yStep);

    const result = new Float32Array(globalPointsPerLine * globalNumScanlines);
    result.fill(NaN);

    for (const tileResult of tileResults) {
        const tile = tileResult.tile;
        const tileData = tileResult.pathData;

        // Use the pre-calculated integer grid coordinates from tile.core
        const coreGridStartX = tile.core.gridStart.x;
        const coreGridStartY = tile.core.gridStart.y;
        const coreGridEndX = tile.core.gridEnd.x;
        const coreGridEndY = tile.core.gridEnd.y;

        // Calculate tile's extended grid coordinates
        const extGridStartX = Math.round((tile.bounds.min.x - globalBounds.min.x) / gridStep);
        const extGridStartY = Math.round((tile.bounds.min.y - globalBounds.min.y) / gridStep);

        // For each grid cell in the core region
        for (let gridY = coreGridStartY; gridY <= coreGridEndY; gridY++) {
            for (let gridX = coreGridStartX; gridX <= coreGridEndX; gridX++) {
                // Convert grid cell to output cell (with xStep/yStep)
                if (gridX % xStep === 0 && gridY % yStep === 0) {
                    const globalOutX = gridX / xStep;
                    const globalOutY = gridY / yStep;

                    // Calculate corresponding position in tile's output
                    const tileGridX = gridX - extGridStartX;
                    const tileGridY = gridY - extGridStartY;
                    const tileOutX = Math.floor(tileGridX / xStep);
                    const tileOutY = Math.floor(tileGridY / yStep);

                    // Check bounds and copy
                    if (globalOutX >= 0 && globalOutX < globalPointsPerLine &&
                        globalOutY >= 0 && globalOutY < globalNumScanlines &&
                        tileOutX >= 0 && tileOutX < tileResult.pointsPerLine &&
                        tileOutY >= 0 && tileOutY < tileResult.numScanlines) {
                        const tileIdx = tileOutY * tileResult.pointsPerLine + tileOutX;
                        const globalIdx = globalOutY * globalPointsPerLine + globalOutX;
                        result[globalIdx] = tileData[tileIdx];
                    }
                }
            }
        }
    }

    return {
        pathData: result,
        numScanlines: globalNumScanlines,
        pointsPerLine: globalPointsPerLine,
        generationTime: 0 // Sum from tiles if needed
    };
}

// Handle messages from main thread
self.onmessage = async function(e) {
    const { type, data } = e.data;

    try {
        switch (type) {
            case 'init':
                // Store config
                config = data?.config || {
                    maxGPUMemoryMB: 256,
                    gpuMemorySafetyMargin: 0.8,
                    tileOverlapMM: 10,
                    autoTiling: true,
                    minTileSize: 50
                };
                const success = await initWebGPU();
                self.postMessage({
                    type: 'webgpu-ready',
                    data: {
                        success,
                        capabilities: deviceCapabilities
                    }
                });
                break;

            case 'update-config':
                config = data.config;
                console.log('[WebGPU Worker] Config updated:', config);
                break;

            case 'rasterize':
                const { triangles, stepSize, filterMode, isForTool, boundsOverride } = data;
                const rasterResult = await rasterizeMesh(triangles, stepSize, filterMode, boundsOverride);
                self.postMessage({
                    type: 'rasterize-complete',
                    data: rasterResult,
                    isForTool: isForTool || false // Pass through the flag
                }, [rasterResult.positions.buffer]);
                break;

            case 'generate-toolpath':
                const { terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep, terrainBounds } = data;
                const toolpathResult = await generateToolpath(
                    terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep, terrainBounds
                );
                self.postMessage({
                    type: 'toolpath-complete',
                    data: toolpathResult
                }, [toolpathResult.pathData.buffer]);
                break;

            default:
                self.postMessage({
                    type: 'error',
                    message: 'Unknown message type: ' + type
                });
        }
    } catch (error) {
        console.error('[WebGPU Worker] Error:', error);
        self.postMessage({
            type: 'error',
            message: error.message,
            stack: error.stack
        });
    }
};

// Initialize on load
initWebGPU();
