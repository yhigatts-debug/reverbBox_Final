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
  async renderOffline(_file: File, _settings: AudioSettings) { return new Blob(); }

  async close() {
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this.reverbNode) { try { this.reverbNode.disconnect(); } catch(e) {} this.reverbNode = null; }
    if (this.ctx) { await this.ctx.close(); this.ctx = null; }
    this.source = null;
    this.workletReady = false;
  }
}

export const audioEngine = new AudioEngine();
