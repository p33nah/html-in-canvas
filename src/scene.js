import { createHtmlSurface, uploadHtmlSurface } from './gpu.js';
import { destroySurface, resizeSurface } from './surfaces.js';

export function createScene({ canvas, context, device, resources, ratioX, ratioY }) {
  const nodes = new Map();
  let disposedSurfaceCount = 0;
  let currentRatioX = ratioX;
  let currentRatioY = ratioY;

  function makeSurface(node) {
    return createHtmlSurface(
      device,
      canvas,
      node.element,
      resources.sampler,
      resources.bindGroupLayout,
      currentRatioX,
      currentRatioY
    );
  }

  function updateGeometry(node, preserveHitTestOrder = false) {
    canvas.updateElementGeometry(node.element, {
      canvasTransform: new DOMMatrix()
        .translate(node.x * currentRatioX, node.y * currentRatioY)
        .scale(currentRatioX, currentRatioY),
      preserveHitTestOrder
    });
  }

  function orderedNodes() {
    return [...nodes.values()];
  }

  function add(element, { x, y }) {
    if (nodes.has(element)) return false;
    nodes.set(element, { element, x, y, surface: null });
    return true;
  }

  function syncPaint(changedElements) {
    for (const element of changedElements) {
      const node = nodes.get(element);
      if (!node) continue;

      const size = canvas.getElementImageDefaultSize(element);
      if (!node.surface) {
        node.surface = makeSurface(node);
      } else if (size.width !== node.surface.sourceSize.width || size.height !== node.surface.sourceSize.height) {
        node.surface = resizeSurface(
          device,
          canvas,
          node.surface,
          resources.sampler,
          resources.bindGroupLayout,
          currentRatioX,
          currentRatioY
        );
        disposedSurfaceCount += 1;
      } else {
        node.surface.contentDirty = true;
      }
    }
  }

  function resize(nextRatioX, nextRatioY) {
    const changed = nextRatioX !== currentRatioX || nextRatioY !== currentRatioY;
    if (!changed) return false;
    currentRatioX = nextRatioX;
    currentRatioY = nextRatioY;

    for (const node of nodes.values()) {
      if (node.surface) {
        node.surface = resizeSurface(
          device,
          canvas,
          node.surface,
          resources.sampler,
          resources.bindGroupLayout,
          currentRatioX,
          currentRatioY
        );
        disposedSurfaceCount += 1;
      }
    }
    return true;
  }

  function render() {
    const renderNodes = orderedNodes().filter((node) => node.surface);
    for (const node of renderNodes) {
      if (node.surface.contentDirty) uploadHtmlSurface(device, node.surface);
      updateGeometry(node);
    }

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.105, g: 0.164, b: 0.25, a: 1 },
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });
    pass.setPipeline(resources.pipeline);
    for (const node of renderNodes) {
      const { surface } = node;
      const uniforms = new Float32Array([
        node.x * currentRatioX, node.y * currentRatioY, surface.width, surface.height,
        canvas.width, canvas.height, 0, 0
      ]);
      device.queue.writeBuffer(surface.uniformBuffer, 0, uniforms);
      pass.setBindGroup(0, surface.bindGroup);
      pass.draw(6);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  function raise(element) {
    const node = nodes.get(element);
    if (!node || [...nodes.keys()].at(-1) === element) return false;
    nodes.delete(element);
    nodes.set(element, node);
    if (node.surface) {
      for (const orderedNode of orderedNodes()) {
        if (orderedNode.surface) updateGeometry(orderedNode);
      }
    }
    return true;
  }

  function remove(element) {
    const node = nodes.get(element);
    if (!node) return false;
    canvas.clearElementGeometry(element);
    if (node.surface) {
      destroySurface(node.surface);
      disposedSurfaceCount += 1;
    }
    nodes.delete(element);
    return true;
  }

  function getStats() {
    let allocatedSurfaceCount = 0;
    for (const node of nodes.values()) {
      if (node.surface) allocatedSurfaceCount += 1;
    }
    return { nodeCount: nodes.size, allocatedSurfaceCount, destroyedSurfaceCount: disposedSurfaceCount };
  }

  function destroy() {
    for (const element of [...nodes.keys()]) remove(element);
  }

  return { add, syncPaint, resize, render, raise, remove, getStats, destroy };
}
