// Node.js test for WASM module
const fs = require('fs');
const path = require('path');

async function testWasm() {
    console.log('Loading WASM module...');

    // Load WASM file
    const wasmPath = path.join(__dirname, 'mesh-converter.wasm');
    const wasmBuffer = fs.readFileSync(wasmPath);

    // Import object (let WASM create its own memory)
    const importObject = {
        env: {
            emscripten_notify_memory_growth: (index) => {
                console.log('Memory growth notification:', index);
            },
            emscripten_resize_heap: (size) => {
                console.log('Resize heap request:', size);
                return 0;
            }
        },
        wasi_snapshot_preview1: {
            proc_exit: () => {},
            fd_close: () => 0,
            fd_write: () => 0,
            fd_read: () => 0,
            fd_seek: () => 0
        }
    };

    // Instantiate WASM
    const wasmModule = await WebAssembly.instantiate(wasmBuffer, importObject);
    const { exports } = wasmModule.instance;

    // Use the memory exported by WASM
    const memory = exports.memory;

    console.log('WASM module loaded successfully!');
    console.log('Available exports:', Object.keys(exports));

    // Load STL file
    console.log('\nLoading STL file: inner.stl');
    const stlBuffer = fs.readFileSync(path.join(__dirname, 'inner.stl'));
    const stlView = new DataView(stlBuffer.buffer, stlBuffer.byteOffset, stlBuffer.byteLength);

    // Parse binary STL
    const triangleCount = stlView.getUint32(80, true);
    console.log('Triangle count:', triangleCount);

    // Extract positions
    const positions = new Float32Array(triangleCount * 9);
    let offset = 84;

    for (let i = 0; i < triangleCount; i++) {
        // Skip normal (12 bytes)
        offset += 12;

        // Read 3 vertices (9 floats)
        for (let j = 0; j < 9; j++) {
            positions[i * 9 + j] = stlView.getFloat32(offset, true);
            offset += 4;
        }

        // Skip attribute byte count (2 bytes)
        offset += 2;
    }

    console.log('First triangle:');
    console.log('  v0:', positions[0], positions[1], positions[2]);
    console.log('  v1:', positions[3], positions[4], positions[5]);
    console.log('  v2:', positions[6], positions[7], positions[8]);

    // Allocate memory for input triangles
    console.log('\nAllocating WASM memory...');
    const inputSize = positions.length * 4;
    const inputPtr = exports.malloc(inputSize);
    console.log('Input pointer:', inputPtr);
    console.log('Input size:', inputSize, 'bytes');

    // Copy data to WASM memory
    const wasmMemory = new Float32Array(memory.buffer, inputPtr, positions.length);
    wasmMemory.set(positions);
    console.log('Data copied to WASM memory');

    // Test data with debug function
    const testSum = exports.test_triangle_data(inputPtr, triangleCount);
    console.log('Test sum of first triangle:', testSum);
    console.log('Expected sum:', positions[0] + positions[1] + positions[2] + positions[3] + positions[4] + positions[5] + positions[6] + positions[7] + positions[8]);

    // Allocate memory for output count
    const countPtr = exports.malloc(4);
    console.log('Count pointer:', countPtr);

    // Call conversion function
    console.log('\nCalling convert_to_point_mesh...');
    const stepSize = 0.05;
    console.log('Step size:', stepSize);

    const outputPtr = exports.convert_to_point_mesh(
        inputPtr,
        triangleCount,
        stepSize,
        countPtr
    );

    console.log('Output pointer:', outputPtr);

    // Read output count
    const countArray = new Int32Array(memory.buffer, countPtr, 1);
    const pointCount = countArray[0];
    console.log('Point count:', pointCount);

    // Get bounds
    const boundsPtr = exports.malloc(24);
    exports.get_bounds(boundsPtr);
    const boundsArray = new Float32Array(memory.buffer, boundsPtr, 6);

    console.log('\nBounding box:');
    console.log('  Min:', boundsArray[0], boundsArray[1], boundsArray[2]);
    console.log('  Max:', boundsArray[3], boundsArray[4], boundsArray[5]);
    console.log('  Size:',
        boundsArray[3] - boundsArray[0],
        boundsArray[4] - boundsArray[1],
        boundsArray[5] - boundsArray[2]
    );

    // Sample some points
    if (pointCount > 0 && outputPtr !== 0) {
        const outputArray = new Float32Array(memory.buffer, outputPtr, Math.min(pointCount * 3, 15));
        console.log('\nFirst 5 points:');
        for (let i = 0; i < Math.min(5, pointCount); i++) {
            console.log(`  Point ${i}:`, outputArray[i * 3], outputArray[i * 3 + 1], outputArray[i * 3 + 2]);
        }
    }

    // Cleanup
    exports.free(inputPtr);
    exports.free(countPtr);
    exports.free(boundsPtr);

    console.log('\n✓ Test completed successfully!');
}

testWasm().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
