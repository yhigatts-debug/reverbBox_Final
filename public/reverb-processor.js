// reverb-processor.js - WASMを直接instantiateするAudioWorkletProcessor

class ReverbProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ready = false;
    this._inPtr = 0;
    this._outPtr = 0;
    this._exports = null;
    this._BLOCK = 128;

    this.port.onmessage = (e) => {
      if (e.data.type === 'INIT') {
        this._initWasm(e.data.wasmBinary);
      } else if (e.data.type === 'PARAM' && this._ready) {
        try { this._exports['q'](e.data.id, e.data.v); } catch(_) {}
      } else if (e.data.type === 'ALGO' && this._ready) {
        try { this._exports['q'](0, e.data.v); } catch(_) {}
      } else if (e.data.type === 'APPLY_ALL' && this._ready) {
        this._applyAll(e.data.settings);
      }
    };
  }

  async _initWasm(wasmBinary) {
    try {
      // wasmImports構造（reverb_combined.js 新ビルド）:
      // a=__embind_register_memory_view, b=__embind_register_integer
      // c=__embind_register_std_wstring, d=__embind_register_float
      // e=__embind_register_bigint, f=___cxa_throw
      // g=__embind_register_std_string, h=__embind_register_bool
      // i=__embind_register_void, j=__abort_js
      // k=_emscripten_resize_heap, l=__embind_register_emval
      // m=_emscripten_date_now
      // ※ memoryとtableは新WASMが内部で管理（importsに不要）

      const noop = () => {};
      const imports = {
        a: {
          a: noop,  // __embind_register_memory_view
          b: noop,  // __embind_register_integer
          c: noop,  // __embind_register_std_wstring
          d: noop,  // __embind_register_float
          e: noop,  // __embind_register_bigint
          f: (ptr, type, destructor) => { throw ptr; }, // ___cxa_throw
          g: noop,  // __embind_register_std_string
          h: noop,  // __embind_register_bool
          i: noop,  // __embind_register_void
          j: () => { throw new Error('abort'); }, // __abort_js
          k: () => 0, // _emscripten_resize_heap
          l: noop,  // __embind_register_emval
          m: () => Date.now(), // _emscripten_date_now
        }
      };

      const result = await WebAssembly.instantiate(wasmBinary, imports);
      const exp = result.instance.exports;
      this._exports = exp;

      // スタック初期化（initRuntime: 's'）
      if (typeof exp['o'] === 'function') exp['o']();

      // prepare x5（'t' = _prepare(float sr)）
      for (let i = 0; i < 5; i++) exp['p'](44100);

      // malloc（'x' = _malloc）
      this._inPtr  = exp['s'](this._BLOCK * 4);
      this._outPtr = exp['s'](this._BLOCK * 4);

      this._ready = true;
      this.port.postMessage({ type: 'READY' });
      console.log('[ReverbProcessor] ready, inPtr=0x' + this._inPtr.toString(16));
    } catch(e) {
      console.error('[ReverbProcessor] init failed:', e);
      this.port.postMessage({ type: 'ERROR', msg: String(e) });
    }
  }

  _applyAll(s) {
    const sp = (id, v) => { try { this._exports['q'](id, v); } catch(_) {} };
    sp(0,  s.algoMode === 'bricasti' ? 2 : s.algoMode === 'tcelectronic' ? 3 : 1);
    sp(1,  s.masterGain);     sp(2,  s.wetPathDryGain);
    sp(3,  s.wetGain);
    sp(4,  s.reverbDuration);
    sp(5,  s.reverbPreDelay); sp(6,  s.lowCut);
    sp(7,  s.highCut);        sp(8,  s.lexSpin);
    sp(9,  s.lexWander);      sp(10, s.lexBassMult);
    sp(13, s.briDensity);     sp(14, s.briSize);
    sp(15, s.briVRoll);       sp(16, s.tcAir);
    sp(17, s.tcEarlyLate);    sp(18, s.tcHiDamp);
    sp(19, s.tcLoDecay ?? 1.0); sp(20, s.tcMidDecay ?? 1.0);
    sp(21, (s.briLfo ?? true) ? 1.0 : 0.0);
  }

  process(inputs, outputs) {
    const iL = inputs[0]?.[0];
    const iR = inputs[0]?.[1] || iL;
    const oL = outputs[0]?.[0];
    const oR = outputs[0]?.[1] || oL;
    if (!iL || !oL) return true;
    const len = iL.length;

    if (!this._ready || !this._exports) {
      oL.set(iL); if (oR !== oL) oR.set(iR);
      return true;
    }
    try {
      // Float32Arrayをキャッシュ（毎ブロックnewするとGCプレッシャーでぷつぷつ）
      const buf = this._exports['n'].buffer;
      if (!this._H || this._H.buffer !== buf) {
        this._H = new Float32Array(buf);
      }
      const H  = this._H;
      const lb = this._inPtr  >> 2;
      const rb = this._outPtr >> 2;
      H.set(iL, lb); H.set(iR, rb);
      this._exports['r'](this._inPtr, this._outPtr, len);
      oL.set(H.subarray(lb, lb + len));
      if (oR !== oL) oR.set(H.subarray(rb, rb + len));
    } catch(e) {
      oL.set(iL); if (oR !== oL) oR.set(iR);
    }
    return true;
  }
}

registerProcessor('reverb-processor', ReverbProcessor);
