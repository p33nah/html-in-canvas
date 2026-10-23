export async function createGpu(canvas, { onDeviceLost }) {
  if (!navigator.gpu) throw new Error('WebGPU non disponibile.');
  if (typeof GPUQueue === 'undefined' || typeof GPUQueue.prototype.drawElementImageToTexture !== 'function') {
    throw new Error('GPUQueue.drawElementImageToTexture non disponibile.');
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Nessun adapter WebGPU disponibile.');

  const device = await adapter.requestDevice();
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('Contesto WebGPU non disponibile.');

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'premultiplied' });
  device.addEventListener('uncapturederror', (event) => onDeviceLost(event.error));
  device.lost.then((info) => {
    if (info.reason !== 'destroyed') onDeviceLost(new Error(info.message || `Device perso: ${info.reason}`));
  });

  return { adapter, device, context, format };
}

export async function createQuadPipeline(device, format, shaderUrl) {
  const response = await fetch(shaderUrl);
  if (!response.ok) throw new Error(`Caricamento WGSL fallito: HTTP ${response.status}.`);

  const shader = device.createShaderModule({ code: await response.text() });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: shader, entryPoint: 'vs' },
    fragment: {
      module: shader,
      entryPoint: 'fs',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }
        }
      }]
    },
    primitive: { topology: 'triangle-list' }
  });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  return { pipeline, sampler, bindGroupLayout: pipeline.getBindGroupLayout(0) };
}

export function createHtmlSurface(device, canvas, element, sampler, bindGroupLayout, pixelRatioX, pixelRatioY) {
  const sourceSize = canvas.getElementImageDefaultSize(element);
  const width = Math.max(1, Math.ceil(sourceSize.width * pixelRatioX));
  const height = Math.max(1, Math.ceil(sourceSize.height * pixelRatioY));
  if (width > device.limits.maxTextureDimension2D || height > device.limits.maxTextureDimension2D) {
    throw new Error(`Surface oltre il limite texture WebGPU: ${width}×${height}.`);
  }

  const texture = device.createTexture({
    size: { width, height, depthOrArrayLayers: 1 },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
  });
  const uniformBuffer = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: texture.createView() },
      { binding: 2, resource: { buffer: uniformBuffer } }
    ]
  });

  return { element, sourceSize, width, height, texture, uniformBuffer, bindGroup, contentDirty: true };
}

export function uploadHtmlSurface(device, surface) {
  device.queue.drawElementImageToTexture(
    {
      source: surface.element,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: surface.sourceSize.width,
      sourceHeight: surface.sourceSize.height
    },
    { texture: surface.texture, size: { width: surface.width, height: surface.height } }
  );
  surface.contentDirty = false;
}
