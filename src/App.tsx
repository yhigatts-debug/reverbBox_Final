import React, { useState, useEffect, useCallback, useRef } from 'react';
// 住所（パス）を実際のフォルダ構成に合わせました
import { audioEngine } from './services/audioEngine';
import { AudioSettings, ReverbParameters } from './types';
import { ALGO_COLORS } from './constants';
import Visualizer from './components/Visualizer';
import StageMap from './components/StageMap';
import ParameterDisplay from './components/ParameterDisplay';

const MATERIALS = [
  "Concrete (Highly Reflective)",
  "Polished Wood (Warm/Musical)",
  "Marble (Bright/Echoic)",
  "Velvet Curtains (High Absorption)",
  "Glass/Tile (Cold/Sharp)",
  "Brick (Diffuse/Dense)",
  "Empty Warehouse (Neutral/Large)"
];

const Slider: React.FC<{
  label: string, value: number, min: number, max: number, step: number, unit?: string,
  disabled?: boolean, onChange: (v: number) => void, thumbColor: string, valueColor?: string
}> = ({ label, value, min, max, step, unit = '', disabled, onChange, thumbColor, valueColor }) => {
  // ローカルstateで表示値を管理（Reactの再レンダリングを最小化）
  const [localVal, setLocalVal] = React.useState(value);
  React.useEffect(() => { setLocalVal(value); }, [value]);
  return (
    <div className={`space-y-1 ${disabled ? 'opacity-20 pointer-events-none' : ''}`}>
      <div className="flex justify-between text-[10px] text-slate-400">
        <span className="font-bold tracking-tight uppercase">{label}</span>
        <span className={`font-mono ${valueColor ? '' : 'text-slate-200'}`} style={valueColor ? { color: valueColor } : undefined}>{localVal.toFixed(step >= 1 ? 0 : 3)}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={localVal} disabled={disabled}
        onChange={e => {
          const v = parseFloat(e.target.value);
          setLocalVal(v);
          onChange(v);
        }}
        className="w-full slider-input"
        style={{ '--thumb-color': thumbColor } as React.CSSProperties} />
    </div>
  );
};

