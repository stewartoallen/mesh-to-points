// test-toolpath-v2.c
// CLI test for v2 toolpath generator (height map based)

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>

// Simple STL parser (binary format only)
typedef struct {
    float* vertices;  // Flat array of vertices (x,y,z per vertex)
    int triangle_count;
} STLMesh;

STLMesh* load_stl_binary(const char* filename) {
    FILE* file = fopen(filename, "rb");
    if (!file) {
        printf("Error: Cannot open file %s\n", filename);
        return NULL;
    }

    // Skip header (80 bytes)
    fseek(file, 80, SEEK_SET);

    // Read triangle count
    uint32_t triangle_count;
    fread(&triangle_count, 4, 1, file);
    printf("Loading %u triangles from %s\n", triangle_count, filename);

    // Allocate vertices array (9 floats per triangle)
    STLMesh* mesh = (STLMesh*)malloc(sizeof(STLMesh));
    mesh->triangle_count = triangle_count;
    mesh->vertices = (float*)malloc(triangle_count * 9 * sizeof(float));

    // Read triangles
    for (uint32_t i = 0; i < triangle_count; i++) {
        // Skip normal (12 bytes)
        fseek(file, 12, SEEK_CUR);

        // Read 3 vertices (9 floats)
        fread(&mesh->vertices[i * 9], sizeof(float), 9, file);

        // Skip attribute (2 bytes)
        fseek(file, 2, SEEK_CUR);
    }

    fclose(file);
    return mesh;
}

// Stub mesh converter - we'll use pre-converted points
#include "../wasm/mesh-converter-lib.h"

// Include toolpath generator
#include "../wasm/toolpath-generator.c"

int main(int argc, char** argv) {
    if (argc < 3) {
        printf("Usage: %s <terrain.stl> <tool.stl> [step_size] [x_step] [y_step]\n", argv[0]);
        return 1;
    }

    const char* terrain_file = argv[1];
    const char* tool_file = argv[2];
    float step_size = argc > 3 ? atof(argv[3]) : 0.5f;
    int x_step = argc > 4 ? atoi(argv[4]) : 5;
    int y_step = argc > 5 ? atoi(argv[5]) : 5;

    printf("\n=== Toolpath Generator Test ===\n");
    printf("Step size: %.2fmm\n", step_size);
    printf("X/Y steps: %d/%d\n", x_step, y_step);

    // Load and convert terrain
    printf("\n--- Converting Terrain ---\n");
    STLMesh* terrain_stl = load_stl_binary(terrain_file);
    if (!terrain_stl) return 1;

    clock_t start = clock();
    int terrain_point_count;
    float* terrain_points = convert_to_point_mesh(
        terrain_stl->vertices,
        terrain_stl->triangle_count,
        step_size,
        &terrain_point_count,
        0  // FILTER_UPWARD_FACING
    );
    clock_t terrain_time = clock() - start;
    printf("Terrain: %d points in %.3f seconds\n",
           terrain_point_count,
           (double)terrain_time / CLOCKS_PER_SEC);

    // Load and convert tool
    printf("\n--- Converting Tool ---\n");
    STLMesh* tool_stl = load_stl_binary(tool_file);
    if (!tool_stl) return 1;

    start = clock();
    int tool_point_count;
    float* tool_points = convert_to_point_mesh(
        tool_stl->vertices,
        tool_stl->triangle_count,
        step_size,
        &tool_point_count,
        1  // FILTER_DOWNWARD_FACING
    );
    clock_t tool_time = clock() - start;
    printf("Tool: %d points in %.3f seconds\n",
           tool_point_count,
           (double)tool_time / CLOCKS_PER_SEC);

    // Create height maps
    printf("\n--- Creating Height Maps ---\n");
    start = clock();
    HeightMap* terrain_map = create_terrain_map(terrain_points, terrain_point_count, step_size);
    HeightMap* tool_map = create_tool_map(tool_points, tool_point_count, step_size);
    clock_t map_time = clock() - start;

    printf("Terrain map: %d x %d (%.3f seconds)\n",
           terrain_map->width, terrain_map->height,
           (double)map_time / CLOCKS_PER_SEC);
    printf("Tool map: %d x %d\n", tool_map->width, tool_map->height);


    // Generate toolpath
    printf("\n--- Generating Toolpath ---\n");
    start = clock();
    ToolPath* path = generate_toolpath(terrain_map, tool_map, x_step, y_step, -100.0f);
    clock_t path_time = clock() - start;

    printf("Toolpath: %d x %d = %d points\n",
           path->points_per_line, path->num_scanlines,
           path->points_per_line * path->num_scanlines);
    printf("Generation time: %.6f seconds (%.3f ms)\n",
           (double)path_time / CLOCKS_PER_SEC,
           (double)path_time / CLOCKS_PER_SEC * 1000.0);


    // Cleanup
    free_toolpath(path);
    free_height_map(tool_map);
    free_height_map(terrain_map);
    // Note: tool_points and terrain_points are managed by mesh-converter-lib
    // Don't free them directly
    free(tool_stl->vertices);
    free(tool_stl);
    free(terrain_stl->vertices);
    free(terrain_stl);

    printf("\n=== Test Complete ===\n");
    return 0;
}
