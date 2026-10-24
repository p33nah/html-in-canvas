import { createHtmlSurface, uploadHtmlSurface } from './gpu.js';
import { destroySurface, resizeSurface } from './surfaces.js';

export function createScene({ canvas, context, device, resources, ratioX, ratioY }) {
  const nodes = new Map();
  let disposedSurfaceCount = 0;
  let snapshotUploadCount = 0;
  let currentRatioX = ratioX;
  let currentRatioY = ratioY;
  const camera = { x: 0, y: 0, zoom: 1 };
  const minZoom = 0.25;
  const maxZoom = 4;

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

  function projectNode(node) {
    const x = camera.x + node.x * camera.zoom;
    const y = camera.y + node.y * camera.zoom;
    return {
      x,
      y,
      scale: camera.zoom,
      backingRect: {
        x: x * currentRatioX,
        y: y * currentRatioY,
        width: node.surface.sourceSize.width * camera.zoom * currentRatioX,
        height: node.surface.sourceSize.height * camera.zoom * currentRatioY
      }
    };
  }

  function updateGeometry(node, preserveHitTestOrder = false, projection = projectNode(node)) {
    canvas.updateElementGeometry(node.element, {
      canvasTransform: new DOMMatrix()
        .translate(projection.x, projection.y)
        .scale(projection.scale),
      preserveHitTestOrder
    });
    node.geometryRegistered = true;
  }

  function orderedNodes() {
    return [...nodes.values()];
  }

  function add(element, { x, y }) {
    if (nodes.has(element)) return false;
    nodes.set(element, { element, x, y, surface: null, geometryRegistered: false });
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
    const projectedNodes = renderNodes.map((node) => ({ node, projection: projectNode(node) }));
    const needsHitTestStack = projectedNodes.some(({ node }) => !node.geometryRegistered);
    for (const { node, projection } of projectedNodes) {
      if (node.surface.contentDirty) {
        uploadHtmlSurface(device, node.surface);
        snapshotUploadCount += 1;
      }
      updateGeometry(node, !needsHitTestStack, projection);
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
    for (const { node, projection } of projectedNodes) {
      const { surface } = node;
      const uniforms = new Float32Array([
        projection.backingRect.x,
        projection.backingRect.y,
        projection.backingRect.width,
        projection.backingRect.height,
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

  function panBy(dx, dy) {
    assertFiniteNumber(dx, 'dx');
    assertFiniteNumber(dy, 'dy');
    camera.x += dx;
    camera.y += dy;
    return true;
  }

  function zoomAt(factor, point) {
    assertFiniteNumber(factor, 'factor');
    assertFiniteNumber(point?.x, 'point.x');
    assertFiniteNumber(point?.y, 'point.y');
    if (factor <= 0) throw new RangeError('factor deve essere maggiore di zero.');

    const nextZoom = Math.min(maxZoom, Math.max(minZoom, camera.zoom * factor));
    if (nextZoom === camera.zoom) return false;

    const worldX = (point.x - camera.x) / camera.zoom;
    const worldY = (point.y - camera.y) / camera.zoom;
    camera.x = point.x - worldX * nextZoom;
    camera.y = point.y - worldY * nextZoom;
    camera.zoom = nextZoom;
    return true;
  }

  function moveNodeBy(element, dx, dy) {
    assertFiniteNumber(dx, 'dx');
    assertFiniteNumber(dy, 'dy');
    const node = nodes.get(element);
    if (!node) return false;
    node.x += dx / camera.zoom;
    node.y += dy / camera.zoom;
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
    return {
      nodeCount: nodes.size,
      allocatedSurfaceCount,
      destroyedSurfaceCount: disposedSurfaceCount,
      snapshotUploadCount
    };
  }

  function getCamera() {
    return { ...camera };
  }

  function assertFiniteNumber(value, name) {
    if (!Number.isFinite(value)) throw new TypeError(`${name} deve essere un numero finito.`);
  }

  function destroy() {
    for (const element of [...nodes.keys()]) remove(element);
  }

  return { add, syncPaint, resize, render, raise, remove, panBy, zoomAt, moveNodeBy, getCamera, getStats, destroy };
}
