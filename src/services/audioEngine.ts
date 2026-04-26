import { AudioSettings } from '../types';

// ============================================================
// パラメータIDマッピング（ReverbEngine.cpp準拠）
// ID 0/11 = engineType (1=lexicon, 2=bricasti, 3=tcelectronic)
// ID 1  = masterGain
// ID 2  = wetPathDryGain (dry)
// ID 3  = wetGain
// ID 4  = reverbDuration (RT60)
// ID 5  = reverbPreDelay
// ID 6  = lowCut
// ID 7  = highCut
// ID 8  = lexSpin
// ID 9  = lexWander
// ID 10 = lexBassMult
// ID 13 = briDensity
// ID 14 = briSize
// ID 15 = briVRoll
// ID 16 = tcAir
// ID 17 = tcEarlyLate
// ID 18 = tcHiDamp
// ============================================================

function algoModeToId(mode: string): number {
  if (mode === 'bricasti')     return 2;
  if (mode === 'tcelectronic') return 3;
  return 1;
}

class AudioEngine {
  public ctx: AudioContext | null = null;
  public source: AudioNode | null = null;
  public reverbNode: AudioWorkletNode | null = null;
  public analyserInput: AnalyserNode | null = null;
  public analyserOutput: AnalyserNode | null = null;

  private stream: MediaStream | null = null;
  private workletReady: boolean = false;
  private currentAlgoMode: string = '';

  // メインスレッドのWASM初期化（不要になったが互換のため残す）
  initWasm(): boolean {
    return true;
  }

