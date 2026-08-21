# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────
#  Lasting Atlas — self-contained static container
#  The running image needs NO internet: third-party libraries are
#  vendored at build time so the container is fully self-sufficient.
# ─────────────────────────────────────────────────────────────

# Stage 1 — fetch third-party runtime deps once, at build time.
FROM alpine:3.19 AS vendor
RUN apk add --no-cache curl
WORKDIR /vendor
RUN curl -fsSL https://unpkg.com/three@0.160.0/build/three.min.js -o three.min.js
# Real coastline / country geometry (Natural Earth, public domain) so the
# illustrated terrain generates offline with no runtime CDN call.
RUN curl -fsSL https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json -o countries-50m.json

# Stage 2 — final static image.
FROM nginx:1.27-alpine

# App source (the Design Component, its runtime, the map texture, etc.)
COPY index.html /usr/share/nginx/html/index.html
COPY support.js /usr/share/nginx/html/support.js
COPY ["Lasting Atlas.dc.html", "/usr/share/nginx/html/Lasting Atlas.dc.html"]
COPY assets/ /usr/share/nginx/html/assets/

# Copy terrain tiles and structure assets into the image
COPY assets/terrain_desert.png assets/terrain_desert_rocky.png \
     assets/terrain_desert_oasis.png assets/terrain_desert_savanna.png \
     assets/terrain_grass.png assets/terrain_grass_farm.png \
     assets/terrain_grass_steppe.png assets/terrain_grass_forest.png \
     assets/terrain_forest.png assets/terrain_forest_ruins.png \
     assets/terrain_forest_taiga.png assets/terrain_forest_grass.png \
     assets/terrain_snow.png assets/terrain_snow_polar.png \
     assets/terrain_snow_crystals.png assets/terrain_savanna.png \
     assets/terrain_savanna_wet.png assets/terrain_alpine.png \
     assets/terrain_alpine_volcano.png \
     assets/linker_grass_plain.png assets/linker_grass_mud.png \
     assets/linker_grass_sparse_trees.png assets/linker_sand_flat.png \
     assets/linker_sand_gravel.png assets/linker_sand_grass_edge.png \
     assets/linker_coast_sandy.png assets/linker_coast_rocky.png \
     assets/linker_forest_sparse.png assets/linker_mountain_foot.png \
     assets/linker_savanna_burnt.png assets/linker_snow_rocks.png \
     assets/struct_mountain.png assets/struct_temple.png \
     assets/struct_harbor.png assets/struct_town.png \
     assets/struct_observatory.png \
     /usr/share/nginx/html/assets/

# Vendored Three.js (so the globe works with no runtime CDN call).
COPY --from=vendor /vendor/three.min.js /usr/share/nginx/html/assets/three.min.js
# Vendored Natural Earth geometry (the app loads assets/countries-50m.json first).
COPY --from=vendor /vendor/countries-50m.json /usr/share/nginx/html/assets/countries-50m.json

# Repoint the app at the local copy of Three.js instead of the CDN.
RUN sed -i 's#https://unpkg.com/three@0.160.0/build/three.min.js#assets/three.min.js#g' \
    "/usr/share/nginx/html/Lasting Atlas.dc.html"

COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1
