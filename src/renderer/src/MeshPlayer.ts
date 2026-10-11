import type { MeshAction } from '../../shared/contracts';

// Deforms the current decoded expression in real time; no replacement poses or raster assets.
export class MeshPlayer {
  private gl: WebGLRenderingContext; private program: WebGLProgram; private texture: WebGLTexture;
  private buffer: WebGLBuffer; private indexBuffer: WebGLBuffer;
  private uv = new Float32Array(41 * 61 * 2); private data = new Float32Array(41 * 61 * 4);
  private disposed = false;
  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('当前设备无法启用连续动作'); this.gl = gl;
    const shader = (kind: number, source: string) => {
      const compiled = gl.createShader(kind)!; gl.shaderSource(compiled, source); gl.compileShader(compiled);
      if (!gl.getShaderParameter(compiled, gl.COMPILE_STATUS)) { gl.deleteShader(compiled); throw new Error('连续动作初始化失败'); } return compiled;
    };
    const vertex = shader(gl.VERTEX_SHADER, 'attribute vec2 position;attribute vec2 uv;varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position,0.0,1.0);}');
    const fragment = shader(gl.FRAGMENT_SHADER, 'precision mediump float;uniform sampler2D picture;varying vec2 vUv;void main(){vec4 p=texture2D(picture,vUv);gl_FragColor=vec4(p.rgb*p.a,p.a);}');
    const program = gl.createProgram()!; gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('连续动作初始化失败');
    this.program = program; gl.useProgram(program);
    this.buffer = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer); gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    for (const [name, offset] of [['position', 0], ['uv', 8]] as const) { const location = gl.getAttribLocation(program, name); gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 16, offset); }
    const indices = new Uint16Array(40 * 60 * 6); let index = 0;
    for (let y = 0; y <= 60; y++) for (let x = 0; x <= 40; x++) { const v = y * 41 + x; this.uv[v * 2] = x / 40; this.uv[v * 2 + 1] = y / 60; }
    for (let y = 0; y < 60; y++) for (let x = 0; x < 40; x++) { const v = y * 41 + x; indices.set([v, v + 1, v + 41, v + 1, v + 42, v + 41], index); index += 6; }
    this.indexBuffer = gl.createBuffer()!; gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    this.texture = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  async play(image: HTMLImageElement, action: MeshAction, signal: AbortSignal, deadline?: number) {
    if (signal.aborted || this.disposed) return;
    const gl = this.gl, rect = this.canvas.getBoundingClientRect(), scale = Math.min(devicePixelRatio, 2);
    this.canvas.width = Math.round(rect.width * scale); this.canvas.height = Math.round(rect.height * scale); gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.bindTexture(gl.TEXTURE_2D, this.texture); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    const imageRatio = image.naturalWidth / image.naturalHeight, width = Math.min(rect.width, rect.height * imageRatio), height = width / imageRatio;
    const sx = width / rect.width, sy = height / rect.height;
    const render = (progress: number) => {
      if (gl.isContextLost()) throw new Error('连续动作暂不可用，请重新显示角色');
      const poses = action.regions.map(region => {
        const end = region.keyframes.findIndex(frame => frame.offset >= progress), right = region.keyframes[Math.max(0, end)], left = region.keyframes[Math.max(0, end - 1)];
        const raw = right.offset === left.offset ? 0 : (progress - left.offset) / (right.offset - left.offset), eased = (1 - Math.cos(Math.PI * raw)) / 2;
        const angle = (left.rotate + (right.rotate - left.rotate) * eased) * Math.PI / 180;
        return { ...region, x: left.x + (right.x - left.x) * eased, y: left.y + (right.y - left.y) * eased, cos: Math.cos(angle), sin: Math.sin(angle) };
      });
      for (let i = 0; i < this.uv.length / 2; i++) {
        const u = this.uv[i * 2], v = this.uv[i * 2 + 1]; let x = u, y = v;
        for (const pose of poses) {
          const distance = ((u - pose.center.x) / pose.radius.x) ** 2 + ((v - pose.center.y) / pose.radius.y) ** 2;
          const weight = Math.max(0, 1 - distance) ** 2;
          const dx = (u - pose.pivot.x) * imageRatio, dy = v - pose.pivot.y;
          x += weight * ((dx * pose.cos - dy * pose.sin - dx) / imageRatio + pose.x);
          y += weight * (dx * pose.sin + dy * pose.cos - dy + pose.y);
        }
        this.data[i * 4] = (x - .5) * 2 * sx; this.data[i * 4 + 1] = 1 - 2 * (1 - sy + y * sy);
        this.data[i * 4 + 2] = u; this.data[i * 4 + 3] = v;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawElements(gl.TRIANGLES, 40 * 60 * 6, gl.UNSIGNED_SHORT, 0);
      this.canvas.dataset.progress = progress.toFixed(4); this.canvas.dataset.action = 'continuous';
    };
    render(0);
    await new Promise<void>((resolve, reject) => {
      const started = performance.now(), duration = deadline === undefined ? action.durationMs : Math.min(action.durationMs, Math.max(100, deadline - Date.now() - 120)); let raf = 0;
      const aborted = () => { cancelAnimationFrame(raf); signal.removeEventListener('abort', aborted); reject(new DOMException('已取消', 'AbortError')); };
      const tick = (time: number) => {
        if (signal.aborted || this.disposed) return aborted();
        const progress = Math.min(1, Math.max(0, (time - started) / duration));
        try { render(progress); } catch (error) { signal.removeEventListener('abort', aborted); reject(error); return; }
        if (progress < 1) raf = requestAnimationFrame(tick); else { signal.removeEventListener('abort', aborted); resolve(); }
      };
      signal.addEventListener('abort', aborted, { once: true }); raf = requestAnimationFrame(tick);
    });
  }
  dispose() {
    this.disposed = true; const gl = this.gl; gl.deleteTexture(this.texture); gl.deleteBuffer(this.buffer); gl.deleteBuffer(this.indexBuffer); gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