  async init(inputDeviceId?: string, outputDeviceId?: string, file?: File): Promise<boolean> {
    try {
      if (this.ctx) await this.close();

      // サンプルレートを入力ソースから自動検出
      let detectedSampleRate = 48000;

      if (file) {
        // ファイルの場合：一時AudioContextでデコードしてサンプルレートを取得
        const tmpCtx = new AudioContext();
        const tmpBuf = await tmpCtx.decodeAudioData(await file.arrayBuffer());
        detectedSampleRate = tmpBuf.sampleRate;
        await tmpCtx.close();
        console.log(`[AudioEngine] File sample rate: ${detectedSampleRate}Hz`);
      } else {
        // マイク入力の場合：getUserMediaで取得したトラックの設定から読む
        const tmpStream = await navigator.mediaDevices.getUserMedia({
          audio: inputDeviceId
            ? { deviceId: { exact: inputDeviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
            : { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        });
        const track = tmpStream.getAudioTracks()[0];
        const settings = track.getSettings();
        if (settings.sampleRate) {
          detectedSampleRate = settings.sampleRate;
          console.log(`[AudioEngine] Device sample rate: ${detectedSampleRate}Hz`);
        }
        this.stream = tmpStream;
      }

      // サンプルレートを44.1kHzまたは48kHzに制限
      const allowedRates = [44100, 48000];
      if (!allowedRates.includes(detectedSampleRate)) {
        console.log(`[AudioEngine] Sample rate ${detectedSampleRate}Hz not supported, falling back to 48000Hz`);
        detectedSampleRate = 48000;
      }

      this.ctx = new AudioContext({ sampleRate: detectedSampleRate });
      if (this.ctx.state === 'suspended') await this.ctx.resume();

      // AudioWorkletモジュール登録
      await this.ctx.audioWorklet.addModule('/reverb-processor.js');

      this.reverbNode = new AudioWorkletNode(this.ctx, 'reverb-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit'
      });

      // Workletからのメッセージ
      this.workletReady = false;
      this.reverbNode.port.onmessage = (e) => {
        if (e.data.type === 'READY') {
          this.workletReady = true;
          console.log('[AudioEngine] Worklet WASM ready');
        } else if (e.data.type === 'ERROR') {
          console.error('[AudioEngine] Worklet error:', e.data.msg);
        }
      };

      // WASMバイナリをfetchしてWorkletに渡す（Transferableで効率的に転送）
      const wasmBinary = await fetch('/reverb_combined.wasm').then(r => r.arrayBuffer());
      this.reverbNode.port.postMessage({ type: 'INIT', wasmBinary }, [wasmBinary]);

      this.analyserInput  = this.ctx.createAnalyser();
      this.analyserOutput = this.ctx.createAnalyser();

      // Source
      if (file) {
        const audioBuf = await this.ctx.decodeAudioData(await file.arrayBuffer());
        const bSource = this.ctx.createBufferSource();
        bSource.buffer = audioBuf;
        bSource.loop = true;
        bSource.start();
        this.source = bSource;
      } else {
        // マイク入力：サンプルレート検出時に取得済みのストリームを再利用
        if (!this.stream) {
          const constraints: MediaStreamConstraints = {
            audio: inputDeviceId
              ? { deviceId: { exact: inputDeviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
              : { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
          };
          this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        }
        this.source = this.ctx.createMediaStreamSource(this.stream);
      }

      // グラフ接続
      this.source.connect(this.analyserInput);
      this.analyserInput.connect(this.reverbNode);
      this.reverbNode.connect(this.analyserOutput);
      this.analyserOutput.connect(this.ctx.destination);

      // 出力デバイス
      if (outputDeviceId && typeof (this.ctx as any).setSinkId === 'function') {
        try { await (this.ctx as any).setSinkId(outputDeviceId); } catch(e) {}
      }

      return true;
    } catch (e) {
      console.error('[AudioEngine] init error:', e);
      return false;
    }
  }

  // 単一パラメータ送信（スライダーのonChangeから直接呼ぶ）
  sp(id: number, v: number) {
    this.reverbNode?.port.postMessage({ type: 'PARAM', id, v });
  }

  // アルゴリズム切り替え
  setAlgo(mode: string) {
    if (mode === this.currentAlgoMode) return;
    this.currentAlgoMode = mode;
    this.reverbNode?.port.postMessage({ type: 'ALGO', v: algoModeToId(mode) });
  }

  // 全パラメータ一括送信（START時のみ）
  updateSettings(settings: AudioSettings) {
    this.currentAlgoMode = settings.algoMode;
    this.reverbNode?.port.postMessage({ type: 'APPLY_ALL', settings });
  }

  resetDSP() {
    const modeId = algoModeToId(this.currentAlgoMode);
    this.reverbNode?.port.postMessage({ type: 'ALGO', v: modeId });
  }

  private recordingChunksL: Float32Array[] = [];
  private recordingChunksR: Float32Array[] = [];
  private isRecording: boolean = false;

  startRecording() {
    if (!this.reverbNode) return;
    this.recordingChunksL = [];
    this.recordingChunksR = [];
    this.isRecording = true;

    // Workletからのキャプチャデータを受け取るハンドラを追加
    const originalHandler = this.reverbNode.port.onmessage;
    this.reverbNode.port.onmessage = (e) => {
      if (originalHandler) (originalHandler as any)(e);
      if (e.data.type === 'CAPTURE_CHUNK') {
        this.recordingChunksL.push(e.data.L);
        this.recordingChunksR.push(e.data.R);
      }
    };

    this.reverbNode.port.postMessage({ type: 'CAPTURE_START' });
  }

  async stopRecording(): Promise<Blob> {
    if (!this.reverbNode || !this.isRecording) return new Blob();
    this.isRecording = false;

    const captureData = new Promise<{ L: Float32Array; R: Float32Array }>((resolve) => {
      const originalHandler = this.reverbNode!.port.onmessage;
      this.reverbNode!.port.onmessage = (e) => {
        if (e.data.type === 'CAPTURE_DATA') {
          resolve({ L: e.data.L, R: e.data.R });
          // ハンドラを元に戻す
          this.reverbNode!.port.onmessage = (e) => {
            if (e.data.type === 'READY') { this.workletReady = true; }
            else if (e.data.type === 'ERROR') { console.error('[AudioEngine] Worklet error:', e.data.msg); }
          };
        } else if (originalHandler) {
          (originalHandler as any)(e);
        }
      };
    });

    this.reverbNode.port.postMessage({ type: 'CAPTURE_STOP' });
    const { L, R } = await captureData;

    return this._encodeWav(L, R, this.ctx?.sampleRate ?? 48000);
  }

  async renderOffline(file: File, settings: AudioSettings): Promise<Blob> {
    const arrayBuf = await file.arrayBuffer();

    // 一時AudioContextでファイルのサンプルレートを検出
    const tmpCtx = new AudioContext();
    const tmpBuf = await tmpCtx.decodeAudioData(arrayBuf.slice(0));
    const allowedRates = [44100, 48000];
    const fileSampleRate = allowedRates.includes(tmpBuf.sampleRate) ? tmpBuf.sampleRate : 48000;
    await tmpCtx.close();

    // 検出したサンプルレートでAudioContextを作成
    const offCtx = new AudioContext({ sampleRate: fileSampleRate });
    await offCtx.audioWorklet.addModule('/reverb-processor.js');

    const revNode = new AudioWorkletNode(offCtx, 'reverb-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit'
    });

    // WASM初期化を待つ
    await new Promise<void>((resolve) => {
      revNode.port.onmessage = (e) => { if (e.data.type === 'READY') resolve(); };
      fetch('/reverb_combined.wasm').then(r => r.arrayBuffer()).then(wasm => {
        revNode.port.postMessage({ type: 'INIT', wasmBinary: wasm }, [wasm]);
      });
    });

    // パラメータ適用
    revNode.port.postMessage({ type: 'APPLY_ALL', settings });

    // オーディオバッファをデコード
    const audioBuf = await offCtx.decodeAudioData(arrayBuf);
    const duration = audioBuf.duration;
    const tailSec = Math.min(settings.reverbDuration + 0.5, 12); // 残響末尾を追加

    // キャプチャ開始
    revNode.port.postMessage({ type: 'CAPTURE_START' });

    // 生PCMデータを受け取るPromise
    const captureData = new Promise<{ L: Float32Array; R: Float32Array }>((resolve) => {
      revNode.port.onmessage = (e) => {
        if (e.data.type === 'CAPTURE_DATA') resolve({ L: e.data.L, R: e.data.R });
      };
    });

    // ダミー出力に接続して再生
    const dest = offCtx.createMediaStreamDestination();
    const src = offCtx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(revNode);
    revNode.connect(dest);
    src.start(0);

    // ファイル長 + 残響末尾分を待ってキャプチャ停止
    await new Promise(r => setTimeout(r, (duration + tailSec) * 1000));
    revNode.port.postMessage({ type: 'CAPTURE_STOP' });

    const { L, R } = await captureData;
    src.stop();
    await offCtx.close();

    return this._encodeWav(L, R, fileSampleRate);
  }

  private _encodeWav(L: Float32Array, R: Float32Array, sampleRate: number): Blob {
    const numCh = 2;
    const numSamples = L.length;
    const bytesPerSample = 2; // 16bit
    const dataSize = numCh * numSamples * bytesPerSample;
    const wavBuf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(wavBuf);

    const write = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    write(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    write(8, 'WAVE');
    write(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numCh, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numCh * bytesPerSample, true);
    view.setUint16(32, numCh * bytesPerSample, true);
    view.setUint16(34, 16, true);
    write(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      const l = Math.max(-1, Math.min(1, L[i]));
      const r = Math.max(-1, Math.min(1, R[i]));
      view.setInt16(offset,     l < 0 ? l * 32768 : l * 32767, true);
      view.setInt16(offset + 2, r < 0 ? r * 32768 : r * 32767, true);
      offset += 4;
    }

    return new Blob([wavBuf], { type: 'audio/wav' });
  }

  async close() {
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this.reverbNode) { try { this.reverbNode.disconnect(); } catch(e) {} this.reverbNode = null; }
    if (this.ctx) { await this.ctx.close(); this.ctx = null; }
    this.source = null;
    this.workletReady = false;
  }
}

export const audioEngine = new AudioEngine();
