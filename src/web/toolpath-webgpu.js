// toolpath-webgpu.js
// WebGPU-accelerated toolpath generation using compute shaders

let device = null;
let adapter = null;

// WebGPU compute shader for toolpath generation
const computeShaderCode = `
struct SparseToolPoint {
    x_offset: i32,
    y_offset: i32,
    z_value: f32,
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

    // Check bounds
    if (scanline >= uniforms.num_scanlines || point_idx >= uniforms.points_per_line) {
        return;
    }

    // Calculate terrain position for this output point (tool center)
    let tool_center_x = i32(point_idx * uniforms.x_step);
    let tool_center_y = i32(scanline * uniforms.y_step);

    // Find minimum delta (most negative = deepest collision)
    var min_delta = 3.402823466e+38; // FLT_MAX

    // Iterate through all sparse tool points
    for (var i = 0u; i < uniforms.tool_count; i++) {
        let tool_point = sparse_tool[i];

        // Calculate terrain lookup position for this tool point
        let terrain_x = tool_center_x + tool_point.x_offset;
        let terrain_y = tool_center_y + tool_point.y_offset;

        // Bounds check
        if (terrain_x < 0 || terrain_y < 0 ||
            terrain_x >= i32(uniforms.terrain_width) ||
            terrain_y >= i32(uniforms.terrain_height)) {
            // Out of bounds - skip this tool point
            continue;
        }

        // Get terrain height at this position
        let terrain_idx = u32(terrain_y) * uniforms.terrain_width + u32(terrain_x);
        let terrain_z = terrain_map[terrain_idx];

        // Check if it's a valid cell (not NaN)
        // In WGSL, NaN != NaN, so we can use this to detect NaN
        if (terrain_z == terrain_z) {
            // Calculate delta between tool point Z and terrain Z
            let delta = tool_point.z_value - terrain_z;

            // Track minimum (most negative = highest required tool lift)
            min_delta = min(min_delta, delta);
        }
    }

    // Calculate output Z
    var output_z = uniforms.oob_z;
    if (min_delta < 3.402823466e+38) {
        // Valid collision found, return tool center Z position
        output_z = -min_delta;
    }

    // Write result to output
    let output_idx = scanline * uniforms.points_per_line + point_idx;
    output_path[output_idx] = output_z;
}
`;

// Initialize WebGPU
export async function initWebGPU() {
    if (device) return true; // Already initialized

    if (!navigator.gpu) {
        console.error('❌ WebGPU not supported in this browser');
        return false;
    }

    try {
        adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            console.error('❌ No WebGPU adapter found');
            return false;
        }

        device = await adapter.requestDevice();
        console.log('✅ WebGPU initialized');
        return true;
    } catch (error) {
        console.error('❌ Failed to initialize WebGPU:', error);
        return false;
    }
}

