// mesh-converter-lib.h
// Header file for shared mesh converter algorithm
#ifndef MESH_CONVERTER_LIB_H
#define MESH_CONVERTER_LIB_H

typedef struct {
    float x, y, z;
} Vec3;

typedef struct {
    Vec3 min;
    Vec3 max;
} BoundingBox;

typedef struct {
    Vec3 v0, v1, v2;
    // Precomputed 2D bounding box for fast culling
    float bbox_min_x, bbox_max_x;
    float bbox_min_y, bbox_max_y;
    // Precomputed normal Z component for backface culling
    float normal_z;
    // Minimum Z value for Z-sorting
    float min_z;
} Triangle;

// Face filtering modes
#define FILTER_UPWARD_FACING 0   // Keep upward-facing triangles (normal_z > 0) - for terrain
#define FILTER_DOWNWARD_FACING 1 // Keep downward-facing triangles (normal_z < 0) - for tools
#define FILTER_NONE 2            // Keep all triangles

// Public API
float* convert_to_point_mesh(float* triangles, int triangle_count, float step_size, int* out_point_count, int filter_mode);
void get_bounds(float* out_bounds);
void free_output();
float test_triangle_data(float* triangles, int count);

#endif // MESH_CONVERTER_LIB_H
