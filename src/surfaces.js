import { createHtmlSurface } from './gpu.js';

export function resizeSurface(device, canvas, surface, sampler, bindGroupLayout, ratioX, ratioY) {
  const next = createHtmlSurface(device, canvas, surface.element, sampler, bindGroupLayout, ratioX, ratioY);
  destroySurface(surface);
  return next;
}

export function destroySurface(surface) {
  if (!surface) return;
  surface.texture.destroy();
  surface.uniformBuffer.destroy();
}
