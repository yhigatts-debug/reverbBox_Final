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

      this.ctx = new AudioContext({ sampleRate: 48000 });
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
        const constraints: MediaStreamConstraints = {
          audio: inputDeviceId
            ? { deviceId: { exact: inputDeviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
            : { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        };
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
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
    this.reverbNode?.port.postMessage({ type: 'ALGO', v: 1 });
  }

  startRecording() {}
  async stopRecording() { return new Blob(); }

  async renderOffline(file: File, settings: AudioSettings): Promise<Blob> {
    // OfflineAudioContextはAudioWorkletが使えないため
    // リアルタイムレンダリング方式: MediaStreamDestination → MediaRecorder → WebM → WAV変換
    const arrayBuf = await file.arrayBuffer();

    // 一時的なAudioContextを作成
    const offCtx = new AudioContext({ sampleRate: 48000 });
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

    // MediaStreamDestinationに接続
    const dest = offCtx.createMediaStreamDestination();
    const src = offCtx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(revNode);
    revNode.connect(dest);
    src.start(0);

    // MediaRecorderで録音
    const recorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm' });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    const recorded = new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'audio/webm' }));
    });

    recorder.start();
    await new Promise(r => setTimeout(r, duration * 1000 + 500)); // 末尾の残響分+500ms
    recorder.stop();
    src.stop();

    const webmBlob = await recorded;
    await offCtx.close();

    // WebMをWAVに変換（AudioContextで再デコード → WAVエンコード）
    const webmBuf = await webmBlob.arrayBuffer();
    const decCtx = new AudioContext({ sampleRate: 48000 });
    const decoded = await decCtx.decodeAudioData(webmBuf);
    await decCtx.close();

    return this._encodeWav(decoded);
  }

  private _encodeWav(buffer: AudioBuffer): Blob {
    const numCh = buffer.numberOfChannels;
    const numSamples = buffer.length;
    const sampleRate = buffer.sampleRate;
    const bytesPerSample = 2; // 16bit
    const dataSize = numCh * numSamples * bytesPerSample;
    const wavBuf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(wavBuf);

    const write = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    const writeU32 = (o: number, v: number) => view.setUint32(o, v, true);
    const writeU16 = (o: number, v: number) => view.setUint16(o, v, true);

    write(0, 'RIFF');
    writeU32(4, 36 + dataSize);
    write(8, 'WAVE');
    write(12, 'fmt ');
    writeU32(16, 16);
    writeU16(20, 1); // PCM
    writeU16(22, numCh);
    writeU32(24, sampleRate);
    writeU32(28, sampleRate * numCh * bytesPerSample);
    writeU16(32, numCh * bytesPerSample);
    writeU16(34, 16);
    write(36, 'data');
    writeU32(40, dataSize);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
        view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true);
        offset += 2;
      }
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
