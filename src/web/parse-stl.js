// parse-stl.js
// Pure JavaScript STL parser (binary and ASCII)

// Parse binary STL file
export function parseBinarySTL(buffer) {
    const dataView = new DataView(buffer);

    // Skip 80-byte header
    const numTriangles = dataView.getUint32(80, true); // little-endian

    const positions = new Float32Array(numTriangles * 9);
    let offset = 84; // After header and triangle count

    for (let i = 0; i < numTriangles; i++) {
        // Skip normal (12 bytes)
        offset += 12;

        // Read 3 vertices (9 floats)
        for (let j = 0; j < 9; j++) {
            positions[i * 9 + j] = dataView.getFloat32(offset, true);
            offset += 4;
        }

        // Skip attribute byte count (2 bytes)
        offset += 2;
    }

    return { positions, triangleCount: numTriangles };
}

// Parse ASCII STL file
export function parseASCIISTL(text) {
    const positions = [];
    const lines = text.split('\n');
    let inFacet = false;
    const vertices = [];

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith('facet')) {
            inFacet = true;
            vertices.length = 0;
        } else if (trimmed.startsWith('vertex')) {
            if (inFacet) {
                const parts = trimmed.split(/\s+/);
                vertices.push(
                    parseFloat(parts[1]),
                    parseFloat(parts[2]),
                    parseFloat(parts[3])
                );
            }
        } else if (trimmed.startsWith('endfacet')) {
            if (vertices.length === 9) {
                positions.push(...vertices);
            }
            inFacet = false;
        }
    }

    return {
        positions: new Float32Array(positions),
        triangleCount: positions.length / 9
    };
}

// Auto-detect and parse STL file
export function parseSTL(buffer) {
    // Try to detect if binary or ASCII
    const view = new Uint8Array(buffer);
    const header = String.fromCharCode(...view.slice(0, 5));

    if (header === 'solid') {
        // Might be ASCII, but could also be binary with "solid" in header
        // Try to decode as text
        const text = new TextDecoder().decode(buffer);
        if (text.includes('facet') && text.includes('vertex')) {
            // Looks like ASCII
            return parseASCIISTL(text);
        }
    }

    // Default to binary
    return parseBinarySTL(buffer);
}
