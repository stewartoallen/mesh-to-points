// toolpath-webgpu-v2.js
// WebGPU toolpath using WASM-generated height maps to ensure exact compatibility

import { initWebGPU } from './toolpath-webgpu.js';
export { initWebGPU };

const computeShaderCode = `
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

// Generate toolpath using WebGPU with WASM-generated height maps
export async function generateToolpathWebGPUv2(terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep) {
    const startTime = performance.now();
    console.log('🎮 [WebGPU v2] Starting with WASM-generated grids...');

    // Create a worker to generate WASM height maps
    const worker = new Worker('worker-parallel.js');

    return new Promise(async (resolve, reject) => {
        let terrainMapData = null;
        let toolMapData = null;
        let sparseToolData = null;

        worker.onmessage = async function(e) {
            const { type, data } = e.data;

            if (type === 'wasm-ready') {
                // Request terrain map creation
                worker.postMessage({
                    type: 'create-maps',
                    data: { terrainPoints, toolPoints, gridStep }
                });
            } else if (type === 'maps-created') {
                terrainMapData = data.terrain;
                toolMapData = data.tool;
                sparseToolData = data.sparseTool;

                worker.terminate();

                console.log(`🎮 [WebGPU v2] Got WASM maps: terrain ${terrainMapData.width}x${terrainMapData.height}, tool sparse count ${sparseToolData.count}`);

                // Now run WebGPU with these exact grids
                try {
                    const result = await runWebGPUWithWASMGrids(
                        terrainMapData, sparseToolData, xStep, yStep, oobZ, startTime
                    );
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            } else if (type === 'error') {
                worker.terminate();
                reject(new Error(data.message));
            }
        };

        worker.onerror = function(error) {
            worker.terminate();
            reject(error);
        };
    });
}

async function runWebGPUWithWASMGrids(terrainMapData, sparseToolData, xStep, yStep, oobZ, startTime) {
    const t0 = performance.now();

    const device = await (async () => {
        const adapter = await navigator.gpu.requestAdapter();
        return await adapter.requestDevice();
    })();

    // Use WASM-generated terrain grid directly
    const terrainBuffer = device.createBuffer({
        size: terrainMapData.grid.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(terrainBuffer, 0, terrainMapData.grid);

    // Use WASM-generated sparse tool directly
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

    // Calculate output dimensions (same as WASM)
    const pointsPerLine = Math.ceil(terrainMapData.width / xStep);
    const numScanlines = Math.ceil(terrainMapData.height / yStep);
    const outputSize = pointsPerLine * numScanlines;

    console.log(`🎮 [WebGPU v2] Output: ${pointsPerLine}x${numScanlines} = ${outputSize} points`);

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

    const shaderModule = device.createShaderModule({ code: computeShaderCode });
    const computePipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: shaderModule, entryPoint: 'main' },
    });

    const bindGroup = device.createBindGroup({
        layout: computePipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: terrainBuffer } },
            { binding: 1, resource: { buffer: toolBuffer } },
            { binding: 2, resource: { buffer: outputBuffer } },
            { binding: 3, resource: { buffer: uniformBuffer } },
        ],
    });

    const commandEncoder = device.createCommandEncoder();
    const passEncoder = commandEncoder.beginComputePass();
    passEncoder.setPipeline(computePipeline);
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
    console.log(`🎮 [WebGPU v2] ✅ Complete in ${(endTime - startTime).toFixed(1)}ms`);

    return {
        pathData: result,
        numScanlines,
        pointsPerLine,
        generationTime: endTime - startTime
    };
}