const App: React.FC = () => {
  const [view, setView] = useState<'studio' | 'simulator'>('studio');
  
  // Initial Room State
  const [dims, setDims] = useState({ 
    length: 15, 
    width: 10, 
    height: 6, 
    material: MATERIALS[1] 
  });
  const [listenerY, setListenerY] = useState(0.8);

  const [c, setC] = useState<any>(null);
// WASM初期化
useEffect(() => {
  const M = (window as any).Module;
  if (typeof M !== 'undefined' && typeof M._prepare === 'function') {
    audioEngine.initWasm();
  }
}, []);

  const [settings, setSettings] = useState<AudioSettings>({
    wetPathDryGain: 1.0, wetGain: 0.3,
    reverbDuration: 1.5, reverbPreDelay: 0.02,
    lowCut: 500, highCut: 12000, masterGain: 1.0, algoMode: 'bricasti',
    lexSpin: 0.5, lexWander: 0.3, lexBassMult: 1.0,
    briDensity: 0.5, briSize: 1.0, briVRoll: 8000, briLfo: true,
    tcAir: 0.5, tcEarlyLate: 0.5, tcHiDamp: 0.5, tcLoDecay: 1.0, tcMidDecay: 1.0,
    isProcessing: false, bypassEffects: false, erKill: false,
    roomDims: { length: 15, width: 10, height: 6, material: MATERIALS[1] },
    roomAnalysis: { room_volume: 900, listener_perceived_distance: "REAR", material_absorption_profile: "Physics-Based Simulation" }
  });

  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [inputDeviceId, setInputDeviceId] = useState('default');
  const [outputDeviceId, setOutputDeviceId] = useState('default');
  const [analysers, setAnalysers] = useState<{in: AnalyserNode | null, out: AnalyserNode | null}>({in: null, out: null});
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Simulator State

  
  const bypassSavedSettings = useRef<{ dry: number, wet: number } | null>(null);

  // settingsの最新値をRefで保持（toggleEngineのクロージャ問題対策）
  // .then()内でsettingsを参照すると、STARTボタン押下時点の古い値になる
  // → SMP計算済みの値（wet, dry等）が反映されない問題を解消
  const settingsRef = useRef<AudioSettings>(null as any);

  // エンジン別全パラメータの保存（Lock時に共通項も含めて保存・復元）
  const algoParamsStore = useRef<Record<string, Partial<AudioSettings>>>({
    lexicon:     { lexSpin: 0.5, lexWander: 0.3, lexBassMult: 1.0, lowCut: 500 },
    bricasti:    { briDensity: 0.5, briSize: 1.0, briVRoll: 8000, briLfo: true },
    tcelectronic:{ tcAir: 0.5, tcEarlyLate: 0.5, tcHiDamp: 0.5, tcLoDecay: 1.0, tcMidDecay: 1.0 },
  });
  // エンジン別Lockステート（UIボタンと連動）
  const [algoLocks, setAlgoLocks] = useState<Record<string, boolean>>({
    lexicon: false, bricasti: false, tcelectronic: false
  });
  const algoLocksRef = useRef<Record<string, boolean>>({
    lexicon: false, bricasti: false, tcelectronic: false
  });
  const justSwitchedEngine = useRef(false);
  const isUnstable = settings.reverbDuration >= 9.9;
  // Bricasti M7: APディフューザー構造的フロアにより RT60 < 0.8s はエミュレータ上実現不可
  // （実機M7は0.2sまで設定可能だが、本エミュレータでは~750msが下限）
  const isBricastiFloor = settings.algoMode === 'bricasti' && settings.reverbDuration < 0.8;
  // TC6000: APディフューザー構造的フロアにより RT60 < 1.2s はエミュレータ上実現不可
  // （1.0s設定でも実測~840ms止まり、1.608s以上で正常動作）
  const isTCFloor = settings.algoMode === 'tcelectronic' && settings.reverbDuration < 1.2;

  // settingsRefを常に最新のsettingsと同期させる
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  const calculateLocalParams = useCallback((currentDims: typeof dims, currentListenerY: number, currentAlgoMode: string) => {
    const vol = currentDims.length * currentDims.width * currentDims.height;
    const surfaceArea = 2 * (currentDims.length * currentDims.width + currentDims.length * currentDims.height + currentDims.width * currentDims.height);
    
    const mat = currentDims.material.toLowerCase();
    let alpha = 0.1;
    let brightness = 0.5;
    
    if (mat.includes("concrete")) { alpha = 0.03; brightness = 0.4; }
    else if (mat.includes("wood")) { alpha = 0.15; brightness = 0.6; }
    else if (mat.includes("marble")) { alpha = 0.01; brightness = 0.9; }
    else if (mat.includes("velvet")) { alpha = 0.6; brightness = 0.1; }
    else if (mat.includes("glass")) { alpha = 0.05; brightness = 0.95; }
    else if (mat.includes("brick")) { alpha = 0.04; brightness = 0.3; }
    
    const eyring = -Math.log(1 - Math.min(alpha, 0.99));
    const rt60_sabine = (0.161 * vol) / (surfaceArea * alpha + 0.1);
    const rt60_eyring = (0.161 * vol) / (surfaceArea * eyring + 0.1);
    let rt60 = Math.min(10, Math.max(0.1, alpha > 0.2 ? rt60_eyring : rt60_sabine));
    
    const distanceFactor = currentListenerY; 
    const wallProximityFactor = 1.0 - Math.abs(currentListenerY - 0.5) * 2.0; 

    const physicalScale = Math.pow(vol / 900, 1/3);
    
    const dry = Math.max(0.05, (1.0 - (distanceFactor * 0.75)) / Math.max(1, physicalScale * 0.5));
    const wet = Math.min(1.4, (0.2 + (distanceFactor * 0.6)) * (0.05 / Math.max(alpha, 0.05)));


    return {
      wetPathDryGain: dry,
      wetGain: wet,
      reverbDuration: rt60,
      reverbPreDelay: 0.005 + (1.0 - distanceFactor) * 0.12 * (currentDims.length / 15),
      lowCut: currentAlgoMode === 'lexicon' ? 500 : 80,
      highCut: mat.includes("velvet") ? 4000 : (mat.includes("marble") ? 19000 : 12000),
      lexSpin: 0.05 + (vol / 12000),
      lexWander: 0.1 + (vol / 18000),
      lexBassMult: alpha < 0.05 ? 1.6 : 0.85,
      briDensity: Math.min(1.0, 0.5 + (vol / 6000)),
      briSize: Math.max(0.1, Math.min(4.0, physicalScale)),
      briVRoll: 4000 + (brightness * 12000),
      tcAir: brightness,
      tcEarlyLate: 0.25 + (distanceFactor * 0.45),
      tcHiDamp: alpha + (distanceFactor * 0.3),
      // 追加する2行（166行のtcHiDampの直後）
      tcLoDecay:  Math.min(3.0, Math.max(0.5, 0.05 / alpha)),
      tcMidDecay: Math.min(1.2, Math.max(0.8, 0.9 + physicalScale * 0.05)),
      roomAnalysis: {
        room_volume: vol,
        listener_perceived_distance: currentListenerY < 0.3 ? "FRONT" : (currentListenerY > 0.7 ? "REAR" : "CENTER"),
        material_absorption_profile: "Physics-Based Simulation"
      },
      roomDims: currentDims
    };
  }, []);

  // SMP連動：Lock解除中は全パラメータ（共通項+専用項）を更新
   useEffect(() => {
      if (justSwitchedEngine.current) {
        justSwitchedEngine.current = false;
        return;
      }
      const mode = settings.algoMode;
      if (algoLocksRef.current[mode]) return;
      const physics = calculateLocalParams(dims, listenerY, mode);
      setSettings(prev => {
        const next = { ...prev, ...physics };
        setTimeout(() => audioEngine.updateSettings(next), 0);
       return next;
      });
    }, [dims, listenerY, settings.algoMode, calculateLocalParams]);

  useEffect(() => {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => { stream.getTracks().forEach(t => t.stop()); return navigator.mediaDevices.enumerateDevices(); })
      .catch(() => navigator.mediaDevices.enumerateDevices())
      .then(devices => {
        setInputDevices(devices.filter(d => d.kind === 'audioinput'));
        setOutputDevices(devices.filter(d => d.kind === 'audiooutput'));
      });
  }, []);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (file.name.endsWith('.json')) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const raw = JSON.parse(ev.target?.result as string);
          let loaded: any = raw.params ? raw.params : raw;
          
          const sanitizedSettings: Partial<AudioSettings> = {};
          const numericFields: (keyof AudioSettings)[] = [
            'wetGain', 'wetPathDryGain', 'reverbDuration', 'reverbPreDelay', 
            'lowCut', 'highCut', 'masterGain', 'lexSpin', 'lexWander', 
            'lexBassMult', 'briDensity', 'briSize', 'briVRoll', 
            'tcAir', 'tcEarlyLate', 'tcHiDamp', 'tcLoDecay', 'tcMidDecay'
          ];

          numericFields.forEach(field => {
            if (loaded[field] !== undefined) {
              const val = parseFloat(loaded[field]);
              if (Number.isFinite(val)) (sanitizedSettings as any)[field] = val;
            }
          });

          if (loaded.algoMode && ['lexicon', 'bricasti', 'tcelectronic'].includes(loaded.algoMode.toLowerCase())) {
            sanitizedSettings.algoMode = loaded.algoMode.toLowerCase();
          }

          setSettings(prev => ({ 
            ...prev, 
            ...sanitizedSettings,
            roomAnalysis: raw.analysis || loaded.roomAnalysis,
            roomDims: raw.dims || loaded.roomDims,
            isProcessing: prev.isProcessing,
            bypassEffects: false 
          }));

          if (e.target) e.target.value = '';
        } catch (e) { 
          console.error("Preset Load Error:", e);
          alert("Invalid Preset JSON format."); 
        }
      };
      reader.readAsText(file);
      return;
    }
    setSelectedFile(file);
    if (settings.isProcessing) toggleEngine();
  };

  const toggleEngine = async () => {
    if (settings.isProcessing) {
      if (isRecording) await handleToggleRecording();
      await audioEngine.close();
      setSettings(s => ({...s, isProcessing: false}));
      setAnalysers({in: null, out: null});
    } else {
      // 1. まずLoadingは出さず、即座に「ON」の状態にする（重要）
      setSettings(s => ({...s, isProcessing: true}));
      
      try {
        // 2. エンジンの初期化を「待たずに」実行開始
        audioEngine.init(
          selectedFile ? undefined : (inputDeviceId === 'default' ? undefined : inputDeviceId),
          outputDeviceId === 'default' ? undefined : outputDeviceId,
          selectedFile || undefined
        ).then(() => {
          // 3. 初期化が終わったら、後からアナライザーを繋ぐ
          // settingsRef.current を使うことでSMP計算済みの最新値を確実に反映
          // （settings直接参照だとクロージャにより古いuseState初期値になる）
          audioEngine.updateSettings(settingsRef.current);
          setAnalysers({in: audioEngine.analyserInput, out: audioEngine.analyserOutput});
        });
        
      } catch (e) {
        console.error(e);
        setSettings(s => ({...s, isProcessing: false}));
        alert("Engine Start Failed.");
      }
    }
  };

  const handleToggleRecording = async () => {
    if (isRecording) {
      const blob = await audioEngine.stopRecording();
      const now = new Date();
        const timestamp = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().replace(/[:.]/g, '-').slice(0, 19);
      
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `AudioFX_Record_${timestamp}.wav`;
      a.click();
      setIsRecording(false);
    } else {
      audioEngine.startRecording();
      setIsRecording(true);
    }
  };

  const handleSavePreset = () => {
    const now = new Date();
      const timestamp = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const { isProcessing, ...presetData } = settings;
    const blob = new Blob([JSON.stringify(presetData, null, 2)], {type: 'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `AudioFX_Preset_${timestamp}.json`;
    a.click();
  };

  const toggleBypass = () => {
    setSettings(prev => {
      const willBypass = !prev.bypassEffects;
      if (willBypass) {
        bypassSavedSettings.current = { dry: prev.wetPathDryGain, wet: prev.wetGain };
        // WASMに即時反映
        audioEngine.sp(2, 1.0);  // Dry Mix = 1.0
        audioEngine.sp(3, 0.0);  // Wet Gain = 0.0
        return { ...prev, bypassEffects: true, wetPathDryGain: 1.0, wetGain: 0.0 };
      } else {
        const saved = bypassSavedSettings.current || { dry: 1.0, wet: 0.6 };
        // WASMに即時反映
        audioEngine.sp(2, saved.dry);
        audioEngine.sp(3, saved.wet);
        return { ...prev, bypassEffects: false, wetPathDryGain: saved.dry, wetGain: saved.wet };
      }
    });
  };

  const handleOfflineRender = async () => {
    if (!selectedFile) return;
    setIsRendering(true);
    try {
      const wavBlob = await audioEngine.renderOffline(selectedFile, settings);
      const url = URL.createObjectURL(wavBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Processed_${selectedFile.name.split('.')[0]}.wav`;
      a.click();
    } catch (e) { alert("Rendering Failed"); } finally { setIsRendering(false); }
  };

  //useEffect(() => { 
    //if (settings.isProcessing) {
      //if (c) {
        // --- 1. 基本・マスター系 ---
        //c.setVal(0, settings.wetPathDryGain);
        //c.setVal(1, settings.wetGain);
        //c.setVal(6, settings.masterGain);

        // --- 2. アコースティック・時間系 ---
        //c.setVal(2, settings.reverbDuration);
        //c.setVal(3, settings.reverbPreDelay);
        //c.setVal(18, settings.erKill ? 1.0 : 0.0);

        // --- 3. EQ・フィルター系 ---
        //c.setVal(4, settings.lowCut);
        //c.setVal(5, settings.highCut);

        // --- 4. アルゴリズム固有 (Lexicon) ---
        //c.setVal(8, settings.lexSpin);
        //c.setVal(9, settings.lexWander);
        //c.setVal(10, settings.lexBassMult);

        // --- 5. アルゴリズム固有 (Bricasti) ---
        //c.setVal(11, settings.briDensity);
        //c.setVal(12, settings.briSize);
        //c.setVal(13, settings.briVRoll);

        // --- 6. アルゴリズム固有 (TC) ---
        //c.setVal(14, settings.tcAir);
        //c.setVal(15, settings.tcEarlyLate);
        //c.setVal(16, settings.tcHiDamp);

        // --- 7. 特殊状態 ---
        //c.setVal(17, settings.bypassEffects ? 1.0 : 0.0);

        // ログでC++側の最終的な状態を確認
        //console.log("C++ Engine Sync:", c.getSettingsJSON());
      //}
      
      // 既存のWeb Audioエンジンも同期
      //audioEngine.updateSettings(settings);
    //}
  //}, [settings, c]);
  // App.tsx の useEffect (settings, cが入っているやつ) の中に追加
  
// パラメータ変更はスライダーのonChangeから直接送信するため不要

  // Simulator Functionality
  

  const renderAlgoSpecificControls = () => {
    const color = ALGO_COLORS[settings.algoMode] || '#ffffff';
    const mode = settings.algoMode;
    const locked = algoLocks[mode];
    const lockBtn = (
      <button
        onClick={() => {
          const next = { ...algoLocks, [mode]: !locked };
          setAlgoLocks(next);
          algoLocksRef.current = next;
          // Lock解除時は保存済みパラメータの共通項をクリア（専用項のみ残す）
          if (locked) {
            const store = algoParamsStore.current[mode] || {};
            const { masterGain, wetPathDryGain, wetGain, reverbDuration, reverbPreDelay, lowCut, highCut, ...specificOnly } = store as any;
            algoParamsStore.current[mode] = specificOnly;
          }
        }}
        className={`px-3 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest border transition-all ${
          locked
            ? 'bg-amber-500/20 border-amber-500/50 text-amber-400'
            : 'bg-white/5 border-white/10 text-slate-500 hover:text-slate-300'
        }`}
      >
        {locked ? '🔒 Engine Locked' : '🔓 Lock Engine'}
      </button>
    );
    switch (mode) {
      case 'lexicon':
        return (
          <>
            <div className="flex justify-end">{lockBtn}</div>
            <Slider label="Spin (Speed)" value={settings.lexSpin} min={0} max={3.0} step={0.01} disabled={locked} onChange={v => { audioEngine.sp(8, v); setSettings(s => ({...s, lexSpin: v})); }} thumbColor={color} />
            <Slider label="Wander (Depth)" value={settings.lexWander} min={0} max={2.0} step={0.01} disabled={locked} onChange={v => { audioEngine.sp(9, v); setSettings(s => ({...s, lexWander: v})); }} thumbColor={color} />
            <Slider label="Bass Multiplier" value={settings.lexBassMult} min={0.5} max={2.0} step={0.01} disabled={locked} onChange={v => { audioEngine.sp(10, v); setSettings(s => ({...s, lexBassMult: v})); }} thumbColor={color} />
          </>
        );
      case 'bricasti':
        return (
          <>
            <div className="flex justify-end">{lockBtn}</div>
            <Slider label="Density" value={settings.briDensity} min={0} max={1.0} step={0.01} disabled={locked} onChange={v => { audioEngine.sp(13, v); setSettings(s => ({...s, briDensity: v})); }} thumbColor={color} />
            <Slider label="Room Size" value={settings.briSize} min={0.1} max={5.0} step={0.01} disabled={locked} onChange={v => { audioEngine.sp(14, v); setSettings(s => ({...s, briSize: v})); }} thumbColor={color} />
            <Slider label="V-Roll (Hz)" value={settings.briVRoll} min={1000} max={20000} step={10} disabled={locked} onChange={v => { audioEngine.sp(15, v); setSettings(s => ({...s, briVRoll: v})); }} thumbColor={color} />
           
          </>
        );
      case 'tcelectronic':
        return (
          <>
            <div className="flex justify-end">{lockBtn}</div>
            <Slider label="Air Quality" value={settings.tcAir} min={0} max={1.0} step={0.01} disabled={locked} onChange={v => { audioEngine.sp(16, v); setSettings(s => ({...s, tcAir: v})); }} thumbColor={color} />
            <Slider label="ER / Tail Balance" value={settings.tcEarlyLate} min={0} max={1.0} step={0.01} disabled={locked} onChange={v => { audioEngine.sp(17, v); setSettings(s => ({...s, tcEarlyLate: v})); }} thumbColor={color} />
            <Slider label="Hi-Damping" value={settings.tcHiDamp} min={0} max={1.0} step={0.01} disabled={locked} onChange={v => { audioEngine.sp(18, v); setSettings(s => ({...s, tcHiDamp: v})); }} thumbColor={color} />
            <Slider label="Lo Decay" value={settings.tcLoDecay ?? 1.0} min={0.1} max={3.0} step={0.01} disabled={locked} onChange={v => { audioEngine.sp(19, v); setSettings(s => ({...s, tcLoDecay: v})); }} thumbColor={color} />
            <Slider label="Mid Decay" value={settings.tcMidDecay ?? 1.0} min={0.1} max={3.0} step={0.01} disabled={locked} onChange={v => { audioEngine.sp(20, v); setSettings(s => ({...s, tcMidDecay: v})); }} thumbColor={color} />
          </>
        );
      default:
        return null;
    }
  };

  return (
    <div className="h-screen w-full bg-[#0a0a0c] relative overflow-hidden">
      {/* STUDIO VIEW CONTAINER */}
      <div className={`h-full w-full ${view === 'studio' ? 'flex' : 'hidden'} text-slate-100 font-sans`}>
        <aside className="w-80 border-r border-white/10 p-6 flex flex-col gap-6 bg-black/40 overflow-y-auto custom-scrollbar">
          <header>
            <h1 className="text-2xl font-black italic bg-gradient-to-r from-blue-400 via-indigo-400 to-emerald-400 bg-clip-text text-transparent tracking-tighter">AudioFX ELITE</h1>
            <p className="text-[10px] text-slate-500 uppercase tracking-[0.2em] font-black">Studio Master V2.5</p>
          </header>

          <div className="p-4 bg-white/5 rounded-2xl border border-white/10 space-y-4">
            <h3 className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Routing</h3>
            <div className="space-y-2">
              <select 
                value={inputDeviceId} 
                onChange={e => setInputDeviceId(e.target.value)} 
                disabled={!!selectedFile}
                className={`w-full bg-black/60 border border-white/10 rounded-lg p-2 text-[10px] outline-none transition-opacity ${selectedFile ? 'opacity-40 cursor-not-allowed' : 'text-slate-300'}`}
              >
                <option value="default">{selectedFile ? '🎤 File Active' : '🎤 Default Input'}</option>
                {!selectedFile && inputDevices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || `Input ${d.deviceId.slice(0,5)}`}</option>)}
              </select>
              <select value={outputDeviceId} onChange={e => setOutputDeviceId(e.target.value)} className="w-full bg-black/60 border border-white/10 rounded-lg p-2 text-[10px] outline-none text-slate-300">
                <option value="default">🔈 System Output</option>
                {outputDevices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || `Output ${d.deviceId.slice(0,5)}`}</option>)}
              </select>
              <input type="file" ref={fileInputRef} hidden accept="audio/*,.json" onChange={handleFileChange} />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex gap-2">
              <button onClick={toggleEngine} disabled={loading} className={`flex-1 py-4 rounded-xl text-xs font-black transition-all shadow-lg ${settings.isProcessing ? 'bg-red-500 hover:bg-red-600 shadow-red-500/10' : 'bg-indigo-600 hover:bg-indigo-500 shadow-indigo-600/10'}`}>
                {loading ? 'WAIT...' : (settings.isProcessing ? 'STOP ENGINE' : 'START ENGINE')}
              </button>
              {settings.isProcessing && (
                <button 
                  onClick={() => audioEngine.resetDSP()}
                  title="DSP Panic Reset"
                  className="px-4 bg-orange-600/20 border border-orange-500/30 text-orange-400 rounded-xl hover:bg-orange-600/40 transition-all text-[10px] font-black"
                >
                  PANIC
                </button>
              )}
            </div>
            
            {settings.isProcessing && (
              <button onClick={handleToggleRecording} className={`w-full py-4 rounded-xl text-xs font-black transition-all border-2 ${isRecording ? 'bg-red-600 border-red-500 animate-pulse' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>
                {isRecording ? 'STOP RECORDING' : 'RECORD OUTPUT'}
              </button>
            )}
            
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => fileInputRef.current?.click()} className="py-2 bg-white/5 border border-white/10 rounded-lg text-[10px] font-black hover:bg-white/10 transition-all uppercase tracking-tighter">Choose File</button>
              <button onClick={toggleBypass} className={`py-2 rounded-lg text-[10px] font-black border-2 transition-all uppercase tracking-tighter ${settings.bypassEffects ? 'bg-orange-500 border-orange-400 text-white' : 'bg-transparent border-white/10 text-slate-500'}`}>
                {settings.bypassEffects ? 'Bypass On' : 'Bypass FX'}
              </button>
            </div>
          </div>

          {selectedFile && (
            <button onClick={handleOfflineRender} disabled={isRendering} className={`w-full py-4 rounded-xl text-[11px] font-black flex items-center justify-center gap-3 border-2 border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/20 transition-all ${isRendering ? 'animate-pulse' : ''}`}>
              {isRendering ? 'RENDERING...' : 'RENDER & DOWNLOAD WAV'}
            </button>
          )}

          <div className="p-4 bg-white/5 rounded-2xl border border-white/10 space-y-4">
            <h3 className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Topology</h3>
            <div className="flex flex-col gap-2">
              {(['lexicon', 'bricasti', 'tcelectronic'] as const).map(m => (
                <button key={m} onClick={() => {
  setSettings(s => {
    // 現在のエンジンのパラメータを保存（Lockされていれば共通項も含めて全保存）
    const current = s.algoMode;
    const commonParams = algoLocksRef.current[current] ? {
      masterGain: s.masterGain, wetPathDryGain: s.wetPathDryGain, wetGain: s.wetGain,
      reverbDuration: s.reverbDuration, reverbPreDelay: s.reverbPreDelay,
      lowCut: s.lowCut, highCut: s.highCut,
    } : {};
    if (current === 'lexicon') {
      algoParamsStore.current.lexicon = { ...commonParams, lexSpin: s.lexSpin, lexWander: s.lexWander, lexBassMult: s.lexBassMult };
    } else if (current === 'bricasti') {
      algoParamsStore.current.bricasti = { ...commonParams, briDensity: s.briDensity, briSize: s.briSize, briVRoll: s.briVRoll, briLfo: s.briLfo };
    } else if (current === 'tcelectronic') {
      algoParamsStore.current.tcelectronic = { ...commonParams, tcAir: s.tcAir, tcEarlyLate: s.tcEarlyLate, tcHiDamp: s.tcHiDamp, tcLoDecay: s.tcLoDecay, tcMidDecay: s.tcMidDecay };
    }
    // 新しいエンジンの保存済みパラメータを復元
    const restored = algoParamsStore.current[m] || {};
    // Algo切り替え時にBypassを強制オフ
    const bypassOff = { bypassEffects: false };
    if (s.bypassEffects) {
      bypassSavedSettings.current = null;
      audioEngine.sp(2, restored.wetPathDryGain ?? s.wetPathDryGain);
      audioEngine.sp(3, restored.wetGain ?? s.wetGain);
    }
    const next = { ...s, algoMode: m, ...restored, ...bypassOff };
    // SMPによる上書きを防ぐフラグをセット
    // lock is manual only
    setTimeout(() => audioEngine.updateSettings(next), 0);
    return next;
  });
  justSwitchedEngine.current = true;
  audioEngine.setAlgo(m);
}}
                  className={`py-4 rounded-xl border-2 transition-all uppercase text-[10px] font-black flex flex-col items-center justify-center gap-0.5 ${settings.algoMode === m ? 'bg-white/10 border-current shadow-lg' : 'bg-transparent border-white/5 text-slate-600'}`}
                  style={{ color: settings.algoMode === m ? ALGO_COLORS[m] : 'inherit', borderColor: settings.algoMode === m ? ALGO_COLORS[m] : 'transparent' }}>
                  <span>{m.toUpperCase()}</span>
                  <span className="text-[7px] opacity-60 font-normal">{m === 'lexicon' ? 'Rich FDN' : m === 'bricasti' ? 'Dense Schroeder' : 'Advanced FDN8'}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="p-4 bg-white/5 rounded-2xl border border-white/10 space-y-4">
            <h3 className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Mastering</h3>
            <Slider label="Master Out" value={settings.masterGain} min={0} max={2.0} step={0.01} disabled={algoLocks[settings.algoMode]} onChange={v => { audioEngine.sp(1, v); setSettings(s => ({...s, masterGain: v})); }} thumbColor="#f59e0b" />
            <Slider label="Dry Mix" value={settings.wetPathDryGain} min={0} max={1.0} step={0.01} disabled={algoLocks[settings.algoMode]} onChange={v => { audioEngine.sp(2, v); setSettings(s => ({...s, wetPathDryGain: v, bypassEffects: false})); }} thumbColor="#fff" />
            <Slider label="Wet Gain" value={settings.wetGain} min={0} max={1.5} step={0.01} disabled={algoLocks[settings.algoMode]} onChange={v => { audioEngine.sp(3, v); setSettings(s => ({...s, wetGain: v, bypassEffects: false})); }} thumbColor={ALGO_COLORS[settings.algoMode]} />
            
            <div className="mt-4 pt-4 border-t border-white/5 flex justify-center">
                <button onClick={handleSavePreset} className="w-full py-2 bg-white/5 border border-white/10 rounded-lg text-[9px] font-black hover:bg-white/10 uppercase tracking-tighter">Save Current Preset</button>
            </div>
          </div>

          <div className="p-4 bg-white/5 rounded-2xl border border-white/10 relative space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Acoustics</h3>

            </div>
            {isUnstable && (
              <div className="absolute top-4 right-4 animate-pulse flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500"></span>
                <span className="text-[7px] font-black text-red-500 uppercase">Stability Alert</span>
              </div>
            )}
            <Slider label="RT60 (Time)" value={settings.reverbDuration} min={0.1} max={10} step={0.1} unit="s" disabled={algoLocks[settings.algoMode]} onChange={v => { audioEngine.sp(4, v); setSettings(s => ({...s, reverbDuration: v})); }} thumbColor={isUnstable ? "#ef4444" : isBricastiFloor ? "#ef4444" : isTCFloor ? "#ef4444" : "#fff"} valueColor={isBricastiFloor ? "#ef4444" : isTCFloor ? "#ef4444" : undefined} />
            {isBricastiFloor && (
              <div className="flex items-center gap-1.5 -mt-1">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0"></span>
                <span className="text-[9px] font-black text-red-400 uppercase tracking-wide">
                  RT60 &lt; 0.8s — emulator floor (~750ms actual)
                </span>
              </div>
            )}
            {isTCFloor && (
              <div className="flex items-center gap-1.5 -mt-1">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0"></span>
                <span className="text-[9px] font-black text-red-400 uppercase tracking-wide">
                  RT60 &lt; 1.2s — emulator floor (~800ms actual)
                </span>
              </div>
            )}
            <Slider label="Pre-Delay" value={settings.reverbPreDelay} min={0} max={0.3} step={0.001} unit="s" disabled={algoLocks[settings.algoMode]} onChange={v => { audioEngine.sp(5, v); setSettings(s => ({...s, reverbPreDelay: v})); }} thumbColor="#fff" />
          </div>

          <div className="p-4 bg-white/5 rounded-2xl border-l-4 space-y-4" style={{ borderLeftColor: ALGO_COLORS[settings.algoMode] }}>
            <div className="flex justify-between items-center">
              <h3 className="text-[9px] font-bold uppercase tracking-widest text-slate-500">Engine Specifics</h3>
            </div>
            {renderAlgoSpecificControls()}
          </div>

          <div className="p-4 bg-white/5 rounded-2xl border border-white/10 space-y-4 mb-10">
            <h3 className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Xover &amp; Hi Filter</h3>
            <Slider label="Lo" value={settings.lowCut} min={20} max={1000} step={1} unit="Hz" disabled={algoLocks[settings.algoMode]} onChange={v => { audioEngine.sp(6, v); setSettings(s => ({...s, lowCut: v})); }} thumbColor="#4ade80" />
            <Slider label="Hi" value={settings.highCut} min={1000} max={20000} step={1} unit="Hz" disabled={algoLocks[settings.algoMode]} onChange={v => { audioEngine.sp(7, v); setSettings(s => ({...s, highCut: v})); }} thumbColor="#fb7185" />
          </div>
        </aside>

        <main className="flex-1 p-8 flex flex-col gap-8 bg-[#0a0a0c] overflow-y-auto custom-scrollbar">
          <div className="shrink-0 space-y-4">
            <div className="h-80 w-full">
              <Visualizer analyserA={analysers.in} analyserB={analysers.out} colorA="#94a3b8" colorB={isUnstable ? "#ef4444" : ALGO_COLORS[settings.algoMode]} labelA="SOURCE" labelB={isUnstable ? "PROCESSED (UNSTABLE)" : "PROCESSED"} />
            </div>
            
            {selectedFile && (
              <div className="flex items-center gap-4 px-6 py-4 bg-indigo-500/10 border border-indigo-500/20 rounded-3xl backdrop-blur-xl animate-in fade-in slide-in-from-top-4 duration-500">
                <div className="w-12 h-12 rounded-2xl bg-indigo-500/20 flex items-center justify-center text-xl shadow-inner shadow-indigo-500/10">
                  🎵
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] text-indigo-400 font-black uppercase tracking-[0.2em] mb-1">Active Audio Source</div>
                  <div className="text-base text-slate-100 font-bold truncate tracking-tight">{selectedFile.name}</div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="hidden sm:block text-[9px] text-slate-500 font-mono bg-black/40 px-3 py-1.5 rounded-full border border-white/5">
                    {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB
                  </div>
                  <button 
                    onClick={() => {
                      setSelectedFile(null);
                      if (settings.isProcessing) toggleEngine();
                    }} 
                    className="px-5 py-2.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-[10px] font-black rounded-xl border border-red-500/20 transition-all uppercase tracking-widest shadow-lg shadow-red-500/5 active:scale-95"
                  >
                    Eject Source
                  </button>
                </div>
              </div>
            )}
          </div>
          
          <button 
            onClick={() => setView('simulator')}
            className={`flex-1 rounded-[3rem] border flex flex-col items-center justify-center p-8 overflow-hidden min-h-[200px] transition-all group cursor-pointer ${isUnstable ? 'border-red-500/30 bg-red-500/5 hover:bg-red-500/10 shadow-[0_0_40px_rgba(239,68,68,0.05)]' : 'border-white/5 bg-black/20 hover:bg-white/5'}`}
          >
            {settings.roomDims ? (
              <div className="w-full max-w-2xl animate-in fade-in zoom-in-95 duration-500">
                <div className="flex justify-between items-end mb-8 border-b border-white/10 pb-4">
                  <div className="space-y-1">
                    <h3 className={`text-[10px] font-bold uppercase tracking-[0.3em] ${isUnstable ? 'text-red-400' : 'text-indigo-400'}`}>Environment Analysis</h3>
                    <div className="text-2xl font-black text-white italic tracking-tighter group-hover:text-emerald-400 transition-colors uppercase">
                      {isUnstable ? 'Unstable Sparse Modeling' : 'Spatial Modeling Profile'}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 mb-1">
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full animate-pulse ${isUnstable ? 'bg-red-500' : 'bg-indigo-500'}`}></div>
                      <span className={`text-[9px] font-bold uppercase tracking-widest ${isUnstable ? 'text-red-400' : 'text-indigo-300'}`}>
                        {isUnstable ? 'Stability Limit' : 'Physics Active'}
                      </span>
                    </div>
                    <span className="text-[8px] text-emerald-400 font-black uppercase tracking-widest opacity-80">
                      Pos: {settings.roomAnalysis?.listener_perceived_distance || '---'}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-x-16 gap-y-6 text-left">
                  <div className={`space-y-1.5 border-l-2 pl-4 ${isUnstable ? 'border-red-500/30' : 'border-indigo-500/30'}`}>
                    <div className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">Surface Material</div>
                    <div className="text-lg text-slate-200 font-black tracking-tight line-clamp-1">{settings.roomDims.material || 'Standard'}</div>
                  </div>
                  <div className={`space-y-1.5 border-l-2 pl-4 ${isUnstable ? 'border-red-500/30' : 'border-indigo-500/30'}`}>
                    <div className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">Internal Volume</div>
                    <div className="text-lg text-slate-200 font-black font-mono tracking-tighter">{settings.roomAnalysis?.room_volume} <span className="text-xs text-slate-500">m³</span></div>
                  </div>
                  <div className={`space-y-1.5 border-l-2 pl-4 ${isUnstable ? 'border-red-500/30' : 'border-indigo-500/30'}`}>
                    <div className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">Dimensions (L × W × H)</div>
                    <div className="text-lg text-slate-200 font-black font-mono tracking-tighter flex items-baseline gap-1">
                      {settings.roomDims.length}<span className="text-[10px] text-slate-600">m</span> × {settings.roomDims.width}<span className="text-[10px] text-slate-600">m</span> × {settings.roomDims.height}<span className="text-[10px] text-slate-600">m</span>
                    </div>
                  </div>
                  <div className={`space-y-1.5 border-l-2 pl-4 ${isUnstable ? 'border-red-500/30' : 'border-indigo-500/30'}`}>
                    <div className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">Absorption Profile</div>
                    <div className={`text-sm font-bold italic line-clamp-2 leading-tight ${isUnstable ? 'text-red-300' : 'text-indigo-300'}`}>
                      {settings.roomAnalysis?.material_absorption_profile || 'Normal Absorption'}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4">
                <div className="italic text-white/5 text-sm uppercase tracking-[0.5em] group-hover:text-emerald-500/40 transition-all">
                  Initialize Physics Core
                </div>
                <div className="px-6 py-2 border border-white/10 rounded-full text-[9px] font-black text-slate-500 uppercase tracking-widest group-hover:border-emerald-500/50 group-hover:text-emerald-400 transition-all">
                  Modeling Engine Ready
                </div>
              </div>
            )}
          </button>
        </main>
      </div>

      {/* SIMULATOR VIEW CONTAINER */}
      <div className={`h-full w-full ${view === 'simulator' ? 'flex' : 'hidden'} text-white flex-col p-8 overflow-hidden animate-in fade-in duration-500`}>
        <header className="flex justify-between items-start mb-10">
            <div className="flex flex-col gap-1">
                <h1 className="text-3xl font-black italic tracking-tighter bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent uppercase">Acoustic Modeler Core</h1>
                <p className="text-[10px] text-zinc-500 uppercase tracking-[0.4em] font-black">AI-Driven Environment Simulation</p>
            </div>
            
            <div className="flex gap-4 p-3 bg-zinc-950 border border-zinc-800 rounded-2xl">
                <div className="flex flex-col gap-1">
                  <span className="text-[8px] text-zinc-500 font-black uppercase tracking-widest mb-1 border-b border-zinc-800 pb-1">Control Hierarchy</span>
                  <div className="flex gap-4">
                    <div className="flex items-center gap-2">
                        <span className="w-4 h-4 rounded bg-emerald-500 text-[8px] flex items-center justify-center font-black">1</span>
                        <span className="text-[9px] text-zinc-300 font-bold">Physics (Map)</span>
                    </div>
                    <div className="flex items-center gap-2 opacity-60">
                        <span className="w-4 h-4 rounded bg-zinc-700 text-[8px] flex items-center justify-center font-black">2</span>
                        <span className="text-[9px] text-zinc-300 font-bold">Manual Sliders</span>
                    </div>
                    <div className="flex items-center gap-2 opacity-40">
                        <span className="w-4 h-4 rounded bg-zinc-800 text-[8px] flex items-center justify-center font-black">3</span>
                        <span className="text-[9px] text-zinc-300 font-bold">AI Prompt</span>
                    </div>
                  </div>
                </div>
                <button onClick={() => setView('studio')} className="px-6 self-center h-10 bg-white/5 border border-white/10 rounded-xl text-xs font-black hover:bg-white/10 transition-all uppercase tracking-widest ml-4">Back to Studio</button>
            </div>
        </header>

        <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-10 overflow-hidden">
            <div className="space-y-6 flex flex-col overflow-y-auto custom-scrollbar pr-4 pb-10">
               
                <div className={`p-6 bg-zinc-950/50 rounded-3xl border transition-all space-y-6 shadow-xl ${isUnstable ? 'border-red-500/30' : 'border-zinc-900'}`}>
                    <StageMap 
                        listenerY={listenerY} 
                        dims={{ length: dims.length, width: dims.width }} 
                        onChange={setListenerY} 
                    />
                    
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-4 border-t border-white/5">
                        <div className="col-span-full flex justify-between items-center mb-2">
                          <h3 className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest">Environment Dimensions</h3>
                        </div>
                        <Slider 
                          label="LENGTH" 
                          value={dims.length} 
                          min={3} 
                          max={60} 
                          step={1} 
                          unit="m" 
                          onChange={v => {
                            const oldLength = dims.length;
                            const absoluteDist = listenerY * oldLength;
                            const newRelativeY = Math.max(0.02, Math.min(0.98, absoluteDist / v));
                            setListenerY(newRelativeY);
                            setDims(d => ({...d, length: v}));
                          }} 
                          thumbColor="#10b981" 
                        />
                        <Slider label="WIDTH" value={dims.width} min={3} max={50} step={1} unit="m" onChange={v => setDims(d => ({...d, width: v}))} thumbColor="#10b981" />
                        <Slider label="HEIGHT" value={dims.height} min={2} max={25} step={1} unit="m" onChange={v => setDims(d => ({...d, height: v}))} thumbColor="#10b981" />
                        
                        <div className="col-span-full space-y-2 mt-2">
                            <label className="text-[9px] text-zinc-500 font-black uppercase tracking-widest">Structural Material</label>
                            <select 
                                className="w-full bg-black/60 border border-white/5 rounded-xl p-3 text-[11px] font-black outline-none text-emerald-400 appearance-none cursor-pointer hover:bg-zinc-900 transition-colors"
                                value={dims.material}
                                onChange={e => setDims(d => ({...d, material: e.target.value}))}
                            >
                                {MATERIALS.map(m => <option key={m} value={m}>{m}</option>)}
                            </select>
                        </div>
                    </div>
                </div>

                <div className="p-4 bg-zinc-900/30 rounded-2xl border border-white/5 space-y-3">
                  <h3 className="text-[9px] font-bold text-slate-600 uppercase tracking-widest">Engine Bridge</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="px-4 py-3 bg-black/60 border border-white/5 rounded-xl text-[10px] text-zinc-400 font-mono flex items-center gap-3">
                      <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse"></span>
                      IN: {inputDevices.find(d => d.deviceId === inputDeviceId)?.label || 'Default'}
                    </div>
                    <button 
                      onClick={toggleEngine} 
                      className={`py-3 rounded-xl text-[10px] font-black transition-all ${settings.isProcessing ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}`}
                    >
                      {settings.isProcessing ? 'ENGINE ACTIVE' : 'START ENGINE'}
                    </button>
                  </div>
                </div>

                <button 
                  onClick={() => setView('studio')}
                  className="w-full py-5 bg-gradient-to-r from-emerald-600/20 to-cyan-600/20 border border-emerald-500/30 text-emerald-400 rounded-3xl text-[11px] font-black uppercase tracking-[0.3em] hover:from-emerald-600/30 hover:to-cyan-600/30 transition-all active:scale-[0.98] shadow-2xl"
                >
                    Finalize to Studio Master
                </button>
            </div>

            <div className="flex flex-col gap-6 overflow-hidden">
                <div className={`flex-1 p-6 bg-zinc-950 rounded-3xl border flex flex-col min-h-0 shadow-2xl transition-all ${isUnstable ? 'border-red-500/30' : 'border-zinc-900'}`}>
                    <div className="flex justify-between items-center mb-6 shrink-0">
                        <div className="flex flex-col gap-0.5">
                          <h3 className={`text-[10px] font-bold uppercase tracking-widest ${isUnstable ? 'text-red-400' : 'text-emerald-400'}`}>
                            {isUnstable ? 'Limited Mode Analytics' : 'Environment Analytics'}
                          </h3>
                        </div>
                        <div className={`px-3 py-1 bg-zinc-900 border rounded-full text-[9px] font-mono uppercase tracking-widest ${isUnstable ? 'border-red-500/20 text-red-400' : 'border-zinc-800 text-zinc-400'}`}>
                            {settings.roomAnalysis?.listener_perceived_distance || 'Calculating...'}
                        </div>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4 mb-6 shrink-0">
                        <div className="p-4 bg-zinc-900/50 border border-white/5 rounded-2xl">
                            <div className="text-[8px] text-zinc-500 font-black uppercase mb-1">Room Volume</div>
                            <div className="text-2xl font-black text-white font-mono tracking-tighter">{settings.roomAnalysis?.room_volume} <span className="text-xs text-zinc-500">m³</span></div>
                        </div>
                        <div className="p-4 bg-zinc-900/50 border border-white/5 rounded-2xl overflow-hidden">
                            <div className="text-[8px] text-zinc-500 font-black uppercase mb-1">Material Absorption</div>
                            <div className={`text-xs font-bold leading-tight line-clamp-2 italic break-words ${isUnstable ? 'text-red-300' : 'text-indigo-300'}`}>
                              {settings.roomAnalysis?.material_absorption_profile || 'Awaiting Physics...'}
                            </div>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 min-h-0">
                      <ParameterDisplay params={{
                          dryGain: settings.wetPathDryGain,
                          wetGain: settings.wetGain,
                          reverbDuration: settings.reverbDuration,
                          reverbPreDelay: settings.reverbPreDelay,
                          highCut: settings.highCut,
                          lowCut: settings.lowCut,
                          lexSpin: settings.lexSpin,
                          lexWander: settings.lexWander,
                          lexBassMult: settings.lexBassMult,
                          briDensity: settings.briDensity,
                          briSize: settings.briSize,
                          briVRoll: settings.briVRoll,
                          tcAir: settings.tcAir,
                          tcEarlyLate: settings.tcEarlyLate,
                          tcHiDamp: settings.tcHiDamp
                      }} />
                    </div>
                </div>
            </div>
        </div>
      </div>
    </div>
  );
};

export default App;
