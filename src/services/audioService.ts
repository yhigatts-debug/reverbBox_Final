// audioService.ts (トグル停止・常にC++処理版)
export const audioService = {
  processorCode: `
    var Module = typeof Module !== "undefined" ? Module : {};
    class ReverbProcessor extends AudioWorkletProcessor {
      static get parameterDescriptors() {
        return Array.from({ length: 21 }, (_, i) => ({ name: 'p' + i, defaultValue: 0 }));
      }
      constructor() {
        super();
        this.initialized = false;
        this.heap = null;
        this.port.onmessage = (e) => {
          if (e.data.type === 'INIT') {
            const { wasmJSCode, wasmBinary } = e.data;
            const initialPages = 256; 
            this.memory = new WebAssembly.Memory({ initial: initialPages, maximum: initialPages });
            Module.wasmBinary = wasmBinary;
            Module.wasmMemory = this.memory;

            Module.onRuntimeInitialized = () => {
              try {
                this.malloc = Module._malloc;
                this.prepare = Module._prepare;
                this.processPtr = Module._processPtr;
                this.heap = new Float32Array(this.memory.buffer);
                this.initialized = true; // 初期化完了フラグ
              } catch (err) { console.error(err); }
            };
            try { new Function('Module', wasmJSCode)(Module); } catch (e) { console.error(e); }
          }
        };
      }

      process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        if (!input?.[0] || !output?.[0]) return true;
        
        const len = input[0].length;
        const outL = output[0];
        const outR = output[1];

        // 【確定】常にC++処理を通す（トグル処理を完全撤去）
        if (!this.initialized || !this.heap || !this.processPtr) {
          // 初期化前はバイパス（入力と同じ）
          outL.set(input[0]);
          if (input[1] && outR) outR.set(input[1]);
          return true;
        }

        // C++処理モード
        try {
          // パラメータ設定処理（既存）
          for (let i = 0; i <= 20; i++) {
            const p = parameters['p' + i];
            if (p) this.setParameter(i, p[p.length - 1]);
          }
          
          const idxL = this.ptrL >> 2;
          const idxR = this.ptrR >> 2;
          this.heap.set(input[0], idxL);
          this.heap.set(input[1] || input[0], idxR);
          
          // C++処理実行
          this.processPtr(this.ptrL, this.ptrR, len);
          
          // C++の結果を出力バッファへコピー
          for (let i = 0; i < len; i++) {
            outL[i] = this.heap[idxL + i];
            if (outR) outR[i] = this.heap[idxR + i];
          }

          // ログ出力: WASM処理後の値を確認
          if (Math.random() < 0.01) { // 負荷軽減のため間引く
            console.log("WASM Sample:", outL[0]);
          }

        } catch (e) {
          console.error(e);
        }
        return true;
      }

      setParameter(index, value) {
        // ... (既存のsetParameter code)
      }
    }
    registerProcessor('reverb-processor', ReverbProcessor);
  `
};