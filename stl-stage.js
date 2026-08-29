/* <stl-stage> — lightweight STL background viewer.
   Attributes:
     models  — JSON: [{"src":"...","name":"...","desc":"..."}]
     spin    — seconds per full rotation (default 18)
     tint    — mesh hex color (default #d9d9d9)
     cycle   — seconds between models when several (default 16)
*/
(() => {
  const THREE_URL = 'https://unpkg.com/three@0.160.0/build/three.module.js';
  let threePromise = null;
  const loadThree = () => (threePromise ||= import(THREE_URL));

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
        off += 12; // skip normal
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
    static get observedAttributes() { return ['spin', 'tint', 'models']; }
    connectedCallback() {
      if (this._init) return; this._init = true;
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `
        <style>
          :host{display:block;position:relative;overflow:hidden}
          canvas{display:block;width:100%;height:100%}
          .cap{position:absolute;right:28px;bottom:24px;text-align:right;
               font:11px/1.6 ui-monospace,'SF Mono',Menlo,monospace;color:#8a8a8a;
               letter-spacing:.06em;pointer-events:none;transition:opacity .6s}
          .cap b{display:block;color:#4a4a4a;font-weight:500;text-transform:uppercase}
        </style>
        <canvas></canvas><div class="cap"></div>`;
      this._cap = this.shadowRoot.querySelector('.cap');
      this._start();
    }
    attributeChangedCallback(name) {
      if (!this._scene) return;
      if (name === 'spin') this._spin = +this.getAttribute('spin') || 18;
      if (name === 'tint' && this._mat) this._mat.color.set(this.getAttribute('tint') || '#d9d9d9');
      if (name === 'models') this._loadModels();
    }
    async _start() {
      const THREE = this._THREE = await loadThree();
      const canvas = this.shadowRoot.querySelector('canvas');
      const renderer = this._renderer = new THREE.WebGLRenderer({
        canvas, alpha: true, antialias: true, powerPreference: 'low-power'
      });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
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
        color: this.getAttribute('tint') || '#d9d9d9',
        metalness: 0.15, roughness: 0.55, flatShading: true, transparent: true
      });
      const resize = () => {
        const w = this.clientWidth || 1, h = this.clientHeight || 1;
        renderer.setSize(w, h, false);
        cam.aspect = w / h; cam.updateProjectionMatrix();
      };
      new ResizeObserver(resize).observe(this); resize();
      let last = performance.now();
      const loop = (t) => {
        const dt = Math.min(t - last, 100) / 1000; last = t;
        if (this._pivot) this._pivot.rotation.y += (Math.PI * 2 / this._spin) * dt;
        // fade transitions
        if (this._fade) {
          this._fade.t += dt / 0.7;
          const k = Math.min(this._fade.t, 1);
          if (this._fade.out) this._fade.out.material.opacity = 1 - k;
          if (this._fade.in) this._fade.in.material.opacity = k;
          if (k >= 1) {
            if (this._fade.out) { this._pivot.remove(this._fade.out); this._fade.out.geometry.dispose(); }
            this._fade = null;
          }
        }
        renderer.render(scene, cam);
      };
      renderer.setAnimationLoop(loop);
      document.addEventListener('visibilitychange', () => {
        renderer.setAnimationLoop(document.hidden ? null : loop);
        last = performance.now();
      });
      this._loadModels();
    }
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
      const scale = 1.55 / geo.boundingSphere.radius;
      const mat = this._mat.clone(); mat.opacity = 0;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.setScalar(scale);
      mesh.rotation.x = -Math.PI / 2; // STL is usually Z-up
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
