// test-converter-new.c
// Native test harness that uses the shared mesh converter library
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>

#include "mesh-converter-lib.h"

// STL data structure
typedef struct {
    float* positions;  // Triangle vertex positions (x,y,z for each vertex)
    int triangle_count;
} STLData;

// Parse binary STL file
STLData parse_binary_stl(const char* filename) {
    STLData data = {NULL, 0};

    FILE* file = fopen(filename, "rb");
    if (!file) {
        fprintf(stderr, "Error: Could not open file %s\n", filename);
        return data;
    }

    // Read header (80 bytes)
    char header[80];
    fread(header, 1, 80, file);

    // Read triangle count
    uint32_t triangle_count;
    fread(&triangle_count, 4, 1, file);

    printf("Triangle count: %u\n", triangle_count);

    // Allocate memory for vertices (9 floats per triangle: 3 vertices × 3 coords)
    data.triangle_count = triangle_count;
    data.positions = (float*)malloc(triangle_count * 9 * sizeof(float));

    // Read triangles
    for (uint32_t i = 0; i < triangle_count; i++) {
        // Read normal (12 bytes) - skip it
        float normal[3];
        fread(normal, 4, 3, file);

        // Read 3 vertices (36 bytes total)
        fread(&data.positions[i * 9], 4, 9, file);

        // Read attribute byte count (2 bytes) - skip it
        uint16_t attr;
        fread(&attr, 2, 1, file);
    }

    fclose(file);
    return data;
}

int main(int argc, char* argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <stl_file> [step_size]\n", argv[0]);
        return 1;
    }

    const char* filename = argv[1];
    float step_size = (argc >= 3) ? atof(argv[2]) : 0.1f;

    printf("Loading STL file: %s\n", filename);
    printf("Step size: %.2f mm\n", step_size);

    // Parse STL
    clock_t start = clock();
    STLData stl = parse_binary_stl(filename);
    clock_t parse_end = clock();

    if (!stl.positions) {
        fprintf(stderr, "Failed to parse STL file\n");
        return 1;
    }

    printf("Parsed %d triangles in %.3f seconds\n",
           stl.triangle_count,
           (double)(parse_end - start) / CLOCKS_PER_SEC);

    // Convert to point mesh using shared library
    int point_count = 0;
    clock_t convert_start = clock();
    float* points = convert_to_point_mesh(stl.positions, stl.triangle_count, step_size, &point_count);
    clock_t convert_end = clock();

    printf("Generated %d points in %.3f seconds\n",
           point_count,
           (double)(convert_end - convert_start) / CLOCKS_PER_SEC);

    // Get bounds
    float bounds[6];
    get_bounds(bounds);
    printf("Bounds: (%.2f, %.2f, %.2f) to (%.2f, %.2f, %.2f)\n",
           bounds[0], bounds[1], bounds[2], bounds[3], bounds[4], bounds[5]);

    // Cleanup
    free(stl.positions);
    free_output();

    return 0;
}
