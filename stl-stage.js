/* <stl-stage> — lightweight STL background viewer.
   Attributes:
     models  — JSON: [{"src":"...","name":"...","desc":"..."}]
     spin    — seconds per full rotation (default 18)
     tint    — mesh hex color (default #d9d9d9)
     paint   — cursor paintbrush color (default #990000)
     cycle   — seconds between models when several (default 16)
   Any element in the page with [data-ascii-target] gets the ASCII-mesh
   treatment where the model passes behind it.
*/
(() => {
  const THREE_URL = 'https://unpkg.com/three@0.160.0/build/three.module.js';
  let threePromise = null;
  const loadThree = () => (threePromise ||= import(THREE_URL));
  const ASCII_CHARS = ['0', '/', '\\', '|', '0', '0'];

  function parseSTL(buffer, THREE) {
    const dv = new DataView(buffer);
    const isBinary = (() => {
      if (buffer.byteLength < 84) return false;
      const n = dv.getUint32(80, true);
      return 84 + n * 50 === buffer.byteLength;
    })();
    let positions;
    if (isBinary) {
      const n = dv.getUint32(80, true);
      positions = new Float32Array(n * 9);
      let off = 84, p = 0;
      for (let i = 0; i < n; i++) {
        off += 12;
        for (let v = 0; v < 9; v++) { positions[p++] = dv.getFloat32(off, true); off += 4; }
        off += 2;
      }
    } else {
      const text = new TextDecoder().decode(buffer);
      const nums = [];
      const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
      let m;
      while ((m = re.exec(text))) nums.push(+m[1], +m[2], +m[3]);
      positions = new Float32Array(nums);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    geo.center();
    return geo;
  }

  class STLStage extends HTMLElement {
    static get observedAttributes() { return ['spin', 'tint', 'models', 'paint']; }
    connectedCallback() {
      if (this._init) return; this._init = true;
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `
        <style>
          :host{display:block;position:relative;overflow:hidden}
          canvas.gl{display:block;width:100%;height:100%}
          canvas.fx{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2}
          .cap{position:absolute;right:28px;bottom:24px;text-align:right;
               font:11px/1.6 ui-monospace,'SF Mono',Menlo,monospace;color:#8a8a8a;
               letter-spacing:.06em;pointer-events:none;transition:opacity .6s}
          .cap b{display:block;color:#4a4a4a;font-weight:500;text-transform:uppercase}
        </style>
        <canvas class="gl"></canvas><canvas class="fx"></canvas><div class="cap"></div>`;
      this._cap = this.shadowRoot.querySelector('.cap');
      this._start();
    }
    attributeChangedCallback(name) {
      if (!this._scene) return;
      if (name === 'spin') this._spin = +this.getAttribute('spin') || 18;
      if (name === 'tint') this._retint();
      if (name === 'models') this._loadModels();
    }
    _tintRGB() {
      const c = new this._THREE.Color(this.getAttribute('tint') || '#d9d9d9');
      return c;
    }
    _retint() {
      if (!this._current) return;
      const c = this._tintRGB();
      const col = this._current.geometry.getAttribute('color');
      if (!col) return;
      for (let i = 0; i < col.count; i++) col.setXYZ(i, c.r, c.g, c.b);
      col.needsUpdate = true;
    }
    async _start() {
      const THREE = this._THREE = await loadThree();
      const canvas = this.shadowRoot.querySelector('canvas.gl');
      const fx = this._fx = this.shadowRoot.querySelector('canvas.fx');
      this._fxCtx = fx.getContext('2d');
      const renderer = this._renderer = new THREE.WebGLRenderer({
        canvas, alpha: true, antialias: true, powerPreference: 'low-power'
      });
      const PR = Math.min(devicePixelRatio, 1.5);
      renderer.setPixelRatio(PR);
      const scene = this._scene = new THREE.Scene();
      const cam = this._cam = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
      cam.position.set(0, 0.55, 4.4);
      cam.lookAt(0, 0, 0);
      scene.add(new THREE.HemisphereLight(0xffffff, 0xcfcfcf, 1.1));
      const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(3, 4, 5); scene.add(key);
      const rim = new THREE.DirectionalLight(0xffffff, 0.5); rim.position.set(-4, 2, -3); scene.add(rim);
      this._pivot = new THREE.Group(); scene.add(this._pivot);
      this._spin = +this.getAttribute('spin') || 18;
      this._mat = new THREE.MeshStandardMaterial({
        color: 0xffffff, vertexColors: true,
        metalness: 0.15, roughness: 0.55, flatShading: true, transparent: true
      });
      this._ray = new THREE.Raycaster();
      this._pointer = null; this._pointerDirty = false;
      window.addEventListener('pointermove', (e) => {
        const r = this.getBoundingClientRect();
        this._pointer = { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
        this._pointerDirty = true;
      }, { passive: true });
      const resize = () => {
        const w = this.clientWidth || 1, h = this.clientHeight || 1;
        renderer.setSize(w, h, false);
        fx.width = Math.round(w * PR); fx.height = Math.round(h * PR);
        cam.aspect = w / h; cam.updateProjectionMatrix();
        this._targetsStale = true;
      };
      new ResizeObserver(resize).observe(this); resize();
      this._PR = PR;
      let last = performance.now();
      const loop = (t) => {
        const dt = Math.min(t - last, 100) / 1000; last = t;
        if (this._pivot) this._pivot.rotation.y += (Math.PI * 2 / this._spin) * dt;
        if (this._fade) {
          this._fade.t += dt / 0.7;
          const k = Math.min(this._fade.t, 1);
          if (this._fade.out) this._fade.out.material.opacity = 1 - k;
          if (this._fade.in) this._fade.in.material.opacity = k;
          if (k >= 1) {
            if (this._fade.out) { this._pivot.remove(this._fade.out); }
            this._fade = null;
          }
        }
        this._paintStep();
        renderer.render(scene, cam);
        this._asciiStep(t);
      };
      renderer.setAnimationLoop(loop);
      document.addEventListener('visibilitychange', () => {
        renderer.setAnimationLoop(document.hidden ? null : loop);
        last = performance.now();
      });
      this._loadModels();
    }
    /* ---- cursor paintbrush ---- */
    _paintStep() {
      if (!this._pointerDirty || !this._pointer || !this._current) return;
      this._pointerDirty = false;
      this._ray.setFromCamera(this._pointer, this._cam);
      const hits = this._ray.intersectObject(this._current, false);
      if (!hits.length) return;
      const THREE = this._THREE;
      const mesh = this._current, geo = mesh.geometry;
      const local = mesh.worldToLocal(hits[0].point.clone());
      const bs = geo.boundingSphere || (geo.computeBoundingSphere(), geo.boundingSphere);
      const r = bs.radius * 0.12, r2 = r * r;
      const pos = geo.getAttribute('position'), col = geo.getAttribute('color');
      const paint = new THREE.Color(this.getAttribute('paint') || '#990000');
      for (let i = 0; i < pos.count; i++) {
        const dx = pos.getX(i) - local.x, dy = pos.getY(i) - local.y, dz = pos.getZ(i) - local.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        const k = 0.55 * (1 - d2 / r2);
        col.setXYZ(i,
          col.getX(i) + (paint.r - col.getX(i)) * k,
          col.getY(i) + (paint.g - col.getY(i)) * k,
          col.getZ(i) + (paint.b - col.getZ(i)) * k);
      }
      col.needsUpdate = true;
    }
    /* ---- ASCII-mesh text distortion ---- */
    _collectTargets() {
      const hostRect = this.getBoundingClientRect();
      this._targets = [...document.querySelectorAll('[data-ascii-target]')].map(el => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const fontSize = parseFloat(cs.fontSize);
        const lineHeight = parseFloat(cs.lineHeight) || fontSize * 1.2;
        return {
          text: el.textContent, x: r.left - hostRect.left, y: r.top - hostRect.top,
          w: r.width, h: r.height, fontSize, lineHeight,
          font: `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
          letterSpacing: cs.letterSpacing !== 'normal' ? cs.letterSpacing : '0px'
        };
      });
      this._targetsStale = false;
      this._patterns = new Map();
    }
    _pattern(tg) {
      let p = this._patterns.get(tg.text + tg.w);
      const cell = Math.max(9, tg.fontSize * 0.13);
      if (!p) {
        const pr = this._PR;
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(tg.w * pr));
        c.height = Math.max(1, Math.round(tg.h * pr));
        const cols = Math.ceil(tg.w / cell), rows = Math.ceil(tg.h / cell);
        const grid = Array.from({ length: cols * rows }, () => ASCII_CHARS[(Math.random() * ASCII_CHARS.length) | 0]);
        p = { canvas: c, ctx: c.getContext('2d'), cols, rows, grid, last: 0 };
        this._patterns.set(tg.text + tg.w, p);
        p.last = -1;
      }
      const now = performance.now();
      if (now - p.last > 130) {
        p.last = now;
        for (let i = 0; i < p.grid.length * 0.08; i++)
          p.grid[(Math.random() * p.grid.length) | 0] = ASCII_CHARS[(Math.random() * ASCII_CHARS.length) | 0];
        const ctx = p.ctx, pr = this._PR;
        ctx.setTransform(pr, 0, 0, pr, 0, 0);
        ctx.clearRect(0, 0, tg.w, tg.h);
        ctx.font = `${Math.round(cell * 0.9)}px ui-monospace, Menlo, monospace`;
        ctx.fillStyle = '#111111';
        ctx.textBaseline = 'top';
        for (let ry = 0; ry < p.rows; ry++)
          for (let cx = 0; cx < p.cols; cx++)
            ctx.fillText(p.grid[ry * p.cols + cx], cx * cell, ry * cell);
      }
      return p.canvas;
    }
    _asciiStep(t) {
      const ctx = this._fxCtx, fx = this._fx, pr = this._PR;
      if (!ctx) return;
      if (this._targetsStale !== false || !this._targets || (t - (this._tScan || 0)) > 600) {
        this._tScan = t; this._collectTargets();
      }
      ctx.setTransform(pr, 0, 0, pr, 0, 0);
      ctx.clearRect(0, 0, fx.width / pr, fx.height / pr);
      if (!this._targets.length || !this._current) return;
      ctx.globalCompositeOperation = 'source-over';
      for (const tg of this._targets) {
        ctx.font = tg.font;
        ctx.letterSpacing = tg.letterSpacing;
        ctx.textBaseline = 'alphabetic';
        const m = ctx.measureText(tg.text);
        const ascent = m.fontBoundingBoxAscent || tg.fontSize * 0.8;
        const y = tg.y + (tg.lineHeight - tg.fontSize) / 2 + ascent * (tg.fontSize / (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent || tg.fontSize));
        ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 4; ctx.lineJoin = 'round';
        ctx.strokeText(tg.text, tg.x, y);
        ctx.fillText(tg.text, tg.x, y);
        ctx.globalCompositeOperation = 'source-atop';
        ctx.drawImage(this._pattern(tg), tg.x, tg.y, tg.w, tg.h);
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(this._renderer.domElement, 0, 0, fx.width / pr, fx.height / pr);
      ctx.globalCompositeOperation = 'source-over';
      ctx.letterSpacing = '0px';
    }
    /* ---- model loading / cycling ---- */
    async _loadModels() {
      let models = [];
      try { models = JSON.parse(this.getAttribute('models') || '[]'); } catch (e) {}
      if (!models.length) return;
      this._models = models; this._idx = -1;
      clearInterval(this._timer);
      this._next();
      if (models.length > 1) {
        const cycle = (+this.getAttribute('cycle') || 16) * 1000;
        this._timer = setInterval(() => this._next(), cycle);
      }
    }
    async _next() {
      const THREE = this._THREE;
      this._idx = (this._idx + 1) % this._models.length;
      const m = this._models[this._idx];
      this._geoCache ||= {};
      let geo = this._geoCache[m.src];
      if (!geo) {
        try {
          const buf = await (await fetch(m.src)).arrayBuffer();
          geo = this._geoCache[m.src] = parseSTL(buf, THREE);
        } catch (e) { console.warn('STL load failed:', m.src, e); return; }
      }
      geo.computeBoundingSphere();
      if (!geo.getAttribute('color')) {
        const c = this._tintRGB();
        const n = geo.getAttribute('position').count;
        const arr = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
        geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      }
      const scale = 1.55 / geo.boundingSphere.radius;
      const mat = this._mat.clone(); mat.opacity = 0;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.setScalar(scale);
      mesh.rotation.x = -Math.PI / 2;
      const old = this._current;
      this._pivot.add(mesh);
      this._current = mesh;
      this._fade = { t: 0, in: mesh, out: old || null };
      this._cap.style.opacity = 0;
      setTimeout(() => {
        this._cap.innerHTML = `<b></b><span></span>`;
        this._cap.querySelector('b').textContent = m.name || '';
        this._cap.querySelector('span').textContent = m.desc || '';
        this._cap.style.opacity = 1;
      }, 350);
    }
  }
  customElements.define('stl-stage', STLStage);
})();