// Convert HeightMap to flat Float32Array for GPU
function heightMapToArray(points, pointCount, gridStep) {
    // Find bounds
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (let i = 0; i < pointCount; i++) {
        const x = points[i * 3 + 0];
        const y = points[i * 3 + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }

    // Calculate grid dimensions
    const width = Math.round((maxX - minX) / gridStep) + 1;
    const height = Math.round((maxY - minY) / gridStep) + 1;

    // Create flat array filled with NaN (empty cells)
    const gridSize = width * height;
    const grid = new Float32Array(gridSize);
    grid.fill(NaN);

    // Fill in point data
    for (let i = 0; i < pointCount; i++) {
        const x = points[i * 3 + 0];
        const y = points[i * 3 + 1];
        const z = points[i * 3 + 2];

        const gx = Math.round((x - minX) / gridStep);
        const gy = Math.round((y - minY) / gridStep);

        if (gx >= 0 && gx < width && gy >= 0 && gy < height) {
            const idx = gy * width + gx;
            // Keep maximum Z if multiple points map to same cell
            if (isNaN(grid[idx]) || z > grid[idx]) {
                grid[idx] = z;
            }
        }
    }

    return { grid, width, height };
}

// Convert tool points to sparse format for GPU
function createSparseTool(points, pointCount, gridStep) {
    // STEP 1: Find the tool tip (minimum Z)
    let toolTipZ = Infinity;
    for (let i = 0; i < pointCount; i++) {
        const z = points[i * 3 + 2];
        if (z < toolTipZ) toolTipZ = z;
    }
    console.log(`🔧 [WebGPU] Tool tip Z: ${toolTipZ.toFixed(3)} (normalizing all tool Z values relative to tip)`);

    // STEP 2: Find bounds
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (let i = 0; i < pointCount; i++) {
        const x = points[i * 3 + 0];
        const y = points[i * 3 + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }

    // Calculate grid dimensions
    const width = Math.round((maxX - minX) / gridStep) + 1;
    const height = Math.round((maxY - minY) / gridStep) + 1;
    const centerX = Math.floor(width / 2);
    const centerY = Math.floor(height / 2);

    // STEP 3: Create temporary grid to collect tool points (Z relative to tip)
    const tempGrid = new Map();

    for (let i = 0; i < pointCount; i++) {
        const x = points[i * 3 + 0];
        const y = points[i * 3 + 1];
        const z = points[i * 3 + 2];

        const gx = Math.round((x - minX) / gridStep);
        const gy = Math.round((y - minY) / gridStep);

        if (gx >= 0 && gx < width && gy >= 0 && gy < height) {
            const key = `${gx},${gy}`;
            // Keep maximum Z if multiple points map to same cell
            // Store Z relative to tool tip (this is the key fix!)
            const relativeZ = z - toolTipZ;
            if (!tempGrid.has(key) || relativeZ > tempGrid.get(key)) {
                tempGrid.set(key, relativeZ);
            }
        }
    }

    // Convert to sparse format: array of structs (x_offset, y_offset, z_value)
    // Each struct is 3 elements: 2 i32s (8 bytes) + 1 f32 (4 bytes) = 12 bytes
    // But GPU alignment requires 16-byte structs, so we'll pack as array
    const sparseCount = tempGrid.size;
    const sparseData = new Float32Array(sparseCount * 3); // [x_offset, y_offset, z] triplets

    let idx = 0;
    for (const [key, z] of tempGrid.entries()) {
        const [gx, gy] = key.split(',').map(Number);
        const xOffset = gx - centerX;
        const yOffset = gy - centerY;

        // Pack as floats (will be cast to ints in shader)
        sparseData[idx * 3 + 0] = xOffset;
        sparseData[idx * 3 + 1] = yOffset;
        sparseData[idx * 3 + 2] = z;
        idx++;
    }

    return { data: sparseData, count: sparseCount, width, height };
}

// Generate toolpath using WebGPU
export async function generateToolpathWebGPU(terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep) {
    if (!device) {
        throw new Error('WebGPU not initialized');
    }

    const startTime = performance.now();

    console.log('🎮 [WebGPU] Starting toolpath generation...');

    // Convert terrain to height map
    const t0 = performance.now();
    const terrainData = heightMapToArray(terrainPoints, terrainPoints.length / 3, gridStep);
    const t1 = performance.now();
    console.log(`🎮 [WebGPU] Terrain map: ${terrainData.width}x${terrainData.height}, time: ${(t1-t0).toFixed(1)}ms`);

    // Convert tool to sparse format
    const toolData = createSparseTool(toolPoints, toolPoints.length / 3, gridStep);
    const t2 = performance.now();
    console.log(`🎮 [WebGPU] Tool map: ${toolData.width}x${toolData.height}, sparse count: ${toolData.count}, time: ${(t2-t1).toFixed(1)}ms`);

    const toolDenseSize = toolData.width * toolData.height;
    const sparsityRatio = ((1 - toolData.count / toolDenseSize) * 100).toFixed(1);
    console.log(`🎮 [WebGPU] Sparsity: ${toolData.count} vs ${toolDenseSize} dense (${sparsityRatio}% sparse)`);

    // Debug: Show sample tool values
    console.log(`🎮 [WebGPU] Sample tool data (first 3 points):`);
    for (let i = 0; i < Math.min(3, toolData.count); i++) {
        const xOff = toolData.data[i * 3 + 0];
        const yOff = toolData.data[i * 3 + 1];
        const zVal = toolData.data[i * 3 + 2];
        console.log(`  Point ${i}: offset=(${xOff}, ${yOff}), z=${zVal.toFixed(3)}`);
    }

    // Calculate output dimensions
    const pointsPerLine = Math.ceil(terrainData.width / xStep);
    const numScanlines = Math.ceil(terrainData.height / yStep);
    const outputSize = pointsPerLine * numScanlines;

    console.log(`🎮 [WebGPU] Output: ${pointsPerLine}x${numScanlines} = ${outputSize} points`);

    // Create GPU buffers
    const t3 = performance.now();

    // Terrain buffer
    const terrainBuffer = device.createBuffer({
        size: terrainData.grid.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(terrainBuffer, 0, terrainData.grid);

    // Sparse tool buffer - need to convert to proper struct format
    // GPU expects struct { i32 x_offset, i32 y_offset, f32 z_value } with 16-byte alignment
    // We need to pack as: [i32 x_offset, i32 y_offset, f32 z_value, f32 padding]
    const toolBufferData = new ArrayBuffer(toolData.count * 16); // 16 bytes per struct
    const toolBufferI32 = new Int32Array(toolBufferData);
    const toolBufferF32 = new Float32Array(toolBufferData);

    for (let i = 0; i < toolData.count; i++) {
        toolBufferI32[i * 4 + 0] = Math.round(toolData.data[i * 3 + 0]); // x_offset as i32
        toolBufferI32[i * 4 + 1] = Math.round(toolData.data[i * 3 + 1]); // y_offset as i32
        toolBufferF32[i * 4 + 2] = toolData.data[i * 3 + 2]; // z_value as f32
        toolBufferF32[i * 4 + 3] = 0; // padding
    }

    const toolBuffer = device.createBuffer({
        size: toolBufferData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(toolBuffer, 0, toolBufferData);

    // Output buffer
    const outputBuffer = device.createBuffer({
        size: outputSize * 4, // Float32Array
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // Uniforms buffer
    const uniformData = new Uint32Array([
        terrainData.width,
        terrainData.height,
        toolData.count,
        xStep,
        yStep,
        0, // padding for oob_z alignment
        pointsPerLine,
        numScanlines,
    ]);
    // Replace padding with oob_z as float
    const uniformDataFloat = new Float32Array(uniformData.buffer);
    uniformDataFloat[5] = oobZ;

    const uniformBuffer = device.createBuffer({
        size: uniformData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const t4 = performance.now();
    console.log(`🎮 [WebGPU] Buffer creation: ${(t4-t3).toFixed(1)}ms`);

    // Create shader module
    const shaderModule = device.createShaderModule({
        code: computeShaderCode,
    });

    // Create compute pipeline
    const computePipeline = device.createComputePipeline({
        layout: 'auto',
        compute: {
            module: shaderModule,
            entryPoint: 'main',
        },
    });

    // Create bind group
    const bindGroup = device.createBindGroup({
        layout: computePipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: terrainBuffer } },
            { binding: 1, resource: { buffer: toolBuffer } },
            { binding: 2, resource: { buffer: outputBuffer } },
            { binding: 3, resource: { buffer: uniformBuffer } },
        ],
    });

    const t5 = performance.now();
    console.log(`🎮 [WebGPU] Pipeline creation: ${(t5-t4).toFixed(1)}ms`);

    // Execute compute shader
    const commandEncoder = device.createCommandEncoder();
    const passEncoder = commandEncoder.beginComputePass();
    passEncoder.setPipeline(computePipeline);
    passEncoder.setBindGroup(0, bindGroup);

    // Dispatch workgroups (16x16 workgroup size)
    const workgroupsX = Math.ceil(pointsPerLine / 16);
    const workgroupsY = Math.ceil(numScanlines / 16);
    passEncoder.dispatchWorkgroups(workgroupsX, workgroupsY);
    passEncoder.end();

    // Create staging buffer for readback
    const stagingBuffer = device.createBuffer({
        size: outputSize * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    commandEncoder.copyBufferToBuffer(outputBuffer, 0, stagingBuffer, 0, outputSize * 4);

    const t6 = performance.now();
    console.log(`🎮 [WebGPU] Command encoding: ${(t6-t5).toFixed(1)}ms`);

    // Submit and wait
    device.queue.submit([commandEncoder.finish()]);

    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const t7 = performance.now();
    console.log(`🎮 [WebGPU] GPU execution + readback: ${(t7-t6).toFixed(1)}ms`);

    const outputData = new Float32Array(stagingBuffer.getMappedRange());
    const result = new Float32Array(outputData); // Copy data
    stagingBuffer.unmap();

    // Cleanup
    terrainBuffer.destroy();
    toolBuffer.destroy();
    outputBuffer.destroy();
    uniformBuffer.destroy();
    stagingBuffer.destroy();

    const endTime = performance.now();
    const totalTime = endTime - startTime;

    console.log(`🎮 [WebGPU] ✅ Complete in ${totalTime.toFixed(1)}ms`);

    // Debug: Show sample output values
    console.log(`🎮 [WebGPU] Sample output (first 5 points):`);
    for (let i = 0; i < Math.min(5, result.length); i++) {
        console.log(`  Point ${i}: z=${result[i].toFixed(3)}`);
    }
    console.log(`🎮 [WebGPU] Sample output (last 5 points):`);
    for (let i = Math.max(0, result.length - 5); i < result.length; i++) {
        console.log(`  Point ${i}: z=${result[i].toFixed(3)}`);
    }

    return {
        pathData: result,
        numScanlines,
        pointsPerLine,
        generationTime: totalTime
    };
}
