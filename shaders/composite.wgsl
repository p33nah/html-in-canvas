struct Params {
  rect: vec4f,
  viewport: vec4f,
};

@group(0) @binding(0) var imageSampler: sampler;
@group(0) @binding(1) var imageTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VertexOutput {
  let corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0)
  );
  let uv = corners[index];
  let pixel = params.rect.xy + uv * params.rect.zw;
  let clip = vec2f(
    2.0 * pixel.x / params.viewport.x - 1.0,
    1.0 - 2.0 * pixel.y / params.viewport.y
  );

  var output: VertexOutput;
  output.position = vec4f(clip, 0.0, 1.0);
  output.uv = uv;
  return output;
}

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4f {
  return textureSample(imageTexture, imageSampler, input.uv);
}
