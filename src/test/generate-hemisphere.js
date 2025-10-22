#!/usr/bin/env node
/**
 * Generate a downward-facing hemisphere STL for testing toolpath generation.
 * The hemisphere represents a ball-end mill or similar CNC tool.
 */

import fs from 'fs';

function writeSTLBinary(filename, triangles) {
    const bufferSize = 80 + 4 + (triangles.length * 50);
    const buffer = Buffer.alloc(bufferSize);
    let offset = 0;

    // Header (80 bytes)
    buffer.write('Hemisphere tool for CNC toolpath testing', 0);
    offset = 80;

    // Number of triangles
    buffer.writeUInt32LE(triangles.length, offset);
    offset += 4;

    // Write each triangle
    for (const tri of triangles) {
        const [v1, v2, v3] = tri;

        // Calculate normal vector
        const edge1 = [v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]];
        const edge2 = [v3[0] - v1[0], v3[1] - v1[1], v3[2] - v1[2]];
        const normal = [
            edge1[1] * edge2[2] - edge1[2] * edge2[1],
            edge1[2] * edge2[0] - edge1[0] * edge2[2],
            edge1[0] * edge2[1] - edge1[1] * edge2[0]
        ];

        // Normalize
        const length = Math.sqrt(normal[0]**2 + normal[1]**2 + normal[2]**2);
        if (length > 0) {
            normal[0] /= length;
            normal[1] /= length;
            normal[2] /= length;
        }

        // Write normal
        buffer.writeFloatLE(normal[0], offset); offset += 4;
        buffer.writeFloatLE(normal[1], offset); offset += 4;
        buffer.writeFloatLE(normal[2], offset); offset += 4;

        // Write vertices
        for (const vertex of tri) {
            buffer.writeFloatLE(vertex[0], offset); offset += 4;
            buffer.writeFloatLE(vertex[1], offset); offset += 4;
            buffer.writeFloatLE(vertex[2], offset); offset += 4;
        }

        // Attribute byte count
        buffer.writeUInt16LE(0, offset); offset += 2;
    }

    fs.writeFileSync(filename, buffer);
}

function generateHemisphere(radius = 5.0, rings = 16, sectors = 32) {
    /**
     * Generate a downward-facing hemisphere (bottom half of sphere).
     *
     * @param {number} radius - Hemisphere radius in mm
     * @param {number} rings - Number of latitude rings
     * @param {number} sectors - Number of longitude sectors
     * @returns {Array} List of triangles, each triangle is 3 vertices [x, y, z]
     */
    const triangles = [];
    const vertices = [];

    // Add center point at top (z=0)
    vertices.push([0, 0, 0]);

    // Generate rings from top to bottom
    for (let i = 1; i <= rings; i++) {
        const phi = Math.PI / 2 + (Math.PI / 2) * (i / rings); // pi/2 to pi (bottom hemisphere)

        for (let j = 0; j < sectors; j++) {
            const theta = 2 * Math.PI * j / sectors;

            const x = radius * Math.sin(phi) * Math.cos(theta);
            const y = radius * Math.sin(phi) * Math.sin(theta);
            const z = radius * Math.cos(phi); // Will be negative (pointing down)

            vertices.push([x, y, z]);
        }
    }

    // Generate triangles
    // Top cap (connect center to first ring)
    for (let j = 0; j < sectors; j++) {
        const v1 = 0; // Center point
        const v2 = 1 + j;
        const v3 = 1 + ((j + 1) % sectors);
        triangles.push([vertices[v1], vertices[v2], vertices[v3]]);
    }

    // Side triangles (connect rings)
    for (let i = 0; i < rings - 1; i++) {
        for (let j = 0; j < sectors; j++) {
            // Current ring
            const currentRingStart = 1 + i * sectors;
            const nextRingStart = 1 + (i + 1) * sectors;

            const v1 = currentRingStart + j;
            const v2 = nextRingStart + j;
            const v3 = currentRingStart + ((j + 1) % sectors);
            const v4 = nextRingStart + ((j + 1) % sectors);

            // Two triangles per quad
            triangles.push([vertices[v1], vertices[v2], vertices[v3]]);
            triangles.push([vertices[v3], vertices[v2], vertices[v4]]);
        }
    }

    return triangles;
}

// Main
console.log("Generating hemisphere tool STL...");
console.log("  Radius: 5mm");
console.log("  Rings: 16");
console.log("  Sectors: 32");

const triangles = generateHemisphere(5.0, 16, 32);

const outputFile = 'hemisphere_tool_5mm.stl';
writeSTLBinary(outputFile, triangles);

console.log(`  Triangles: ${triangles.length}`);
console.log(`  Output: ${outputFile}`);
console.log("Done!");
