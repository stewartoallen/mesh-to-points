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

// Public API
float* convert_to_point_mesh(float* triangles, int triangle_count, float step_size, int* out_point_count);
void get_bounds(float* out_bounds);
void free_output();
float test_triangle_data(float* triangles, int count);

#endif // MESH_CONVERTER_LIB_H
