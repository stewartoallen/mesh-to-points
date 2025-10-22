/**
 * CLI Test Program for Toolpath Generation
 *
 * Usage: ./test-toolpath <terrain.stl> <tool.stl> <x_step> <y_step>
 *
 * Example: ./test-toolpath inner.stl hemisphere_tool_5mm.stl 2 10
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>

// Include the toolpath generator source directly for native testing
#include "../wasm/toolpath-generator.c"

// STL reading functions from existing test code
typedef struct {
    float x, y, z;
} Vertex;

typedef struct {
    Vertex normal;
    Vertex vertices[3];
} Triangle;

typedef struct {
    Triangle* triangles;
    int count;
} STLData;

STLData* read_stl_binary(const char* filename) {
    FILE* file = fopen(filename, "rb");
    if (!file) {
        fprintf(stderr, "Error: Could not open file %s\n", filename);
        return NULL;
    }

    // Skip 80-byte header
    fseek(file, 80, SEEK_SET);

    // Read triangle count
    unsigned int triangle_count;
    fread(&triangle_count, sizeof(unsigned int), 1, file);

    STLData* data = (STLData*)malloc(sizeof(STLData));
    data->count = triangle_count;
    data->triangles = (Triangle*)malloc(sizeof(Triangle) * triangle_count);

    // Read triangles
    for (unsigned int i = 0; i < triangle_count; i++) {
        // Normal
        fread(&data->triangles[i].normal, sizeof(float), 3, file);
        // Vertices
        fread(&data->triangles[i].vertices, sizeof(float), 9, file);
        // Skip attribute byte count
        fseek(file, 2, SEEK_CUR);
    }

    fclose(file);
    return data;
}

void free_stl_data(STLData* data) {
    if (data) {
        free(data->triangles);
        free(data);
    }
}

// Convert STL triangles to flat array for mesh converter
float* triangles_to_array(STLData* data) {
    int float_count = data->count * 9; // 3 vertices * 3 floats per triangle
    float* array = (float*)malloc(sizeof(float) * float_count);

    for (int i = 0; i < data->count; i++) {
        for (int v = 0; v < 3; v++) {
            array[i * 9 + v * 3 + 0] = data->triangles[i].vertices[v].x;
            array[i * 9 + v * 3 + 1] = data->triangles[i].vertices[v].y;
            array[i * 9 + v * 3 + 2] = data->triangles[i].vertices[v].z;
        }
    }

    return array;
}

// Simple mesh-to-points converter (XY rasterization) - simplified version
float* convert_mesh_to_points(float* triangles, int triangle_count, float step_size, int* out_point_count) {
    // Find bounding box
    float min_x = 1e10, max_x = -1e10;
    float min_y = 1e10, max_y = -1e10;
    float min_z = 1e10, max_z = -1e10;

    for (int i = 0; i < triangle_count * 3; i++) {
        float x = triangles[i * 3 + 0];
        float y = triangles[i * 3 + 1];
        float z = triangles[i * 3 + 2];

        if (x < min_x) min_x = x;
        if (x > max_x) max_x = x;
        if (y < min_y) min_y = y;
        if (y > max_y) max_y = y;
        if (z < min_z) min_z = z;
        if (z > max_z) max_z = z;
    }

    printf("  Bounds: X[%.2f, %.2f] Y[%.2f, %.2f] Z[%.2f, %.2f]\n",
           min_x, max_x, min_y, max_y, min_z, max_z);

    // Calculate grid dimensions
    int grid_x = (int)((max_x - min_x) / step_size) + 1;
    int grid_y = (int)((max_y - min_y) / step_size) + 1;

    printf("  Grid: %d x %d (step: %.3fmm)\n", grid_x, grid_y, step_size);

    // Allocate point array (worst case: one point per grid cell)
    float* points = (float*)malloc(sizeof(float) * grid_x * grid_y * 3);
    int point_count = 0;

    // Raster XY plane
    for (int iy = 0; iy < grid_y; iy++) {
        float y = min_y + iy * step_size;

        for (int ix = 0; ix < grid_x; ix++) {
            float x = min_x + ix * step_size;

            // Cast ray down from top, find highest intersection
            float highest_z = -1e10;
            int found_hit = 0;

            // Test ray against all triangles (simplified - not optimized)
            for (int t = 0; t < triangle_count; t++) {
                float* tri = &triangles[t * 9];
                float x0 = tri[0], y0 = tri[1], z0 = tri[2];
                float x1 = tri[3], y1 = tri[4], z1 = tri[5];
                float x2 = tri[6], y2 = tri[7], z2 = tri[8];

                // Simple point-in-triangle test and Z interpolation
                // This is a very simplified version - just checking bounding box for now
                float tri_min_x = fmin(fmin(x0, x1), x2) - step_size;
                float tri_max_x = fmax(fmax(x0, x1), x2) + step_size;
                float tri_min_y = fmin(fmin(y0, y1), y2) - step_size;
                float tri_max_y = fmax(fmax(y0, y1), y2) + step_size;

                if (x >= tri_min_x && x <= tri_max_x && y >= tri_min_y && y <= tri_max_y) {
                    // Approximate Z by taking average of triangle vertices
                    float avg_z = (z0 + z1 + z2) / 3.0;
                    if (avg_z > highest_z) {
                        highest_z = avg_z;
                        found_hit = 1;
                    }
                }
            }

            if (found_hit) {
                points[point_count * 3 + 0] = x;
                points[point_count * 3 + 1] = y;
                points[point_count * 3 + 2] = highest_z;
                point_count++;
            }
        }
    }

    *out_point_count = point_count;
    printf("  Generated %d points\n", point_count);

    return points;
}

int main(int argc, char* argv[]) {
    if (argc != 5) {
        printf("Usage: %s <terrain.stl> <tool.stl> <x_step> <y_step>\n", argv[0]);
        printf("  x_step, y_step: grid units to step (e.g., 2, 10)\n");
        printf("\nExample: %s inner.stl hemisphere_tool_5mm.stl 2 10\n", argv[0]);
        return 1;
    }

    const char* terrain_file = argv[1];
    const char* tool_file = argv[2];
    int x_step = atoi(argv[3]);
    int y_step = atoi(argv[4]);

    printf("=== Toolpath Generator Test ===\n\n");

    // Load terrain STL
    printf("Loading terrain: %s\n", terrain_file);
    STLData* terrain_stl = read_stl_binary(terrain_file);
    if (!terrain_stl) return 1;
    printf("  Triangles: %d\n", terrain_stl->count);

    // Load tool STL
    printf("\nLoading tool: %s\n", tool_file);
    STLData* tool_stl = read_stl_binary(tool_file);
    if (!tool_stl) {
        free_stl_data(terrain_stl);
        return 1;
    }
    printf("  Triangles: %d\n", tool_stl->count);

    // Convert to point clouds
    printf("\nConverting terrain to point cloud...\n");
    float* terrain_triangles = triangles_to_array(terrain_stl);
    int terrain_point_count;
    float* terrain_points = convert_mesh_to_points(terrain_triangles, terrain_stl->count, 0.5, &terrain_point_count);

    printf("\nConverting tool to point cloud...\n");
    float* tool_triangles = triangles_to_array(tool_stl);
    int tool_point_count;
    float* tool_points = convert_mesh_to_points(tool_triangles, tool_stl->count, 0.5, &tool_point_count);

    // Create grids
    printf("\nCreating terrain grid...\n");
    PointGrid* terrain_grid = create_point_grid(terrain_points, terrain_point_count);
    printf("  Grid dimensions: %d x %d\n", terrain_grid->width, terrain_grid->height);

    printf("\nCreating tool cloud...\n");
    ToolCloud* tool_cloud = create_tool_cloud(tool_points, tool_point_count, 0.5);
    printf("  Tool points: %d\n", tool_cloud->point_count);

    // Generate toolpath
    printf("\nGenerating toolpath...\n");
    printf("  X step: %d grid units\n", x_step);
    printf("  Y step: %d grid units\n", y_step);

    clock_t start = clock();
    ToolPath* path = generate_toolpath(terrain_grid, tool_cloud, x_step, y_step, -100.0);
    clock_t end = clock();

    double time_taken = ((double)(end - start)) / CLOCKS_PER_SEC;

    printf("  Scanlines: %d\n", path->num_scanlines);
    printf("  Points per line: %d\n", path->points_per_line);
    printf("  Total points: %d\n", path->num_scanlines * path->points_per_line);
    printf("  Time: %.3f seconds\n", time_taken);

    // Sample output (first few points)
    printf("\nSample toolpath (first 5 points of first scanline):\n");
    for (int i = 0; i < 5 && i < path->points_per_line; i++) {
        printf("  [%d]: Z = %.3f mm\n", i, path->scanlines[0][i]);
    }

    // Output some statistics
    float min_z = 1e10, max_z = -1e10;
    for (int y = 0; y < path->num_scanlines; y++) {
        for (int x = 0; x < path->points_per_line; x++) {
            float z = path->scanlines[y][x];
            if (z < min_z) min_z = z;
            if (z > max_z) max_z = z;
        }
    }
    printf("\nPath Z range: [%.3f, %.3f] mm\n", min_z, max_z);

    // Cleanup
    free_toolpath(path);
    free_tool_cloud(tool_cloud);
    free_point_grid(terrain_grid);
    free(tool_points);
    free(terrain_points);
    free(tool_triangles);
    free(terrain_triangles);
    free_stl_data(tool_stl);
    free_stl_data(terrain_stl);

    printf("\n=== Test Complete ===\n");
    return 0;
}
